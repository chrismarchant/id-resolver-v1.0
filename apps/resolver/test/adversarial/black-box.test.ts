/**
 * Black-box verification of the real service process: spawned exactly as in
 * deployment (same entry module, src/main.ts), with ALL stdout/stderr
 * captured. Covers deployment health, the single-process model (no child
 * processes, ever), bounded concurrency, graceful shutdown with drain, and the
 * privacy invariants from the outside.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { startMockEnrichServer, SPECIAL_IPS, type MockServerHandle } from "../../src/provider/mock-server.js";
import { createTestDb, getTestDatabaseUrl, resetTestDb } from "../helpers/db.js";
import { startProductionDb, type ProductionDb } from "../helpers/prod-db.js";
import { TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";
import { dumpDatabaseText, entranceResponseProblems, findLeaks, FORBIDDEN_PROVIDER_FIELDS, ipVariants } from "../helpers/leak-scan.js";
import type { Db } from "../../src/db/index.js";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const QUALIFIED_IP = "203.0.113.10";
const TEST_IPS = [QUALIFIED_IP, "203.0.113.11", "203.0.113.13", "2001:db8::10", SPECIAL_IPS.slow, SPECIAL_IPS.serverError, "198.51.100.77"];
const COMPANY_NEEDLES = ["example.com", "Example Ltd", "Example Transit Networks"];
let entranceSeq = 0;
/** A valid entrance.v1 body; `over` replaces or adds fields. */
const entrance = (ip: string, over: Record<string, unknown> = {}) => ({
  contract: "entrance.v1",
  website_id: "site-test",
  ip,
  entrance_id: `bb-entrance-${String((entranceSeq += 1)).padStart(8, "0")}`,
  occurred_at: new Date().toISOString(),
  page_key: "/pricing",
  acquisition: "search",
  eligibility: "tsa-1",
  ...over,
});

/**
 * Child processes of the service process. Under tsx the loader may keep a
 * transient esbuild helper as a child (the container runs compiled
 * JavaScript and has none), so that helper is the only process excluded.
 */
function childProcesses(parentPid: number): string[] {
  try {
    const out = execSync(`ps -o args= --ppid ${parentPid} || true`, { encoding: "utf8" });
    return out.split("\n").filter((l) => l.trim().length > 0 && !/esbuild/.test(l));
  } catch {
    return [];
  }
}

