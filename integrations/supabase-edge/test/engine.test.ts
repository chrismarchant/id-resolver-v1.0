import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSync, type Store } from "../src/core/index.ts";
import { INSTALLATION, PgStore, asRole, counts, newPool, resetDatabase, storedCursor, truncateAll } from "./helpers/db.ts";
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
        await c.query("select public.idr_apply_feed_page($1,null,'c1',$2::jsonb)", [INSTALLATION, JSON.stringify([obs(1, 3, D)])]);
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow();
    expect(await counts(pool)).toEqual({ companies: 0, observations: 0, tombstones: 0 });
    expect(await storedCursor(pool)).toBeNull();
  });

  it("a stale expected cursor changes nothing (CAS)", async () => {
    const a = await store.applyPage({ expectedCursor: null, nextCursor: "c1", items: [obs(1, 3, D)] as never });
    expect(a.applied).toBe(true);
    const stale = await store.applyPage({ expectedCursor: null, nextCursor: "c1", items: [obs(2, 3, D)] as never });
    expect(stale.applied).toBe(false);
    const wrong = await store.applyPage({ expectedCursor: "c9", nextCursor: "c10", items: [obs(3, 3, D)] as never });
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
  it("410 cursor_expired -> needs_resync, cursor unchanged, no further fetches", async () => {
    mock.items = [1, 2, 3, 4].map((i) => obs(i, 3, D));
    await runSync(testConfig(mock, { maxPages: 1 }), testDeps(store));
    expect(await storedCursor(pool)).toBe("c2");
    mock.retentionFloor = 3; // buffer was pruned past our cursor
    mock.requests = [];
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r.status).toBe("needs_resync");
    expect(await storedCursor(pool)).toBe("c2");
    expect((await counts(pool)).observations).toBe(2);
    const st = await pool.query("select status, needs_resync from public.idr_sync_state");
    expect(st.rows[0]).toEqual({ status: "needs_resync", needs_resync: true });
    // Flagged: later runs do not call the resolver at all until an operator resyncs.
    mock.requests = [];
    const again = await runSync(testConfig(mock), testDeps(store));
    expect(again.status).toBe("needs_resync");
    expect(mock.requests.length).toBe(0);
    // Operator resync restarts from the start of the buffer.
    await asRole(pool, "service_role", (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION]));
    const ok = await runSync(testConfig(mock), testDeps(store));
    expect(ok.status).toBe("ok");
    // Observations 1-2 kept; 3 was pruned before we saw it (the loss the alert is for); 4 arrives.
    expect((await counts(pool)).observations).toBe(3);
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
