import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { ChildManagerOverloadedError, type ChildJobRequest, type ChildManager } from "../../src/contracts/child-manager.js";
import type { ChildOutcome } from "../../src/contracts/ipc.js";
import { testConfig, TEST_AUTH_TOKEN } from "../helpers/env.js";

const TEST_IP = "203.0.113.77";

function fakeManager(opts: { capacity?: number; outcome?: (job: ChildJobRequest) => Promise<ChildOutcome> } = {}) {
  const jobs: ChildJobRequest[] = [];
  let active = 0;
  const capacity = opts.capacity ?? 4;
  const manager: ChildManager & { jobs: ChildJobRequest[] } = {
    jobs,
    activeCount: () => active,
    capacity: () => capacity,
    async run(job) {
      if (active >= capacity) throw new ChildManagerOverloadedError();
      active += 1;
      jobs.push(job);
      try {
        return await (opts.outcome
          ? opts.outcome(job)
          : Promise.resolve({
              status: "qualified",
              company: {
                domain: "example.com",
                organisation_name: "Example Ltd",
                qualification: { category: "COM", source: "provider_usage_type" },
                resolved_at: "2026-10-26T00:00:00.000Z",
              },
              source: "provider",
              reason: "provider_resolved",
            } satisfies ChildOutcome));
      } finally {
        active -= 1;
      }
    },
    async shutdown() {},
  };
  return manager;
}

