// bedrock-agentcore@0.4.3's root export ("bedrock-agentcore") points at a
// dist/src/index.js that isn't actually published — import the working
// "./runtime" subpath export instead.
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseCallerMessage } from "../domain/caller-message";
import { parseRuntimeSessionId } from "../domain/runtime-session-id";
import { respondToCallerMessage } from "../usecase/respond-to-caller-message";
import { buildConciergePorts } from "./composition-root";

const ports = buildConciergePorts();

export const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ message: z.string() }),
    process: async (request, context) => {
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

      const result = await respondToCallerMessage(ports, sessionId.value, message.value);
      if (!result.ok) {
        // A ModelError is an expected, recoverable failure — surface a safe
        // message to the Caller, not the raw (possibly sensitive) SDK detail.
        context.log.error({ modelError: result.error }, "model client failed");
        return "Sorry, I'm having trouble reaching the model right now — please try again in a moment.";
      }

      return result.value;
    },
  },
});

// bedrock-agentcore ships ESM-only, so the deployed bundle is ESM too — this is
// the ESM equivalent of a CommonJS `require.main === module` entry-point guard.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.run();
}
