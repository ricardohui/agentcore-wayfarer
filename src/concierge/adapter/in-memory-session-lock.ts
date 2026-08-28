import type { RuntimeSessionId } from "../domain/runtime-session-id";
import type { SessionLock } from "../usecase/ports";

export class InMemorySessionLock implements SessionLock {
  private readonly queueBySessionId = new Map<RuntimeSessionId, Promise<unknown>>();

  async runExclusive<TResult>(
    sessionId: RuntimeSessionId,
    fn: () => Promise<TResult>,
  ): Promise<TResult> {
    const previous = this.queueBySessionId.get(sessionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.queueBySessionId.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }
}
