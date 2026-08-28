import { parseCallerMessage, type CallerMessage } from "../../../src/concierge/domain/caller-message";
import { parseConciergeReply, type ConciergeReply } from "../../../src/concierge/domain/concierge-reply";
import { parseRuntimeSessionId, type RuntimeSessionId } from "../../../src/concierge/domain/runtime-session-id";

function unwrap<TValue>(result: { ok: boolean; value?: TValue }): TValue {
  if (!result.ok) {
    throw new Error("object mother received an invalid fixture value");
  }
  return result.value as TValue;
}

export function aRuntimeSessionId(suffix = "aaaa"): RuntimeSessionId {
  return unwrap(parseRuntimeSessionId(`test-session-${suffix}`.padEnd(33, "-")));
}

export function aCallerMessage(text = "Plan me a trip to Tokyo"): CallerMessage {
  return unwrap(parseCallerMessage(text));
}

export function aConciergeReply(text = "Sure, let's start with your dates."): ConciergeReply {
  return unwrap(parseConciergeReply(text));
}
