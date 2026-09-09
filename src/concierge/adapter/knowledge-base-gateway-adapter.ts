import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  DESTINATION_GUIDES_GATEWAY_TARGET_NAME,
  RETRIEVE_OPERATION_NAME,
} from "../../destination-guides/gateway-target-name";
import { DestinationGuideExcerpt } from "../domain/destination-guide-excerpt";
import type { GatewayError } from "../domain/gateway-error";
import { err, ok, type Result } from "../domain/result";
import type { KnowledgeBasePort } from "../usecase/ports";
import type { FetchLike } from "./sigv4-fetch";

const CLIENT_INFO = { name: "wayfarer-concierge", version: "1.0.0" };

// Speaks MCP to AgentCore Gateway's Knowledge Base connector target (issue
// #21 / ADR-0009) — the same booking Gateway BookingGatewayAdapter talks to,
// via a second, distinct target. Opens one MCP session per call, same
// tradeoff BookingGatewayAdapter makes: a destination question is a single
// retrieve, not a chatty tool-call sequence.
export class KnowledgeBaseGatewayAdapter implements KnowledgeBasePort {
  constructor(
    private readonly gatewayUrl: string,
    private readonly fetch: FetchLike,
  ) {}

  async retrieve(query: string): Promise<Result<readonly DestinationGuideExcerpt[], GatewayError>> {
    const result = await this.callTool({ retrievalQuery: { text: query } });
    if (!result.ok) {
      return result;
    }
    return parseRetrievalResults(result.value);
  }

  private async callTool(args: Record<string, unknown>): Promise<Result<unknown, GatewayError>> {
    const client = new Client(CLIENT_INFO);
    const transport = new StreamableHTTPClientTransport(new URL(this.gatewayUrl), {
      // See booking-gateway-adapter.ts's identical cast: FetchLike is pinned
      // to undici's Request/Response types, the MCP SDK's own FetchLike
      // declares against the ambient global fetch types — an upstream typing
      // mismatch, not a runtime concern.
      fetch: this.fetch as unknown as typeof fetch,
    });

    try {
      // See booking-gateway-adapter.ts's identical cast: the SDK's own
      // StreamableHTTPClientTransport doesn't satisfy Transport under
      // exactOptionalPropertyTypes — an upstream typing gap.
      await client.connect(transport as unknown as Transport);
      const response = await client.callTool({
        name: `${DESTINATION_GUIDES_GATEWAY_TARGET_NAME}___${RETRIEVE_OPERATION_NAME}`,
        arguments: args,
      });

      if (response.isError) {
        return err({ type: "GatewayUnavailable", message: extractText(response.content) });
      }
      return ok(extractJson(response.content));
    } catch (error) {
      return err({
        type: "GatewayUnavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // A close() failure must never override the try/catch's Result — see
      // booking-gateway-adapter.ts's identical reasoning.
      await client.close().catch(() => undefined);
    }
  }
}

type TextContentBlock = { readonly type: "text"; readonly text: string };

function isTextBlock(block: unknown): block is TextContentBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function extractText(content: unknown): string {
  const block = Array.isArray(content) ? content.find(isTextBlock) : undefined;
  return block?.text ?? "Gateway returned no error detail";
}

function extractJson(content: unknown): unknown {
  const block = Array.isArray(content) ? content.find(isTextBlock) : undefined;
  if (!block) {
    return content;
  }
  try {
    return JSON.parse(block.text);
  } catch {
    return block.text;
  }
}

function parseRetrievalResults(raw: unknown): Result<readonly DestinationGuideExcerpt[], GatewayError> {
  const items = (raw as { retrievalResults?: unknown } | undefined)?.retrievalResults;
  if (!Array.isArray(items)) {
    return err({ type: "MalformedResponse", message: "expected a retrievalResults array" });
  }

  const excerpts: DestinationGuideExcerpt[] = [];
  for (const item of items) {
    const result = DestinationGuideExcerpt.parse(item);
    if (!result.ok) {
      return err({ type: "MalformedResponse", message: result.error.message });
    }
    excerpts.push(result.value);
  }
  return ok(excerpts);
}
