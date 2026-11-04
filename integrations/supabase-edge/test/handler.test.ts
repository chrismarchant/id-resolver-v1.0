import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleSyncRequest, loadConfig, PostgrestStore, secretsMatch, StoreError, type HandlerDeps } from "../src/core/index.ts";
import { INSTALLATION, asRole, counts, gapRows, newPool, resetDatabase, storedCursor, truncateAll } from "./helpers/db.ts";
import { FakePostgrest, SERVICE_KEY } from "./helpers/fake-postgrest.ts";
import { MockResolver, TOKEN, obs } from "./helpers/mock-resolver.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
let pool: pg.Pool;
const mock = new MockResolver();
let rest: FakePostgrest;

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    IDR_BASE_URL: mock.baseUrl,
    IDR_REPORTING_TOKEN: TOKEN,
    IDR_INSTALLATION_ID: INSTALLATION,
    IDR_SYNC_SECRET: SECRET,
    SUPABASE_URL: rest.url,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    IDR_ALLOW_INSECURE_HTTP: "true",
    IDR_PAGE_LIMIT: "2",
    ...over,
  };
}
const deps = (over: Record<string, string | undefined> = {}): HandlerDeps => ({ env: env(over), fetch, sleep: () => Promise.resolve() });
const post = (headers: Record<string, string> = {}) => new Request("http://function.invalid/idr-sync", { method: "POST", headers });

beforeAll(async () => {
  pool = newPool();
  await resetDatabase(pool);
  await mock.start();
  rest = new FakePostgrest(pool);
  await rest.start();
});
afterAll(async () => {
  await rest.stop();
  await mock.stop();
  await pool.end();
});
beforeEach(async () => {
  mock.reset();
  await truncateAll(pool);
});

describe("authentication of the function endpoint", () => {
  it("rejects missing, wrong, truncated and padded secrets with an empty 401", async () => {
    for (const h of [{}, { "x-idr-sync-secret": "nope" }, { "x-idr-sync-secret": SECRET.slice(0, -1) }, { "x-idr-sync-secret": SECRET + "x" }, { "x-idr-sync-secret": "" }]) {
      const res = await handleSyncRequest(post(h), deps());
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    }
    expect(mock.requests.length).toBe(0);
    expect(rest.calls).toBe(0);
  });

  it("rejects non-POST methods even with the right secret", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await handleSyncRequest(new Request("http://function.invalid/", { method, headers: { "x-idr-sync-secret": SECRET } }), deps());
      expect(res.status).toBe(401);
    }
    expect(mock.requests.length).toBe(0);
  });

  it("fails closed when the server-side secret is unset or too short", async () => {
    const res = await handleSyncRequest(post({ "x-idr-sync-secret": "" }), deps({ IDR_SYNC_SECRET: undefined }));
    expect(res.status).toBe(401);
    const short = await handleSyncRequest(post({ "x-idr-sync-secret": "short" }), deps({ IDR_SYNC_SECRET: "short" }));
    expect(short.status).toBe(401);
  });

  it("secretsMatch compares by value", async () => {
    expect(await secretsMatch("a", "a")).toBe(true);
    expect(await secretsMatch("a", "b")).toBe(false);
    expect(await secretsMatch("", "")).toBe(true);
  });
});

