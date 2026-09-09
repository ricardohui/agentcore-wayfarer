import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
  type Event,
  type MemoryRecordSummary,
} from "@aws-sdk/client-bedrock-agentcore";
import type { ActorId } from "../domain/actor-id";
import { parseCallerMessage } from "../domain/caller-message";
import { parseCallerPreference, type CallerPreference } from "../domain/caller-preference";
import { parseConciergeReply } from "../domain/concierge-reply";
import type { ConversationTurn } from "../domain/conversation-turn";
import type { MemoryError } from "../domain/memory-error";
import { err, ok, type Result } from "../domain/result";
import type { RuntimeSessionId } from "../domain/runtime-session-id";
import { semanticPreferenceNamespace, userPreferenceNamespace } from "../memory-namespaces";
import { withSpan } from "../observability/tracing";
import type { MemoryPort } from "../usecase/ports";

// Speaks directly to AgentCore Memory's data plane (issue #16). CreateEvent
// backs scratch-state writes (also the raw material the user-preference and
// semantic Strategies mine); ListEvents is get_last_k_turns' underlying
// call — session-scoped, so a fresh runtimeSessionId sees no prior turns;
// RetrieveMemoryRecords surfaces whatever those Strategies have already
// extracted for this actor, across every session they've ever had.
export class AgentCoreMemoryAdapter implements MemoryPort {
  constructor(
    private readonly client: BedrockAgentCoreClient,
    private readonly memoryId: string,
  ) {}

  async recordTurn(
    sessionId: RuntimeSessionId,
    actorId: ActorId,
    turn: ConversationTurn,
  ): Promise<Result<void, MemoryError>> {
    return withSpan(
      "create_event",
      { "gen_ai.operation.name": "create_event", "session.id": sessionId, "actor.id": actorId },
      async () => {
        try {
          await this.client.send(
            new CreateEventCommand({
              memoryId: this.memoryId,
              actorId,
              sessionId,
              eventTimestamp: new Date(),
              payload: [
                { conversational: { role: "USER", content: { text: turn.message } } },
                { conversational: { role: "ASSISTANT", content: { text: turn.reply } } },
              ],
            }),
          );
          return ok(undefined);
        } catch (error) {
          return err(toMemoryError(error));
        }
      },
    );
  }

  async getRecentTurns(
    sessionId: RuntimeSessionId,
    actorId: ActorId,
    limit: number,
  ): Promise<Result<readonly ConversationTurn[], MemoryError>> {
    return withSpan(
      "get_last_k_turns",
      { "gen_ai.operation.name": "get_last_k_turns", "session.id": sessionId, "actor.id": actorId },
      async (span) => {
        try {
          const response = await this.client.send(
            new ListEventsCommand({
              memoryId: this.memoryId,
              actorId,
              sessionId,
              includePayloads: true,
              maxResults: limit,
            }),
          );
          const turns = parseTurns(response.events ?? []);
          span.setAttribute("memory.turns_returned", turns.length);
          return ok(turns);
        } catch (error) {
          return err(toMemoryError(error));
        }
      },
    );
  }

  async getPreferences(actorId: ActorId): Promise<Result<readonly CallerPreference[], MemoryError>> {
    return withSpan(
      "RetrieveMemoryRecords",
      {
        "gen_ai.operation.name": "retrieve_memory_records",
        "actor.id": actorId,
        "memory.strategies": "user-preference,semantic",
      },
      async (span) => {
        try {
          const [userPreference, semantic] = await Promise.all([
            this.retrieveNamespace(userPreferenceNamespace(actorId)),
            this.retrieveNamespace(semanticPreferenceNamespace(actorId)),
          ]);
          span.setAttribute("memory.user_preference_count", userPreference.length);
          span.setAttribute("memory.semantic_count", semantic.length);
          return ok([...userPreference, ...semantic]);
        } catch (error) {
          return err(toMemoryError(error));
        }
      },
    );
  }

  private async retrieveNamespace(namespace: string): Promise<readonly CallerPreference[]> {
    const response = await this.client.send(
      new RetrieveMemoryRecordsCommand({
        memoryId: this.memoryId,
        namespace,
        // This recalls everything stored for the actor in this namespace, not
        // a query-specific search — RetrieveMemoryRecords requires a query,
        // so a fixed, broad one stands in for "give me what you know". A
        // generous topK keeps a semantically-distant fact (e.g. a dietary
        // restriction) from being cut off by the API's default result count.
        searchCriteria: { searchQuery: "caller travel preferences", topK: 20 },
      }),
    );
    return parsePreferences(response.memoryRecordSummaries ?? []);
  }
}

// Each event was written by recordTurn as exactly one USER + one ASSISTANT
// conversational payload — reconstruct the pair, oldest turn first, to match
// the chronological order generateReply expects. One malformed event (a
// partial write, a foreign event written by something other than
// recordTurn) is skipped rather than discarding every other turn already
// read successfully.
function parseTurns(events: readonly Event[]): readonly ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  for (const event of [...events].reverse()) {
    const texts = new Map<string, string>();
    for (const item of event.payload ?? []) {
      const conversational = item.conversational;
      if (conversational?.role && typeof conversational.content?.text === "string") {
        texts.set(conversational.role, conversational.content.text);
      }
    }

    const userText = texts.get("USER");
    const assistantText = texts.get("ASSISTANT");
    if (!userText || !assistantText) {
      continue;
    }

    const message = parseCallerMessage(userText);
    const reply = parseConciergeReply(assistantText);
    if (!message.ok || !reply.ok) {
      continue;
    }

    turns.push({ message: message.value, reply: reply.value });
  }

  return turns;
}

function parsePreferences(summaries: readonly MemoryRecordSummary[]): readonly CallerPreference[] {
  const preferences: CallerPreference[] = [];
  for (const summary of summaries) {
    const text = summary.content?.text;
    if (typeof text !== "string") {
      continue;
    }
    const preference = parseCallerPreference(text);
    if (preference.ok) {
      preferences.push(preference.value);
    }
  }
  return preferences;
}

function toMemoryError(error: unknown): MemoryError {
  return { type: "MemoryUnavailable", message: error instanceof Error ? error.message : String(error) };
}
