const SESSION_ID_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

export function aSessionId(suffix: string): string {
  return `acceptance-test-session-${suffix}`.padEnd(33, "-");
}

export async function waitForHealthy(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ping`);
      if (response.ok) {
        return;
      }
    } catch {
      // server not accepting connections yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Concierge server did not become healthy in time");
}

// bedrock-agentcore@0.4.3 exposes no public stop()/close() — reach into the
// underlying Fastify instance (its documented internal field is named `_app`)
// to tear the server down between test files.
export function closeConciergeApp(app: unknown): Promise<void> {
  return (app as { _app: { close: () => Promise<void> } })._app.close();
}

export async function invoke(
  baseUrl: string,
  sessionId: string,
  message: string,
  authorizationHeader: string,
): Promise<Response> {
  return fetch(`${baseUrl}/invocations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SESSION_ID_HEADER]: sessionId,
      authorization: authorizationHeader,
    },
    body: JSON.stringify({ message }),
  });
}
