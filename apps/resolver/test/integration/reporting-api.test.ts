/**
 * Reporting API (v1) over the real reporting repository and PostgreSQL:
 * credential separation, scope from configuration, cursor pagination, UTC
 * date bounds, bounded limits, 404 for companies outside the scope, and no
 * leakage of fingerprints, IPs or provider fields. The website route
 * (POST /v1/entrances) is exercised only to prove credential separation; its
 * contract is covered by test/integration/api.test.ts (V0.1's /v1/resolve
 * activity-field assertions were ported there to entrance_id).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import type { ObservationScope } from "../../src/contracts/db.js";
import type { JobRequest, ResolutionOutcome, Runner } from "../../src/contracts/runtime.js";
import type { Db } from "../../src/db/index.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { createTestDb, resetTestDb, testKey } from "../helpers/db.js";
import { testConfig, TEST_AUTH_TOKEN } from "../helpers/env.js";

const REPORTING_TOKEN = "test-reporting-token-fedcba9876543210fedcba9876543210";
const SCOPE: ObservationScope = { installationId: "inst-test", websiteId: "site-test" };
const OTHER: ObservationScope = { installationId: "inst-test", websiteId: "other-site" };
const T0 = new Date("2026-03-10T00:00:00.000Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const ref = (n: number | string) => `obsref-${String(n).padStart(16, "0")}`;
const TEST_IP = "203.0.113.77";

/** Records jobs and answers no_match; reporting tests never need a real resolution. */
function fakeRunner() {
  const jobs: JobRequest[] = [];
  const runner: Runner & { jobs: JobRequest[] } = {
    jobs,
    activeCount: () => 0,
    capacity: () => 4,
    async run(job): Promise<ResolutionOutcome> {
      jobs.push(job);
      return { status: "no_match", source: "provider" };
    },
    async shutdown() {
      return { drained: true, activeJobs: 0, pendingWrites: 0 };
    },
  };
  return runner;
}

async function seedCompany(db: Db, label: string, domain: string, scope: ObservationScope, observations: { ref: string; at: Date; source?: "cache" | "provider" }[]): Promise<number> {
  const key = testKey(label, { installationId: scope.installationId, websiteId: scope.websiteId });
  const r = await db.cache.reserve(key, { leaseMs: 5_000 }); // lease by database time; T0 below is metadata
  if (r.kind !== "acquired") throw new Error("expected acquired");
  const c = await db.cache.commitResolved(key, r.token, { status: "qualified", company: { domain, organisationName: `${domain} Ltd`, qualificationCategory: "COM" }, checkedAt: T0, ttlMs: 60_000 });
  if (c.kind !== "committed" || c.companyId === null) throw new Error("expected committed");
  for (const o of observations) {
    await db.activity.recordObservation({ scope, companyId: c.companyId, observationRef: o.ref, source: o.source ?? "provider", observedAt: o.at });
  }
  return c.companyId;
}

