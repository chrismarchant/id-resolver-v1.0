/**
 * HTTP layer for the website route, POST /v1/entrances (contract entrance.v1,
 * owner decisions D1/D2), over a fake runner: authentication, strict request
 * validation (including the occurred_at replay bound), the acknowledgement-only
 * response, overload and readiness, the server-side deadline race, rate limits
 * and log hygiene. The V0.1 POST /v1/resolve no longer exists.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { RunnerOverloadedError, type JobRequest, type ResolutionOutcome, type Runner } from "../../src/contracts/runtime.js";
import { testConfig, TEST_AUTH_TOKEN } from "../helpers/env.js";
import { entranceResponseProblems, ipVariants } from "../helpers/leak-scan.js";

const TEST_IP = "203.0.113.77";
const ROUTE = "/v1/entrances";
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const ENTRANCE_ID = "ent_0123456789abcdef";

function entrance(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: "entrance.v1",
    website_id: "site-test",
    ip: TEST_IP,
    entrance_id: ENTRANCE_ID,
    occurred_at: new Date(NOW).toISOString(),
    page_key: "/pricing",
    acquisition: "search",
    eligibility: "tsa-1",
    ...over,
  };
}

const QUALIFIED_RECORDED: ResolutionOutcome = {
  status: "qualified",
  source: "provider",
  reason: "provider_resolved",
  activity: { company_id: 42, previously_seen: false, recorded: true, observation_ref: ENTRANCE_ID },
};

function fakeRunner(opts: { capacity?: number; outcome?: (job: JobRequest) => Promise<ResolutionOutcome> } = {}) {
  const jobs: JobRequest[] = [];
  let active = 0;
  const capacity = opts.capacity ?? 4;
  const runner: Runner & { jobs: JobRequest[] } = {
    jobs,
    activeCount: () => active,
    capacity: () => capacity,
    async run(job) {
      if (active >= capacity) throw new RunnerOverloadedError();
      active += 1;
      jobs.push(job);
      try {
        return await (opts.outcome ? opts.outcome(job) : Promise.resolve(QUALIFIED_RECORDED));
      } finally {
        active -= 1;
      }
    },
    async shutdown() {
      return { drained: true, activeJobs: 0, pendingWrites: 0 };
    },
  };
  return runner;
}

describe("resolver API: POST /v1/entrances", () => {
  let app: FastifyInstance;
  let logger: ReturnType<typeof createMemoryLogger>;
  let runner: ReturnType<typeof fakeRunner>;
  let pingOk = true;
  let outcomeFor: (job: JobRequest) => Promise<ResolutionOutcome> = async () => QUALIFIED_RECORDED;
  const now = () => NOW;

  beforeAll(async () => {
    logger = createMemoryLogger();
    runner = fakeRunner({ outcome: (job) => outcomeFor(job) });
    app = await buildServer({ config: testConfig(), logger, runner, ping: async () => pingOk, now });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = { authorization: `Bearer ${TEST_AUTH_TOKEN}`, "content-type": "application/json" };
  const post = (payload: unknown, headers: Record<string, string> = auth, target = app) =>
    target.inject({ method: "POST", url: ROUTE, headers, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });

  it("rejects missing and wrong credentials before reading the body", async () => {
    const before = runner.jobs.length;
    const r1 = await app.inject({ method: "POST", url: ROUTE, payload: entrance() });
    expect(r1.statusCode).toBe(401);
    expect(r1.json()).toEqual({ version: "1", error: "unauthorized" });
    const r2 = await post(entrance(), { authorization: `Bearer ${TEST_AUTH_TOKEN}x`, "content-type": "application/json" });
    expect(r2.statusCode).toBe(401);
    const r3 = await post({}, { authorization: "Basic abc", "content-type": "application/json" });
    expect(r3.statusCode).toBe(401);
    expect(runner.jobs.length).toBe(before);
    expect(r1.headers["cache-control"]).toBe("no-store");
    expect(r1.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects a wrong website id with 403 before processing", async () => {
    const before = runner.jobs.length;
    const r = await post(entrance({ website_id: "other-site" }));
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ version: "1", error: "forbidden" });
    expect(runner.jobs.length).toBe(before);
  });

  it("rejects every malformed or out-of-contract body with 400 and the bare error body", async () => {
    const before = runner.jobs.length;
    const { contract: _c, ...noContract } = entrance();
    const { entrance_id: _e, ...noEntranceId } = entrance();
    const { occurred_at: _o, ...noOccurredAt } = entrance();
    const { page_key: _p, ...noPageKey } = entrance();
    const { acquisition: _a, ...noAcquisition } = entrance();
    const { eligibility: _g, ...noEligibility } = entrance();
    const cases: unknown[] = [
      {},
      noContract,
      noEntranceId,
      noOccurredAt,
      noPageKey,
      noAcquisition,
      noEligibility,
      entrance({ contract: "entrance.v2" }),
      entrance({ contract: "resolve.v1" }),
      entrance({ website_id: "SITE-TEST" }),
      entrance({ ip: "" }),
      entrance({ ip: "not-an-ip" }),
      entrance({ ip: "203.0.113.5 " }),
      entrance({ ip: 1234 }),
      entrance({ ip: "x".repeat(65) }),
      entrance({ entrance_id: "short" }),
      entrance({ entrance_id: "x".repeat(65) }),
      entrance({ entrance_id: "has space 0123456789" }),
      entrance({ entrance_id: "dots.are.not.allowed.0123" }),
      entrance({ occurred_at: "2026-11-03T12:00:00" }),
      entrance({ occurred_at: "2026-11-03T12:00:00+00:00" }),
      entrance({ occurred_at: "2026-11-03 12:00:00Z" }),
      entrance({ occurred_at: "2026-02-30T12:00:00Z" }),
      entrance({ occurred_at: "2026-11-03T24:00:00Z" }),
      entrance({ occurred_at: "2026-11-03T12:00:00.1234567890Z" }),
      entrance({ occurred_at: 1_762_171_200_000 }),
      entrance({ page_key: "" }),
      entrance({ page_key: "pricing" }),
      entrance({ page_key: "/pricing?utm_medium=email" }),
      entrance({ page_key: "/pricing#plans" }),
      entrance({ page_key: "/pri cing" }),
      entrance({ page_key: "/pricing\t" }),
      entrance({ page_key: "/pricing\n" }),
      entrance({ page_key: "/pri\u0000cing" }),
      entrance({ page_key: "/pri\u007fcing" }),
      entrance({ page_key: "/pri\u0085cing" }),
      entrance({ page_key: "/pri cing" }),
      entrance({ page_key: "/pri cing" }),
      entrance({ page_key: "/pri\ud800cing" }),
      entrance({ page_key: `/${"a".repeat(256)}` }),
      entrance({ acquisition: "newsletter" }),
      entrance({ acquisition: "Search" }),
      entrance({ eligibility: "TSA-1" }),
      entrance({ eligibility: "-tsa" }),
      entrance({ eligibility: "t".repeat(33) }),
      entrance({ extra: 1 }),
      entrance({ request_id: "abc" }),
      entrance({ observation_ref: "obsref-0123456789abcdef" }),
      entrance({ referrer: "https://www.example.com/" }),
      [],
      "string",
    ];
    for (const payload of cases) {
      const r = await post(payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json(), JSON.stringify(payload)).toEqual({ version: "1", error: "invalid_request" });
    }
    const bad = await post("{not json");
    expect(bad.statusCode).toBe(400);
    const wrongType = await app.inject({ method: "POST", url: ROUTE, headers: { ...auth, "content-type": "text/plain" }, payload: "ip=1" });
    expect([400, 415]).toContain(wrongType.statusCode);
    expect(wrongType.json().error).toBe("invalid_request");
    expect(runner.jobs.length).toBe(before);
  });

  it("accepts the boundaries of every field rule", async () => {
    const ok = [
      entrance({ page_key: "/" }),
      entrance({ page_key: `/${"a".repeat(255)}` }),
      entrance({ page_key: `/${"é".repeat(255)}` }),
      entrance({ page_key: "/%E2%82%AC/café/\u{1F600}" }),
      entrance({ entrance_id: "A".repeat(16) }),
      entrance({ entrance_id: "z".repeat(64) }),
      entrance({ eligibility: "t".repeat(32) }),
      entrance({ eligibility: "tsa-1.2" }),
      entrance({ occurred_at: "2026-11-03T12:00:00Z" }),
      entrance({ occurred_at: "2026-11-03T12:00:00.123456789Z" }),
      ...["direct", "search", "social", "email", "paid", "referral", "internal", "unknown"].map((acquisition) => entrance({ acquisition })),
    ];
    for (const payload of ok) {
      const r = await post(payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(200);
    }
  });

  it("rejects an occurred_at more than 300 s from resolver time (replay bound) and accepts it within", async () => {
    const at = (offsetMs: number) => entrance({ occurred_at: new Date(NOW + offsetMs).toISOString() });
    for (const offset of [300_001, -300_001, 3_600_000, -86_400_000]) {
      const r = await post(at(offset));
      expect(r.statusCode, String(offset)).toBe(400);
      expect(r.json()).toEqual({ version: "1", error: "invalid_request" });
    }
    for (const offset of [300_000, -300_000, 299_999, 0]) {
      expect((await post(at(offset))).statusCode, String(offset)).toBe(200);
    }
    const rejected = logger.entries.filter((e) => e["event"] === "request_rejected" && e["reason"] === "occurred_at");
    expect(rejected.length).toBeGreaterThanOrEqual(4);
  });

  it("rejects oversized bodies with 413", async () => {
    const r = await post(entrance({ pad: "x".repeat(5000) }));
    expect(r.statusCode).toBe(413);
    expect(r.json()).toEqual({ version: "1", error: "payload_too_large" });
  });

  it("hands the job the IP, the entrance_id as the observation key and the entrance context, and answers with the acknowledgement only", async () => {
    outcomeFor = async () => QUALIFIED_RECORDED;
    const r = await post(entrance());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ version: "1", status: "qualified", source: "provider", recorded: true });
    expect(entranceResponseProblems(r.body, ipVariants(TEST_IP))).toEqual([]);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    const job = runner.jobs.at(-1)!;
    expect(job.ip).toBe(TEST_IP);
    expect(job.observationRef).toBe(ENTRANCE_ID);
    expect(job.context).toEqual({ pageKey: "/pricing", acquisition: "search", entranceContract: "entrance.v1", eligibility: "tsa-1" });
    expect(job.deadlineAtMs).toBe(NOW + testConfig().REQUEST_DEADLINE_MS);
  });

  it("reports recorded=true only for a qualified outcome whose observation is recorded", async () => {
    const cases: Array<[ResolutionOutcome, Record<string, unknown>]> = [
      [{ ...QUALIFIED_RECORDED, source: "cache", reason: "cache_fresh" }, { status: "qualified", source: "cache", recorded: true }],
      [{ ...QUALIFIED_RECORDED, activity: { company_id: 42, previously_seen: null, recorded: false, observation_ref: ENTRANCE_ID } }, { status: "qualified", source: "provider", recorded: false }],
      [{ status: "qualified", source: "provider", reason: "provider_resolved" }, { status: "qualified", source: "provider", recorded: false }],
      [{ status: "no_match", source: "cache", reason: "cache_fresh" }, { status: "no_match", source: "cache", recorded: false }],
      [{ status: "excluded", source: "provider" }, { status: "excluded", source: "provider", recorded: false }],
      [{ status: "ineligible", source: "none", reason: "ip_ineligible" }, { status: "ineligible", source: "none", recorded: false }],
      [{ status: "unavailable", source: "none", reason: "deadline_exceeded" }, { status: "unavailable", source: "none", recorded: false }],
      // A non-qualified outcome can never claim a recorded observation, even if the runner were wrong.
      [{ status: "pending", source: "none", activity: QUALIFIED_RECORDED.activity } as ResolutionOutcome, { status: "pending", source: "none", recorded: false }],
    ];
    for (const [outcome, expected] of cases) {
      outcomeFor = async () => outcome;
      const r = await post(entrance());
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ version: "1", ...expected });
    }
    outcomeFor = async () => QUALIFIED_RECORDED;
  });

  it("never returns company data, even if a runner outcome carried some", async () => {
    outcomeFor = async () =>
      ({
        ...QUALIFIED_RECORDED,
        company: { domain: "example.org", organisation_name: "Example Org", qualification: { category: "ORG", source: "provider_usage_type" }, resolved_at: "2026-01-01T00:00:00.000Z", ipRange: "203.0.113.0/24" },
        fingerprint: "deadbeef",
      }) as unknown as ResolutionOutcome;
    const r = await post(entrance());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ version: "1", status: "qualified", source: "provider", recorded: true });
    expect(entranceResponseProblems(r.body, ["example.org", "Example Org", "ORG", "ipRange", "deadbeef", "42", ...ipVariants(TEST_IP)])).toEqual([]);
    outcomeFor = async () => QUALIFIED_RECORDED;
  });

  it("logs the outcome, the recorded flag and the internal company id, but never the IP, the credential, the entrance_id or the page", async () => {
    await post(entrance({ entrance_id: "ent_logcheck_000000001", page_key: "/secret-launch-page" }));
    const completed = logger.entries.filter((e) => e["event"] === "request_completed").at(-1)!;
    expect(completed).toMatchObject({ route: ROUTE, http_status: 200, status: "qualified", source: "provider", recorded: true, company_id: 42 });
    const text = JSON.stringify(logger.entries);
    for (const needle of [...ipVariants(TEST_IP), TEST_AUTH_TOKEN, "ent_logcheck_000000001", ENTRANCE_ID, "/secret-launch-page", "tsa-1"]) expect(text).not.toContain(needle);
  });

  it("maps overload to 503 overloaded; readiness reflects capacity", async () => {
    const slow = fakeRunner({ capacity: 1, outcome: () => new Promise((resolve) => setTimeout(() => resolve({ status: "no_match", source: "provider" }), 150)) });
    const app2 = await buildServer({ config: testConfig(), logger, runner: slow, ping: async () => true, now });
    const p1 = post(entrance(), auth, app2);
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await post(entrance(), auth, app2);
    expect(r2.statusCode).toBe(503);
    expect(r2.json()).toEqual({ version: "1", error: "overloaded" });
    // Readiness reflects capacity: not ready while every job slot is taken.
    const busy = await app2.inject({ method: "GET", url: "/readyz" });
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toEqual({ ok: false });
    const r1 = await p1;
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ version: "1", status: "no_match", source: "provider", recorded: false });
    expect((await app2.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    await app2.close();
  });

  it("server-side deadline race: answers unavailable at the deadline even if the runner never does", async () => {
    const hang = fakeRunner({ outcome: () => new Promise(() => {}) });
    const cfg = testConfig({ REQUEST_DEADLINE_MS: "400", ENRICH_TIMEOUT_MS: "200", LEASE_MS: "600" });
    const app4 = await buildServer({ config: cfg, logger, runner: hang, ping: async () => true });
    const started = Date.now();
    const r = await post(entrance({ occurred_at: new Date().toISOString() }), auth, app4);
    const elapsed = Date.now() - started;
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ version: "1", status: "unavailable", source: "none", recorded: false });
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(400 + 250);
    await app4.close();
  });

  it("applies the deployment rate limit", async () => {
    const cfg = testConfig({ RATE_LIMIT_PER_MINUTE: "3" });
    const app5 = await buildServer({ config: cfg, logger, runner: fakeRunner(), ping: async () => true, now });
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) codes.push((await post(entrance(), auth, app5)).statusCode);
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
    const before = runner.jobs.length;
    for (const url of ["/%761/entrances", "/%76%31/entrances", "/v1/entrances/", "/V1/entrances", "/v1/entrances?x=1", "/v1/%65ntrances"]) {
      const r = await app.inject({ method: "POST", url, payload: entrance() });
      expect(r.statusCode, url).toBe(401);
      expect(r.json()).toEqual({ version: "1", error: "unauthorized" });
    }
    const unknown = await app.inject({ method: "GET", url: "/admin" });
    expect(unknown.statusCode).toBe(401);
    expect(runner.jobs.length).toBe(before);
  });

  it("the reporting credential never opens the website route", async () => {
    const reportingToken = "test-reporting-token-fedcba9876543210fedcba9876543210";
    const app8 = await buildServer({ config: testConfig({ REPORTING_AUTH_TOKEN: reportingToken }), logger, runner, ping: async () => true, now });
    const before = runner.jobs.length;
    const r = await post(entrance(), { authorization: `Bearer ${reportingToken}`, "content-type": "application/json" }, app8);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ version: "1", error: "unauthorized" });
    expect(runner.jobs.length).toBe(before);
    await app8.close();
  });

  it("the V0.1 POST /v1/resolve route no longer exists", async () => {
    const before = runner.jobs.length;
    const r = await app.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: TEST_IP } });
    expect([400, 404]).toContain(r.statusCode);
    expect(r.json()).toEqual({ version: "1", error: "invalid_request" });
    expect(r.body).not.toContain("company");
    expect(runner.jobs.length).toBe(before);
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
    const app6 = await buildServer({ config: cfg, logger, runner: fakeRunner(), ping: async () => true, now });
    for (let i = 0; i < 10; i += 1) {
      expect((await app6.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      expect((await app6.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    }
    const ok = await post(entrance(), auth, app6);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(ok.headers["x-ratelimit-remaining"]).toBeUndefined();
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) codes.push((await post({}, { authorization: "Bearer wrong", "content-type": "application/json" }, app6)).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    // Exhausted invalid-auth allowance must not lock out a valid credential from the
    // same peer address (callers may share a proxy address): it proceeds to the
    // authenticated controls, here the deployment limit of 2 (one already used).
    expect((await post(entrance(), auth, app6)).statusCode).toBe(200);
    expect((await post(entrance(), auth, app6)).statusCode).toBe(429);
    // Invalid credentials from that peer stay throttled, and a forwarded header
    // cannot change the peer key.
    const stillBad = await post({}, { authorization: "Bearer wrong", "x-forwarded-for": "198.51.100.200", "content-type": "application/json" }, app6);
    expect(stillBad.statusCode).toBe(429);
    await app6.close();
  });

  it("answers requests that arrive during shutdown with the contract error and headers", async () => {
    const app7 = await buildServer({ config: testConfig(), logger, runner: fakeRunner(), ping: async () => true, now });
    await app7.ready();
    const closing = app7.close();
    const r = await post(entrance(), auth, app7).catch(() => null);
    await closing;
    if (r) {
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ version: "1", error: "not_ready" });
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });

  it("rejects unknown routes and methods generically", async () => {
    const r = await app.inject({ method: "GET", url: ROUTE, headers: auth });
    expect([400, 404]).toContain(r.statusCode);
    const r2 = await app.inject({ method: "GET", url: "/admin", headers: auth });
    expect(r2.statusCode).toBe(400);
  });
});