describe("authorised invocation", () => {
  it("runs a sync end to end through the PostgREST store and returns only counts and status", async () => {
    mock.items = [1, 2, 3].map((i) => obs(i, 5, "2026-11-02T10:00:00.000Z"));
    const res = await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), deps());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      status: "ok",
      pages: 2,
      observations: 3,
      tombstones: 0,
      reconcile: null,
      gap_recorded: false,
      gap_new: false,
      gaps_resolved: 0,
      ignored_erased: 0,
      page_keys_cleared: 0,
    });
    for (const leak of [TOKEN, SERVICE_KEY, SECRET, "example.com", "Company", "c3", INSTALLATION]) expect(text).not.toContain(leak);
    expect((await counts(pool)).observations).toBe(3);
    expect(await storedCursor(pool)).toBe("c3");
  });

  it("maps resolver failures to a status without leaking details", async () => {
    mock.overrides = [{ status: 401 }];
    const res = await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), deps());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: "auth_failed" });
  });

  it("returns 409 needs_resync after cursor expiry, records the continuity gap and says so (summary and log), never data", async () => {
    mock.items = [1, 2, 3, 4].map((i) => obs(i, 5, "2026-11-02T10:00:00.000Z"));
    await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), deps({ IDR_MAX_PAGES: "1" }));
    mock.retentionFloor = 3;
    const logs: string[] = [];
    const res = await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), { ...deps(), log: (m) => logs.push(m) });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      status: "needs_resync",
      pages: 0,
      observations: 0,
      tombstones: 0,
      reconcile: null,
      gap_recorded: true,
      gap_new: true,
      gaps_resolved: 0,
      ignored_erased: 0,
      page_keys_cleared: 0,
    });
    expect(await storedCursor(pool)).toBe("c2");
    expect(await gapRows(pool)).toHaveLength(1);
    expect(logs).toContain("sync needs_resync pages=0 observations=0 tombstones=0 gap_recorded=true gap_new=true");
    expect(logs.some((l) => l.startsWith("continuity gap open (cursor_expired): recorded in idr_sync_gaps"))).toBe(true);
    for (const leak of [TOKEN, SERVICE_KEY, SECRET, "example.com", "c2", INSTALLATION]) {
      expect(text).not.toContain(leak);
      expect(logs.join("\n")).not.toContain(leak);
    }

    // Repeated invocations: still 409 and gap_recorded, never a second row.
    const again = await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), deps());
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ status: "needs_resync", gap_recorded: true, gap_new: false });
    expect(await gapRows(pool)).toHaveLength(1);

    // After the operator's resync the first drained run reports the resolution; the row stays.
    await pool.query("select public.idr_begin_resync($1)", [INSTALLATION]);
    const resynced = await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), deps());
    expect(resynced.status).toBe(200);
    expect(await resynced.json()).toMatchObject({ status: "ok", gap_recorded: false, gaps_resolved: 1 });
    expect((await gapRows(pool))[0]).toMatchObject({ resolution: "full_resync" });
  });

  it("schema 8 counts: ignored_erased and page_keys_cleared reach the response and the log line, as counts only", async () => {
    const D = "2026-11-02T10:00:00.000Z";
    const BAD_KEY = "/reset?token=value-that-must-not-appear";
    // Company 5 is erased; a stale observation of it follows (G7). One page_key fails the resolver's rule (G5).
    mock.items = [obs(1, 5, D), { type: "company_erased", tombstone_id: "1", company_id: 5, erased_at: D }, obs(1, 5, D), obs(2, 6, D, { page_key: BAD_KEY }), obs(3, 6, D)];
    const logs: string[] = [];
    const res = await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), { ...deps(), log: (m) => logs.push(m) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      status: "ok",
      pages: 3,
      observations: 3,
      tombstones: 1,
      reconcile: null,
      gap_recorded: false,
      gap_new: false,
      gaps_resolved: 0,
      ignored_erased: 1,
      page_keys_cleared: 1,
    });
    expect(logs).toContain("sync ok pages=3 observations=3 tombstones=1 ignored_erased=1 page_keys_cleared=1");
    for (const leak of [BAD_KEY, "value-that-must-not-appear", "example.com", "Company", INSTALLATION]) {
      expect(text).not.toContain(leak);
      expect(logs.join("\n")).not.toContain(leak);
    }
    const stored = (await pool.query<{ id: number; k: string | null }>("select observation_id::int as id, page_key as k from public.idr_observations order by 1")).rows;
    expect(stored).toEqual([
      { id: 2, k: null },
      { id: 3, k: "/pricing" },
    ]);
  });

  it("zero counts keep the earlier log line unchanged (no ignored_erased / page_keys_cleared parts)", async () => {
    mock.items = [obs(1, 5, "2026-11-02T10:00:00.000Z")];
    const logs: string[] = [];
    await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), { ...deps(), log: (m) => logs.push(m) });
    expect(logs).toContain("sync ok pages=1 observations=1 tombstones=0");
  });

  it("reports store failures (PostgREST rejecting the key) as store_error", async () => {
    mock.items = [obs(1, 5, "2026-11-02T10:00:00.000Z")];
    const res = await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), deps({ SUPABASE_SERVICE_ROLE_KEY: "wrong-wrong-wrong-wrong" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      status: "store_error",
      pages: 0,
      observations: 0,
      tombstones: 0,
      reconcile: null,
      gap_recorded: false,
      gap_new: false,
      gaps_resolved: 0,
      ignored_erased: 0,
      page_keys_cleared: 0,
    });
  });

  it("returns a generic misconfigured status (no variable values) when env is invalid", async () => {
    const logs: string[] = [];
    const res = await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), { ...deps({ IDR_REPORTING_TOKEN: undefined }), log: (m) => logs.push(m) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: "misconfigured" });
    expect(logs.join(" ")).toContain("IDR_REPORTING_TOKEN");
    expect(logs.join(" ")).not.toContain(SECRET);
  });
});

