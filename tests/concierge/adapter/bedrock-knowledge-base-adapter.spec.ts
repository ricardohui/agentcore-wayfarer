import {
  AccessDeniedException,
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  ThrottlingException,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { BedrockKnowledgeBaseAdapter } from "../../../src/concierge/adapter/bedrock-knowledge-base-adapter";
import { KNOWLEDGE_BASE_ID, knowledgeBaseMock } from "../support/knowledge-base-network-boundary";

// Integration coverage for the direct bedrock-agent-runtime Retrieve call
// (issue #21 / ADR-0010): the seam that turns a Retrieve response
// (retrievalResults, per AWS's Retrieve API contract) into domain-typed
// DestinationGuideExcerpts, and SDK failures into a KnowledgeBaseError.
describe("BedrockKnowledgeBaseAdapter (issue #21 / ADR-0010)", () => {
  let adapter: BedrockKnowledgeBaseAdapter;

  beforeEach(() => {
    knowledgeBaseMock.reset();
    adapter = new BedrockKnowledgeBaseAdapter(new BedrockAgentRuntimeClient({}), KNOWLEDGE_BASE_ID);
  });

  it("sends the query nested under retrievalQuery.text, per the Retrieve input schema", async () => {
    knowledgeBaseMock.on(RetrieveCommand).resolves({ retrievalResults: [] });

    await adapter.retrieve("visa situation for Tokyo");

    const calls = knowledgeBaseMock.commandCalls(RetrieveCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      retrievalQuery: { text: "visa situation for Tokyo" },
    });
  });

  it("parses retrievalResults into DestinationGuideExcerpts", async () => {
    knowledgeBaseMock.on(RetrieveCommand).resolves({
      retrievalResults: [
        {
          content: { type: "TEXT", text: "Visa on arrival for stays under 90 days." },
          location: { type: "S3", s3Location: { uri: "s3://wayfarer-destination-guides/tokyo.md" } },
          score: 0.87,
        },
      ],
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

  it("maps a missing retrievalResults to a MalformedResponse KnowledgeBaseError", async () => {
    knowledgeBaseMock.on(RetrieveCommand).resolves({});

    const result = await adapter.retrieve("climate in Paris");

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "MalformedResponse" }) });
  });

  it("maps an item missing content.text to a MalformedResponse KnowledgeBaseError", async () => {
    knowledgeBaseMock.on(RetrieveCommand).resolves({
      retrievalResults: [{ content: { type: "TEXT" }, location: undefined, score: undefined }],
    });

    const result = await adapter.retrieve("customs rules for New York");

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ type: "MalformedResponse" }) });
  });

  it("maps a throttled Retrieve call to a KnowledgeBaseUnavailable KnowledgeBaseError", async () => {
    knowledgeBaseMock
      .on(RetrieveCommand)
      .rejects(new ThrottlingException({ message: "slow down", $metadata: {} }));

    const result = await adapter.retrieve("visa situation for Tokyo");

    expect(result).toEqual({
      ok: false,
      error: { type: "KnowledgeBaseUnavailable", message: "slow down" },
    });
  });

  it("maps an access-denied Retrieve call to a KnowledgeBaseUnavailable KnowledgeBaseError", async () => {
    knowledgeBaseMock
      .on(RetrieveCommand)
      .rejects(new AccessDeniedException({ message: "not authorized", $metadata: {} }));

    const result = await adapter.retrieve("customs rules for New York");

    expect(result).toEqual({
      ok: false,
      error: { type: "KnowledgeBaseUnavailable", message: "not authorized" },
    });
  });
});