describe("supervisor API", () => {
  let app: FastifyInstance;
  let logger: ReturnType<typeof createMemoryLogger>;
  let manager: ReturnType<typeof fakeManager>;
  let pingOk = true;

  beforeAll(async () => {
    logger = createMemoryLogger();
    manager = fakeManager();
    app = await buildServer({ config: testConfig(), logger, childManager: manager, ping: async () => pingOk });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = { authorization: `Bearer ${TEST_AUTH_TOKEN}`, "content-type": "application/json" };

  it("rejects missing and wrong credentials before reading the body", async () => {
    const before = manager.jobs.length;
    const r1 = await app.inject({ method: "POST", url: "/v1/resolve", payload: { website_id: "site-test", ip: TEST_IP } });
    expect(r1.statusCode).toBe(401);
    expect(r1.json()).toEqual({ version: "1", error: "unauthorized" });
    const r2 = await app.inject({ method: "POST", url: "/v1/resolve", headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}x` }, payload: { website_id: "site-test", ip: TEST_IP } });
    expect(r2.statusCode).toBe(401);
    const r3 = await app.inject({ method: "POST", url: "/v1/resolve", headers: { authorization: "Basic abc" }, payload: {} });
    expect(r3.statusCode).toBe(401);
    expect(manager.jobs.length).toBe(before);
    expect(r1.headers["cache-control"]).toBe("no-store");
    expect(r1.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects wrong website id with 403 before processing", async () => {
    const before = manager.jobs.length;
    const r = await app.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "other-site", ip: TEST_IP, request_id: "req-1" } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ version: "1", error: "forbidden", request_id: "req-1" });
    expect(manager.jobs.length).toBe(before);
  });

  it("rejects invalid bodies safely", async () => {
    const before = manager.jobs.length;
    const cases: unknown[] = [
      {},
      { website_id: "site-test" },
      { website_id: "site-test", ip: "" },
      { website_id: "site-test", ip: "not-an-ip" },
      { website_id: "site-test", ip: "203.0.113.5 " },
      { website_id: "site-test", ip: "203.0.113.5", extra: 1 },
      { website_id: "site-test", ip: "203.0.113.5", request_id: "has space" },
      { website_id: "site-test", ip: "203.0.113.5", request_id: "x".repeat(65) },
      { website_id: "SITE-TEST", ip: "203.0.113.5" },
      { website_id: "site-test", ip: 1234 },
      { website_id: "site-test", ip: "x".repeat(65) },
      [],
      "string",
    ];
    for (const payload of cases) {
      const r = await app.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: JSON.stringify(payload) });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error).toBe("invalid_request");
    }
    const bad = await app.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    const wrongType = await app.inject({ method: "POST", url: "/v1/resolve", headers: { ...auth, "content-type": "text/plain" }, payload: "ip=1" });
    expect([400, 415]).toContain(wrongType.statusCode);
    expect(wrongType.json().error).toBe("invalid_request");
    expect(manager.jobs.length).toBe(before);
  });

  it("rejects oversized bodies with 413", async () => {
    const payload = JSON.stringify({ website_id: "site-test", ip: TEST_IP, request_id: "a", pad: "x".repeat(5000) });
    const r = await app.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toEqual({ version: "1", error: "payload_too_large" });
  });

  it("returns sanitised company context and echoes request_id", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: TEST_IP, request_id: "abc-123" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      version: "1",
      status: "qualified",
      company: {
        domain: "example.com",
        organisation_name: "Example Ltd",
        qualification: { category: "COM", source: "provider_usage_type" },
        resolved_at: "2026-10-26T00:00:00.000Z",
      },
      source: "provider",
      request_id: "abc-123",
    });
    expect(r.body).not.toContain(TEST_IP);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    const job = manager.jobs.at(-1)!;
    expect(job.ip).toBe(TEST_IP);
    expect(job.requestId).toBe("abc-123");
    expect(job.deadlineAtMs).toBeGreaterThan(Date.now() - 10);
  });

  it("never logs the IP or the credential", () => {
    const text = JSON.stringify(logger.entries);
    expect(text).not.toContain(TEST_IP);
    expect(text).not.toContain(TEST_AUTH_TOKEN);
    expect(text).toContain("request_completed");
  });

  it("maps overload to 503 and still allows default rendering", async () => {
    const slow = fakeManager({ capacity: 1, outcome: () => new Promise((resolve) => setTimeout(() => resolve({ status: "no_match", company: null, source: "provider" }), 150)) });
    const app2 = await buildServer({ config: testConfig(), logger, childManager: slow, ping: async () => true });
    const p1 = app2.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: TEST_IP } });
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await app2.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: TEST_IP } });
    expect(r2.statusCode).toBe(503);
    expect(r2.json().error).toBe("overloaded");
    const r1 = await p1;
    expect(r1.statusCode).toBe(200);
    expect(r1.json().status).toBe("no_match");
    await app2.close();
  });

  it("strips unexpected fields from a child outcome", async () => {
    const leaky = fakeManager({
      outcome: async () =>
        ({
          status: "qualified",
          company: { domain: "example.org", organisation_name: null, qualification: { category: "ORG", source: "provider_usage_type" }, resolved_at: "2026-01-01T00:00:00.000Z", ipRange: "203.0.113.0/24" },
          source: "provider",
          fingerprint: "deadbeef",
        }) as unknown as ChildOutcome,
    });
    const app3 = await buildServer({ config: testConfig(), logger, childManager: leaky, ping: async () => true });
    const r = await app3.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: TEST_IP } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("ipRange");
    expect(r.body).not.toContain("fingerprint");
    expect(r.json().company.domain).toBe("example.org");
    await app3.close();
  });

  it("returns default-safe outcome when the child never answers within the hard stop", async () => {
    const hang = fakeManager({ outcome: () => new Promise(() => {}) });
    const cfg = testConfig({ REQUEST_DEADLINE_MS: "400", ENRICH_TIMEOUT_MS: "200", LEASE_MS: "600", CHILD_HARD_KILL_GRACE_MS: "100" });
    const app4 = await buildServer({ config: cfg, logger, childManager: hang, ping: async () => true });
    const started = Date.now();
    const r = await app4.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: TEST_IP } });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2000);
    await app4.close();
  });

  it("applies the deployment rate limit", async () => {
    const cfg = testConfig({ RATE_LIMIT_PER_MINUTE: "3" });
    const app5 = await buildServer({ config: cfg, logger, childManager: fakeManager(), ping: async () => true });
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await app5.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: TEST_IP } });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    await app5.close();
  });

  it("serves liveness and readiness", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    pingOk = false;
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ ok: false });
    pingOk = true;
  });

  it("authenticates by matched route, not raw request target", async () => {
    const before = manager.jobs.length;
    for (const url of ["/%761/resolve", "/%76%31/resolve", "/v1/resolve/", "/V1/resolve", "/v1/resolve?x=1"]) {
      const r = await app.inject({ method: "POST", url, payload: { website_id: "site-test", ip: TEST_IP } });
      expect(r.statusCode, url).toBe(401);
      expect(r.json()).toEqual({ version: "1", error: "unauthorized" });
    }
    const unknown = await app.inject({ method: "GET", url: "/admin" });
    expect(unknown.statusCode).toBe(401);
    expect(manager.jobs.length).toBe(before);
  });

  it("does not log an encoded IP from an unauthenticated request target", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/x?ip=203%2E0%2E113%2E5&v6=2001%3Adb8%3A%3A5" });
    expect(r.statusCode).toBe(401);
    const text = JSON.stringify(logger.entries);
    expect(text).not.toContain("203%2E0%2E113%2E5");
    expect(text).not.toContain("2001%3Adb8");
    expect(text).not.toContain("203.0.113.5");
  });

  it("keeps health probes out of the deployment bucket and throttles repeated 401s per peer", async () => {
    const cfg = testConfig({ RATE_LIMIT_PER_MINUTE: "2", AUTH_FAILURE_LIMIT_PER_MINUTE: "3" });
    const app6 = await buildServer({ config: cfg, logger, childManager: fakeManager(), ping: async () => true });
    for (let i = 0; i < 10; i += 1) {
      expect((await app6.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      expect((await app6.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    }
    const ok = await app6.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: TEST_IP } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(ok.headers["x-ratelimit-remaining"]).toBeUndefined();
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await app6.inject({ method: "POST", url: "/v1/resolve", headers: { authorization: "Bearer wrong" }, payload: {} });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    // Exhausted invalid-auth allowance must not lock out a valid credential from the
    // same peer address (callers may share a proxy address): it proceeds to the
    // authenticated controls, here the deployment limit of 2 (one already used).
    const valid = await app6.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: TEST_IP } });
    expect(valid.statusCode).toBe(200);
    const limited = await app6.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: TEST_IP } });
    expect(limited.statusCode).toBe(429);
    // Invalid credentials from that peer stay throttled, and a forwarded header
    // cannot change the peer key.
    const stillBad = await app6.inject({ method: "POST", url: "/v1/resolve", headers: { authorization: "Bearer wrong", "x-forwarded-for": "198.51.100.200" }, payload: {} });
    expect(stillBad.statusCode).toBe(429);
    await app6.close();
  });

  it("answers requests that arrive during shutdown with the contract error and headers", async () => {
    const app7 = await buildServer({ config: testConfig(), logger, childManager: fakeManager(), ping: async () => true });
    await app7.ready();
    const closing = app7.close();
    const r = await app7.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: TEST_IP } }).catch(() => null);
    await closing;
    if (r) {
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ version: "1", error: "not_ready" });
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });

  it("rejects unknown routes and methods generically", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/resolve", headers: auth });
    expect([400, 404]).toContain(r.statusCode);
    const r2 = await app.inject({ method: "GET", url: "/admin", headers: auth });
    expect(r2.statusCode).toBe(400);
  });
});