describe("PostgrestStore: the apply result's schema 8 counts are additive", () => {
  /** A store whose idr_apply_feed_page answers `body` (HTTP 200, JSON). */
  const storeAnswering = (body: unknown) =>
    new PostgrestStore({
      supabaseUrl: "https://project.example.com",
      serviceRoleKey: SERVICE_KEY,
      installationId: INSTALLATION,
      fetch: (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    });
  const args = { expectedCursor: null, expectedResetFrom: null, nextCursor: "c1", items: [], drained: false };

  it("reads ignored_erased and page_keys_cleared when present", async () => {
    const r = await storeAnswering({ applied: true, observations: 2, tombstones: 1, ignored_erased: 3, page_keys_cleared: 4 }).applyPage(args);
    expect(r).toEqual({ applied: true, observations: 2, tombstones: 1, ignoredErased: 3, pageKeysCleared: 4 });
  });

  it("an answer without them (the earlier result shape) still parses, as 0", async () => {
    const r = await storeAnswering({ applied: true, observations: 2, tombstones: 1 }).applyPage(args);
    expect(r).toEqual({ applied: true, observations: 2, tombstones: 1, ignoredErased: 0, pageKeysCleared: 0 });
    expect(await storeAnswering({ applied: false }).applyPage(args)).toEqual({ applied: false, observations: 0, tombstones: 0, ignoredErased: 0, pageKeysCleared: 0 });
  });

  it.each([
    ["a negative count", { ignored_erased: -1 }],
    ["a string", { page_keys_cleared: "1" }],
    ["a fraction", { ignored_erased: 1.5 }],
    ["null", { page_keys_cleared: null }],
  ])("refuses %s (bad_rpc_response, so the run ends store_error)", async (_name, extra) => {
    await expect(storeAnswering({ applied: true, observations: 0, tombstones: 0, ...extra }).applyPage(args)).rejects.toThrow(StoreError);
  });
});

describe("configuration", () => {
  it("requires https unless the explicit dev flag is set", () => {
    const base = env({ IDR_BASE_URL: "http://resolver.example.com", SUPABASE_URL: "https://project.example.com", IDR_ALLOW_INSECURE_HTTP: undefined });
    const bad = loadConfig(base);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems).toContain("IDR_BASE_URL must use https");
    expect(loadConfig({ ...base, IDR_BASE_URL: "https://resolver.example.com" }).ok).toBe(true);
    expect(loadConfig({ ...base, IDR_ALLOW_INSECURE_HTTP: "true" }).ok).toBe(true);
  });

  it("G3c: refuses an IDR_BASE_URL on a Supabase host (fixed message, no value); SUPABASE_URL stays a Supabase host", () => {
    const base = env({ SUPABASE_URL: "https://example-project.supabase.co", IDR_ALLOW_INSECURE_HTTP: undefined });
    for (const url of [
      "https://example-project.supabase.co",
      "https://example-project.supabase.co/functions/v1/idr-sync",
      "https://EXAMPLE-PROJECT.SUPABASE.CO./",
      "https://example-project.supabase.in",
      "https://pooler.supabase.com",
      "https://example-project.supabase%2Eco",
    ]) {
      const r = loadConfig({ ...base, IDR_BASE_URL: url });
      expect(r.ok, url).toBe(false);
      if (!r.ok) {
        expect(r.problems).toEqual(["IDR_BASE_URL must be the ID Resolver service, never a Supabase host"]);
        expect(r.problems.join(" ")).not.toContain("example-project");
      }
    }
    // Positive: the resolver's own host, and look-alikes, with this project's Supabase URL.
    for (const url of ["https://resolver.example.com", "https://supabase.co.example.com", "https://resolver.example.com/supabase.co"]) {
      expect(loadConfig({ ...base, IDR_BASE_URL: url }).ok, url).toBe(true);
    }
  });

  it("G3c: the handler answers misconfigured and fetches nothing when IDR_BASE_URL is a Supabase host", async () => {
    const logs: string[] = [];
    const res = await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), { ...deps({ IDR_BASE_URL: "https://example-project.supabase.co" }), log: (m) => logs.push(m) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: "misconfigured" });
    expect(mock.requests).toHaveLength(0);
    expect(logs.join(" ")).toContain("IDR_BASE_URL must be the ID Resolver service, never a Supabase host");
    expect(logs.join(" ")).not.toContain("example-project");
  });

  it("rejects URLs with credentials, bad bounds, and never echoes values", () => {
    const r = loadConfig(env({ IDR_BASE_URL: "https://user:pw@" + "resolver.example.com", IDR_PAGE_LIMIT: "9999" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.join(" ")).not.toContain("pw");
      expect(r.problems.join(" ")).toContain("IDR_PAGE_LIMIT");
    }
  });
});
