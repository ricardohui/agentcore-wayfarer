import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Response as UndiciResponse } from "undici";

// Pinned to undici's own Request/Response types, not the DOM lib's ambient
// globals — every adapter's fetch call goes through undici's own fetch (see
// the comment below) so its response type must match what callers await.
export type FetchLike = (url: string | URL, init?: UndiciRequestInit) => Promise<UndiciResponse>;

// SigV4-signs every request before sending it — the mechanism AgentCore
// Gateway's AWS_IAM authorizer requires from a caller with no OAuth token.
export function createSigV4Fetch(region: string, service: string): FetchLike {
  const signer = new SignatureV4({
    service,
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  return async (url, init = {}) => {
    const target = typeof url === "string" ? new URL(url) : url;
    const headers = normalizeHeaders(init.headers);
    headers.host = target.host;

    const request = new HttpRequest({
      method: init.method ?? "GET",
      protocol: target.protocol,
      hostname: target.hostname,
      path: target.pathname,
      query: Object.fromEntries(target.searchParams),
      headers,
      ...(target.port ? { port: Number(target.port) } : {}),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });

    const signed = await signer.sign(request);
    const signedBody = typeof signed.body === "string" ? signed.body : undefined;

    // Node's ambient global fetch is backed by a *different* undici instance
    // than the "undici" package this repo's tests use to mock the network
    // boundary (setGlobalDispatcher on one has no effect on the other) — use
    // that package's own fetch so tests actually intercept this call.
    return undiciFetch(target, {
      method: signed.method,
      headers: flattenHeaders(signed.headers),
      ...(signedBody !== undefined ? { body: signedBody } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  };
}

function normalizeHeaders(headers: UndiciRequestInit["headers"]): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return flattenHeaders(headers as Record<string, string | readonly string[]>);
}

function flattenHeaders(headers: Record<string, string | readonly string[]>): Record<string, string> {
  const flattened: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    flattened[name] = typeof value === "string" ? value : value.join(", ");
  }
  return flattened;
}
