import { buildCalendarOAuthDeps } from "./composition-root";
import { createHandler, type FunctionUrlEvent, type FunctionUrlResponse } from "./router";

// Deps (including the two Secrets Manager fetches) are resolved once per
// cold start and reused across warm invocations, same lifecycle as the
// Concierge's own composition root.
const depsPromise = buildCalendarOAuthDeps();

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResponse> {
  const deps = await depsPromise;
  return createHandler(deps)(event);
}
