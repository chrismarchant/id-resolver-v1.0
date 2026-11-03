import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSync, type Store } from "../src/core/index.ts";
import { INSTALLATION, PgStore, asRole, counts, gapRows, newPool, resetDatabase, storedCursor, truncateAll } from "./helpers/db.ts";
import { MemoryStore } from "./helpers/memory-store.ts";
import { MockResolver, obs, tomb } from "./helpers/mock-resolver.ts";
import { T0, testConfig, testDeps } from "./helpers/setup.ts";

let pool: pg.Pool;
const mock = new MockResolver();
let store: PgStore;

beforeAll(async () => {
  pool = newPool();
  await resetDatabase(pool);
  await mock.start();
  store = new PgStore(pool);
});
afterAll(async () => {
  await mock.stop();
  await pool.end();
});
beforeEach(async () => {
  mock.reset();
  await truncateAll(pool);
});

const D = "2026-11-02T12:00:00.000Z";

describe("initial sync", () => {
  it("pulls multiple pages from an empty cursor and stores the last cursor", async () => {
    mock.items = [1, 2, 3, 4, 5].map((i) => obs(i, 100 + (i % 2), D));
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r).toMatchObject({ status: "ok", pages: 3, observations: 5, tombstones: 0 });
    expect(await counts(pool)).toEqual({ companies: 2, observations: 5, tombstones: 0 });
    expect(await storedCursor(pool)).toBe("c5");
    // First request had no cursor; later ones continued from the stored cursor.
    expect(mock.requests.map((q) => q.query.get("after"))).toEqual([null, "c2", "c4"]);
    // A second run is an empty page and changes nothing.
    const again = await runSync(testConfig(mock), testDeps(store));
    expect(again).toMatchObject({ status: "ok", observations: 0 });
    expect(await counts(pool)).toMatchObject({ observations: 5 });
  });

  it("stops with partial when maxPages is reached and resumes next run", async () => {
    mock.items = [1, 2, 3, 4, 5].map((i) => obs(i, 7, D));
    const r1 = await runSync(testConfig(mock, { maxPages: 2 }), testDeps(store));
    expect(r1).toMatchObject({ status: "partial", pages: 2 });
    expect(await storedCursor(pool)).toBe("c4");
    const r2 = await runSync(testConfig(mock, { maxPages: 2 }), testDeps(store));
    expect(r2.status).toBe("ok");
    expect((await counts(pool)).observations).toBe(5);
  });
});

describe("idempotency", () => {
  it("handles duplicates within a page and across pages, and full replays", async () => {
    mock.items = [obs(1, 5, D), obs(1, 5, D), obs(2, 5, D), obs(3, 6, D), obs(2, 5, D), obs(4, 6, D)];
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r.status).toBe("ok");
    expect(r.observations).toBe(4); // distinct observation ids only
    expect(await counts(pool)).toEqual({ companies: 2, observations: 4, tombstones: 0 });
    // Operator resync replays the whole stream: still 4 rows.
    await asRole(pool, "service_role", (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION]));
    const replay = await runSync(testConfig(mock), testDeps(store));
    expect(replay).toMatchObject({ status: "ok", observations: 0 });
    expect((await counts(pool)).observations).toBe(4);
  });
});

