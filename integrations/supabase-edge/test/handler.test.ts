import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleSyncRequest, loadConfig, secretsMatch, type HandlerDeps } from "../src/core/index.ts";
import { INSTALLATION, counts, newPool, resetDatabase, storedCursor, truncateAll } from "./helpers/db.ts";
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
    expect(JSON.parse(text)).toEqual({ status: "ok", pages: 2, observations: 3, tombstones: 0, reconcile: null });
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

  it("returns 409 needs_resync after cursor expiry", async () => {
    mock.items = [1, 2, 3, 4].map((i) => obs(i, 5, "2026-11-02T10:00:00.000Z"));
    await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), deps({ IDR_MAX_PAGES: "1" }));
    mock.retentionFloor = 3;
    const res = await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), deps());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: "needs_resync" });
    expect(await storedCursor(pool)).toBe("c2");
  });

  it("reports store failures (PostgREST rejecting the key) as store_error", async () => {
    mock.items = [obs(1, 5, "2026-11-02T10:00:00.000Z")];
    const res = await handleSyncRequest(post({ "x-idr-sync-secret": SECRET }), deps({ SUPABASE_SERVICE_ROLE_KEY: "wrong-wrong-wrong-wrong" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: "store_error", pages: 0, observations: 0, tombstones: 0, reconcile: null });
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

describe("configuration", () => {
  it("requires https unless the explicit dev flag is set", () => {
    const base = env({ IDR_BASE_URL: "http://resolver.example.com", SUPABASE_URL: "https://project.example.com", IDR_ALLOW_INSECURE_HTTP: undefined });
    const bad = loadConfig(base);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems).toContain("IDR_BASE_URL must use https");
    expect(loadConfig({ ...base, IDR_BASE_URL: "https://resolver.example.com" }).ok).toBe(true);
    expect(loadConfig({ ...base, IDR_ALLOW_INSECURE_HTTP: "true" }).ok).toBe(true);
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
