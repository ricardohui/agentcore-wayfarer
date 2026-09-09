import { describe, expect, it } from "vitest";
import { DestinationGuideExcerpt } from "../../../src/concierge/domain/destination-guide-excerpt";
import { err, ok } from "../../../src/concierge/domain/result";
import { KnowledgeBaseToolExecutor } from "../../../src/concierge/usecase/knowledge-base-tool-executor";
import { FakeKnowledgeBasePort } from "../support/fakes";
import { aRuntimeSessionId } from "../support/object-mothers";

describe("KnowledgeBaseToolExecutor", () => {
  it("dispatches a retrieve-destination-guide call to the port and serializes the excerpts", async () => {
    const port = new FakeKnowledgeBasePort();
    port.respondToRetrieveWith(
      ok([new DestinationGuideExcerpt("Visa on arrival for stays under 90 days.", "s3://bucket/tokyo.md", 0.87)]),
    );
    const executor = new KnowledgeBaseToolExecutor(port);

    const result = await executor.execute(
      { toolUseId: "call-1", name: "retrieve-destination-guide", input: { query: "visa for Tokyo" } },
      aRuntimeSessionId(),
    );

    expect(port.receivedQueries).toEqual(["visa for Tokyo"]);
    expect(result).toEqual({
      toolUseId: "call-1",
      isError: false,
      content: {
        excerpts: [{ text: "Visa on arrival for stays under 90 days.", sourceUri: "s3://bucket/tokyo.md", score: 0.87 }],
      },
    });
  });

  it("surfaces a KnowledgeBaseError from the port as a tool error result", async () => {
    const port = new FakeKnowledgeBasePort();
    port.respondToRetrieveWith(err({ type: "KnowledgeBaseUnavailable", message: "Knowledge Base timed out" }));
    const executor = new KnowledgeBaseToolExecutor(port);

    const result = await executor.execute(
      { toolUseId: "call-2", name: "retrieve-destination-guide", input: { query: "climate in Paris" } },
      aRuntimeSessionId(),
    );

    expect(result).toEqual({ toolUseId: "call-2", isError: true, content: { error: "Knowledge Base timed out" } });
  });

  it("rejects an unknown tool name without calling the port", async () => {
    const port = new FakeKnowledgeBasePort();
    const executor = new KnowledgeBaseToolExecutor(port);

    const result = await executor.execute(
      { toolUseId: "call-3", name: "delete-everything", input: {} },
      aRuntimeSessionId(),
    );

    expect(result.isError).toBe(true);
    expect(port.receivedQueries).toEqual([]);
  });

  it("rejects a call with a blank query without calling the port", async () => {
    const port = new FakeKnowledgeBasePort();
    const executor = new KnowledgeBaseToolExecutor(port);

    const result = await executor.execute(
      { toolUseId: "call-4", name: "retrieve-destination-guide", input: { query: "   " } },
      aRuntimeSessionId(),
    );

    expect(result.isError).toBe(true);
    expect(port.receivedQueries).toEqual([]);
  });
});