describe("crash and atomicity", () => {
  it("a crash right after apply loses nothing and duplicates nothing", async () => {
    mock.items = [1, 2, 3, 4].map((i) => obs(i, 9, D));
    let applies = 0;
    const crashy: Store = {
      getState: () => store.getState(),
      recordStatus: (a) => store.recordStatus(a),
      localCounts: (a, b) => store.localCounts(a, b),
      resetCursor: (c) => store.resetCursor(c),
      recordGap: (k) => store.recordGap(k),
      resolveGaps: (c) => store.resolveGaps(c),
      applyPage: async (a) => {
        const out = await store.applyPage(a);
        if (++applies === 1) throw new Error("process died after apply");
        return out;
      },
    };
    const r1 = await runSync(testConfig(mock), testDeps(crashy));
    expect(r1.status).toBe("store_error");
    // The apply and the cursor advance were one transaction.
    expect(await storedCursor(pool)).toBe("c2");
    expect((await counts(pool)).observations).toBe(2);
    const r2 = await runSync(testConfig(mock), testDeps(store));
    expect(r2.status).toBe("ok");
    expect((await counts(pool)).observations).toBe(4);
    expect(mock.requests.map((q) => q.query.get("after"))).toEqual([null, "c2"]);
  });

  it("applying and cursor advance roll back together", async () => {
    await expect(
      asRole(pool, "service_role", async (c) => {
        await c.query("select public.idr_apply_feed_page($1,null,'c1',$2::jsonb,null)", [INSTALLATION, JSON.stringify([obs(1, 3, D)])]);
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow();
    expect(await counts(pool)).toEqual({ companies: 0, observations: 0, tombstones: 0 });
    expect(await storedCursor(pool)).toBeNull();
  });

  it("a stale expected cursor changes nothing (CAS)", async () => {
    const a = await store.applyPage({ expectedCursor: null, expectedResetFrom: null, nextCursor: "c1", items: [obs(1, 3, D)] as never });
    expect(a.applied).toBe(true);
    const stale = await store.applyPage({ expectedCursor: null, expectedResetFrom: null, nextCursor: "c1", items: [obs(2, 3, D)] as never });
    expect(stale.applied).toBe(false);
    const wrong = await store.applyPage({ expectedCursor: "c9", expectedResetFrom: null, nextCursor: "c10", items: [obs(3, 3, D)] as never });
    expect(wrong.applied).toBe(false);
    expect((await counts(pool)).observations).toBe(1);
    expect(await storedCursor(pool)).toBe("c1");
  });

  it("concurrent invocations: exactly one wins the first page, the loser stops", async () => {
    mock.items = [1, 2, 3, 4, 5, 6].map((i) => obs(i, 4, D));
    // Barrier so both invocations read the same (empty) cursor before either applies.
    let waiting = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const barrier: Store = {
      getState: async () => {
        const s = await store.getState();
        if (++waiting === 2) release();
        await gate;
        return s;
      },
      applyPage: (a) => store.applyPage(a),
      recordStatus: (a) => store.recordStatus(a),
      localCounts: (a, b) => store.localCounts(a, b),
      resetCursor: (c) => store.resetCursor(c),
      recordGap: (k) => store.recordGap(k),
      resolveGaps: (c) => store.resolveGaps(c),
    };
    const [a, b] = await Promise.all([runSync(testConfig(mock), testDeps(barrier)), runSync(testConfig(mock), testDeps(barrier))]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["cas_conflict", "ok"]);
    expect(await counts(pool)).toMatchObject({ observations: 6 });
    expect(await storedCursor(pool)).toBe("c6");
  });
});

describe("tombstones", () => {
  it("deletes the company and its observations, and is idempotent", async () => {
    mock.items = [obs(1, 7, D), obs(2, 8, D), obs(3, 7, D), tomb(1, 7), obs(4, 8, D)];
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r).toMatchObject({ status: "ok", tombstones: 1 });
    expect(await counts(pool)).toEqual({ companies: 1, observations: 2, tombstones: 1 });
    const left = await pool.query("select distinct company_id from public.idr_observations");
    expect(left.rows).toEqual([{ company_id: "8" }]);
    // Replaying the whole stream re-applies the tombstone: same end state.
    await asRole(pool, "service_role", (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION]));
    await runSync(testConfig(mock), testDeps(store));
    expect(await counts(pool)).toEqual({ companies: 1, observations: 2, tombstones: 1 });
  });
});

describe("backoff and budget", () => {
  beforeEach(() => {
    mock.items = [1, 2].map((i) => obs(i, 3, D));
  });

  it("honours Retry-After on 429", async () => {
    mock.overrides = [{ status: 429, headers: { "retry-after": "2" } }];
    const deps = testDeps(store);
    const r = await runSync(testConfig(mock), deps);
    expect(r.status).toBe("ok");
    expect(deps.sleeps).toEqual([2000]);
  });

  it("honours an HTTP-date Retry-After", async () => {
    const at = new Date(T0 + 3000).toUTCString();
    mock.overrides = [{ status: 429, headers: { "retry-after": at } }];
    const deps = testDeps(store);
    await runSync(testConfig(mock), deps);
    expect(deps.sleeps).toEqual([3000]);
  });

  it("uses bounded exponential backoff on 5xx and a network error", async () => {
    mock.overrides = [{ status: 503 }, { status: 500 }];
    const deps = testDeps(store);
    let first = true;
    deps.fetch = ((...a: Parameters<typeof fetch>) => {
      if (first) {
        first = false;
        return Promise.reject(new TypeError("network down"));
      }
      return fetch(...a);
    }) as typeof fetch;
    const r = await runSync(testConfig(mock), deps);
    expect(r.status).toBe("ok");
    // random=0.5 -> 0.75 * min(maxDelay, 500 * 2^n)
    expect(deps.sleeps).toEqual([375, 750, 1500]);
  });

  it("caps each delay at maxDelayMs", async () => {
    mock.overrides = Array.from({ length: 5 }, () => ({ status: 502 }));
    const deps = testDeps(store);
    const r = await runSync(testConfig(mock, { maxDelayMs: 1000, maxRetries: 5 }), deps);
    expect(r.status).toBe("ok");
    expect(Math.max(...deps.sleeps)).toBeLessThanOrEqual(1000);
  });

  it("gives up with upstream_error when retries or the budget run out, without sleeping past the budget", async () => {
    mock.overrides = Array.from({ length: 30 }, () => ({ status: 503 }));
    const deps = testDeps(store);
    const r = await runSync(testConfig(mock, { budgetMs: 1000 }), deps);
    expect(r.status).toBe("upstream_error");
    expect(deps.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(1000);
    expect(await storedCursor(pool)).toBeNull();
  });

  it("stops rate_limited when Retry-After exceeds the remaining budget", async () => {
    mock.overrides = [{ status: 429, headers: { "retry-after": "600" } }];
    const deps = testDeps(store);
    const r = await runSync(testConfig(mock, { budgetMs: 10_000 }), deps);
    expect(r.status).toBe("rate_limited");
    expect(deps.sleeps).toEqual([]);
    expect(await storedCursor(pool)).toBeNull();
  });

  it("stops after maxRetries consecutive failures", async () => {
    mock.overrides = Array.from({ length: 30 }, () => ({ status: 500 }));
    const deps = testDeps(store);
    const r = await runSync(testConfig(mock, { maxRetries: 2 }), deps);
    expect(r.status).toBe("upstream_error");
    expect(deps.sleeps.length).toBe(2);
  });
});

describe("terminal statuses never advance the cursor", () => {
  it("410 cursor_expired -> needs_resync and a recorded gap, cursor unchanged, no further fetches", async () => {
    mock.items = [1, 2, 3, 4].map((i) => obs(i, 3, D));
    await runSync(testConfig(mock, { maxPages: 1 }), testDeps(store));
    expect(await storedCursor(pool)).toBe("c2");
    mock.retentionFloor = 3; // buffer was pruned past our cursor
    mock.requests = [];
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r.status).toBe("needs_resync");
    expect(r.gap).toEqual({ recorded: true, newGap: true, superseded: false, needsResync: true });
    expect(await storedCursor(pool)).toBe("c2");
    expect((await counts(pool)).observations).toBe(2);
    const st = await pool.query("select status, needs_resync from public.idr_sync_state");
    expect(st.rows[0]).toEqual({ status: "needs_resync", needs_resync: true });
    expect((await gapRows(pool)).map((g) => [g.kind, g.expired_cursor, g.resolved_at])).toEqual([["cursor_expired", "c2", null]]);
    // Flagged: later runs do not call the resolver at all until an operator resyncs.
    mock.requests = [];
    const again = await runSync(testConfig(mock), testDeps(store));
    expect(again.status).toBe("needs_resync");
    expect(mock.requests.length).toBe(0);
    // Operator resync restarts from the start of the buffer.
    await asRole(pool, "service_role", (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION]));
    const ok = await runSync(testConfig(mock), testDeps(store));
    expect(ok.status).toBe("ok");
    expect(ok.gapsResolved).toBe(1);
    // Observations 1-2 kept; 3 was pruned before we saw it (the loss the gap record is for); 4 arrives.
    expect((await counts(pool)).observations).toBe(3);
    // The gap record survives the resync: resolved (rebuilt), not erased.
    const [gap] = await gapRows(pool);
    expect(gap).toMatchObject({ kind: "cursor_expired", resolution: "full_resync" });
    expect(gap!.resolved_at).toBeInstanceOf(Date);
  });

  it("401/403 -> auth_failed with no retry", async () => {
    const deps = testDeps(store);
    const r = await runSync(testConfig(mock, { token: "wrong-wrong-wrong-wrong" }), deps);
    expect(r.status).toBe("auth_failed");
    expect(mock.requests.length).toBe(1);
    mock.overrides = [{ status: 403 }];
    const r2 = await runSync(testConfig(mock), deps);
    expect(r2.status).toBe("auth_failed");
    expect(await storedCursor(pool)).toBeNull();
  });

  it("rejects a page for another installation or a malformed page", async () => {
    mock.items = [obs(1, 3, D)];
    mock.installationId = "someone_else";
    expect((await runSync(testConfig(mock), testDeps(store))).status).toBe("contract_error");
    mock.installationId = INSTALLATION;
    mock.items = [obs(1, 3, "not-a-date")];
    expect((await runSync(testConfig(mock), testDeps(store))).status).toBe("contract_error");
    expect(await storedCursor(pool)).toBeNull();
    expect((await counts(pool)).observations).toBe(0);
  });

  it("drops unknown item types and never forwards unknown fields", async () => {
    mock.items = [{ type: "future_thing", x: 1 }, obs(1, 3, D, { ip: "192.0.2.1", secret: "x" })];
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r.status).toBe("ok");
    const row = await pool.query("select to_jsonb(o) as j from public.idr_observations o");
    expect(JSON.stringify(row.rows[0])).not.toContain("192.0.2.1");
  });
});

