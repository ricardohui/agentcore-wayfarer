import { fetch as undiciFetch } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBaseGatewayAdapter } from "../../../src/concierge/adapter/knowledge-base-gateway-adapter";
import { GatewayMockServer } from "../support/gateway-network-boundary";
import { NetworkBoundary } from "../support/network-boundary";

// Integration coverage for the Knowledge Base connector target's wire shape
// (issue #21 / ADR-0009): the seam that turns Gateway's Retrieve response
// (retrievalResults, per AWS's `bedrock-knowledge-bases` connector contract)
// into domain-typed DestinationGuideExcerpts, and Gateway failures into a
// GatewayError — this target carries no Policy consequence, so there's no
// HoldGated-style denial mapping to cover here.
describe("KnowledgeBaseGatewayAdapter (issue #21 / ADR-0009)", () => {
  let network: NetworkBoundary;
  let gateway: GatewayMockServer;
  let adapter: KnowledgeBaseGatewayAdapter;

  beforeEach(() => {
    network = new NetworkBoundary();
    gateway = new GatewayMockServer(network.agent);
    adapter = new KnowledgeBaseGatewayAdapter(
      "https://test-gateway.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
      undiciFetch,
    );
  });

  afterEach(async () => {
    await network.close();
  });

  it("sends the query nested under retrievalQuery.text, per the connector's Retrieve input schema", async () => {
    gateway.respondToTool("Retrieve", { content: { retrievalResults: [] } });

    await adapter.retrieve("visa situation for Tokyo");

    expect(gateway.receivedToolCalls).toEqual([
      { name: "Retrieve", arguments: { retrievalQuery: { text: "visa situation for Tokyo" } } },
    ]);
  });

  it("parses retrievalResults into DestinationGuideExcerpts", async () => {
    gateway.respondToTool("Retrieve", {
      content: {
        retrievalResults: [
          {
            content: { type: "TEXT", text: "Visa on arrival for stays under 90 days." },
            location: { type: "S3", s3Location: { uri: "s3://wayfarer-destination-guides/tokyo.md" } },
            score: 0.87,
          },
        ],
      },
    });

    const result = await adapter.retrieve("visa situation for Tokyo");

    expect(result).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          text: "Visa on arrival for stays under 90 days.",
          sourceUri: "s3://wayfarer-destination-guides/tokyo.md",
          score: 0.87,
        }),
      ],
    });
  });

  it("maps a malformed retrievalResults payload to a MalformedResponse GatewayError", async () => {
    gateway.respondToTool("Retrieve", { content: { retrievalResults: "not an array" } });

    const result = await adapter.retrieve("climate in Paris");

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "MalformedResponse" }) });
  });

  it("maps a Gateway tool error to a GatewayUnavailable GatewayError", async () => {
    gateway.respondToTool("Retrieve", { isError: true, content: "Knowledge base validation failed" });

    const result = await adapter.retrieve("customs rules for New York");

    expect(result).toEqual({
      ok: false,
      error: { type: "GatewayUnavailable", message: "Knowledge base validation failed" },
    });
  });
});
