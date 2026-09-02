import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";

// Only one undici MockAgent can be the global dispatcher at a time — every
// per-concern mock server (Gateway, Cognito, Calendar) registers its own
// interceptors onto this single shared agent instead of each swapping the
// dispatcher independently.
export class NetworkBoundary {
  public readonly agent: MockAgent;
  private readonly previousDispatcher: Dispatcher;

  constructor() {
    this.previousDispatcher = getGlobalDispatcher();
    this.agent = new MockAgent();
    setGlobalDispatcher(this.agent);
  }

  async close(): Promise<void> {
    await this.agent.close();
    setGlobalDispatcher(this.previousDispatcher);
  }
}
