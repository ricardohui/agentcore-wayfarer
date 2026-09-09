import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  type KnowledgeBaseRetrievalResult,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { DestinationGuideExcerpt } from "../domain/destination-guide-excerpt";
import type { KnowledgeBaseError } from "../domain/knowledge-base-error";
import { err, ok, type Result } from "../domain/result";
import type { KnowledgeBasePort } from "../usecase/ports";

// Speaks directly to Bedrock Agent Runtime's Retrieve API (issue #21 /
// ADR-0010) against the Managed Knowledge Base — no Gateway hop. No
// retrievalConfiguration or nextToken paging: a single page at the API's
// default result count matches today's behavior.
export class BedrockKnowledgeBaseAdapter implements KnowledgeBasePort {
  constructor(
    private readonly client: BedrockAgentRuntimeClient,
    private readonly knowledgeBaseId: string,
  ) {}

  async retrieve(query: string): Promise<Result<readonly DestinationGuideExcerpt[], KnowledgeBaseError>> {
    try {
      const response = await this.client.send(
        new RetrieveCommand({
          knowledgeBaseId: this.knowledgeBaseId,
          retrievalQuery: { text: query },
        }),
      );
      return parseRetrievalResults(response.retrievalResults);
    } catch (error) {
      return err(toKnowledgeBaseError(error));
    }
  }
}

function parseRetrievalResults(
  results: readonly KnowledgeBaseRetrievalResult[] | undefined,
): Result<readonly DestinationGuideExcerpt[], KnowledgeBaseError> {
  if (!results) {
    return err({ type: "MalformedResponse", message: "expected a retrievalResults array" });
  }

  const excerpts: DestinationGuideExcerpt[] = [];
  for (const item of results) {
    const result = DestinationGuideExcerpt.parse(item);
    if (!result.ok) {
      return err({ type: "MalformedResponse", message: result.error.message });
    }
    excerpts.push(result.value);
  }
  return ok(excerpts);
}

function toKnowledgeBaseError(error: unknown): KnowledgeBaseError {
  return { type: "KnowledgeBaseUnavailable", message: error instanceof Error ? error.message : String(error) };
}