describe("continuity gaps (410 cursor_expired is a potential gap, never a recovery)", () => {
  const setupStalled = async (s: Store) => {
    mock.items = [1, 2, 3, 4, 5, 6].map((i) => obs(i, 3, D));
    expect((await runSync(testConfig(mock, { maxPages: 1 }), testDeps(s))).status).toBe("partial");
    mock.retentionFloor = 4; // obs 3, 4 pruned before they were pulled
  };

  it("PG: 410 records exactly one gap together with needs_resync, bounded by the stored state", async () => {
    await setupStalled(store);
    const before = await pool.query<{ last_applied_at: Date }>("select last_applied_at from public.idr_sync_state");
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r).toMatchObject({ status: "needs_resync", gap: { recorded: true, newGap: true }, gapsResolved: 0 });
    const gaps = await gapRows(pool);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ installation_id: INSTALLATION, kind: "cursor_expired", expired_cursor: "c2", resolved_at: null, resolution: null });
    expect(gaps[0]!.last_applied_at).toEqual(before.rows[0]!.last_applied_at);
    expect(gaps[0]!.last_observed_at).toEqual(new Date(D));
    const st = await pool.query("select status, needs_resync from public.idr_sync_state");
    expect(st.rows[0]).toEqual({ status: "needs_resync", needs_resync: true });
  });

  it("PG: repeated runs and a direct retry never add a second open gap", async () => {
    await setupStalled(store);
    for (let i = 0; i < 3; i++) {
      const r = await runSync(testConfig(mock), testDeps(store));
      expect(r.status).toBe("needs_resync");
      expect(r.gap).toEqual({ recorded: true, newGap: i === 0, superseded: false, needsResync: true });
    }
    // A retry of the record itself (e.g. after a crash before the response arrived).
    const again = { kind: "cursor_expired" as const, expectedCursor: "c2" };
    expect(await store.recordGap(again)).toEqual({ recorded: true, newGap: false, superseded: false, needsResync: true });
    // Concurrent records serialise on the state row and the partial unique index.
    await Promise.all([store.recordGap(again), store.recordGap(again), store.recordGap(again)]);
    expect(await gapRows(pool)).toHaveLength(1);
  });

  it("PG: begin_resync then a drained run resolves the gap; the row persists; a partial replay does not resolve it", async () => {
    await setupStalled(store);
    expect((await runSync(testConfig(mock), testDeps(store))).status).toBe("needs_resync");
    mock.items.push(obs(7, 3, D), obs(8, 3, D)); // retained: 5-8, two pages
    await asRole(pool, "service_role", (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION]));
    // The replay needs several runs: not drained yet -> still open.
    const part = await runSync(testConfig(mock, { maxPages: 1 }), testDeps(store));
    expect(part).toMatchObject({ status: "partial", gapsResolved: 0 });
    expect((await gapRows(pool))[0]!.resolved_at).toBeNull();
    const done = await runSync(testConfig(mock), testDeps(store));
    expect(done).toMatchObject({ status: "ok", gapsResolved: 1 });
    const gaps = await gapRows(pool);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ resolution: "full_resync" });
    expect(gaps[0]!.resolved_at).toBeInstanceOf(Date);
    // Obs 3 and 4 are permanently absent: resolved_at is the rebuild, not a recovery.
    const ids = await pool.query<{ id: string }>("select observation_id::text as id from public.idr_observations order by 1");
    expect(ids.rows.map((r) => r.id)).toEqual(["1", "2", "5", "6", "7", "8"]);
    // Later runs resolve nothing more; a new expiry opens a new, separate gap.
    expect((await runSync(testConfig(mock), testDeps(store))).gapsResolved).toBe(0);
    mock.items.push(obs(9, 3, D), obs(10, 3, D), obs(11, 3, D));
    expect(await storedCursor(pool)).toBe("c8"); // obs 9 is pruned before the next run
    mock.retentionFloor = 10;
    expect((await runSync(testConfig(mock), testDeps(store))).status).toBe("needs_resync");
    const after = await gapRows(pool);
    expect(after).toHaveLength(2);
    expect(after.map((g) => g.resolved_at === null)).toEqual([false, true]);
  });

  it("PG: a gap is not resolved by a drain without a resync request after it", async () => {
    await setupStalled(store);
    expect((await runSync(testConfig(mock), testDeps(store))).status).toBe("needs_resync");
    // Someone clears the flag by hand instead of calling idr_begin_resync.
    await pool.query("update public.idr_sync_state set needs_resync = false, cursor = null");
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r).toMatchObject({ status: "ok", gapsResolved: 0 });
    expect((await gapRows(pool))[0]!.resolved_at).toBeNull();
  });

  it("PG: if recording the gap fails, the run still ends needs_resync (gap.recorded=false) and the next run records it", async () => {
    await setupStalled(store);
    const failing: Store = {
      getState: () => store.getState(),
      applyPage: (a) => store.applyPage(a),
      recordStatus: (a) => store.recordStatus(a),
      localCounts: (a, b) => store.localCounts(a, b),
      resetCursor: (c) => store.resetCursor(c),
      recordGap: async () => {
        throw new Error("rpc failed");
      },
      resolveGaps: (c) => store.resolveGaps(c),
    };
    const r = await runSync(testConfig(mock), testDeps(failing));
    expect(r).toMatchObject({ status: "needs_resync", gap: { recorded: false, newGap: false } });
    expect(await gapRows(pool)).toHaveLength(0);
    const st = await pool.query("select status, needs_resync from public.idr_sync_state");
    expect(st.rows[0]).toEqual({ status: "needs_resync", needs_resync: true });
    mock.requests = [];
    const again = await runSync(testConfig(mock), testDeps(store));
    expect(again).toMatchObject({ status: "needs_resync", gap: { recorded: true, newGap: true } });
    expect(mock.requests).toHaveLength(0); // flagged: no fetch, only the record
    expect(await gapRows(pool)).toHaveLength(1);
  });

  it("PG R2-7: a stale overlapping run that gets 410 for an older cursor records nothing, ends cas_conflict and leaves the healthy state untouched", async () => {
    mock.items = [1, 2, 3, 4, 5, 6].map((i) => obs(i, 3, D));
    expect((await runSync(testConfig(mock, { maxPages: 1 }), testDeps(store))).status).toBe("partial");
    expect(await storedCursor(pool)).toBe("c2");
    // Another run drains: everything is delivered and the stored cursor is c6.
    expect((await runSync(testConfig(mock), testDeps(store))).status).toBe("ok");
    expect(await storedCursor(pool)).toBe("c6");
    const healthy = (await pool.query("select cursor, status, needs_resync, last_run_at from public.idr_sync_state")).rows[0];
    mock.retentionFloor = 3; // retention passes c2, which only the stale run still holds
    const stale: Store = {
      getState: async () => ({ ...(await store.getState()), cursor: "c2" }), // read before the other run advanced
      applyPage: (a) => store.applyPage(a),
      recordStatus: (a) => store.recordStatus(a),
      localCounts: (a, b) => store.localCounts(a, b),
      resetCursor: (c) => store.resetCursor(c),
      recordGap: (a) => store.recordGap(a),
      resolveGaps: (c) => store.resolveGaps(c),
    };
    mock.requests = [];
    const r = await runSync(testConfig(mock), testDeps(stale));
    expect(mock.requests.map((q) => q.query.get("after"))).toEqual(["c2"]); // it did get the 410
    expect(r).toMatchObject({ status: "cas_conflict", gap: null });
    expect(await gapRows(pool)).toHaveLength(0);
    expect((await pool.query("select cursor, status, needs_resync, last_run_at from public.idr_sync_state")).rows[0]).toEqual(healthy);
    expect((await runSync(testConfig(mock), testDeps(store))).status).toBe("ok");
  });

  it("PG R2-6: recording fails once and the operator resyncs before the retry: exactly one gap row survives the resync (scenario E)", async () => {
    await setupStalled(store);
    let fail = true;
    const flaky: Store = {
      getState: () => store.getState(),
      applyPage: (a) => store.applyPage(a),
      recordStatus: (a) => store.recordStatus(a),
      localCounts: (a, b) => store.localCounts(a, b),
      resetCursor: (c) => store.resetCursor(c),
      recordGap: async (a) => {
        if (fail) {
          fail = false;
          throw new Error("rpc down");
        }
        return store.recordGap(a);
      },
      resolveGaps: (c) => store.resolveGaps(c),
    };
    const r1 = await runSync(testConfig(mock), testDeps(flaky));
    expect(r1).toMatchObject({ status: "needs_resync", gap: { recorded: false } });
    expect(await gapRows(pool)).toHaveLength(0); // only the needs_resync flag is durable
    await asRole(pool, "service_role", (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION])); // the operator acts first
    const gaps = await gapRows(pool);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "cursor_expired", expired_cursor: "c2" });
    const r2 = await runSync(testConfig(mock), testDeps(store));
    expect(r2).toMatchObject({ status: "ok", gapsResolved: 1 });
    expect(await gapRows(pool)).toHaveLength(1);
  });

  it("in-memory store: the same lifecycle (record once, survive the resync, resolve after the drain)", async () => {
    const mem = new MemoryStore();
    await setupStalled(mem);
    for (let i = 0; i < 2; i++) expect((await runSync(testConfig(mock), testDeps(mem))).status).toBe("needs_resync");
    expect(mem.gaps).toHaveLength(1);
    expect(await mem.recordGap({ kind: "cursor_expired", expectedCursor: "c0" })).toEqual({ recorded: false, newGap: false, superseded: true, needsResync: false });
    expect(mem.gaps[0]).toMatchObject({ kind: "cursor_expired", expiredCursor: "c2", resolvedAt: null });
    expect(mem.needsResync).toBe(true);
    mem.beginResync();
    const r = await runSync(testConfig(mock), testDeps(mem));
    expect(r).toMatchObject({ status: "ok", gapsResolved: 1 });
    expect(mem.gaps).toHaveLength(1);
    expect(mem.gaps[0]).toMatchObject({ resolution: "full_resync" });
    expect([...mem.observations.keys()].sort()).toEqual(["1", "2", "5", "6"]);
  });
});

