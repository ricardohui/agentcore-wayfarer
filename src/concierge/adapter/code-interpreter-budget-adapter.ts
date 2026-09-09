import {
  BedrockAgentCoreClient,
  InvokeCodeInterpreterCommand,
  StartCodeInterpreterSessionCommand,
  type CodeInterpreterResult,
  type CodeInterpreterStreamOutput,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-agentcore";
import type { BudgetCategory } from "../domain/budget-category";
import type { BudgetError } from "../domain/budget-error";
import { BudgetSnapshot } from "../domain/budget-snapshot";
import type { LocalPrice } from "../domain/local-price";
import { err, ok, type Result } from "../domain/result";
import type { RuntimeSessionId } from "../domain/runtime-session-id";
import type { ScenarioCity } from "../domain/scenario-city";
import { withSpan } from "../observability/tracing";
import type { BudgetPort } from "../usecase/ports";

// ADR-0004: a static mock rate table, not a live forex API — every Local
// currency Gateway's mock catalog produces (mock-catalog.ts), converted to
// Home currency (USD).
const MOCK_RATE_TABLE_TO_USD: Readonly<Record<string, number>> = { JPY: 0.0067, EUR: 1.08, USD: 1 };

const SESSION_NAME_PREFIX = "wayfarer-budget";
const SESSION_TIMEOUT_SECONDS = 900;

// Code Interpreter's budget/currency math (issue #18 / ADR-0004): one
// Sandbox-mode session persists per RuntimeSessionId (CONTEXT.md's "Running
// total" and "Budget breakdown" both live as that sandbox's own Python
// state, not something tracked here) — `clearContext: false` on every
// executeCode call is what keeps that state alive across holds, so this
// adapter's only job is starting the session once per conversation and
// re-sending the accumulation script on each hold.
export class CodeInterpreterBudgetAdapter implements BudgetPort {
  // Caches the in-flight start Promise, not just its resolved value — a
  // model round can dispatch hold-flight and hold-hotel concurrently
  // (BedrockConverseModelClient runs a round's tool calls via Promise.all),
  // and without this both calls would see no cached session and each start
  // their own, orphaning one sandbox's accumulated state.
  private readonly sandboxSessionByRuntimeSession = new Map<RuntimeSessionId, Promise<string>>();

  constructor(
    private readonly client: BedrockAgentCoreClient,
    private readonly codeInterpreterIdentifier: string,
  ) {}

  async recordHold(
    sessionId: RuntimeSessionId,
    city: ScenarioCity,
    category: BudgetCategory,
    price: LocalPrice,
  ): Promise<Result<BudgetSnapshot, BudgetError>> {
    // Code Interpreter span (issue #24 / ADR-0008): budget figures stay
    // visible, unredacted — they aren't a credential, and they're the
    // substance a reviewer needs to judge the session.
    return withSpan(
      "executeCode",
      { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "executeCode", "session.id": sessionId, "budget.city": city, "budget.category": category, "budget.local_price": `${price.amount} ${price.currency}` },
      async (span) => {
        let sandboxSessionId: string;
        try {
          sandboxSessionId = await this.ensureSandboxSession(sessionId);
        } catch (error) {
          const budgetError = toSandboxUnavailable(error);
          span.setAttribute("gen_ai.tool.call.result", JSON.stringify(budgetError));
          return err(budgetError);
        }

        let response;
        try {
          response = await this.client.send(
            new InvokeCodeInterpreterCommand({
              codeInterpreterIdentifier: this.codeInterpreterIdentifier,
              sessionId: sandboxSessionId,
              name: "executeCode",
              arguments: {
                code: buildBudgetConversionScript(city, category, price),
                language: "python",
                clearContext: false,
              },
            }),
          );
        } catch (error) {
          // The cached session may itself be stale (expired server-side, or the
          // request never reached it) — drop it so the next hold starts fresh
          // instead of retrying against a session that will never work again.
          this.sandboxSessionByRuntimeSession.delete(sessionId);
          const budgetError = toSandboxUnavailable(error);
          span.setAttribute("gen_ai.tool.call.result", JSON.stringify(budgetError));
          return err(budgetError);
        }

        const result = await parseInvokeResponse(response);
        if (!result.ok && result.error.type === "SandboxUnavailable") {
          this.sandboxSessionByRuntimeSession.delete(sessionId);
        }
        span.setAttribute("gen_ai.tool.call.result", JSON.stringify(result.ok ? result.value : result.error));
        return result;
      },
    );
  }

  private ensureSandboxSession(sessionId: RuntimeSessionId): Promise<string> {
    const existing = this.sandboxSessionByRuntimeSession.get(sessionId);
    if (existing) {
      return existing;
    }

    const starting = this.startSandboxSession(sessionId);
    // A failed start must not poison the cache — the next call needs to try
    // starting again, not permanently reuse a rejected Promise.
    starting.catch(() => this.sandboxSessionByRuntimeSession.delete(sessionId));
    this.sandboxSessionByRuntimeSession.set(sessionId, starting);
    return starting;
  }

  private async startSandboxSession(sessionId: RuntimeSessionId): Promise<string> {
    const response = await this.client.send(
      new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: this.codeInterpreterIdentifier,
        name: `${SESSION_NAME_PREFIX}-${sessionId}`.slice(0, 63),
        sessionTimeoutSeconds: SESSION_TIMEOUT_SECONDS,
      }),
    );
    if (!response.sessionId) {
      throw new Error("StartCodeInterpreterSession returned no sessionId");
    }
    return response.sessionId;
  }
}

