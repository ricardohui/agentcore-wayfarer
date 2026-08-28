import { createServer } from "node:http";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";

const PORT = 8787;
const runtimeArn = process.env.RUNTIME_ARN;

if (!runtimeArn) {
  throw new Error(
    "RUNTIME_ARN not set — copy tools/concierge-ui/.env.example to .env and fill in the deployed Runtime ARN",
  );
}

const client = new BedrockAgentCoreClient({ region: process.env.AWS_REGION ?? "us-east-1" });

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/api/invoke") {
    res.writeHead(404).end();
    return;
  }

  const body = await readJsonBody(req);
  if (!body.ok) {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: body.error }));
    return;
  }

  const { message, sessionId } = body.value;

  try {
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: sessionId,
      contentType: "application/json",
      payload: new TextEncoder().encode(JSON.stringify({ message })),
    });
    const response = await client.send(command);
    const reply = (await response.response?.transformToString()) ?? "";
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reply }));
  } catch (error) {
    console.error("InvokeAgentRuntime failed", error);
    res
      .writeHead(502, { "content-type": "application/json" })
      .end(JSON.stringify({ error: error instanceof Error ? error.message : "invoke failed" }));
  }
});

server.listen(PORT, () => {
  console.log(`Concierge UI proxy listening on http://localhost:${PORT}`);
});

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.message !== "string" || typeof parsed.sessionId !== "string") {
          resolve({ ok: false, error: "expected { message: string, sessionId: string }" });
          return;
        }
        resolve({ ok: true, value: parsed });
      } catch {
        resolve({ ok: false, error: "invalid JSON body" });
      }
    });
  });
}
