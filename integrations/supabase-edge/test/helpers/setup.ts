import { INSTALLATION } from "./db.ts";
import { TOKEN, type MockResolver } from "./mock-resolver.ts";
import type { SyncConfig, SyncDeps, Store } from "../../src/core/index.ts";

export const T0 = Date.parse("2026-11-03T10:00:00.000Z");

export function testConfig(mock: MockResolver, over: Partial<SyncConfig> = {}): SyncConfig {
  return {
    baseUrl: mock.baseUrl,
    token: TOKEN,
    installationId: INSTALLATION,
    pageLimit: 2,
    maxPages: 50,
    budgetMs: 60_000,
    requestTimeoutMs: 5000,
    maxRetries: 5,
    baseDelayMs: 500,
    maxDelayMs: 8000,
    reconcileDays: 0,
    ...over,
  };
}

/** Fake clock: time only moves when the engine sleeps. */
export function testDeps(store: Store, over: Partial<SyncDeps> = {}): SyncDeps & { sleeps: number[]; clock: { t: number } } {
  const clock = { t: T0 };
  const sleeps: number[] = [];
  return {
    fetch,
    store,
    now: () => clock.t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
      return Promise.resolve();
    },
    random: () => 0.5,
    ...over,
    sleeps,
    clock,
  };
}