describe("black-box service process", () => {
  let proc: ChildProcess;
  let mock: MockServerHandle;
  let db: Db;
  let prodDb: ProductionDb;
  let output = "";
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  const responses: string[] = [];
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}/v1/entrances`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}`, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    responses.push(text);
    return { status: res.status, text, json: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })(), headers: res.headers };
  };

  beforeAll(async () => {
    db = await createTestDb();
    await resetTestDb(db);
    // Due before the process starts: the startup maintenance run must remove
    // them without waiting one CACHE_PRUNE_INTERVAL_S (CHR-66 F1), in several batches.
    const seedCompany = await db.pool.query<{ id: string }>("INSERT INTO companies (domain, organisation_name, first_seen_at, last_seen_at) VALUES ('maintenance-seed.example', NULL, now(), now()) RETURNING id");
    await db.pool.query(
      `INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source)
       SELECT 'inst-test', 'site-test', $1::bigint, now() - interval '40 days', 'bb-maint-' || lpad(g::text, 16, '0'), 'cache' FROM generate_series(1, 25) g`,
      [seedCompany.rows[0]!.id],
    );
    await db.pool.query(
      `INSERT INTO ip_resolution_cache (installation_id, website_id, key_version, ip_fingerprint, status, checked_at, expires_at)
       SELECT 'inst-test', 'site-test', 1, sha256(convert_to('bb-maintenance-' || g, 'UTF8')), 'no_match', now() - interval '2 days', now() - interval '1 hour'
       FROM generate_series(1, 25) g`,
    );
    mock = await startMockEnrichServer({ slowMs: 4_000 });
    prodDb = await startProductionDb();
    await prodDb.provision();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"] ?? "",
      NODE_ENV: "production",
      LOG_LEVEL: "debug",
      PORT: String(PORT),
      HOST: "127.0.0.1",
      INSTALLATION_ID: "inst-test",
      WEBSITE_ID: "site-test",
      RESOLVER_AUTH_TOKEN: TEST_AUTH_TOKEN,
      IP_HMAC_SECRET: TEST_HMAC_SECRET,
      ENRICH_API_KEY: "sk_test_placeholder_key",
      // Production posture: verified (pinned) TLS through the test terminator.
      ...prodDb.env(),
      PROVIDER_MODE: "live",
      ENRICH_API_BASE_URL: mock.url,
      ENRICH_TIMEOUT_MS: "700",
      REQUEST_DEADLINE_MS: "1500",
      LEASE_MS: "1200",
      MAX_CONCURRENT_JOBS: "4",
      SHUTDOWN_GRACE_MS: "2000",
      PERIOD_CALL_CAP: "100",
      ALLOW_DOCUMENTATION_RANGES: "true",
      OBSERVATION_RETENTION_DAYS: "30",
      // Default interval (600 s): only the startup run can prune during this suite.
      CACHE_PRUNE_BATCH: "10",
    };
    proc = spawn(process.execPath, ["--import", "tsx", resolve("src/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"], cwd: resolve(".") });
    proc.stdout!.on("data", (d: Buffer) => (output += d.toString()));
    proc.stderr!.on("data", (d: Buffer) => (output += d.toString()));
    proc.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    const deadline = Date.now() + 20_000;
    while (!output.includes("server_started") && Date.now() < deadline && exitCode === null) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(output, output.slice(-2000)).toContain("server_started");
  });

  afterAll(async () => {
    if (exitCode === null) proc.kill("SIGKILL");
    await mock.close();
    await db.close();
    await prodDb.close();
  });

  it("answers liveness and readiness", async () => {
    const h = await fetch(`${BASE}/healthz`);
    expect(h.status).toBe(200);
    expect(h.headers.get("cache-control")).toBe("no-store");
    const r = await fetch(`${BASE}/readyz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("runs maintenance once at startup, without waiting one interval, draining every due row in batches (CHR-66 F1)", async () => {
    const deadline = Date.now() + 10_000;
    while (!output.includes('"event":"maintenance_run"') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const line = output.split("\n").find((l) => l.includes('"event":"maintenance_run"'));
    expect(line, output.slice(-2000)).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ level: "info", cache_rows: 25, observation_rows: 25, backlog: false, outcome: "completed" });
    expect(output.indexOf('"event":"maintenance_run"')).toBeGreaterThan(output.indexOf("server_started"));
    expect((await db.pool.query("SELECT 1 FROM company_observations WHERE observation_ref LIKE 'bb-maint-%'")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM ip_resolution_cache WHERE expires_at <= now()")).rowCount).toBe(0);
    expect(output).not.toContain('"event":"maintenance_backlog"');
  });

  it("rejects bad credentials, wrong website and oversized bodies before processing", async () => {
    const hitsBefore = mock.hits(QUALIFIED_IP);
    expect((await post(entrance(QUALIFIED_IP), { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(entrance(QUALIFIED_IP, { website_id: "another" }))).status).toBe(403);
    expect((await post(entrance(QUALIFIED_IP, { pad: "x".repeat(4000) }))).status).toBe(413);
    expect((await post("{broken")).status).toBe(400);
    // A captured request replayed outside the 300 s window is refused before any processing.
    expect((await post(entrance(QUALIFIED_IP, { occurred_at: new Date(Date.now() - 600_000).toISOString() }))).status).toBe(400);
    // The removed V0.1 route does not exist, even with a valid credential.
    const legacy = await fetch(`${BASE}/v1/resolve`, { method: "POST", headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ website_id: "site-test", ip: QUALIFIED_IP }) });
    expect(legacy.status).toBe(404);
    expect(await legacy.json()).toEqual({ version: "1", error: "not_found" });
    expect(mock.hits(QUALIFIED_IP)).toBe(hitsBefore);
  });

  it("rejects absolute-form and percent-encoded request targets without a credential", async () => {
    const raw = (target: string) =>
      new Promise<string>((resolve, reject) => {
        const sock = connect(PORT, "127.0.0.1");
        let data = "";
        const body = JSON.stringify(entrance(QUALIFIED_IP));
        sock.on("connect", () => sock.write(`POST ${target} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
        sock.on("data", (d) => (data += d.toString()));
        sock.on("end", () => resolve(data));
        sock.on("error", reject);
      });
    const before = mock.hits(QUALIFIED_IP);
    for (const target of [`http://127.0.0.1:${PORT}/v1/entrances`, "/%761/entrances", "/v1/%65ntrances"]) {
      const res = await raw(target);
      expect(res, target).toMatch(/^HTTP\/1\.1 (401|400) /);
      expect(res).toContain("no-store");
      expect(res).not.toContain('"status":"qualified"');
      expect(res).not.toContain("example.com");
    }
    expect(mock.hits(QUALIFIED_IP)).toBe(before);
  });

  it("resolves in-process, then from cache", async () => {
    const a = await post(entrance(QUALIFIED_IP));
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ version: "1", status: "qualified", source: "provider", recorded: true });
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(a.headers.get("access-control-allow-origin")).toBeNull();
    const b = await post(entrance(QUALIFIED_IP));
    expect(b.json).toEqual({ version: "1", status: "qualified", source: "cache", recorded: true });
    expect(mock.hits(QUALIFIED_IP)).toBe(1);
  });

  it("times out a slow provider inside the deadline and defaults", async () => {
    const t0 = Date.now();
    const r = await post(entrance(SPECIAL_IPS.slow));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.json["status"]).toBe("uncertain");
  });

  it("handles a burst in one process: bounded concurrency, 503 overloaded beyond it, never a child process", async () => {
    const ips = Array.from({ length: 12 }, (_, i) => `198.51.100.${10 + i}`);
    const pending = Promise.all(ips.map((ip) => post(entrance(ip))));
    // Sampled while the burst is in flight: the service never forks.
    const during = childProcesses(proc.pid!);
    const results = await pending;
    expect(during).toEqual([]);
    for (const r of results) expect([200, 503]).toContain(r.status);
    for (const r of results.filter((x) => x.status === 503)) expect(r.json).toEqual({ version: "1", error: "overloaded" });
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThan(0);
    expect(childProcesses(proc.pid!)).toEqual([]);
    const startLines = output.split("\n").filter((l) => l.includes('"job_started"'));
    expect(startLines.length).toBeGreaterThan(0);
    const maxActive = Math.max(...startLines.map((l) => Number(/"active_jobs":(\d+)/.exec(l)?.[1] ?? 0)));
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("carries no IP or secret in its command line", () => {
    const cmdline = readFileSync(`/proc/${proc.pid}/cmdline`, "utf8");
    for (const needle of [QUALIFIED_IP, TEST_AUTH_TOKEN, TEST_HMAC_SECRET, "sk_test_placeholder_key", getTestDatabaseUrl(), prodDb.url()]) expect(cmdline).not.toContain(needle);
  });

  it("shuts down gracefully on SIGTERM, draining the in-flight job", async () => {
    const inflight = post(entrance("198.51.100.77"));
    await new Promise((r) => setTimeout(r, 30));
    proc.kill("SIGTERM");
    const t0 = Date.now();
    while (exitCode === null && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    const r = await inflight.catch(() => null);
    expect(exitCode).toBe(0);
    expect(exitSignal).toBeNull();
    expect(output).toContain("server_stopping");
    expect(output).toContain("server_stopped");
    const stopped = output.split("\n").find((l) => l.includes('"server_stopped"'))!;
    expect(stopped).toContain('"active_jobs":0');
    expect(stopped).toContain('"outcome":"drained"');
    if (r) expect([200, 503]).toContain(r.status);
    await expect(fetch(`${BASE}/healthz`)).rejects.toThrow();
  });

  it("captured process output, database and responses contain no IP, secret or provider-only field", async () => {
    const needles = [
      ...TEST_IPS.flatMap(ipVariants),
      ...Array.from({ length: 12 }, (_, i) => `198.51.100.${10 + i}`),
      TEST_AUTH_TOKEN,
      TEST_HMAC_SECRET,
      "sk_test_placeholder_key",
      getTestDatabaseUrl(),
      prodDb.url(),
      "Example Transit Networks",
      "203.0.113.0/24",
      ...FORBIDDEN_PROVIDER_FIELDS,
    ];
    expect(output.length).toBeGreaterThan(500);
    expect(output).toContain('"component":"resolver"');
    expect(output).toContain('"event":"job_finished"');
    expect(findLeaks(output, needles)).toEqual([]);
    expect(findLeaks(await dumpDatabaseText(db.pool), needles)).toEqual([]);
    // Every website-facing response is the bare acknowledgement or error body: no IP, no company data (D2).
    expect(responses.length).toBeGreaterThan(10);
    for (const raw of responses) expect(entranceResponseProblems(raw, [...needles, ...COMPANY_NEEDLES])).toEqual([]);
    // The observations carry the entrance context, never the address.
    const ctx = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM company_observations WHERE page_key = '/pricing' AND acquisition = 'search' AND entrance_contract = 'entrance.v1' AND eligibility = 'tsa-1'");
    expect(ctx.rows[0]!.n).toBeGreaterThan(0);
    expect(output).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  });
});
