/**
 * Black-box verification of the real supervisor process: spawned exactly as
 * in deployment (same entry module), with ALL stdout/stderr captured so child
 * process logs are scanned too. Covers deployment health, graceful shutdown,
 * child reaping and the privacy invariants from the outside.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { startMockEnrichServer, SPECIAL_IPS, type MockServerHandle } from "../../src/provider/mock-server.js";
import { createTestDb, resetTestDb, getTestDatabaseUrl } from "../helpers/db.js";
import { TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";
import { dumpDatabaseText, findLeaks, FORBIDDEN_PROVIDER_FIELDS, ipVariants } from "../helpers/leak-scan.js";
import type { Db } from "../../src/db/index.js";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const QUALIFIED_IP = "203.0.113.10";
const TEST_IPS = [QUALIFIED_IP, "203.0.113.11", "203.0.113.13", "2001:db8::10", SPECIAL_IPS.slow, SPECIAL_IPS.serverError, "198.51.100.77"];

/**
 * Live resolver children of the supervisor process. Under tsx the loader may
 * keep a transient esbuild helper as a child too, so only forked resolver
 * children (argv contains the child module path) are counted.
 */
function childProcessCount(parentPid: number): number {
  try {
    const out = execSync(`ps -o args= --ppid ${parentPid} || true`, { encoding: "utf8" });
    return out.split("\n").filter((l) => l.includes("child/main")).length;
  } catch {
    return 0;
  }
}