// Exported for direct unit testing of the rate table and the persistence
// pattern, without needing a real (or mocked) sandbox round trip.
export function buildBudgetConversionScript(
  city: ScenarioCity,
  category: BudgetCategory,
  price: LocalPrice,
): string {
  const input = JSON.stringify({ city, category, amount: price.amount, currency: price.currency });
  const rateTable = JSON.stringify(MOCK_RATE_TABLE_TO_USD);

  return [
    "import json",
    "",
    `_wayfarer_rate_table = json.loads('${rateTable}')`,
    `_wayfarer_input = json.loads('${input}')`,
    "",
    // `clearContext: false` keeps Python globals alive across executeCode
    // calls in the same sandbox session — this is the Running total's actual
    // storage (CONTEXT.md), initialized once and reused on every later hold.
    "if '_wayfarer_budget_state' not in globals():",
    "    _wayfarer_budget_state = {'runningTotal': 0.0, 'byCity': {}, 'byCategory': {}}",
    "",
    "_wayfarer_currency = _wayfarer_input['currency']",
    "if _wayfarer_currency not in _wayfarer_rate_table:",
    "    raise ValueError(f\"no mock rate for currency {_wayfarer_currency}\")",
    "",
    "_wayfarer_home_amount = round(_wayfarer_input['amount'] * _wayfarer_rate_table[_wayfarer_currency], 2)",
    "_wayfarer_city = _wayfarer_input['city']",
    "_wayfarer_category = _wayfarer_input['category']",
    "",
    "_wayfarer_budget_state['runningTotal'] = round(_wayfarer_budget_state['runningTotal'] + _wayfarer_home_amount, 2)",
    "_wayfarer_budget_state['byCity'][_wayfarer_city] = round(_wayfarer_budget_state['byCity'].get(_wayfarer_city, 0.0) + _wayfarer_home_amount, 2)",
    "_wayfarer_budget_state['byCategory'][_wayfarer_category] = round(_wayfarer_budget_state['byCategory'].get(_wayfarer_category, 0.0) + _wayfarer_home_amount, 2)",
    "",
    "print(json.dumps({",
    "    'runningTotal': _wayfarer_budget_state['runningTotal'],",
    "    'breakdownByCity': _wayfarer_budget_state['byCity'],",
    "    'breakdownByCategory': _wayfarer_budget_state['byCategory'],",
    "}))",
  ].join("\n");
}

// InvokeCodeInterpreterCommand's response streams its events rather than
// returning one object — a single executeCode call produces exactly one
// event (a result or a named exception), so this reads just that first one.
async function parseInvokeResponse(response: {
  stream: AsyncIterable<CodeInterpreterStreamOutput> | undefined;
}): Promise<Result<BudgetSnapshot, BudgetError>> {
  let event: CodeInterpreterStreamOutput | undefined;
  try {
    for await (const streamEvent of response.stream ?? []) {
      event = streamEvent;
      break;
    }
  } catch (error) {
    return err(toSandboxUnavailable(error));
  }

  const namedException =
    event?.accessDeniedException ??
    event?.conflictException ??
    event?.internalServerException ??
    event?.resourceNotFoundException ??
    event?.serviceQuotaExceededException ??
    event?.throttlingException ??
    event?.validationException;
  if (namedException) {
    return err({ type: "SandboxUnavailable", message: namedException.message ?? "Code Interpreter request failed" });
  }

  const result = event?.result;
  if (!result) {
    return err({ type: "ExecutionFailed", message: "Code Interpreter returned no result" });
  }
  if (result.isError) {
    return err({ type: "ExecutionFailed", message: extractText(result) ?? "executed code raised an error" });
  }

  const stdout = result.structuredContent?.stdout ?? extractText(result);
  if (!stdout) {
    return err({ type: "ExecutionFailed", message: "executed code produced no stdout" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastNonBlankLine(stdout));
  } catch {
    return err({ type: "ExecutionFailed", message: `sandbox stdout was not valid JSON: ${stdout}` });
  }

  const snapshot = BudgetSnapshot.parse(parsed);
  if (!snapshot.ok) {
    return err({ type: "ExecutionFailed", message: snapshot.error.message });
  }
  return ok(snapshot.value);
}

function extractText(result: CodeInterpreterResult): string | undefined {
  const text = (result.content ?? [])
    .filter((block: ContentBlock) => block.type === "text" && typeof block.text === "string")
    .map((block: ContentBlock) => block.text)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function lastNonBlankLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? "";
}

function toSandboxUnavailable(error: unknown): BudgetError {
  return { type: "SandboxUnavailable", message: error instanceof Error ? error.message : String(error) };
}
