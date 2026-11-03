/**
 * Vertical slice: HTTP API -> forked child -> mock Enrich server -> PostgreSQL.
 * Everything is real except the provider, which is the in-repo mock server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { buildChildRuntimeConfig, createChildManager } from "../../src/supervisor/child-manager.js";
import { startMockEnrichServer, SPECIAL_IPS, type MockServerHandle } from "../../src/provider/mock-server.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";
import { testConfig, TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";
import { compiledChildModulePath } from "../helpers/child.js";
import { dumpDatabaseText, findLeaks, FORBIDDEN_PROVIDER_FIELDS, ipVariants } from "../helpers/leak-scan.js";
import type { Db } from "../../src/db/index.js";
import type { ChildManager } from "../../src/contracts/child-manager.js";
import { usagePeriodKey } from "../../src/contracts/db.js";

// Real children run as the compiled artefact (see test/helpers/global-setup.ts).
const CHILD = compiledChildModulePath();
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

describe("end-to-end vertical slice", () => {
  let db: Db;
  let mock: MockServerHandle;
  let app: FastifyInstance;
  let manager: ChildManager;
  let logger: ReturnType<typeof createMemoryLogger>;
  // The mock server and logger live for the whole file; tests reason about deltas.
  const baseline = new Map<string, number>();
  let logStart = 0;
  const hits = (ip: string) => mock.hits(ip) - (baseline.get(ip) ?? 0);
  const logs = () => logger.entries.slice(logStart);
  const auth = { authorization: `Bearer ${TEST_AUTH_TOKEN}`, "content-type": "application/json" };
  const scope = { installationId: "inst-test", websiteId: "site-test", periodKey: usagePeriodKey("month", new Date()) };

  async function resolve(ip: string, requestId?: string) {
    const r = await app.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip, ...(requestId ? { request_id: requestId } : {}) } });
    return { status: r.statusCode, body: r.json() as Record<string, unknown>, raw: r.body };
  }

  beforeAll(async () => {
    db = await createTestDb({ max: 4 });
    mock = await startMockEnrichServer({ slowMs: 5_000 });
    logger = createMemoryLogger();
    const config = testConfig({ PROVIDER_MODE: "live", ENRICH_API_BASE_URL: mock.url, ENRICH_API_KEY: "sk_test_placeholder_key", PERIOD_CALL_CAP: "50" });
    manager = createChildManager({ config, logger, childRuntimeConfig: buildChildRuntimeConfig(config), childModulePath: CHILD });
    app = await buildServer({ config, logger, childManager: manager, ping: () => db.ping() });
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

  it("resolves a qualified company through a real child and persists only sanitised data", async () => {
    const first = await resolve(QUALIFIED_IP, "e2e-1");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      version: "1",
      status: "qualified",
      source: "provider",
      request_id: "e2e-1",
      company: { domain: "example.com", organisation_name: "Example Ltd", qualification: { category: "COM", source: "provider_usage_type" } },
    });
    expect(hits(QUALIFIED_IP)).toBe(1);

    const second = await resolve(QUALIFIED_IP);
    expect(second.body["status"]).toBe("qualified");
    expect(second.body["source"]).toBe("cache");
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
      expect(r.body["company"]).toBeNull();
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
    const m3 = createChildManager({ config, logger, childRuntimeConfig: buildChildRuntimeConfig(config), childModulePath: CHILD });
    const app3 = await buildServer({ config, logger, childManager: m3, ping: () => db.ping() });
    const r1 = await app3.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: SPECIAL_IPS.slow } });
    expect(r1.json().status).toBe("uncertain");
    const rows = await db.pool.query<{ status: string }>("SELECT status FROM ip_resolution_cache");
    expect(rows.rows.map((r) => r.status)).toEqual(["uncertain"]);
    const r2 = await app3.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: SPECIAL_IPS.slow } });
    expect(r2.json()).toMatchObject({ status: "uncertain", source: "cache" });
    expect(hits(SPECIAL_IPS.slow)).toBe(1);
    await app3.close();
    await m3.shutdown(1_000);
  });

  it("defaults safely on provider failures and malformed responses, with bounded backoff", async () => {
    for (const ip of [SPECIAL_IPS.serverError, SPECIAL_IPS.rateLimited, SPECIAL_IPS.unauthorized, SPECIAL_IPS.paymentRequired, SPECIAL_IPS.malformedJson, SPECIAL_IPS.missingData, SPECIAL_IPS.oversized]) {
      const r = await resolve(ip);
      expect(r.status, ip).toBe(200);
      expect(r.body["status"], ip).toBe("unavailable");
      expect(r.body["company"]).toBeNull();
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
    const config = testConfig({ PROVIDER_MODE: "live", ENRICH_API_BASE_URL: mock.url, ENRICH_API_KEY: "sk_test_placeholder_key", PERIOD_CALL_CAP: "2", MAX_CONCURRENT_CHILDREN: "6" });
    const m2 = createChildManager({ config, logger, childRuntimeConfig: buildChildRuntimeConfig(config), childModulePath: CHILD });
    const app2 = await buildServer({ config, logger, childManager: m2, ping: () => db.ping() });
    const ips = ["203.0.113.10", "203.0.113.11", "203.0.113.12", "203.0.113.13", "203.0.113.14"];
    const results = await Promise.all(ips.map((ip) => app2.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip } })));
    const statuses = results.map((r) => r.json().status as string);
    expect(statuses.filter((s) => s === "disabled").length).toBe(3);
    const snapshot = await db.usage.snapshot(scope);
    expect(snapshot.provider_attempts).toBe(2);
    expect(ips.reduce((n, ip) => n + hits(ip), 0)).toBe(2);
    // Cache still served when the cap is exhausted.
    const servedIp = ips.find((ip, i) => statuses[i] !== "disabled")!;
    const cached = await app2.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip: servedIp } });
    expect(cached.json().source).toBe("cache");
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

  it("children terminate and are reaped; concurrency stays bounded", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => resolve(`203.0.113.${20 + i}`)));
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.activeCount()).toBe(0);
    const spawned = logs().filter((e) => e["event"] === "child_spawned").map((e) => e["active_children"] as number);
    expect(Math.max(...spawned)).toBeLessThanOrEqual(4);
    const exits = logs().filter((e) => e["event"] === "child_exit").length;
    expect(exits).toBeGreaterThan(0);
  });

  it("leaks no test IP, secret or provider-only field into logs, database or responses", async () => {
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
    expect(findLeaks(responses.join("\n"), needles)).toEqual([]);
    expect(logText).toContain("child_result");
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
      db.pool.query<{ company_id: string; source: string; observation_ref: string; previously_seen: boolean }>(
        `SELECT o.company_id, o.source, o.observation_ref, r.previously_seen FROM company_observations o
         JOIN company_observation_refs r USING (installation_id, website_id, observation_ref) ORDER BY o.id`,
      );
    async function resolveRef(ip: string, observationRef?: string) {
      const r = await app.inject({ method: "POST", url: "/v1/resolve", headers: auth, payload: { website_id: "site-test", ip, ...(observationRef ? { observation_ref: observationRef } : {}) } });
      return { status: r.statusCode, body: r.json() as Record<string, unknown>, raw: r.body };
    }

    it("records the provider result, then a cache hit, with no second provider attempt and the backward-compatible fields", async () => {
      const first = await resolveRef(QUALIFIED_IP, REF(1));
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ status: "qualified", source: "provider", previously_seen_company: false, activity_recorded: true, observation_ref: REF(1) });
      const companyId = first.body["company_id"];
      expect(typeof companyId).toBe("number");
      const second = await resolveRef(QUALIFIED_IP, REF(2));
      expect(second.body).toMatchObject({ status: "qualified", source: "cache", company_id: companyId, previously_seen_company: true, activity_recorded: true, observation_ref: REF(2) });
      expect(hits(QUALIFIED_IP)).toBe(1);
      const rows = await observationRows();
      expect(rows.rows).toEqual([
        { company_id: String(companyId), source: "provider", observation_ref: REF(1), previously_seen: false },
        { company_id: String(companyId), source: "cache", observation_ref: REF(2), previously_seen: true },
      ]);
      const company = await db.pool.query<{ last_seen_at: Date; first_seen_at: Date }>("SELECT first_seen_at, last_seen_at FROM companies WHERE id = $1", [companyId]);
      expect(company.rows[0]!.last_seen_at.getTime()).toBeGreaterThanOrEqual(company.rows[0]!.first_seen_at.getTime());
      const stats = await db.pool.query<{ observation_count: string }>("SELECT observation_count FROM company_scope_stats WHERE company_id = $1", [companyId]);
      expect(stats.rows[0]!.observation_count).toBe("2");
      // A generated reference when the caller omits one: another observation, 22-char base64url.
      const third = await resolveRef(QUALIFIED_IP);
      expect(third.body["observation_ref"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect((await observationRows()).rows).toHaveLength(3);
      const snapshot = await db.usage.snapshot(scope);
      expect(snapshot.provider_attempts).toBe(1);
    });

    it("pending followers sharing the caller's reference insert exactly one observation", async () => {
      const results = await Promise.all(Array.from({ length: 4 }, () => resolveRef(QUALIFIED_IP, REF(7))));
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(["qualified", "pending"]).toContain(r.body["status"]);
        if (r.body["status"] === "qualified") expect(r.body).toMatchObject({ activity_recorded: true, observation_ref: REF(7) });
        else expect(r.body["company_id"]).toBeUndefined();
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
      await resolveRef("10.1.2.3", REF(4));
      const r = await resolveRef(EXCLUDED_IP, REF(5));
      expect(r.body["status"]).toBe("excluded");
      expect(r.body["company_id"]).toBeUndefined();
      expect(r.body["activity_recorded"]).toBeUndefined();
      expect((await observationRows()).rows).toEqual([]);
      expect((await db.pool.query("SELECT count(*)::int AS n FROM companies")).rows[0].n).toBe(0);
      expect((await db.pool.query("SELECT count(*)::int AS n FROM company_scope_stats")).rows[0].n).toBe(0);
    });

    it("a different address resolving to the same domain reuses the company id and keeps the records across cache pruning", async () => {
      const a = await resolveRef(QUALIFIED_IP, REF(1));
      const b = await resolveRef("::ffff:203.0.113.10", REF(2)); // same canonical address: cache hit
      expect(b.body["company_id"]).toBe(a.body["company_id"]);
      await db.pool.query("UPDATE ip_resolution_cache SET expires_at = now() - interval '1 second'");
      expect(await db.cache.pruneExpired(100)).toBe(1);
      const c = await resolveRef(QUALIFIED_IP, REF(3)); // provider again (cache gone), same company
      expect(c.body).toMatchObject({ status: "qualified", source: "provider", company_id: a.body["company_id"], previously_seen_company: true });
      expect(hits(QUALIFIED_IP)).toBe(2);
      expect((await observationRows()).rows.map((x) => x.previously_seen)).toEqual([false, true, true]);
      expect((await db.pool.query("SELECT count(*)::int AS n FROM companies")).rows[0].n).toBe(1);
    });

    it("delayed usage accounting in a real child cannot consume the activity or response budget (Warp P2-3)", async () => {
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
        expect(r.body).toMatchObject({ status: "qualified", source: "cache", previously_seen_company: true, activity_recorded: true, observation_ref: REF(2) });
        expect(hits(QUALIFIED_IP)).toBe(1);
        expect((await observationRows()).rows).toHaveLength(2);
        // The child's own `db_error{usage_counter_timeout}` lines go to its stdout (unit `pipeline` asserts them);
        // what this test establishes is the real child's timing, result and exit under a blocked counter.
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        locker.release();
      }
      // The child finishes (tracked deferred accounting, bounded close) and is reaped.
      const until = Date.now() + 4_000;
      while (manager.activeCount() > 0 && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
      expect(manager.activeCount()).toBe(0);
    });

    it("the observation history carries no IP, fingerprint, header or provider field", async () => {
      await resolveRef(QUALIFIED_IP, REF(1));
      await resolveRef(QUALIFIED_IP, REF(2));
      const dump = (await db.pool.query("SELECT row_to_json(o)::text AS t FROM company_observations o UNION ALL SELECT row_to_json(s)::text FROM company_scope_stats s UNION ALL SELECT row_to_json(r)::text FROM company_observation_refs r")).rows.map((r: { t: string }) => r.t).join("\n");
      expect(findLeaks(dump, [...ALL_TEST_IPS.flatMap(ipVariants), ...FORBIDDEN_PROVIDER_FIELDS, "user-agent", "authorization"])).toEqual([]);
      const fps = await db.pool.query<{ hex: string }>("SELECT encode(ip_fingerprint, 'hex') AS hex FROM ip_resolution_cache");
      for (const { hex } of fps.rows) expect(dump).not.toContain(hex);
    });
  });
});
