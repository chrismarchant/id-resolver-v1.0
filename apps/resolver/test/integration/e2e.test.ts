/**
 * Vertical slice for the website route: POST /v1/entrances (entrance.v1) ->
 * in-process runner -> pipeline -> mock Enrich server -> PostgreSQL.
 * Everything is real except the provider, which is the in-repo mock server.
 * Every response is checked against the acknowledgement-only contract (D2).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { buildPipelineConfig, createRunner } from "../../src/runtime/runner.js";
import { createProvider } from "../../src/provider/index.js";
import type { Config } from "../../src/config/index.js";
import { startMockEnrichServer, SPECIAL_IPS, type MockServerHandle } from "../../src/provider/mock-server.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";
import { testConfig, TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";
import { dumpDatabaseText, entranceResponseProblems, findLeaks, FORBIDDEN_PROVIDER_FIELDS, ipVariants } from "../helpers/leak-scan.js";
import type { Db } from "../../src/db/index.js";
import type { Runner } from "../../src/contracts/runtime.js";
import { usagePeriodKey } from "../../src/contracts/db.js";

const QUALIFIED_IP = "203.0.113.10";
const EXCLUDED_IP = "203.0.113.11";
const NO_DOMAIN_IP = "203.0.113.13";
const ALL_TEST_IPS = [
  QUALIFIED_IP,
  EXCLUDED_IP,
  NO_DOMAIN_IP,
  "203.0.113.12",
  "203.0.113.14",
  "203.0.113.15",
  "2001:db8::10",
  ...Array.from({ length: 6 }, (_, i) => `203.0.113.${20 + i}`),
  ...Object.values(SPECIAL_IPS),
];
/** Company data the mock provider returns; none of it may ever reach a response (D2). */
const COMPANY_NEEDLES = ["example.com", "Example Ltd", "example.edu", "Example University", "example.org", "Example Org", "example-isp.net", "Example Broadband"];
const ENTRANCE_KEYS = ["recorded", "source", "status", "version"];

