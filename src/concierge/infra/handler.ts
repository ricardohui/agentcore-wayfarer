// bedrock-agentcore@0.4.3's root export ("bedrock-agentcore") points at a
// dist/src/index.js that isn't actually published — import the working
// "./runtime" subpath export instead.
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseCallerMessage } from "../domain/caller-message";
import { parseRuntimeSessionId } from "../domain/runtime-session-id";
import { respondToCallerMessage } from "../usecase/respond-to-caller-message";
import { startTracing, withSpan } from "../observability/tracing";
import { buildConciergePorts, buildJwtVerifier } from "./composition-root";

// Observability (issue #24): must run before any span is created, so this
// is the very first thing the module does.
startTracing(process.env.AWS_REGION ?? "us-east-1");

const ports = buildConciergePorts();
const jwtVerifier = buildJwtVerifier();

export const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ message: z.string() }),
    process: async (request, context) =>
      // Runtime's session span (issue #24 / ADR-0008): one span per
      // invocation, everything else (Identity's inbound-auth check, the
      // model's inference spans, every tool call) nests under it via the
      // async-hooks context manager registered in startTracing().
      withSpan(
        "InvokeAgent",
        { "session.id": context.sessionId, "gen_ai.task.input": request.message, "gen_ai.operation.name": "invoke_agent" },
        async (span) => {
          // Every path below sets gen_ai.task.output before returning —
          // including the three "safe fallback message" early-return paths
          // — not just the success path. Split telemetry's event record
          // for this span (issue #23) needs both input and output present
          // to be usable; confirmed live that a span whose reply came from
          // one of these fallbacks (auth rejected, malformed message, or a
          // ModelError) but never got an output attribute set produces an
          // event record the Evaluations judge treats as missing entirely,
          // failing the whole session's evaluation with
          // LogEventMissingException — not just skipping that one span.
          const reply = await respond();
          span.setAttribute("gen_ai.task.output", reply);
          return reply;

          async function respond(): Promise<string> {
            // Inbound auth (issue #17): AgentCore Runtime's platform-level JWT
            // authorizer rejects a missing/invalid token before this ever runs in
            // production — this check is both defense-in-depth and the only layer
            // the local invocation server (and this repo's tests) can exercise.
            const authenticated = await withSpan("Identity.InboundAuth", {}, async (authSpan) => {
              const result = await jwtVerifier.verify(context.headers.authorization);
              authSpan.setAttribute("auth.result", result.ok ? "authenticated" : "rejected");
              return result;
            });
            if (!authenticated.ok) {
              // An expected, recoverable failure — same treatment as ModelError
              // below, not a thrown crash: log the (possibly sensitive) detail
              // server-side, return a safe message, never call the usecase.
              context.log.warn({ authenticationError: authenticated.error }, "inbound authentication failed");
              return "You need to be signed in to talk to me — please try again with a valid session.";
            }
            const actorId = authenticated.value;

            const sessionId = parseRuntimeSessionId(context.sessionId);
            if (!sessionId.ok) {
              // AgentCore Runtime guarantees a >=33 char session id on every invocation —
              // a violation here means the platform contract broke, not a Caller mistake.
              throw new Error(`invalid runtimeSessionId from platform: ${sessionId.error.message}`);
            }

            const message = parseCallerMessage(request.message);
            if (!message.ok) {
              return "I didn't catch that — could you say something?";
            }

            const result = await respondToCallerMessage(ports, sessionId.value, actorId, message.value);
            if (!result.ok) {
              // A ModelError is an expected, recoverable failure — surface a safe
              // message to the Caller, not the raw (possibly sensitive) SDK detail.
              context.log.error({ modelError: result.error }, "model client failed");
              return "Sorry, I'm having trouble reaching the model right now — please try again in a moment.";
            }

            return result.value;
          }
        },
      ),
  },
});

// bedrock-agentcore ships ESM-only, so the deployed bundle is ESM too — this is
// the ESM equivalent of a CommonJS `require.main === module` entry-point guard.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.run();
}
