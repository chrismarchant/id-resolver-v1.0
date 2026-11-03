/**
 * The resolution pipeline against the REAL repositories with deliberately offset
 * worker clocks (review P1: database-authoritative lease lifecycle). Workers
 * whose clocks run ahead or behind must neither take over a live reservation,
 * nor dispatch a second provider call for one address, nor persist a stale
 * result; the only clock that decides ownership is the database's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runJob, type PipelineDeps } from "../../src/resolution/pipeline.js";
import { usagePeriodKey, type UsageScope } from "../../src/contracts/db.js";
import type { PipelineConfig, ResolutionJob } from "../../src/contracts/runtime.js";
import type { ProviderAdapter } from "../../src/contracts/provider.js";
import type { Db } from "../../src/db/index.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { createMockProvider } from "../../src/provider/mock.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";

const SECRET = "0123456789abcdef".repeat(4);
const IP = "203.0.113.40";

function config(over: Partial<PipelineConfig["policy"]> = {}): PipelineConfig {
  return {
    installation_id: "inst-test",
    website_id: "site-test",
    key_version: 1,
    ip_hmac_secret: SECRET,
    provider: { mode: "mock", base_url: "https://provider.invalid", api_key: "k", auth_header: "x-api-key", timeout_ms: 5_000 },
    policy: {
      ttl_qualified_ms: 60_000,
      ttl_no_match_ms: 60_000,
      ttl_excluded_ms: 60_000,
      ttl_unknown_ms: 60_000,
      ttl_provider_error_ms: 60_000,
      ttl_uncertain_ms: 60_000,
      lease_ms: 1_000,
      pending_wait_ms: 1_500,
      pending_poll_ms: 20,
      period_call_cap: 100,
      usage_period: "month",
      qualified_usage_types: ["COM"],
      excluded_usage_types: ["ISP"],
      denied_domains: [],
      allow_documentation_ranges: true,
      ...over,
    },
  };
}

const job = (ref: string, deadlineInMs = 6_000): ResolutionJob => ({
  job_id: `job-${ref}`,
  ip: IP,
  deadline_at_ms: Date.now() + deadlineInMs,
  observation_ref: `obsref-${ref.padStart(16, "0")}`,
});

/** A worker clock offset by `skewMs` from the host (and therefore from the database on this machine). */
const skewed = (skewMs: number) => () => new Date(Date.now() + skewMs);

describe("pipeline against PostgreSQL with offset worker clocks", () => {
  let db: Db;
  let scope: UsageScope;
  beforeAll(async () => {
    db = await createTestDb({ max: 8 });
    scope = { installationId: "inst-test", websiteId: "site-test", periodKey: usagePeriodKey("month", new Date()) };
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });

  function deps(provider: ProviderAdapter): PipelineDeps & { logger: ReturnType<typeof createMemoryLogger> } {
    const logger = createMemoryLogger();
    return { cache: db.cache, usage: db.usage, controls: db.controls, companies: db.companies, activity: db.activity, provider, logger };
  }

  it("a worker 600 ms ahead cannot take over a live reservation: it waits and reuses the owner's result; one provider attempt", async () => {
    const mock = createMockProvider({ [IP]: { outcome: { kind: "resolved", domain: "example.com", organisationName: "Example Ltd", usageType: "COM", creditsReported: 100 }, delayMs: 400 } });
    const owner = runJob(deps(mock), config({ lease_ms: 1_000 }), job("owner"), skewed(0));
    await new Promise((r) => setTimeout(r, 100)); // the owner holds the lease and is inside its provider call
    const skewedWorker = await runJob(deps(mock), config({ lease_ms: 1_000 }), job("ahead"), skewed(600));
    const ownerOutcome = await owner;
    expect(ownerOutcome).toMatchObject({ status: "qualified", source: "provider", activity: { recorded: true, previously_seen: false } });
    expect(skewedWorker).toMatchObject({ status: "qualified", source: "cache", activity: { recorded: true, previously_seen: true } });
    expect(mock.calls).toBe(1);
    const usage = await db.usage.snapshot(scope);
    expect(usage.provider_attempts).toBe(1);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM company_observations")).rows[0].n).toBe(2);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM companies")).rows[0].n).toBe(1);
  });

  it("a worker whose provider call outlives its lease loses the fence and persists nothing, however far ahead its clock reads", async () => {
    const slow = createMockProvider({ [IP]: { outcome: { kind: "resolved", domain: "stale.example", organisationName: "Stale", usageType: "COM", creditsReported: 100 }, delayMs: 900 } });
    // Lease 700 ms with a 5 s provider timeout: the pipeline bounds the call by the database-reported lease remaining,
    // so the call is aborted before expiry and the outcome is uncertain, not a stale qualified commit.
    const o = await runJob(deps(slow), config({ lease_ms: 700 }), job("stale"), skewed(250));
    expect(o).toMatchObject({ status: "uncertain", source: "provider" });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM companies")).rows[0].n).toBe(0);
    expect((await db.pool.query("SELECT status FROM ip_resolution_cache")).rows[0]).toMatchObject({ status: "uncertain" });
  });

  it("a worker 400 ms behind resolves normally and a concurrent ahead worker neither takes over nor dispatches again", async () => {
    const mock = createMockProvider({ [IP]: { outcome: { kind: "resolved", domain: "example.com", organisationName: "Example Ltd", usageType: "COM", creditsReported: 100 }, delayMs: 300 } });
    const [behind, ahead] = await Promise.all([
      runJob(deps(mock), config({ lease_ms: 1_000 }), job("behind"), skewed(-400)),
      (async () => {
        await new Promise((r) => setTimeout(r, 50));
        return runJob(deps(mock), config({ lease_ms: 1_000 }), job("ahead"), skewed(400));
      })(),
    ]);
    expect(behind).toMatchObject({ status: "qualified", source: "provider", activity: { recorded: true } });
    expect(ahead).toMatchObject({ status: "qualified", source: "cache", activity: { recorded: true, previously_seen: true } });
    expect(mock.calls).toBe(1);
    expect((await db.usage.snapshot(scope)).provider_attempts).toBe(1);
  });

  it("a lease taken over after real expiry: the stale worker's late commit is rejected and records no activity", async () => {
    // The pipeline itself never commits late (it bounds the provider call by the lease), so the stale path is driven
    // through the repository with a worker clock reading 250 ms ahead in its metadata.
    const key = { installationId: "inst-test", websiteId: "site-test", keyVersion: 1, ipFingerprint: Buffer.alloc(32, 9) };
    const r = await db.cache.reserve(key, { leaseMs: 200 });
    if (r.kind !== "acquired") throw new Error("expected acquired");
    await new Promise((res) => setTimeout(res, 300));
    const takeover = await db.cache.reserve(key, { leaseMs: 5_000 });
    expect(takeover.kind).toBe("acquired");
    const late = await db.cache.commitResolved(key, r.token, { status: "qualified", company: { domain: "example.com", organisationName: "Stale Name", qualificationCategory: "COM" }, checkedAt: new Date(Date.now() + 250), ttlMs: 60_000 });
    expect(late).toEqual({ kind: "lost_lease" });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM companies")).rows[0].n).toBe(0);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM company_observations")).rows[0].n).toBe(0);
    // The new owner commits normally.
    if (takeover.kind !== "acquired") return;
    expect(await db.cache.commitResolved(key, takeover.token, { status: "qualified", company: { domain: "example.com", organisationName: "Example Ltd", qualificationCategory: "COM" }, checkedAt: new Date(), ttlMs: 60_000 })).toMatchObject({ kind: "committed" });
  });
});