describe("end-to-end vertical slice", () => {
  let db: Db;
  let mock: MockServerHandle;
  let app: FastifyInstance;
  let manager: Runner;
  let logger: ReturnType<typeof createMemoryLogger>;
  // The mock server and logger live for the whole file; tests reason about deltas.
  const baseline = new Map<string, number>();
  let logStart = 0;
  const hits = (ip: string) => mock.hits(ip) - (baseline.get(ip) ?? 0);
  const logs = () => logger.entries.slice(logStart);
  const auth = { authorization: `Bearer ${TEST_AUTH_TOKEN}`, "content-type": "application/json" };
  const scope = { installationId: "inst-test", websiteId: "site-test", periodKey: usagePeriodKey("month", new Date()) };

  const newEntranceId = () => randomBytes(12).toString("base64url");
  const entranceBody = (ip: string, over: Record<string, unknown> = {}) => ({
    contract: "entrance.v1",
    website_id: "site-test",
    ip,
    entrance_id: newEntranceId(),
    occurred_at: new Date().toISOString(),
    page_key: "/pricing",
    acquisition: "search",
    eligibility: "tsa-1",
    ...over,
  });
  /** Every 200 response must be exactly the acknowledgement, with no company data or echoed input. */
  async function enter(ip: string, over: Record<string, unknown> = {}, target?: FastifyInstance) {
    const r = await (target ?? app).inject({ method: "POST", url: "/v1/entrances", headers: auth, payload: entranceBody(ip, over) });
    if (r.statusCode === 200) {
      expect(Object.keys(r.json()).sort()).toEqual(ENTRANCE_KEYS);
      expect(entranceResponseProblems(r.body, [...ALL_TEST_IPS.flatMap(ipVariants), ...COMPANY_NEEDLES])).toEqual([]);
    }
    return { status: r.statusCode, body: r.json() as Record<string, unknown>, raw: r.body };
  }
  const resolve = (ip: string) => enter(ip);

  /** The runner exactly as src/main.ts builds it, over the shared test pool. */
  function runnerFor(config: Config): Runner {
    const pipeline = buildPipelineConfig(config);
    return createRunner({
      config: pipeline,
      deps: { cache: db.cache, usage: db.usage, controls: db.controls, companies: db.companies, activity: db.activity, provider: createProvider(pipeline.provider) },
      logger,
      capacity: config.MAX_CONCURRENT_JOBS,
    });
  }

  beforeAll(async () => {
    db = await createTestDb({ max: 12 });
    mock = await startMockEnrichServer({ slowMs: 5_000 });
    logger = createMemoryLogger();
    const config = testConfig({ PROVIDER_MODE: "live", ENRICH_API_BASE_URL: mock.url, ENRICH_API_KEY: "sk_test_placeholder_key", PERIOD_CALL_CAP: "50" });
    manager = runnerFor(config);
    app = await buildServer({ config, logger, runner: manager, ping: () => db.ping() });
    await app.ready();
  });

  beforeEach(async () => {
    await resetTestDb(db);
    for (const ip of ALL_TEST_IPS) baseline.set(ip, mock.hits(ip));
    logStart = logger.entries.length;
  });

  afterAll(async () => {
    await app.close();
    await manager.shutdown(2_000);
    await mock.close();
    await db.close();
  });

  it("identifies a qualified company in-process, acknowledges it without company data, and persists only sanitised data", async () => {
    const first = await resolve(QUALIFIED_IP);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ version: "1", status: "qualified", source: "provider", recorded: true });
    expect(hits(QUALIFIED_IP)).toBe(1);

    const second = await resolve(QUALIFIED_IP);
    expect(second.body).toEqual({ version: "1", status: "qualified", source: "cache", recorded: true });
    expect(hits(QUALIFIED_IP)).toBe(1);

    const snapshot = await db.usage.snapshot(scope);
    expect(snapshot.provider_attempts).toBe(1);
    expect(snapshot.qualified_matches).toBe(1);
    expect(snapshot.cache_hits).toBe(1);
    expect(snapshot.resolver_requests).toBe(2);
    expect(snapshot.providerCreditsReported).toBe(100);
    expect(snapshot.providerCreditsEstimated).toBe(100);
  });

  it("deduplicates equivalent IP representations into one provider call", async () => {
    const forms = ["2001:db8::10", "2001:DB8:0:0:0:0:0:10", "2001:db8:0000::0010", "[2001:db8::10]".slice(1, -1)];
    for (const f of forms) {
      const r = await resolve(f);
      expect(r.status).toBe(200);
      expect(r.body["status"]).toBe("qualified");
    }
    expect(hits("2001:db8::10")).toBe(1);
    const mapped = await resolve("::ffff:203.0.113.10");
    expect(mapped.body["status"]).toBe("qualified");
    expect(hits(QUALIFIED_IP)).toBe(1);
    expect(mapped.body["source"]).toBe("provider");
    const again = await resolve(QUALIFIED_IP);
    expect(again.body["source"]).toBe("cache");
    expect(hits(QUALIFIED_IP)).toBe(1);
    const rows = await db.pool.query("SELECT count(*)::int AS n FROM ip_resolution_cache");
    expect(rows.rows[0].n).toBe(2);
  });

  it("a concurrent same-IP burst produces exactly one provider attempt", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => resolve(EXCLUDED_IP)));
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(["excluded", "pending"]).toContain(r.body["status"]);
      expect(r.body["recorded"]).toBe(false);
    }
    expect(hits(EXCLUDED_IP)).toBe(1);
    expect(results.some((r) => r.body["status"] === "excluded")).toBe(true);
    const snapshot = await db.usage.snapshot(scope);
    expect(snapshot.provider_attempts).toBe(1);
    const cached = await resolve(EXCLUDED_IP);
    expect(cached.body["status"]).toBe("excluded");
    expect(cached.body["source"]).toBe("cache");
    expect(hits(EXCLUDED_IP)).toBe(1);
  });

  it("caches no-match outcomes and suppresses repeated calls", async () => {
    const r1 = await resolve(NO_DOMAIN_IP);
    expect(r1.body["status"]).toBe("no_match");
    const r2 = await resolve(NO_DOMAIN_IP);
    expect(r2.body["status"]).toBe("no_match");
    expect(r2.body["source"]).toBe("cache");
    expect(hits(NO_DOMAIN_IP)).toBe(1);
    const snapshot = await db.usage.snapshot(scope);
    expect(snapshot.providerCreditsEstimated).toBe(0);
    expect(snapshot.no_matches).toBe(1);
  });

  it("treats a provider timeout as uncertain and does not retry immediately", async () => {
    const t0 = Date.now();
    const r1 = await resolve(SPECIAL_IPS.slow);
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(r1.body["status"]).toBe("uncertain");
    const r2 = await resolve(SPECIAL_IPS.slow);
    expect(r2.body["status"]).toBe("uncertain");
    expect(r2.body["source"]).toBe("cache");
    expect(hits(SPECIAL_IPS.slow)).toBe(1);
    const snapshot = await db.usage.snapshot(scope);
    expect(snapshot.uncertain_outcomes).toBe(1);
    expect(snapshot.provider_attempts).toBe(1);
  });

  it("persists the uncertain outcome even when the request deadline, not the provider timeout, is the binding limit", async () => {
    // Deadline 1300 ms with a 1 s provider timeout: the deadline-derived budget (deadline minus the 550 ms commit reserve) governs.
    const config = testConfig({ PROVIDER_MODE: "live", ENRICH_API_BASE_URL: mock.url, ENRICH_API_KEY: "sk_test_placeholder_key", REQUEST_DEADLINE_MS: "1300", ENRICH_TIMEOUT_MS: "1000", LEASE_MS: "3000", SHUTDOWN_GRACE_MS: "2000" });
    const m3 = runnerFor(config);
    const app3 = await buildServer({ config, logger, runner: m3, ping: () => db.ping() });
    const r1 = await enter(SPECIAL_IPS.slow, {}, app3);
    expect(r1.body).toEqual({ version: "1", status: "uncertain", source: "provider", recorded: false });
    const rows = await db.pool.query<{ status: string }>("SELECT status FROM ip_resolution_cache");
    expect(rows.rows.map((r) => r.status)).toEqual(["uncertain"]);
    const r2 = await enter(SPECIAL_IPS.slow, {}, app3);
    expect(r2.body).toMatchObject({ status: "uncertain", source: "cache" });
    expect(hits(SPECIAL_IPS.slow)).toBe(1);
    await app3.close();
    await m3.shutdown(1_000);
  });

  it("defaults safely on provider failures and malformed responses, with bounded backoff", async () => {
    for (const ip of [SPECIAL_IPS.serverError, SPECIAL_IPS.rateLimited, SPECIAL_IPS.unauthorized, SPECIAL_IPS.paymentRequired, SPECIAL_IPS.malformedJson, SPECIAL_IPS.missingData, SPECIAL_IPS.oversized]) {
      const r = await resolve(ip);
      expect(r.status, ip).toBe(200);
      expect(r.body["status"], ip).toBe("unavailable");
      expect(r.body["recorded"]).toBe(false);
      const again = await resolve(ip);
      expect(again.body["status"], ip).toBe("unavailable");
      expect(hits(ip), ip).toBe(1);
    }
    const snapshot = await db.usage.snapshot(scope);
    expect(snapshot.failures).toBe(7);
  });

  it("never enriches ineligible addresses", async () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "::1", "fe80::1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "169.254.1.1"]) {
      const r = await resolve(ip);
      expect(r.status, ip).toBe(200);
      expect(r.body["status"], ip).toBe("ineligible");
    }
    const rows = await db.pool.query("SELECT count(*)::int AS n FROM ip_resolution_cache");
    expect(rows.rows[0].n).toBe(0);
  });

  it("honours the call cap under concurrency and keeps serving the cache", async () => {
    const config = testConfig({ PROVIDER_MODE: "live", ENRICH_API_BASE_URL: mock.url, ENRICH_API_KEY: "sk_test_placeholder_key", PERIOD_CALL_CAP: "2", MAX_CONCURRENT_JOBS: "6" });
    const m2 = runnerFor(config);
    const app2 = await buildServer({ config, logger, runner: m2, ping: () => db.ping() });
    const ips = ["203.0.113.10", "203.0.113.11", "203.0.113.12", "203.0.113.13", "203.0.113.14"];
    const results = await Promise.all(ips.map((ip) => enter(ip, {}, app2)));
    const statuses = results.map((r) => r.body["status"] as string);
    expect(statuses.filter((s) => s === "disabled").length).toBe(3);
    const snapshot = await db.usage.snapshot(scope);
    expect(snapshot.provider_attempts).toBe(2);
    expect(ips.reduce((n, ip) => n + hits(ip), 0)).toBe(2);
    // Cache still served when the cap is exhausted.
    const servedIp = ips.find((ip, i) => statuses[i] !== "disabled")!;
    const cached = await enter(servedIp, {}, app2);
    expect(cached.body["source"]).toBe("cache");
    // The released reservations leave no live lease behind.
    const pending = await db.pool.query("SELECT count(*)::int AS n FROM ip_resolution_cache WHERE status = 'pending'");
    expect(pending.rows[0].n).toBe(0);
    await app2.close();
    await m2.shutdown(1_000);
  });

  it("stops paid calls when the runtime kill switch is engaged, cache still served", async () => {
    await resolve(QUALIFIED_IP);
    await db.controls.setEnrichmentEnabled("inst-test", false, "e2e");
    const r = await resolve(NO_DOMAIN_IP);
    expect(r.body["status"]).toBe("disabled");
    expect(hits(NO_DOMAIN_IP)).toBe(0);
    const cached = await resolve(QUALIFIED_IP);
    expect(cached.body["status"]).toBe("qualified");
    expect(cached.body["source"]).toBe("cache");
    await db.controls.setEnrichmentEnabled("inst-test", true, "e2e");
  });

  it("jobs settle and free their slots; concurrency stays bounded; excess load gets 503 overloaded", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => enter(`203.0.113.${20 + i}`)));
    for (const r of results) expect([200, 503]).toContain(r.status);
    for (const r of results.filter((x) => x.status === 503)) expect(r.body).toEqual({ version: "1", error: "overloaded" });
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.activeCount()).toBe(0);
    const started = logs().filter((e) => e["event"] === "job_started").map((e) => e["active_jobs"] as number);
    expect(started.length).toBeGreaterThan(0);
    expect(Math.max(...started)).toBeLessThanOrEqual(4);
  });

  it("leaks no test IP, secret, company data or provider-only field into logs, database or responses", async () => {
    const responses: string[] = [];
    for (const ip of [QUALIFIED_IP, EXCLUDED_IP, NO_DOMAIN_IP, "2001:db8::10", SPECIAL_IPS.serverError]) {
      responses.push((await resolve(ip)).raw);
      responses.push((await resolve(ip)).raw);
    }
    const needles = [
      ...ALL_TEST_IPS.flatMap(ipVariants),
      "2001:DB8:0:0:0:0:0:10",
      TEST_AUTH_TOKEN,
      TEST_HMAC_SECRET,
      "sk_test_placeholder_key",
      "Example Transit Networks",
      "203.0.113.0/24",
      ...FORBIDDEN_PROVIDER_FIELDS,
    ];
    const logText = JSON.stringify(logger.entries);
    expect(findLeaks(logText, needles)).toEqual([]);
    const dbText = await dumpDatabaseText(db.pool);
    expect(findLeaks(dbText, needles)).toEqual([]);
    expect(findLeaks(responses.join("\n"), [...needles, ...COMPANY_NEEDLES])).toEqual([]);
    for (const raw of responses) expect(entranceResponseProblems(raw, needles)).toEqual([]);
    expect(logText).toContain("job_finished");
    // Fingerprints never appear in responses or logs.
    const fps = await db.pool.query<{ hex: string }>("SELECT encode(ip_fingerprint, 'hex') AS hex FROM ip_resolution_cache");
    for (const { hex } of fps.rows) {
      expect(responses.join("\n")).not.toContain(hex);
      expect(logText).not.toContain(hex);
    }
  });

  describe("durable company activity", () => {
    const REF = (n: number) => `e2e-ref-${String(n).padStart(16, "0")}`;
    const observationRows = () =>
      db.pool.query<{ company_id: string; source: string; observation_ref: string; previously_seen: boolean; page_key: string | null; acquisition: string | null; entrance_contract: string | null; eligibility: string | null }>(
        `SELECT o.company_id, o.source, o.observation_ref, r.previously_seen, o.page_key, o.acquisition, o.entrance_contract, o.eligibility
         FROM company_observations o
         JOIN company_observation_refs r USING (installation_id, website_id, observation_ref) ORDER BY o.id`,
      );
    const resolveRef = (ip: string, entranceId: string, over: Record<string, unknown> = {}) => enter(ip, { entrance_id: entranceId, ...over });

    it("records the provider result, then a cache hit, with no second provider attempt; each observation carries its entrance context", async () => {
      const first = await resolveRef(QUALIFIED_IP, REF(1), { page_key: "/pricing", acquisition: "search", eligibility: "tsa-1" });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ version: "1", status: "qualified", source: "provider", recorded: true });
      const second = await resolveRef(QUALIFIED_IP, REF(2), { page_key: "/about/team", acquisition: "direct", eligibility: "tsa-2.1" });
      expect(second.body).toEqual({ version: "1", status: "qualified", source: "cache", recorded: true });
      expect(hits(QUALIFIED_IP)).toBe(1);
      const rows = await observationRows();
      const companyId = rows.rows[0]!.company_id;
      expect(rows.rows).toEqual([
        { company_id: companyId, source: "provider", observation_ref: REF(1), previously_seen: false, page_key: "/pricing", acquisition: "search", entrance_contract: "entrance.v1", eligibility: "tsa-1" },
        { company_id: companyId, source: "cache", observation_ref: REF(2), previously_seen: true, page_key: "/about/team", acquisition: "direct", entrance_contract: "entrance.v1", eligibility: "tsa-2.1" },
      ]);
      const company = await db.pool.query<{ last_seen_at: Date; first_seen_at: Date; domain: string }>("SELECT domain, first_seen_at, last_seen_at FROM companies WHERE id = $1", [companyId]);
      expect(company.rows[0]!.domain).toBe("example.com");
      expect(company.rows[0]!.last_seen_at.getTime()).toBeGreaterThanOrEqual(company.rows[0]!.first_seen_at.getTime());
      const stats = await db.pool.query<{ observation_count: string }>("SELECT observation_count FROM company_scope_stats WHERE company_id = $1", [companyId]);
      expect(stats.rows[0]!.observation_count).toBe("2");
      // The commit-safe feed position is set by the inserting transaction (0005).
      const txids = await db.pool.query<{ ok: boolean }>("SELECT bool_and(txid IS NOT NULL) AS ok FROM company_observations");
      expect(txids.rows[0]!.ok).toBe(true);
      const snapshot = await db.usage.snapshot(scope);
      expect(snapshot.provider_attempts).toBe(1);
    });

    it("the entrance_id is the idempotency key: a retried entrance records no second observation and still acknowledges recorded=true", async () => {
      const first = await resolveRef(QUALIFIED_IP, REF(3));
      expect(first.body).toEqual({ version: "1", status: "qualified", source: "provider", recorded: true });
      for (let i = 0; i < 3; i += 1) {
        const retry = await resolveRef(QUALIFIED_IP, REF(3), { page_key: "/retried-page" });
        expect(retry.body).toEqual({ version: "1", status: "qualified", source: "cache", recorded: true });
      }
      const rows = await observationRows();
      expect(rows.rows).toHaveLength(1);
      // The original observation (and its context) is kept unchanged.
      expect(rows.rows[0]).toMatchObject({ observation_ref: REF(3), page_key: "/pricing" });
      const stats = await db.pool.query<{ observation_count: string }>("SELECT observation_count FROM company_scope_stats");
      expect(stats.rows[0]!.observation_count).toBe("1");
      // A new entrance_id from the same visitor address is a new observation.
      await resolveRef(QUALIFIED_IP, REF(4));
      expect((await observationRows()).rows).toHaveLength(2);
    });

    it("pending followers sharing the caller's entrance_id insert exactly one observation", async () => {
      const results = await Promise.all(Array.from({ length: 4 }, () => resolveRef(QUALIFIED_IP, REF(7))));
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(["qualified", "pending"]).toContain(r.body["status"]);
        expect(r.body["recorded"]).toBe(r.body["status"] === "qualified");
      }
      expect(hits(QUALIFIED_IP)).toBe(1);
      expect(results.some((r) => r.body["status"] === "qualified")).toBe(true);
      const rows = await observationRows();
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ observation_ref: REF(7), previously_seen: false });
    });

    it("excluded, no-match and ineligible outcomes create no company and no observation", async () => {
      await resolveRef(EXCLUDED_IP, REF(1));
      await resolveRef(EXCLUDED_IP, REF(2));
      await resolveRef(NO_DOMAIN_IP, REF(3));
      const ineligible = await resolveRef("10.1.2.3", REF(4));
      expect(ineligible.body).toEqual({ version: "1", status: "ineligible", source: "none", recorded: false });
      const r = await resolveRef(EXCLUDED_IP, REF(5));
      expect(r.body).toEqual({ version: "1", status: "excluded", source: "cache", recorded: false });
      expect((await observationRows()).rows).toEqual([]);
      expect((await db.pool.query("SELECT count(*)::int AS n FROM companies")).rows[0].n).toBe(0);
      expect((await db.pool.query("SELECT count(*)::int AS n FROM company_scope_stats")).rows[0].n).toBe(0);
    });

    it("a different address resolving to the same domain reuses the company id and keeps the records across cache pruning", async () => {
      await resolveRef(QUALIFIED_IP, REF(1));
      await resolveRef("::ffff:203.0.113.10", REF(2)); // same canonical address: cache hit
      await db.pool.query("UPDATE ip_resolution_cache SET expires_at = now() - interval '1 second'");
      expect(await db.cache.pruneExpired(100)).toBe(1);
      const c = await resolveRef(QUALIFIED_IP, REF(3)); // provider again (cache gone), same company
      expect(c.body).toEqual({ version: "1", status: "qualified", source: "provider", recorded: true });
      expect(hits(QUALIFIED_IP)).toBe(2);
      const rows = (await observationRows()).rows;
      expect(new Set(rows.map((x) => x.company_id)).size).toBe(1);
      expect(rows.map((x) => x.previously_seen)).toEqual([false, true, true]);
      expect((await db.pool.query("SELECT count(*)::int AS n FROM companies")).rows[0].n).toBe(1);
    });

    it("delayed usage accounting in the runner cannot consume the activity or response budget (Warp P2-3)", async () => {
      const first = await resolveRef(QUALIFIED_IP, REF(1)); // provider path: creates the usage row and the cache row
      expect(first.body["status"]).toBe("qualified");
      const locker = await db.pool.connect();
      try {
        await locker.query("BEGIN");
        const locked = await locker.query("SELECT 1 FROM usage_periods WHERE installation_id = $1 AND website_id = $2 AND period_key = $3 FOR UPDATE", [scope.installationId, scope.websiteId, scope.periodKey]);
        expect(locked.rowCount).toBe(1);
        const t0 = Date.now();
        const r = await resolveRef(QUALIFIED_IP, REF(2)); // every counter write now blocks behind the lock
        expect(Date.now() - t0).toBeLessThan(2_000); // REQUEST_DEADLINE_MS in the test config
        expect(r.body).toEqual({ version: "1", status: "qualified", source: "cache", recorded: true });
        expect(hits(QUALIFIED_IP)).toBe(1);
        const rows = (await observationRows()).rows;
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ observation_ref: REF(2), previously_seen: true });
        // In-process, the pipeline's own log lines are visible here too.
        expect(logs().some((e) => e["event"] === "db_error" && e["category"] === "usage_counter_timeout")).toBe(true);
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        locker.release();
      }
      // The job settles and frees its slot; the delayed counters are tracked as background writes.
      const until = Date.now() + 4_000;
      while (manager.activeCount() > 0 && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
      expect(manager.activeCount()).toBe(0);
    });

    it("an observation write past the deadline is not cancelled: the answer says recorded=false (not confirmed), then the observation commits and the feed serves it (CHR-66 F4)", async () => {
      const first = await resolveRef(QUALIFIED_IP, REF(1)); // provider path: creates the company and the cache row
      expect(first.body).toEqual({ version: "1", status: "qualified", source: "provider", recorded: true });
      const companyId = (await observationRows()).rows[0]!.company_id;
      const lateRef = REF(2);
      const lateRow = () => db.pool.query<{ id: string; company_id: string; page_key: string }>("SELECT id::text AS id, company_id, page_key FROM company_observations WHERE observation_ref = $1", [lateRef]);
      // Hold the company row lock past the request deadline: the cache-hit observation write blocks on it.
      const locker = await db.pool.connect();
      let committed = false;
      try {
        await locker.query("BEGIN");
        expect((await locker.query("SELECT 1 FROM companies WHERE id = $1 FOR UPDATE", [companyId])).rowCount).toBe(1);
        const t0 = Date.now();
        const late = await resolveRef(QUALIFIED_IP, lateRef, { page_key: "/late-write" });
        expect(Date.now() - t0).toBeLessThan(2_000); // REQUEST_DEADLINE_MS in the test config
        // Answered by the deadline, honestly: not confirmed.
        expect(late.body).toEqual({ version: "1", status: "qualified", source: "cache", recorded: false });
        expect(logs().some((e) => e["event"] === "activity_write_failed" && e["reason"] === "deadline_exceeded")).toBe(true);
        // At answer time nothing is stored yet: the write is still waiting on the lock.
        expect((await lateRow()).rowCount).toBe(0);
        await locker.query("COMMIT");
        committed = true;
      } finally {
        if (!committed) await locker.query("ROLLBACK").catch(() => undefined);
        locker.release();
      }
      // The write that outlived the answer commits afterwards (it was kept, not cancelled).
      const until = Date.now() + 5_000;
      while ((await lateRow()).rowCount === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      const stored = (await lateRow()).rows;
      expect(stored).toEqual([{ id: expect.any(String), company_id: companyId, page_key: "/late-write" }]);
      // ... and the reporting feed serves it like any other observation.
      const feedIds = async () => (await db.reporting.feed({ installationId: "inst-test", websiteId: "site-test" }, { after: null, limit: 100 })).items.flatMap((i) => (i.type === "observation" ? [String(i.observationId)] : []));
      const feedUntil = Date.now() + 5_000;
      while (!(await feedIds()).includes(stored[0]!.id) && Date.now() < feedUntil) await new Promise((r) => setTimeout(r, 25));
      expect(await feedIds()).toContain(stored[0]!.id);
      // A retry of the same entrance_id finds it and now confirms it, without a second observation.
      const retry = await resolveRef(QUALIFIED_IP, lateRef);
      expect(retry.body).toEqual({ version: "1", status: "qualified", source: "cache", recorded: true });
      expect((await lateRow()).rowCount).toBe(1);
      expect((await observationRows()).rows).toHaveLength(2);
    });

    it("the observation history carries no IP, fingerprint, header, query string or provider field", async () => {
      await resolveRef(QUALIFIED_IP, REF(1));
      await resolveRef(QUALIFIED_IP, REF(2));
      const dump = (await db.pool.query("SELECT row_to_json(o)::text AS t FROM company_observations o UNION ALL SELECT row_to_json(s)::text FROM company_scope_stats s UNION ALL SELECT row_to_json(r)::text FROM company_observation_refs r")).rows.map((r: { t: string }) => r.t).join("\n");
      expect(findLeaks(dump, [...ALL_TEST_IPS.flatMap(ipVariants), ...FORBIDDEN_PROVIDER_FIELDS, "user-agent", "authorization", "?", "utm_", "referrer"])).toEqual([]);
      const fps = await db.pool.query<{ hex: string }>("SELECT encode(ip_fingerprint, 'hex') AS hex FROM ip_resolution_cache");
      for (const { hex } of fps.rows) expect(dump).not.toContain(hex);
    });
  });
});