describe("voluntary resync (idr_begin_resync without needs_resync) re-checks the old position first", () => {
  const begin = () => asRole(pool, "service_role", (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION]));
  const st = async () =>
    (
      await pool.query<{ cursor: string | null; reset_from_cursor: string | null; needs_resync: boolean }>(
        "select cursor, reset_from_cursor, needs_resync from public.idr_sync_state where installation_id = $1",
        [INSTALLATION],
      )
    ).rows[0];
  const projectedIds = async () => (await pool.query<{ id: string }>("select observation_id::text as id from public.idr_observations order by observation_id")).rows.map((r) => r.id);
  /** Consumer at c2 of obs 1-6. */
  const stalledAtC2 = async (s: Store) => {
    mock.items = [1, 2, 3, 4, 5, 6].map((i) => obs(i, 3, D));
    expect((await runSync(testConfig(mock, { maxPages: 1 }), testDeps(s))).status).toBe("partial");
  };

  it("from a cursor behind the watermark: the next run records exactly one gap, continues the requested replay, and the gap resolves after the drain", async () => {
    await stalledAtC2(store);
    mock.retentionFloor = 4; // obs 3, 4 pruned: c2 is expired, but nobody has asked the resolver yet
    await begin(); // voluntary: needs_resync was false
    expect(await st()).toEqual({ cursor: null, reset_from_cursor: "c2", needs_resync: false });
    mock.requests = [];
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(mock.requests.map((q) => q.query.get("after"))).toEqual(["c2", null]);
    expect(r).toMatchObject({ status: "ok", gap: { recorded: true, newGap: true, needsResync: false }, gapsResolved: 1 });
    const gaps = await gapRows(pool);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "cursor_expired", expired_cursor: "c2", detected_generation: 0, resolution: "full_resync" });
    expect(await st()).toEqual({ cursor: "c6", reset_from_cursor: null, needs_resync: false });
    expect(await projectedIds()).toEqual(["1", "2", "5", "6"]); // 3, 4 missing, and on record
    expect((await runSync(testConfig(mock), testDeps(store))).status).toBe("ok");
    expect(await gapRows(pool)).toHaveLength(1);
  });

  it("from a cursor within retention: the re-check is served (200), no gap, a normal replay (status ok)", async () => {
    await stalledAtC2(store);
    await begin();
    mock.requests = [];
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(mock.requests.map((q) => q.query.get("after"))).toEqual(["c2", null, "c2", "c4"]);
    expect(r).toMatchObject({ status: "ok", gap: null, gapsResolved: 0 });
    expect(await gapRows(pool)).toHaveLength(0);
    expect(await st()).toEqual({ cursor: "c6", reset_from_cursor: null, needs_resync: false });
  });

  it("a resync with needs_resync set does not re-check (the gap is already on record) and does not loop", async () => {
    await stalledAtC2(store);
    mock.retentionFloor = 4;
    expect((await runSync(testConfig(mock), testDeps(store))).status).toBe("needs_resync");
    await begin();
    expect(await st()).toEqual({ cursor: null, reset_from_cursor: null, needs_resync: false });
    mock.requests = [];
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(mock.requests[0]!.query.get("after")).toBeNull(); // straight to the replay
    expect(r).toMatchObject({ status: "ok", gapsResolved: 1 });
    expect((await runSync(testConfig(mock), testDeps(store))).status).toBe("ok");
    expect(await gapRows(pool)).toHaveLength(1);
  });

  it("race: a run in flight with the old cursor gets its 410 after a voluntary resync -> the gap is recorded (against the kept position) without halting", async () => {
    await stalledAtC2(store);
    mock.retentionFloor = 4;
    const seen = await store.getState(); // the in-flight run read cursor c2 before the resync
    await begin();
    const inFlight: Store = {
      getState: async () => seen,
      applyPage: (a) => store.applyPage(a),
      recordStatus: (a) => store.recordStatus(a),
      localCounts: (a, b) => store.localCounts(a, b),
      resetCursor: (c) => store.resetCursor(c),
      recordGap: (a) => store.recordGap(a),
      resolveGaps: (c) => store.resolveGaps(c),
    };
    const r = await runSync(testConfig(mock), testDeps(inFlight));
    expect(r).toMatchObject({ status: "cas_conflict", gap: { recorded: true, newGap: true, needsResync: false } });
    expect(await st()).toEqual({ cursor: null, reset_from_cursor: null, needs_resync: false });
    const next = await runSync(testConfig(mock), testDeps(store)); // the requested replay
    expect(next).toMatchObject({ status: "ok", gapsResolved: 1 });
    expect(await gapRows(pool)).toHaveLength(1);
  });

  it("race: the next run's re-check records the gap first; the in-flight run's later 410 is superseded and adds nothing", async () => {
    await stalledAtC2(store);
    mock.retentionFloor = 4;
    const seen = await store.getState();
    await begin();
    const next = await runSync(testConfig(mock), testDeps(store)); // re-check -> 410 -> record, replay, drain
    expect(next).toMatchObject({ status: "ok", gap: { recorded: true, newGap: true }, gapsResolved: 1 });
    const inFlight: Store = {
      getState: async () => seen,
      applyPage: (a) => store.applyPage(a),
      recordStatus: (a) => store.recordStatus(a),
      localCounts: (a, b) => store.localCounts(a, b),
      resetCursor: (c) => store.resetCursor(c),
      recordGap: (a) => store.recordGap(a),
      resolveGaps: (c) => store.resolveGaps(c),
    };
    const late = await runSync(testConfig(mock), testDeps(inFlight));
    expect(late).toMatchObject({ status: "cas_conflict", gap: null });
    const gaps = await gapRows(pool);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ expired_cursor: "c2", resolution: "full_resync" });
    expect((await st())!.needs_resync).toBe(false);
  });

  it("a failed record of the re-check leaves the old position set; the next run re-checks and records it", async () => {
    await stalledAtC2(store);
    mock.retentionFloor = 4;
    await begin();
    const failing: Store = {
      getState: () => store.getState(),
      applyPage: (a) => store.applyPage(a),
      recordStatus: (a) => store.recordStatus(a),
      localCounts: (a, b) => store.localCounts(a, b),
      resetCursor: (c) => store.resetCursor(c),
      recordGap: async () => {
        throw new Error("rpc down");
      },
      resolveGaps: (c) => store.resolveGaps(c),
    };
    expect((await runSync(testConfig(mock), testDeps(failing))).status).toBe("store_error");
    expect(await st()).toEqual({ cursor: null, reset_from_cursor: "c2", needs_resync: false }); // nothing replayed, evidence kept
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r).toMatchObject({ status: "ok", gap: { recorded: true, newGap: true }, gapsResolved: 1 });
    expect(await gapRows(pool)).toHaveLength(1);
  });

  it("in-memory store: voluntary resync from an expired position records one gap and resolves it after the drain", async () => {
    const mem = new MemoryStore();
    await stalledAtC2(mem);
    mock.retentionFloor = 4;
    mem.beginResync();
    expect(mem.resetFromCursor).toBe("c2");
    const r = await runSync(testConfig(mock), testDeps(mem));
    expect(r).toMatchObject({ status: "ok", gap: { recorded: true, newGap: true, needsResync: false }, gapsResolved: 1 });
    expect(mem.gaps).toHaveLength(1);
    expect(mem.gaps[0]).toMatchObject({ expiredCursor: "c2", resolution: "full_resync" });
    expect(mem.needsResync).toBe(false);
  });
});

