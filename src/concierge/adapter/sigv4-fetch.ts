import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

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

    return fetch(target, {
      method: signed.method,
      headers: flattenHeaders(signed.headers),
      ...(signedBody !== undefined ? { body: signedBody } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  };
}

function normalizeHeaders(headers: RequestInit["headers"]): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return flattenHeaders(headers);
}

function flattenHeaders(headers: Record<string, string | readonly string[]>): Record<string, string> {
  const flattened: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    flattened[name] = typeof value === "string" ? value : value.join(", ");
  }
  return flattened;
}