describe("reporting API", () => {
  let db: Db;
  let app: FastifyInstance;
  let logger: ReturnType<typeof createMemoryLogger>;
  let runner: ReturnType<typeof fakeRunner>;
  const reportingAuth = { authorization: `Bearer ${REPORTING_TOKEN}` };

  beforeAll(async () => {
    db = await createTestDb({ max: 6 });
    logger = createMemoryLogger();
    runner = fakeRunner();
    const config = testConfig({ REPORTING_AUTH_TOKEN: REPORTING_TOKEN });
    app = await buildServer({ config, logger, runner, ping: () => db.ping(), reporting: db.reporting });
    await app.ready();
  });
  beforeEach(async () => {
    await resetTestDb(db);
    runner.jobs.length = 0;
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  const get = (url: string, headers: Record<string, string> = reportingAuth) => app.inject({ method: "GET", url, headers });

  describe("credentials", () => {
    it("rejects the resolver credential, a missing credential and a malformed credential on every reporting route with 401", async () => {
      for (const url of ["/v1/reporting/companies", "/v1/reporting/companies/1", "/v1/reporting/summary?from=2026-03-01&to=2026-03-02"]) {
        expect((await get(url, { authorization: `Bearer ${TEST_AUTH_TOKEN}` })).statusCode).toBe(401);
        expect((await get(url, {})).statusCode).toBe(401);
        expect((await get(url, { authorization: "Bearer nope" })).statusCode).toBe(401);
        expect((await get(url, { authorization: `Bearer ${TEST_AUTH_TOKEN}` })).json()).toEqual({ version: "1", error: "unauthorized" });
      }
    });

    it("rejects the reporting credential on /v1/entrances", async () => {
      const payload = { contract: "entrance.v1", website_id: "site-test", ip: TEST_IP, entrance_id: ref("cred"), occurred_at: new Date().toISOString(), page_key: "/", acquisition: "direct", eligibility: "tsa-1" };
      const r = await app.inject({ method: "POST", url: "/v1/entrances", headers: { authorization: `Bearer ${REPORTING_TOKEN}`, "content-type": "application/json" }, payload });
      expect(r.statusCode).toBe(401);
      expect(runner.jobs).toHaveLength(0);
    });

    it("serves nothing on the reporting routes when REPORTING_AUTH_TOKEN is not configured", async () => {
      const bare = await buildServer({ config: testConfig(), logger: createMemoryLogger(), runner, ping: () => db.ping(), reporting: db.reporting });
      await bare.ready();
      try {
        await seedCompany(db, "a", "example.com", SCOPE, [{ ref: ref(1), at: at(0) }]);
        const noCred = await bare.inject({ method: "GET", url: "/v1/reporting/companies" });
        expect(noCred.statusCode).toBe(401);
        // The routes do not exist: the generic unknown-route answer, never data.
        const resolverCred = await bare.inject({ method: "GET", url: "/v1/reporting/companies", headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}` } });
        expect(resolverCred.statusCode).toBe(404);
        expect(resolverCred.json()).toEqual({ version: "1", error: "not_found" });
        expect(resolverCred.body).not.toContain("example.com");
      } finally {
        await bare.close();
      }
    });

    it("refuses to start when the reporting credential equals the resolver credential", () => {
      expect(() => testConfig({ REPORTING_AUTH_TOKEN: TEST_AUTH_TOKEN })).toThrow(/REPORTING_AUTH_TOKEN/);
    });
  });

  describe("companies", () => {
    it("enumerates companies in the configured scope by id (default, stable) and by recent activity on request", async () => {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) ids.push(await seedCompany(db, `c${i}`, `company-${i}.example`, SCOPE, [{ ref: ref(i), at: at(i * 1_000) }]));
      const foreign = await seedCompany(db, "foreign", "foreign.example", OTHER, [{ ref: ref("f"), at: at(99_000) }]);

      const p1 = await get("/v1/reporting/companies?limit=2");
      expect(p1.statusCode).toBe(200);
      const b1 = p1.json();
      expect(b1).toMatchObject({ version: "1", order: "id", scope: { installation_id: "inst-test", website_id: "site-test" } });
      expect(b1.items.map((c: { company_id: number }) => c.company_id)).toEqual([ids[0], ids[1]]);
      expect(b1.items[0]).toEqual({
        company_id: ids[0],
        domain: "company-0.example",
        organisation_name: "company-0.example Ltd",
        first_observed_at: at(0).toISOString(),
        last_observed_at: at(0).toISOString(),
        observation_count: 1,
      });
      expect(typeof b1.next_cursor).toBe("string");
      expect(b1.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);

      // An unseen company (index 3) becomes the most recently active between pages (Warp P2-4): still enumerated exactly once.
      await db.activity.recordObservation({ scope: SCOPE, companyId: ids[3]!, observationRef: ref("late"), source: "cache", observedAt: at(500_000) });
      const p2 = await get(`/v1/reporting/companies?limit=2&cursor=${b1.next_cursor}`);
      expect(p2.json().items.map((c: { company_id: number }) => c.company_id)).toEqual([ids[2], ids[3]]);
      const p3 = await get(`/v1/reporting/companies?limit=2&cursor=${p2.json().next_cursor}`);
      expect(p3.json().items.map((c: { company_id: number }) => c.company_id)).toEqual([ids[4]]);
      expect(p3.json().next_cursor).toBeNull();

      const all = await get("/v1/reporting/companies");
      expect(all.json().items.map((c: { company_id: number }) => c.company_id)).toEqual(ids);
      expect(all.body).not.toContain("foreign.example");
      expect(all.json().items.map((c: { company_id: number }) => c.company_id)).not.toContain(foreign);

      // Display order: most recent first, with its own cursor shape.
      const recent = await get("/v1/reporting/companies?order=recent&limit=2");
      expect(recent.json()).toMatchObject({ order: "recent" });
      expect(recent.json().items.map((c: { company_id: number }) => c.company_id)).toEqual([ids[3], ids[4]]);
      const recent2 = await get(`/v1/reporting/companies?order=recent&limit=2&cursor=${recent.json().next_cursor}`);
      expect(recent2.json().items.map((c: { company_id: number }) => c.company_id)).toEqual([ids[2], ids[1]]);
      // A cursor from one order is refused by the other.
      expect((await get(`/v1/reporting/companies?order=id&cursor=${recent.json().next_cursor}`)).statusCode).toBe(400);
      expect((await get(`/v1/reporting/companies?order=recent&cursor=${b1.next_cursor}`)).statusCode).toBe(400);
      expect((await get("/v1/reporting/companies?order=name")).statusCode).toBe(400);
    });

    it("rejects out-of-range limits, malformed cursors and unknown query keys with 400", async () => {
      for (const q of ["limit=0", "limit=101", "limit=abc", "limit=1.5", "cursor=not%20base64url!", "cursor=" + Buffer.from('{"t":1}').toString("base64url"), "cursor=" + Buffer.from('{"t":-1,"c":1}').toString("base64url"), "cursor=" + Buffer.from('"x"').toString("base64url"), "cursor=" + Buffer.from('{"t":9000000000000000,"c":1}').toString("base64url"), "cursor=" + Buffer.from('{"t":1,"c":0}').toString("base64url"), "cursor=" + Buffer.from('{"t":1,"c":1,"x":1}').toString("base64url"), "foo=bar", "cursor=" + "A".repeat(129)]) {
        const r = await get(`/v1/reporting/companies?${q}`);
        expect(r.statusCode, q).toBe(400);
        expect(r.json()).toEqual({ version: "1", error: "invalid_request" });
      }
    });
  });

  describe("company detail", () => {
    it("returns the company with paginated observations, and 404 for companies outside the scope or unknown", async () => {
      const id = await seedCompany(db, "a", "example.com", SCOPE, [
        { ref: ref(1), at: at(0) },
        { ref: ref(2), at: at(1_000), source: "cache" },
        { ref: ref(3), at: at(2_000), source: "cache" },
      ]);
      const foreign = await seedCompany(db, "foreign", "foreign.example", OTHER, [{ ref: ref("f"), at: at(0) }]);

      const r = await get(`/v1/reporting/companies/${id}?limit=2`);
      expect(r.statusCode).toBe(200);
      const b = r.json();
      expect(b.company).toMatchObject({ company_id: id, domain: "example.com", observation_count: 3 });
      expect(b.observations).toEqual([
        { observation_id: expect.any(Number), observed_at: at(2_000).toISOString(), source: "cache", observation_ref: ref(3), company_first: false },
        { observation_id: expect.any(Number), observed_at: at(1_000).toISOString(), source: "cache", observation_ref: ref(2), company_first: false },
      ]);
      const r2 = await get(`/v1/reporting/companies/${id}?limit=2&cursor=${b.next_cursor}`);
      expect(r2.json().observations.map((o: { observation_ref: string; company_first: boolean }) => [o.observation_ref, o.company_first])).toEqual([[ref(1), true]]);
      expect(r2.json().next_cursor).toBeNull();

      for (const url of [`/v1/reporting/companies/${foreign}`, "/v1/reporting/companies/987654321", "/v1/reporting/companies/0", "/v1/reporting/companies/abc", "/v1/reporting/companies/1?cursor=" + b.next_cursor + "x"]) {
        const bad = await get(url);
        expect([400, 404], url).toContain(bad.statusCode);
        expect(bad.body).not.toContain("foreign.example");
      }
      expect((await get(`/v1/reporting/companies/${foreign}`)).json()).toEqual({ version: "1", error: "not_found" });
      expect((await get("/v1/reporting/companies/987654321")).statusCode).toBe(404);
      expect((await get("/v1/reporting/companies/0")).statusCode).toBe(400);
    });
  });

  describe("summary", () => {
    it("counts over inclusive UTC calendar dates and rejects invalid ranges", async () => {
      const a = await seedCompany(db, "a", "a.example", SCOPE, [{ ref: ref("a1"), at: new Date("2026-03-10T23:59:59.999Z") }]);
      await seedCompany(db, "b", "b.example", SCOPE, [{ ref: ref("b1"), at: new Date("2026-03-11T00:00:00.000Z") }]);
      await db.activity.recordObservation({ scope: SCOPE, companyId: a, observationRef: ref("a2"), source: "cache", observedAt: new Date("2026-03-11T12:00:00.000Z") });
      await seedCompany(db, "foreign", "foreign.example", OTHER, [{ ref: ref("f"), at: new Date("2026-03-11T12:00:00.000Z") }]);

      const d10 = await get("/v1/reporting/summary?from=2026-03-10&to=2026-03-10");
      expect(d10.statusCode).toBe(200);
      expect(d10.json()).toEqual({ version: "1", scope: { installation_id: "inst-test", website_id: "site-test" }, from: "2026-03-10", to: "2026-03-10", observations: 1, observed_companies: 1, newly_observed_companies: 1, previously_observed_companies: 0 });
      const d11 = await get("/v1/reporting/summary?from=2026-03-11&to=2026-03-11");
      expect(d11.json()).toMatchObject({ observations: 2, observed_companies: 2, newly_observed_companies: 1, previously_observed_companies: 1 });
      const both = await get("/v1/reporting/summary?from=2026-03-10&to=2026-03-11");
      expect(both.json()).toMatchObject({ observations: 3, observed_companies: 2, newly_observed_companies: 2, previously_observed_companies: 0 });
      const empty = await get("/v1/reporting/summary?from=2026-03-12&to=2026-03-12");
      expect(empty.json()).toMatchObject({ observations: 0, observed_companies: 0, newly_observed_companies: 0, previously_observed_companies: 0 });
      // A full year is allowed; a day more is not.
      expect((await get("/v1/reporting/summary?from=2025-03-12&to=2026-03-12")).statusCode).toBe(200);
      expect((await get("/v1/reporting/summary?from=2025-03-11&to=2026-03-12")).statusCode).toBe(400);
      for (const q of ["from=2026-03-11&to=2026-03-10", "from=2026-02-30&to=2026-03-01", "from=2026-3-1&to=2026-03-02", "from=2026-03-01", "to=2026-03-01", "from=2026-03-01T00:00:00Z&to=2026-03-02", "from=2026-03-01&to=2026-03-02&limit=5"]) {
        const r = await get(`/v1/reporting/summary?${q}`);
        expect(r.statusCode, q).toBe(400);
      }
    });
  });

  describe("leakage", () => {
    it("reporting responses and logs carry no fingerprint, IP, provider field or credential", async () => {
      const id = await seedCompany(db, "a", "example.com", SCOPE, [{ ref: ref(1), at: at(0) }]);
      const fingerprintHex = (await db.pool.query<{ fp: string }>("SELECT encode(ip_fingerprint, 'hex') AS fp FROM ip_resolution_cache")).rows[0]!.fp;
      const logStart = logger.entries.length;
      const bodies = [
        (await get("/v1/reporting/companies")).body,
        (await get(`/v1/reporting/companies/${id}`)).body,
        (await get("/v1/reporting/summary?from=2026-03-10&to=2026-03-11")).body,
      ].join("\n");
      const haystack = bodies + "\n" + JSON.stringify(logger.entries.slice(logStart));
      for (const needle of [fingerprintHex, fingerprintHex.slice(0, 16), TEST_IP, "ip_fingerprint", "ipRange", "ipIsp", "usageType", REPORTING_TOKEN, TEST_AUTH_TOKEN]) {
        expect(haystack, needle).not.toContain(needle);
      }
      const keys = new Set<string>();
      expect(JSON.parse(bodies.split("\n")[0]!).order).toBe("id");
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
      };
      for (const b of bodies.split("\n")) walk(JSON.parse(b));
      expect([...keys].sort()).toEqual([
        "company",
        "company_first",
        "company_id",
        "domain",
        "first_observed_at",
        "from",
        "installation_id",
        "items",
        "last_observed_at",
        "newly_observed_companies",
        "next_cursor",
        "observation_count",
        "observation_id",
        "observation_ref",
        "observations",
        "observed_at",
        "observed_companies",
        "order",
        "organisation_name",
        "previously_observed_companies",
        "scope",
        "source",
        "to",
        "version",
        "website_id",
      ]);
    });
  });
});