describe("reconciliation", () => {
  it("passes when the projection matches the summary, flags a mismatch otherwise", async () => {
    mock.items = [obs(1, 3, "2026-11-02T01:00:00.000Z"), obs(2, 3, "2026-11-02T05:00:00.000Z"), obs(3, 4, "2026-11-01T23:59:59.000Z")];
    const cfg = testConfig(mock, { reconcileDays: 3 });
    const ok = await runSync(cfg, testDeps(store));
    expect(ok).toMatchObject({ status: "ok", reconcile: { checked: true, matched: true, from: "2026-10-31", to: "2026-11-02" } });

    // Projection drifts (a row lost): the next run reports a mismatch and records it.
    await pool.query("delete from public.idr_observations where observation_id = 2");
    const bad = await runSync(cfg, testDeps(store));
    expect(bad.status).toBe("reconcile_mismatch");
    expect(bad.reconcile).toMatchObject({ checked: true, matched: false });
    const st = await pool.query("select status from public.idr_sync_state");
    expect(st.rows[0].status).toBe("reconcile_mismatch");
    // Cursor was not touched by the reconciliation.
    expect(await storedCursor(pool)).toBe("c3");
  });

  it("does not reconcile when the run was not drained", async () => {
    mock.items = [1, 2, 3].map((i) => obs(i, 3, "2026-11-02T01:00:00.000Z"));
    const r = await runSync(testConfig(mock, { reconcileDays: 2, maxPages: 1 }), testDeps(store));
    expect(r.status).toBe("partial");
    expect(r.reconcile).toBeNull();
  });
});

