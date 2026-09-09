import { BedrockAgentCoreClient, GetResourceOauth2TokenCommand } from "@aws-sdk/client-bedrock-agentcore";
import { withWAT } from "bedrock-agentcore/identity";
import { fetch as undiciFetch } from "undici";
import { CalendarEvent } from "../domain/calendar-event";
import type { DelegatedCredentialError } from "../domain/delegated-credential-error";
import type { HoldId } from "../domain/hold";
import { err, ok, type Result } from "../domain/result";
import { redactTokenValue, withSpan } from "../observability/tracing";
import type { CalendarPort } from "../usecase/ports";
import type { FetchLike } from "./sigv4-fetch";

const CALENDAR_SCOPES = ["calendar.write"];

// withWAT (bedrock-agentcore/identity) reads the current invocation's
// Workload Access Token from AgentCore Runtime's own request-scoped context
// (AsyncLocalStorage-based, so concurrent Callers' requests never cross) —
// this wraps it into a bare "give me the current token" accessor so the
// adapter's constructor can accept a stub in tests without needing to fake
// that context machinery, which the SDK doesn't expose publicly.
type WorkloadIdentitySource = () => Promise<string>;
const defaultWorkloadIdentitySource: WorkloadIdentitySource = () => withWAT((wat: string) => Promise.resolve(wat))();

// Identity's Delegated credential (issue #17 / ADR-0003): fetches an OAuth2
// access token for the mock calendar-events store from AgentCore Identity's
// token vault, then writes the event. No vaulted credential yet surfaces as
// ConsentRequired, carrying the authorizationUrl for the consent handshake —
// not a failure, just "not authorized yet".
export class DelegatedCalendarAdapter implements CalendarPort {
  constructor(
    private readonly identityClient: BedrockAgentCoreClient,
    private readonly credentialProviderName: string,
    private readonly calendarApiUrl: string,
    private readonly fetch: FetchLike = undiciFetch,
    private readonly workloadIdentitySource: WorkloadIdentitySource = defaultWorkloadIdentitySource,
  ) {}

  async writeEvent(holdId: HoldId, title: string): Promise<Result<CalendarEvent, DelegatedCredentialError>> {
    // Identity's consent-flow span (issue #24 / ADR-0008): the one genuine
    // credential in this trace — every token value goes through
    // redactTokenValue, never a raw attribute. Flow state ("pending" /
    // "authorized" / "approved") stays visible; that's what a reviewer needs
    // to see, not the secret itself.
    return withSpan(
      "Identity.ConsentHandshake",
      { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "write-calendar-event", "hold.id": holdId },
      async (span) => {
        // Every return path goes through this, not just the success one -
        // an execute_tool span's event record needs gen_ai.tool.call.result
        // set regardless of outcome, the same class of bug fixed in
        // handler.ts's gen_ai.task.output (issue #23 / ADR-0007's Revision 3).
        // A DelegatedCredentialError carries no token/secret value itself
        // (ConsentRequired's authorizationUrl and the others' messages
        // aren't credentials), so this needs no redaction the way the
        // token/consent-state attributes above already get.
        function finish<T extends Result<CalendarEvent, DelegatedCredentialError>>(result: T): T {
          span.setAttribute("gen_ai.tool.call.result", JSON.stringify(result.ok ? result.value : result.error));
          return result;
        }

        let workloadIdentityToken: string;
        try {
          workloadIdentityToken = await this.workloadIdentitySource();
        } catch (error) {
          return finish(
            err({
              type: "IdentityUnavailable",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        span.setAttribute("identity.workload_identity_token", redactTokenValue(workloadIdentityToken));

        let tokenResponse;
        try {
          tokenResponse = await this.identityClient.send(
            new GetResourceOauth2TokenCommand({
              resourceCredentialProviderName: this.credentialProviderName,
              scopes: CALENDAR_SCOPES,
              oauth2Flow: "USER_FEDERATION",
              workloadIdentityToken,
            }),
          );
        } catch (error) {
          return finish(
            err({
              type: "IdentityUnavailable",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }

        if (tokenResponse.authorizationUrl) {
          span.setAttribute("identity.consent_flow_state", "pending");
          return finish(
            err({
              type: "ConsentRequired",
              message: "Caller has not yet authorized calendar access",
              authorizationUrl: tokenResponse.authorizationUrl,
            }),
          );
        }
        if (!tokenResponse.accessToken) {
          return finish(
            err({
              type: "IdentityUnavailable",
              message: "Identity returned neither an access token nor an authorization URL",
            }),
          );
        }
        span.setAttribute("identity.consent_flow_state", "approved");
        span.setAttribute("identity.access_token", redactTokenValue(tokenResponse.accessToken));

        return finish(await this.writeEventToCalendar(tokenResponse.accessToken, holdId, title));
      },
    );
  }

  private async writeEventToCalendar(
    accessToken: string,
    holdId: HoldId,
    title: string,
  ): Promise<Result<CalendarEvent, DelegatedCredentialError>> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetch(`${this.calendarApiUrl}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ holdId, title }),
      });
    } catch (error) {
      return err({
        type: "CalendarUnavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (!response.ok) {
      return err({ type: "CalendarUnavailable", message: `calendar API returned ${response.status}` });
    }

    const body: unknown = await response.json().catch(() => undefined);
    const parsed = CalendarEvent.parse(body);
    if (!parsed.ok) {
      return err({ type: "CalendarUnavailable", message: parsed.error.message });
    }
    return ok(parsed.value);
  }
}