describe("black-box supervisor process", () => {
  let proc: ChildProcess;
  let mock: MockServerHandle;
  let db: Db;
  let output = "";
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}/v1/resolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}`, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })(), headers: res.headers };
  };

  beforeAll(async () => {
    db = await createTestDb();
    await resetTestDb(db);
    mock = await startMockEnrichServer({ slowMs: 4_000 });
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
      DATABASE_URL: getTestDatabaseUrl(),
      DATABASE_SSL: "disable",
      PROVIDER_MODE: "live",
      ENRICH_API_BASE_URL: mock.url,
      ENRICH_TIMEOUT_MS: "700",
      REQUEST_DEADLINE_MS: "1500",
      LEASE_MS: "1200",
      CHILD_HARD_KILL_GRACE_MS: "300",
      MAX_CONCURRENT_CHILDREN: "4",
      SHUTDOWN_GRACE_MS: "2000",
      PERIOD_CALL_CAP: "100",
      ALLOW_DOCUMENTATION_RANGES: "true",
    };
    proc = spawn(process.execPath, ["--import", "tsx", resolve("src/supervisor/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"], cwd: resolve(".") });
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
  });

  it("answers liveness and readiness", async () => {
    const h = await fetch(`${BASE}/healthz`);
    expect(h.status).toBe(200);
    expect(h.headers.get("cache-control")).toBe("no-store");
    const r = await fetch(`${BASE}/readyz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("rejects bad credentials, wrong website and oversized bodies before processing", async () => {
    const hitsBefore = mock.hits(QUALIFIED_IP);
    expect((await post({ website_id: "site-test", ip: QUALIFIED_IP }, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post({ website_id: "another", ip: QUALIFIED_IP })).status).toBe(403);
    expect((await post({ website_id: "site-test", ip: QUALIFIED_IP, pad: "x".repeat(4000) })).status).toBe(413);
    expect((await post("{broken")).status).toBe(400);
    expect(mock.hits(QUALIFIED_IP)).toBe(hitsBefore);
  });

  it("rejects absolute-form and percent-encoded request targets without a credential", async () => {
    const raw = (target: string) =>
      new Promise<string>((resolve, reject) => {
        const sock = connect(PORT, "127.0.0.1");
        let data = "";
        const body = JSON.stringify({ website_id: "site-test", ip: QUALIFIED_IP });
        sock.on("connect", () => sock.write(`POST ${target} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
        sock.on("data", (d) => (data += d.toString()));
        sock.on("end", () => resolve(data));
        sock.on("error", reject);
      });
    const before = mock.hits(QUALIFIED_IP);
    for (const target of [`http://127.0.0.1:${PORT}/v1/resolve`, "/%761/resolve", "/v1/%72esolve"]) {
      const res = await raw(target);
      expect(res, target).toMatch(/^HTTP\/1\.1 (401|400) /);
      expect(res).toContain("no-store");
      expect(res).not.toContain('"status":"qualified"');
    }
    expect(mock.hits(QUALIFIED_IP)).toBe(before);
  });

  it("resolves through a real child, then from cache", async () => {
    const a = await post({ website_id: "site-test", ip: QUALIFIED_IP, request_id: "bb-1" });
    expect(a.status).toBe(200);
    expect(a.json["status"]).toBe("qualified");
    expect(a.json["source"]).toBe("provider");
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(a.headers.get("access-control-allow-origin")).toBeNull();
    const b = await post({ website_id: "site-test", ip: QUALIFIED_IP });
    expect(b.json["source"]).toBe("cache");
    expect(mock.hits(QUALIFIED_IP)).toBe(1);
  });

  it("times out a slow provider inside the deadline and defaults", async () => {
    const t0 = Date.now();
    const r = await post({ website_id: "site-test", ip: SPECIAL_IPS.slow });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.json["status"]).toBe("uncertain");
  });

  it("handles a burst, keeps children bounded and reaps every child", async () => {
    const ips = Array.from({ length: 12 }, (_, i) => `198.51.100.${10 + i}`);
    const results = await Promise.all(ips.map((ip) => post({ website_id: "site-test", ip })));
    for (const r of results) expect([200, 503]).toContain(r.status);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThan(0);
    // Children must be gone within a bounded window after the last response.
    const t0 = Date.now();
    while (childProcessCount(proc.pid!) > 0 && Date.now() - t0 < 2_000) await new Promise((r) => setTimeout(r, 50));
    const listing = execSync(`ps -o pid,stat,etimes,args --ppid ${proc.pid} || true`, { encoding: "utf8" });
    expect(childProcessCount(proc.pid!), listing).toBe(0);
    const spawnLines = output.split("\n").filter((l) => l.includes('"child_spawned"'));
    const maxActive = Math.max(...spawnLines.map((l) => Number(/"active_children":(\d+)/.exec(l)?.[1] ?? 0)));
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("shuts down gracefully on SIGTERM with no children left", async () => {
    const inflight = post({ website_id: "site-test", ip: "198.51.100.77" });
    await new Promise((r) => setTimeout(r, 30));
    proc.kill("SIGTERM");
    const t0 = Date.now();
    while (exitCode === null && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    const r = await inflight.catch(() => null);
    expect(exitCode).toBe(0);
    expect(exitSignal).toBeNull();
    expect(output).toContain("server_stopping");
    expect(output).toContain("server_stopped");
    expect(childProcessCount(proc.pid!)).toBe(0);
    if (r) expect([200, 503]).toContain(r.status);
    await expect(fetch(`${BASE}/healthz`)).rejects.toThrow();
  });

  it("captured supervisor and child output, database and responses contain no IP, secret or provider-only field", async () => {
    const needles = [
      ...TEST_IPS.flatMap(ipVariants),
      ...Array.from({ length: 12 }, (_, i) => `198.51.100.${10 + i}`),
      TEST_AUTH_TOKEN,
      TEST_HMAC_SECRET,
      "sk_test_placeholder_key",
      getTestDatabaseUrl(),
      "Example Transit Networks",
      "203.0.113.0/24",
      ...FORBIDDEN_PROVIDER_FIELDS,
    ];
    expect(output.length).toBeGreaterThan(500);
    expect(output).toContain('"component":"child"');
    expect(findLeaks(output, needles)).toEqual([]);
    expect(findLeaks(await dumpDatabaseText(db.pool), needles)).toEqual([]);
    expect(output).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  });
});