describe("rejected cursor (resolver cursor-key rotation)", () => {
  const cfg = () => testConfig(mock, { pageLimit: 2 });
  const resetFromCursor = async () =>
    (await pool.query<{ r: string | null }>("select reset_from_cursor as r from public.idr_sync_state where installation_id = $1", [INSTALLATION])).rows[0]?.r ?? null;
  /** fetch that answers 503 to the first request WITHOUT a cursor (the replay start), once. */
  const failFirstCursorless = (): typeof fetch => {
    let failed = false;
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (!failed && u.pathname.endsWith("/observations") && !u.searchParams.has("after")) {
        failed = true;
        return new Response("", { status: 503 });
      }
      return fetch(url, init);
    }) as typeof fetch;
  };
  /** Consumer at c2 of obs 1-5, then the resolver's key rotates and the replay start fails once. */
  const resetButReplayFailed = async () => {
    mock.items = [1, 2, 3, 4, 5].map((i) => obs(i, 7, D));
    expect((await runSync(testConfig(mock, { maxPages: 1 }), testDeps(store))).status).toBe("partial");
    expect(await storedCursor(pool)).toBe("c2");
    mock.cursorPrefix = "k2";
    mock.requests = [];
    const r = await runSync(testConfig(mock, { maxRetries: 0 }), testDeps(store, { fetch: failFirstCursorless() }));
    expect(r.status).toBe("upstream_error");
    expect(mock.requests.map((q) => q.query.get("after"))).toEqual(["c2"]); // the 503 never reached the mock
    expect(await storedCursor(pool)).toBeNull();
    expect(await resetFromCursor()).toBe("c2"); // kept by idr_reset_cursor in the same transaction
  };

  it("R2-5: retention passes the rejected cursor before the replay starts -> the next run re-presents it, gets 410 and records the gap (no silent loss)", async () => {
    await resetButReplayFailed();
    mock.retentionFloor = 3; // obs 1-3 pruned; obs 3 was never delivered
    mock.requests = [];
    const r = await runSync(cfg(), testDeps(store));
    expect(r).toMatchObject({ status: "needs_resync", gap: { recorded: true, newGap: true, superseded: false } });
    expect(mock.requests.map((q) => [q.query.get("after"), q.query.get("limit")])).toEqual([["c2", "1"]]);
    const gaps = await gapRows(pool);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "cursor_expired", expired_cursor: "c2", resolved_at: null });
    expect(await resetFromCursor()).toBeNull(); // the re-check ended with the record
    const st = await pool.query("select status, needs_resync, cursor from public.idr_sync_state");
    expect(st.rows[0]).toEqual({ status: "needs_resync", needs_resync: true, cursor: null });
    // The operator's resync rebuilds from what is retained; obs 3 stays missing, and is on record.
    await asRole(pool, "service_role", (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION]));
    const ok = await runSync(cfg(), testDeps(store));
    expect(ok).toMatchObject({ status: "ok", gapsResolved: 1 });
    const ids = await pool.query<{ id: string }>("select observation_id::text as id from public.idr_observations order by observation_id");
    expect(ids.rows.map((x) => x.id)).toEqual(["1", "2", "4", "5"]);
  });

  it("R2-5: still within retention -> the next run re-checks (400), replays once in the same run (cursor_rejected) and clears reset_from_cursor with the first page", async () => {
    await resetButReplayFailed();
    mock.requests = [];
    const r = await runSync(cfg(), testDeps(store));
    expect(r.status).toBe("cursor_rejected");
    expect(mock.requests.map((q) => q.query.get("after"))).toEqual(["c2", null, "k2c2", "k2c4"]);
    expect(await resetFromCursor()).toBeNull();
    expect(await storedCursor(pool)).toBe("k2c5");
    expect((await counts(pool)).observations).toBe(5);
    expect(await gapRows(pool)).toHaveLength(0);
    expect((await runSync(cfg(), testDeps(store))).status).toBe("ok");
  });

  it("R2-5: a crash between the reset and the first page (apply fails), or a failed re-check, leaves reset_from_cursor set; the next run re-checks", async () => {
    mock.items = [1, 2, 3, 4, 5].map((i) => obs(i, 7, D));
    expect((await runSync(cfg(), testDeps(store))).status).toBe("ok");
    mock.cursorPrefix = "k2";
    const crashing: Store = {
      getState: () => store.getState(),
      applyPage: async (a) => {
        if (a.expectedCursor === null) throw new Error("function killed before the first page committed");
        return store.applyPage(a);
      },
      recordStatus: (a) => store.recordStatus(a),
      localCounts: (a, b) => store.localCounts(a, b),
      resetCursor: (c) => store.resetCursor(c),
      recordGap: (a) => store.recordGap(a),
      resolveGaps: (c) => store.resolveGaps(c),
    };
    expect((await runSync(cfg(), testDeps(crashing))).status).toBe("store_error");
    expect(await storedCursor(pool)).toBeNull();
    expect(await resetFromCursor()).toBe("c5");
    // The re-check itself fails (resolver down): still set, nothing applied.
    mock.overrides = [{ status: 503 }];
    expect((await runSync(testConfig(mock, { maxRetries: 0 }), testDeps(store))).status).toBe("upstream_error");
    expect(await resetFromCursor()).toBe("c5");
    // Next healthy run: re-check (400), replay, cleared.
    mock.requests = [];
    expect((await runSync(cfg(), testDeps(store))).status).toBe("cursor_rejected");
    expect(mock.requests[0]!.query.get("after")).toBe("c5");
    expect(await resetFromCursor()).toBeNull();
    expect((await counts(pool)).observations).toBe(5);
  });

  it("R2-5 SQL: the reset keeps the rejected cursor; apply is a compare-and-set on it and clears it atomically", async () => {
    await pool.query("insert into public.idr_sync_state (installation_id, cursor) values ($1, 'c7')", [INSTALLATION]);
    const svc = (sql: string, args: unknown[]) => asRole(pool, "service_role", (c) => c.query<{ r: { applied: boolean } }>(sql, args));
    expect((await svc("select public.idr_reset_cursor($1, 'c7') as r", [INSTALLATION])).rows[0]!.r.applied).toBe(true);
    expect(await resetFromCursor()).toBe("c7");
    const apply = (expectedResetFrom: string | null) =>
      svc("select public.idr_apply_feed_page($1, null, 'k2c1', $2::jsonb, $3) as r", [INSTALLATION, JSON.stringify([obs(1, 7, D)]), expectedResetFrom]);
    // A run that did not see the reset (expects no pending re-check) loses the compare-and-set.
    expect((await apply(null)).rows[0]!.r.applied).toBe(false);
    expect((await counts(pool)).observations).toBe(0);
    expect((await apply("c7")).rows[0]!.r.applied).toBe(true);
    expect(await resetFromCursor()).toBeNull();
    expect(await storedCursor(pool)).toBe("k2c1");
  });

  it("400 to a request carrying a cursor resets to the buffer start and replays idempotently", async () => {
    mock.items = [1, 2, 3, 4, 5].map((i) => obs(i, i % 2 === 0 ? 7 : 8, D));
    expect((await runSync(cfg(), testDeps(store))).status).toBe("ok");
    expect(await storedCursor(pool)).toBe("c5");
    const before = await counts(pool);

    mock.items.push(obs(6, 7, D));
    mock.cursorPrefix = "k2"; // key rotated: every old cursor is now a 400
    mock.requests = [];
    const r = await runSync(cfg(), testDeps(store));

    expect(r.status).toBe("cursor_rejected");
    expect(mock.requests.map((q) => q.query.get("after"))).toEqual(["c5", null, "k2c2", "k2c4"]);
    expect(await storedCursor(pool)).toBe("k2c6");
    expect(await counts(pool)).toEqual({ ...before, observations: before.observations + 1 });
    const dup = await pool.query("select observation_id from public.idr_observations group by 1 having count(*) > 1");
    expect(dup.rowCount).toBe(0);
    const st = await pool.query("select status, needs_resync from public.idr_sync_state");
    expect(st.rows[0]).toEqual({ status: "cursor_rejected", needs_resync: false });
    expect(await resetFromCursor()).toBeNull(); // cleared with the first page from null

    // The next run is back to normal.
    expect((await runSync(cfg(), testDeps(store))).status).toBe("ok");
  });

  it("the reset is compare-and-set: a concurrent advance wins (cas_conflict), nothing is reset", async () => {
    mock.items = [1, 2, 3].map((i) => obs(i, 7, D));
    expect((await runSync(cfg(), testDeps(store))).status).toBe("ok");
    mock.cursorPrefix = "k2";
    const racing: Store = {
      getState: () => store.getState(),
      applyPage: (a) => store.applyPage(a),
      recordStatus: (a) => store.recordStatus(a),
      localCounts: (a, b) => store.localCounts(a, b),
      recordGap: (k) => store.recordGap(k),
      resolveGaps: (c) => store.resolveGaps(c),
      resetCursor: async (c) => {
        await pool.query("update public.idr_sync_state set cursor = 'c2'"); // another run moved it
        return store.resetCursor(c);
      },
    };
    expect((await runSync(cfg(), testDeps(racing))).status).toBe("cas_conflict");
    expect(await storedCursor(pool)).toBe("c2");
  });

  it("a rotation does not mask a 410: a stale cursor behind the retention floor -> needs_resync, no reset", async () => {
    mock.items = [1, 2, 3, 4, 5, 6].map((i) => obs(i, 7, D));
    // One page (obs 1, 2), then the consumer stalls.
    expect((await runSync(testConfig(mock, { pageLimit: 2, maxPages: 1 }), testDeps(store))).status).toBe("partial");
    expect(await storedCursor(pool)).toBe("c2");
    const before = await counts(pool);
    mock.retentionFloor = 4; // obs 3, 4 pruned before they were pulled
    mock.cursorPrefix = "k2"; // and the key rotated
    mock.requests = [];
    const r = await runSync(cfg(), testDeps(store));

    expect(r.status).toBe("needs_resync");
    expect(r.gap).toEqual({ recorded: true, newGap: true, superseded: false, needsResync: true });
    expect(mock.requests.map((q) => q.query.get("after"))).toEqual(["c2"]);
    expect(await storedCursor(pool)).toBe("c2");
    expect(await counts(pool)).toEqual(before);
    expect((await gapRows(pool)).map((g) => [g.kind, g.expired_cursor, g.resolved_at])).toEqual([["cursor_expired", "c2", null]]);
    const st = await pool.query("select status, needs_resync from public.idr_sync_state");
    expect(st.rows[0]).toEqual({ status: "needs_resync", needs_resync: true });
  });

  it("400 to a request WITHOUT a cursor stays contract_error", async () => {
    mock.items = [obs(1, 7, D)];
    mock.overrides = [{ status: 400 }];
    const r = await runSync(cfg(), testDeps(store));
    expect(r.status).toBe("contract_error");
    expect(mock.requests.length).toBe(1);
    expect(await storedCursor(pool)).toBeNull();
  });

  it("a 400 right after a reset (cursorless request) is contract_error, not a loop", async () => {
    mock.items = [1, 2, 3].map((i) => obs(i, 7, D));
    expect((await runSync(cfg(), testDeps(store))).status).toBe("ok");
    mock.cursorPrefix = "k2";
    mock.requests = [];
    mock.overrides = [{ status: 400 }, { status: 400 }]; // consumed in order: 400 (carried), then 400 (reset replay)
    const r = await runSync(cfg(), testDeps(store));
    expect(r.status).toBe("contract_error");
    expect(mock.requests.length).toBe(2);
  });
});
