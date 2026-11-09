import { describe, expect, it } from "vitest";
import { runJob, LEASE_COMMIT_BUDGET_MS, type PipelineDeps } from "../../src/resolution/pipeline.js";
import type { CacheKey, UsageScope } from "../../src/contracts/db.js";
import { usagePeriodKey } from "../../src/contracts/db.js";
import type { PipelineConfig, ResolutionJob } from "../../src/contracts/runtime.js";
import type { ProviderAdapter, ProviderOutcome } from "../../src/contracts/provider.js";
import { canonicaliseIp } from "../../src/ip/canonical.js";
import { computeFingerprint, decodeSecret } from "../../src/ip/fingerprint.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { createMockProvider, type MockScript } from "../../src/provider/mock.js";
import { createFakeRepositories } from "../helpers/fakes.js";

const SECRET = "0123456789abcdef".repeat(4);
const IP = "203.0.113.10";

function makeConfig(overrides: { policy?: Partial<PipelineConfig["policy"]>; provider?: Partial<PipelineConfig["provider"]> } = {}): PipelineConfig {
  return {
    installation_id: "inst-test",
    website_id: "site-test",
    key_version: 1,
    ip_hmac_secret: SECRET,
    provider: { mode: "mock", base_url: "https://provider.invalid", api_key: "k", auth_header: "x-api-key", timeout_ms: 1_000, ...overrides.provider },
    policy: {
      ttl_qualified_ms: 7 * 86_400_000,
      ttl_no_match_ms: 86_400_000,
      ttl_excluded_ms: 7 * 86_400_000,
      ttl_unknown_ms: 86_400_000,
      ttl_provider_error_ms: 600_000,
      ttl_uncertain_ms: 3_600_000,
      lease_ms: 3_000,
      pending_wait_ms: 1_500,
      pending_poll_ms: 10,
      period_call_cap: 100,
      period_resolved_cap: 100,
      usage_period: "month",
      qualified_usage_types: ["COM", "ORG", "GOV", "EDU", "MIL", "LIB"],
      excluded_usage_types: ["ISP", "MOB", "DCH", "CDN", "SES", "RSV"],
      denied_domains: ["denied.example"],
      allow_documentation_ranges: true,
      ...overrides.policy,
    },
  };
}

const REF = "obsref-0123456789abcdef";
const CONTEXT = { pageKey: "/pricing", acquisition: "search", entranceContract: "entrance.v1", eligibility: "tsa-1" } as const;
const job = (ip = IP, deadlineInMs = 4_000, observationRef = REF): ResolutionJob => ({
  context: { ...CONTEXT },
  job_id: "job-1",
  ip,
  deadline_at_ms: Date.now() + deadlineInMs,
  observation_ref: observationRef,
});

const resolved = (domain: string, usageType: string | null, organisationName: string | null = "Example Ltd"): ProviderOutcome => ({
  kind: "resolved",
  domain,
  organisationName,
  usageType,
  creditsReported: 100,
});

function keyFor(config: PipelineConfig, ip = IP): CacheKey {
  const c = canonicaliseIp(ip);
  if (!c.ok) throw new Error("bad test ip");
  return {
    installationId: config.installation_id,
    websiteId: config.website_id,
    keyVersion: config.key_version,
    ipFingerprint: computeFingerprint(decodeSecret(SECRET), config.installation_id, config.website_id, c.canonical),
  };
}

function setup(script: MockScript = {}, provider?: ProviderAdapter) {
  const repos = createFakeRepositories();
  const mock = createMockProvider(script);
  const logger = createMemoryLogger();
  const deps: PipelineDeps = { ...repos, provider: provider ?? mock, logger };
  const config = makeConfig();
  const scope: UsageScope = { installationId: config.installation_id, websiteId: config.website_id, periodKey: usagePeriodKey("month", new Date()) };
  const snapshot = () => repos.usage.snapshot(scope);
  return { repos, mock, logger, deps, config, scope, snapshot };
}

describe("runJob: eligibility", () => {
  it.each([
    ["10.0.0.1", "ip_ineligible"],
    ["::1", "ip_ineligible"],
    ["not-an-ip", "ip_invalid"],
  ])("%s -> ineligible (%s) without cache or provider access", async (ip, reason) => {
    const t = setup();
    const o = await runJob(t.deps, t.config, job(ip));
    expect(o).toEqual({ status: "ineligible", source: "none", reason });
    expect(t.repos.cache.calls.reserve + t.repos.cache.calls.readFresh).toBe(0);
    expect(t.mock.calls).toBe(0);
    expect((await t.snapshot()).resolver_requests).toBe(1);
  });
});

describe("runJob: provider outcomes", () => {
  it("acquired -> qualified: commits with qualified TTL and company, counts", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    const o = await runJob(t.deps, t.config, job());
    expect(o).toMatchObject({ status: "qualified", source: "provider", reason: "provider_resolved" });
    // D2: the outcome carries no company identity; the association lives in the cache row and the observation.
    expect(Object.keys(o).sort()).toEqual(["activity", "reason", "source", "status"]);
    expect(JSON.stringify(o)).not.toMatch(/example\.com|Example Ltd|COM"/);
    const e = t.repos.cache.inspect(keyFor(t.config))!;
    expect(e.status).toBe("qualified");
    expect(e.expiresAt.getTime() - e.checkedAt!.getTime()).toBeGreaterThanOrEqual(t.config.policy.ttl_qualified_ms); // expiry is clock time + ttl, checkedAt is metadata
    expect(e.expiresAt.getTime() - e.checkedAt!.getTime()).toBeLessThan(t.config.policy.ttl_qualified_ms + 1_000);
    expect(e.company).toEqual({ domain: "example.com", organisationName: "Example Ltd", qualificationCategory: "COM" });
    // The fenced commit owns the company upsert; the pipeline never writes companies directly.
    expect(t.repos.companies.companies.size).toBe(0);
    const s = await t.snapshot();
    expect(s).toMatchObject({
      resolver_requests: 1,
      provider_attempts: 1,
      domain_resolutions: 1,
      qualified_matches: 1,
      cache_hits: 0,
      providerCreditsReported: 100,
      providerCreditsEstimated: 100,
    });
  });

  it("fresh cache hit returns the cached company without a provider call", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    await runJob(t.deps, t.config, job());
    const o = await runJob(t.deps, t.config, job());
    expect(o).toMatchObject({ status: "qualified", source: "cache", reason: "cache_fresh" });
    expect(o.activity!.company_id).toBe(t.repos.cache.companyIdFor("example.com"));
    expect(t.mock.calls).toBe(1);
    expect((await t.snapshot()).cache_hits).toBe(1);
  });

  it.each([
    ["no_domain", { kind: "no_domain", creditsReported: 0 } as ProviderOutcome, "no_match", "provider_no_domain", "ttl_no_match_ms", "no_matches"],
    ["excluded", resolved("example-isp.net", "ISP"), "excluded", "provider_excluded_usage_type", "ttl_excluded_ms", "excluded_results"],
    ["unknown usage", resolved("example.org", null), "unknown", "provider_unknown_usage_type", "ttl_unknown_ms", "unknown_results"],
    ["unrecognised usage", resolved("example.org", "XYZ"), "unknown", "provider_unknown_usage_type", "ttl_unknown_ms", "unknown_results"],
    ["denied domain", resolved("denied.example", "COM"), "unknown", "provider_denied_domain", "ttl_unknown_ms", "unknown_results"],
  ] as const)("%s -> %s", async (_label, outcome, status, reason, ttlKey, counter) => {
    const t = setup({ [IP]: { outcome } });
    const o = await runJob(t.deps, t.config, job());
    expect(o).toEqual({ status, source: "provider", reason });
    const e = t.repos.cache.inspect(keyFor(t.config))!;
    expect(e.status).toBe(status);
    expect(e.company).toBeNull();
    expect(e.expiresAt.getTime() - e.checkedAt!.getTime()).toBeGreaterThanOrEqual(t.config.policy[ttlKey]); // expiry is clock time + ttl, checkedAt is metadata
    expect(e.expiresAt.getTime() - e.checkedAt!.getTime()).toBeLessThan(t.config.policy[ttlKey] + 1_000);
    expect(t.repos.companies.companies.size).toBe(0);
    const s = await t.snapshot();
    expect(s[counter]).toBe(1);
    expect(s.qualified_matches).toBe(0);
    expect(s.providerCreditsEstimated).toBe(outcome.kind === "resolved" ? 100 : 0);
  });

  it("timeout -> uncertain, cached for the uncertain TTL, and no second provider call", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM"), delayMs: 10_000 } });
    const config = makeConfig({ provider: { timeout_ms: 250 } });
    const o = await runJob(t.deps, config, job());
    expect(o).toEqual({ status: "uncertain", source: "provider", reason: "provider_timeout" });
    const e = t.repos.cache.inspect(keyFor(config))!;
    expect(e.status).toBe("uncertain");
    expect(e.expiresAt.getTime() - e.checkedAt!.getTime()).toBeGreaterThanOrEqual(config.policy.ttl_uncertain_ms); // expiry is clock time + ttl, checkedAt is metadata
    expect(e.expiresAt.getTime() - e.checkedAt!.getTime()).toBeLessThan(config.policy.ttl_uncertain_ms + 1_000);
    const again = await runJob(t.deps, config, job());
    expect(again).toEqual({ status: "uncertain", source: "cache", reason: "cache_fresh" });
    expect(t.mock.calls).toBe(1);
    const s = await t.snapshot();
    expect(s).toMatchObject({ uncertain_outcomes: 1, provider_attempts: 1, providerCreditsEstimated: 100, providerCreditsReported: 0 });
  });

  it.each([
    ["auth", null, 600_000],
    ["credits", null, 600_000],
    ["server", null, 600_000],
    ["network", null, 600_000],
    ["malformed", null, 600_000],
    ["rate_limited", 1_800_000, 1_800_000],
    ["rate_limited", 5_000, 600_000],
    ["rate_limited", 86_400_000, 3_600_000],
  ] as const)("provider error %s -> unavailable with provider_error TTL", async (category, retryAfterMs, ttl) => {
    const t = setup({ [IP]: { outcome: { kind: "error", category, retryAfterMs } } });
    const o = await runJob(t.deps, t.config, job());
    expect(o).toEqual({ status: "unavailable", source: "provider", reason: `provider_error_${category}` });
    const e = t.repos.cache.inspect(keyFor(t.config))!;
    expect(e.status).toBe("provider_error");
    expect(e.expiresAt.getTime() - e.checkedAt!.getTime()).toBeGreaterThanOrEqual(ttl); // expiry is clock time + ttl, checkedAt is metadata
    expect(e.expiresAt.getTime() - e.checkedAt!.getTime()).toBeLessThan(ttl + 1_000);
    expect((await t.snapshot()).failures).toBe(1);
    const again = await runJob(t.deps, t.config, job());
    expect(again).toEqual({ status: "unavailable", source: "cache", reason: "cache_fresh" });
    expect(t.mock.calls).toBe(1);
  });
});

describe("runJob: controls and caps", () => {
  it("cap exhausted -> disabled, reservation released, provider never called", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    const config = makeConfig({ policy: { period_call_cap: 0 } });
    const o = await runJob(t.deps, config, job());
    expect(o).toEqual({ status: "disabled", source: "none", reason: "cap_exhausted" });
    expect(t.mock.calls).toBe(0);
    const e = t.repos.cache.inspect(keyFor(config))!;
    expect(e.leaseExpiresAt).toBeNull();
    expect(e.token).toBeNull();
    expect(e.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    // Next caller may acquire immediately.
    const r = await t.repos.cache.reserve(keyFor(config), { leaseMs: 1_000 });
    expect(r.kind).toBe("acquired");
  });

  it("stops at the cap across jobs", async () => {
    const t = setup();
    const config = makeConfig({ policy: { period_call_cap: 2 } });
    const ips = ["203.0.113.31", "203.0.113.32", "203.0.113.33"];
    const outcomes = [];
    for (const ip of ips) outcomes.push(await runJob(t.deps, config, job(ip)));
    expect(outcomes.map((o) => o.status)).toEqual(["no_match", "no_match", "disabled"]);
    expect(t.mock.calls).toBe(2);
    expect((await t.snapshot()).provider_attempts).toBe(2);
  });

  it("calls that find no domain give their charge slot back, so they never use up the resolved cap", async () => {
    const t = setup();
    const config = makeConfig({ policy: { period_call_cap: 100, period_resolved_cap: 2 } });
    const ips = ["203.0.113.41", "203.0.113.42", "203.0.113.43", "203.0.113.44", "203.0.113.45"];
    const outcomes = [];
    for (const ip of ips) outcomes.push(await runJob(t.deps, config, job(ip)));
    expect(outcomes.map((o) => o.status)).toEqual(["no_match", "no_match", "no_match", "no_match", "no_match"]);
    expect(t.mock.calls).toBe(5);
    const s = await t.snapshot();
    expect(s.provider_attempts).toBe(5);
    expect(s.providerChargeSlots).toBe(0);
  });

  it("resolved cap reached -> disabled with cap_exhausted, released, provider not called", async () => {
    const script = {
      "203.0.113.51": { outcome: resolved("one.example", "COM") },
      "203.0.113.52": { outcome: resolved("isp.example", "ISP") },
      "203.0.113.53": { outcome: resolved("three.example", "COM") },
    };
    const t = setup(script);
    const config = makeConfig({ policy: { period_call_cap: 100, period_resolved_cap: 2 } });
    const a = await runJob(t.deps, config, job("203.0.113.51"));
    const b = await runJob(t.deps, config, job("203.0.113.52", 4_000, "obsref-b"));
    const c = await runJob(t.deps, config, job("203.0.113.53", 4_000, "obsref-c"));
    expect([a.status, b.status]).toEqual(["qualified", "excluded"]);
    expect(c).toEqual({ status: "disabled", source: "none", reason: "cap_exhausted" });
    expect(t.mock.calls).toBe(2);
    const s = await t.snapshot();
    expect(s.provider_attempts).toBe(2);
    expect(s.providerChargeSlots).toBe(2);
    const e = t.repos.cache.inspect(keyFor(config, "203.0.113.53"))!;
    expect(e.token).toBeNull();
    expect(e.leaseExpiresAt).toBeNull();
    const reservation = t.logger.entries.find((x) => x["event"] === "usage_reservation" && x["outcome"] === "resolved_cap_exhausted");
    expect(reservation?.["resolved_cap"]).toBe(2);
  });

  it("once the resolved cap is reached, every new lookup pauses, because its charge is unknown in advance", async () => {
    const t = setup({ "203.0.113.61": { outcome: resolved("one.example", "COM") } });
    const config = makeConfig({ policy: { period_call_cap: 100, period_resolved_cap: 1 } });
    expect((await runJob(t.deps, config, job("203.0.113.61"))).status).toBe("qualified");
    const o = await runJob(t.deps, config, job("203.0.113.62", 4_000, "obsref-62"));
    expect(o.reason).toBe("cap_exhausted");
    expect(t.mock.calls).toBe(1);
  });

  it("keeps the slot when the charge is possible or certain, gives it back when the answer proves no charge", async () => {
    const cases: { outcome: ProviderOutcome; kept: boolean }[] = [
      { outcome: resolved("kept.example", "COM"), kept: true },
      { outcome: { kind: "timeout" }, kept: true },
      { outcome: { kind: "error", category: "server", retryAfterMs: null }, kept: true },
      { outcome: { kind: "error", category: "network", retryAfterMs: null }, kept: true },
      { outcome: { kind: "error", category: "malformed", retryAfterMs: null }, kept: true },
      { outcome: { kind: "no_domain", creditsReported: 100 }, kept: true },
      { outcome: { kind: "no_domain", creditsReported: null }, kept: false },
      { outcome: { kind: "no_domain", creditsReported: 0 }, kept: false },
      { outcome: { kind: "error", category: "auth", retryAfterMs: null }, kept: false },
      { outcome: { kind: "error", category: "credits", retryAfterMs: null }, kept: false },
      { outcome: { kind: "error", category: "rate_limited", retryAfterMs: 1_000 }, kept: false },
    ];
    for (const [i, c] of cases.entries()) {
      const ip = `203.0.113.${70 + i}`;
      const t = setup({ [ip]: { outcome: c.outcome } });
      await runJob(t.deps, t.config, job(ip));
      expect({ i, slots: (await t.snapshot()).providerChargeSlots }).toEqual({ i, slots: c.kept ? 1 : 0 });
    }
  });

  it("a failed give-back keeps the slot and does not change the outcome", async () => {
    const t = setup();
    t.repos.usage.failures.releaseChargeSlot = true;
    const o = await runJob(t.deps, t.config, job("203.0.113.90"));
    expect(o.status).toBe("no_match");
    expect((await t.snapshot()).providerChargeSlots).toBe(1);
    expect(t.logger.entries.some((x) => x["event"] === "db_error" && x["category"] === "usage_charge_slot")).toBe(true);
  });

  it("runtime kill switch -> disabled, released, no provider call", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    await t.repos.controls.setEnrichmentEnabled(t.config.installation_id, false, "test");
    const o = await runJob(t.deps, t.config, job());
    expect(o).toEqual({ status: "disabled", source: "none", reason: "kill_switch" });
    expect(t.mock.calls).toBe(0);
    expect(t.repos.cache.inspect(keyFor(t.config))!.token).toBeNull();
    expect((await t.snapshot()).provider_attempts).toBe(0);
  });

  it("usage reservation reporting disabled -> kill_switch", async () => {
    const t = setup();
    t.repos.usage.reserveProviderAttempt = async () => "disabled";
    const o = await runJob(t.deps, t.config, job());
    expect(o.reason).toBe("kill_switch");
    expect(t.mock.calls).toBe(0);
  });

  it("provider mode disabled -> disabled without usage reservation", async () => {
    const t = setup();
    const config = makeConfig({ provider: { mode: "disabled" } });
    const o = await runJob(t.deps, config, job());
    expect(o).toEqual({ status: "disabled", source: "none", reason: "provider_disabled" });
    expect(t.mock.calls).toBe(0);
    expect((await t.snapshot()).provider_attempts).toBe(0);
    expect(t.repos.cache.inspect(keyFor(config))!.token).toBeNull();
  });

  it("cache hits are still served while disabled", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    await runJob(t.deps, t.config, job());
    const o = await runJob(t.deps, makeConfig({ provider: { mode: "disabled" } }), job());
    expect(o).toMatchObject({ status: "qualified", source: "cache" });
  });

  it("deadline too short -> deadline_exceeded, no provider call, attempt still counted", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    const o = await runJob(t.deps, t.config, job(IP, 300));
    expect(o).toEqual({ status: "unavailable", source: "none", reason: "deadline_exceeded" });
    expect(t.mock.calls).toBe(0);
    expect((await t.snapshot()).provider_attempts).toBe(1);
    expect(t.repos.cache.inspect(keyFor(t.config))!.token).toBeNull();
  });

  it("provider timeout is bounded by the remaining lease", async () => {
    let seenTimeout = 0;
    const provider: ProviderAdapter = {
      name: "probe",
      lookup: (_ip, { signal }) =>
        new Promise((resolve) => {
          const started = Date.now();
          signal.addEventListener("abort", () => {
            seenTimeout = Date.now() - started;
            resolve({ kind: "timeout" });
          });
        }),
    };
    const t = setup({}, provider);
    const config = makeConfig({ policy: { lease_ms: 600 }, provider: { timeout_ms: 5_000 } });
    const o = await runJob(t.deps, config, job(IP, 10_000));
    expect(o.status).toBe("uncertain");
    // lease 600 ms minus the commit budget: the abort fires before the lease expires.
    expect(seenTimeout).toBeGreaterThanOrEqual(600 - LEASE_COMMIT_BUDGET_MS - 20);
    expect(seenTimeout).toBeLessThan(600 - LEASE_COMMIT_BUDGET_MS + 100);
  });
});

describe("runJob: concurrency and fencing", () => {
  it("pending: returns pending within the wait budget when nothing is committed", async () => {
    const t = setup();
    const config = makeConfig({ policy: { pending_wait_ms: 200, pending_poll_ms: 20 } });
    await t.repos.cache.reserve(keyFor(config), { leaseMs: 10_000 });
    const started = Date.now();
    const o = await runJob(t.deps, config, job());
    expect(o).toEqual({ status: "pending", source: "none", reason: "pending_other_worker" });
    expect(Date.now() - started).toBeLessThan(600);
    expect(t.mock.calls).toBe(0);
  });

  it("pending: never waits past the request deadline", async () => {
    const t = setup();
    const config = makeConfig({ policy: { pending_wait_ms: 5_000, pending_poll_ms: 20 } });
    await t.repos.cache.reserve(keyFor(config), { leaseMs: 10_000 });
    const started = Date.now();
    const o = await runJob(t.deps, config, job(IP, 400));
    expect(o.status).toBe("pending");
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("pending: picks up a result committed by another worker mid-poll", async () => {
    const t = setup();
    const config = makeConfig({ policy: { pending_wait_ms: 1_000, pending_poll_ms: 20 } });
    const key = keyFor(config);
    const r = await t.repos.cache.reserve(key, { leaseMs: 10_000 });
    if (r.kind !== "acquired") throw new Error("expected acquired");
    setTimeout(() => {
      void t.repos.cache.commit(key, r.token, {
        status: "qualified",
        company: { domain: "example.com", organisationName: "Example Ltd", qualificationCategory: "COM" },
        checkedAt: new Date(),
        ttlMs: 60_000,
      });
    }, 100);
    const o = await runJob(t.deps, config, job());
    expect(o).toMatchObject({ status: "qualified", source: "cache" });
    expect(o.activity!.company_id).toBe(t.repos.cache.companyIdFor("example.com"));
    expect(t.mock.calls).toBe(0);
    expect((await t.snapshot()).cache_hits).toBe(1);
  });

  it("lost lease: outcome returned to this caller but not persisted", async () => {
    const t = setup();
    const config = t.config;
    const key = keyFor(config);
    const provider: ProviderAdapter = {
      name: "slow-stale",
      async lookup() {
        t.repos.cache.expireLease(key); // another worker took over meanwhile
        return resolved("example.com", "COM");
      },
    };
    const o = await runJob({ ...t.deps, provider }, config, job());
    expect(o).toMatchObject({ status: "qualified", source: "provider" });
    const e = t.repos.cache.inspect(key)!;
    expect(e.status).toBe("pending");
    expect(e.company).toBeNull();
    expect(t.logger.entries.some((l) => l["event"] === "lease_lost")).toBe(true);
  });

  it("20 concurrent jobs for the same IP produce exactly one provider call", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM"), delayMs: 100 } });
    const config = makeConfig({ policy: { pending_wait_ms: 2_000, pending_poll_ms: 10 } });
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => runJob(t.deps, config, job())));
    expect(t.mock.calls).toBe(1);
    expect(outcomes.filter((o) => o.source === "provider")).toHaveLength(1);
    const companyId = t.repos.cache.companyIdFor("example.com");
    expect(outcomes.every((o) => o.status === "qualified" && o.activity?.company_id === companyId)).toBe(true);
    const s = await t.snapshot();
    expect(s.provider_attempts).toBe(1);
    expect(s.resolver_requests).toBe(20);
    expect(s.cache_hits).toBe(19);
  });

  it("equivalent IP spellings share one cache entry", async () => {
    const t = setup({ "2001:db8::1": { outcome: resolved("example.com", "COM") } });
    await runJob(t.deps, t.config, job("2001:DB8:0:0:0:0:0:1"));
    const o = await runJob(t.deps, t.config, job("2001:db8::0001"));
    expect(o.source).toBe("cache");
    expect(t.mock.calls).toBe(1);
  });
});

describe("runJob: failures and hygiene", () => {
  it.each(["reserve", "commit"] as const)("repository %s throwing -> unavailable/database_error", async (method) => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    t.repos.cache.failures[method] = true;
    const o = await runJob(t.deps, t.config, job());
    expect(o).toEqual({ status: "unavailable", source: "none", reason: "database_error" });
  });

  it("usage reservation throwing -> database_error and the reservation is released", async () => {
    const t = setup();
    t.repos.usage.failures.reserveProviderAttempt = true;
    const o = await runJob(t.deps, t.config, job());
    expect(o.reason).toBe("database_error");
    expect(t.repos.cache.inspect(keyFor(t.config))!.token).toBeNull();
    expect(t.mock.calls).toBe(0);
  });

  it("commit failing after dispatch does not release the lease (no second paid call)", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    t.repos.cache.failures.commit = true;
    await runJob(t.deps, t.config, job());
    expect(t.repos.cache.calls.release).toBe(0);
    expect(t.repos.cache.inspect(keyFor(t.config))!.token).not.toBeNull();
  });

  it("counter failures do not change a correct outcome", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    t.repos.usage.failures.increment = true;
    t.repos.usage.failures.addProviderCredits = true;
    const o = await runJob(t.deps, t.config, job());
    expect(o.status).toBe("qualified");
  });

  it("a throwing provider adapter -> internal_error", async () => {
    const provider: ProviderAdapter = {
      name: "broken",
      lookup: async () => {
        throw new Error(`boom ${IP}`);
      },
    };
    const t = setup({}, provider);
    const o = await runJob(t.deps, t.config, job());
    expect(o).toEqual({ status: "unavailable", source: "none", reason: "internal_error" });
    expect(JSON.stringify(o)).not.toContain(IP);
  });

  it("zeroes the fingerprint buffer after the job", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    let captured: Buffer | null = null;
    const reserve = t.repos.cache.reserve.bind(t.repos.cache);
    t.repos.cache.reserve = async (key, opts) => {
      captured = key.ipFingerprint;
      return reserve(key, opts);
    };
    await runJob(t.deps, t.config, job());
    expect(captured).not.toBeNull();
    expect(captured!.every((b) => b === 0)).toBe(true);
  });

  it("never logs the IP, the domain or the secret", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    await runJob(t.deps, t.config, job());
    t.repos.cache.failures.reserve = true;
    await runJob(t.deps, t.config, job("2001:db8::99"));
    const all = JSON.stringify(t.logger.entries);
    expect(t.logger.entries.length).toBeGreaterThan(0);
    for (const s of [IP, "2001:db8::99", "example.com", SECRET, "injected failure"]) expect(all).not.toContain(s);
    const events = new Set(t.logger.entries.map((e) => e["event"]));
    expect(events).toContain("job_finished");
    expect(events).toContain("provider_outcome");
  });
});

describe("runJob: company activity", () => {
  const ref = (n: number) => `obsref-${String(n).padStart(16, "0")}`;
  const activityLogs = (t: ReturnType<typeof setup>) => t.logger.entries.filter((l) => l["event"] === "activity_recorded" || l["event"] === "activity_write_failed");

  it("a qualified provider result records a provider observation for the committed company", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    const o = await runJob(t.deps, t.config, job(IP, 4_000, ref(1)));
    const companyId = t.repos.cache.inspect(keyFor(t.config))!.companyId!;
    expect(o.activity).toEqual({ company_id: companyId, previously_seen: false, recorded: true, observation_ref: ref(1) });
    expect(t.repos.activity.observations).toHaveLength(1);
    expect(t.repos.activity.observations[0]).toMatchObject({ installationId: "inst-test", websiteId: "site-test", companyId, source: "provider", observationRef: ref(1), companyFirst: true });
    // The entrance evidence travels with the observation, unchanged.
    expect(t.repos.activity.observations[0]!.context).toEqual(CONTEXT);
    expect(activityLogs(t)).toEqual([expect.objectContaining({ event: "activity_recorded", company_id: companyId, recorded: true, previously_seen: false, source: "provider" })]);
    expect(JSON.stringify(activityLogs(t))).not.toMatch(/example\.com|203\.0\.113/);
  });

  it("a fresh cache hit records a cache observation without any provider attempt", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    const key = keyFor(t.config);
    t.repos.cache.seed(key, { status: "qualified", company: { domain: "example.com", organisationName: "Example Ltd", qualificationCategory: "COM" }, checkedAt: new Date(), ttlMs: 60_000 });
    const first = await runJob(t.deps, t.config, job(IP, 4_000, ref(1)));
    expect(first).toMatchObject({ status: "qualified", source: "cache", activity: { previously_seen: false, recorded: true, observation_ref: ref(1) } });
    const second = await runJob(t.deps, t.config, job(IP, 4_000, ref(2)));
    expect(second).toMatchObject({ status: "qualified", source: "cache", activity: { previously_seen: true, recorded: true, observation_ref: ref(2) } });
    expect(t.mock.calls).toBe(0);
    expect(t.repos.activity.observations.map((x) => x.source)).toEqual(["cache", "cache"]);
    const s = await t.snapshot();
    expect(s.provider_attempts).toBe(0);
    expect(s.cache_hits).toBe(2);
  });

  it("a new fingerprint resolving to a known domain reuses the company id and is previously seen", async () => {
    const other = "203.0.113.20";
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") }, [other]: { outcome: resolved("example.com", "COM") } });
    const a = await runJob(t.deps, t.config, job(IP, 4_000, ref(1)));
    const b = await runJob(t.deps, t.config, job(other, 4_000, ref(2)));
    expect(a.activity!.company_id).toBe(b.activity!.company_id);
    expect(a.activity!.previously_seen).toBe(false);
    expect(b.activity!.previously_seen).toBe(true);
    expect(t.repos.cache.companyIds.size).toBe(1);
    expect(t.repos.activity.observations).toHaveLength(2);
  });

  it.each([
    ["no_domain", { kind: "no_domain", creditsReported: 0 } as ProviderOutcome],
    ["excluded", resolved("example-isp.net", "ISP")],
    ["unknown usage", resolved("example.org", null)],
    ["denied domain", resolved("denied.example", "COM")],
    ["timeout", { kind: "timeout" } as ProviderOutcome],
    ["error", { kind: "error", category: "server", retryAfterMs: null } as ProviderOutcome],
  ] as const)("%s records no observation, from the provider or from the cache afterwards", async (_label, outcome) => {
    const t = setup({ [IP]: { outcome } });
    const o1 = await runJob(t.deps, t.config, job(IP, 4_000, ref(1)));
    expect(o1.status).not.toBe("qualified");
    expect(o1.activity).toBeUndefined();
    const o2 = await runJob(t.deps, t.config, job(IP, 4_000, ref(2)));
    expect(o2.source).toBe("cache");
    expect(o2.activity).toBeUndefined();
    expect(t.repos.activity.calls.recordObservation).toBe(0);
    expect(t.repos.activity.observations).toHaveLength(0);
  });

  it("a stale worker that lost its lease returns the answer but records nothing", async () => {
    const t = setup();
    const key = keyFor(t.config);
    const provider: ProviderAdapter = {
      name: "slow-stale",
      async lookup() {
        t.repos.cache.expireLease(key);
        return resolved("example.com", "COM");
      },
    };
    const o = await runJob({ ...t.deps, provider }, t.config, job());
    expect(o).toMatchObject({ status: "qualified", source: "provider" });
    expect(o.activity).toBeUndefined();
    expect(t.repos.activity.calls.recordObservation).toBe(0);
    expect(t.repos.activity.observations).toHaveLength(0);
  });

  it("pending followers sharing the caller's reference insert exactly once; distinct references each record", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM"), delayMs: 100 } });
    const config = makeConfig({ policy: { pending_wait_ms: 2_000, pending_poll_ms: 10 } });
    const shared = await Promise.all(Array.from({ length: 10 }, () => runJob(t.deps, config, job(IP, 4_000, ref(1)))));
    expect(shared.every((o) => o.status === "qualified" && o.activity?.recorded === true && o.activity.observation_ref === ref(1))).toBe(true);
    expect(t.repos.activity.observations).toHaveLength(1);
    expect(t.mock.calls).toBe(1);
    const distinct = await Promise.all(Array.from({ length: 10 }, (_, i) => runJob(t.deps, config, job(IP, 4_000, ref(100 + i)))));
    expect(distinct.every((o) => o.activity?.recorded === true && o.activity.previously_seen === true)).toBe(true);
    expect(t.repos.activity.observations).toHaveLength(11);
    expect(t.repos.activity.observations.filter((x) => x.companyFirst)).toHaveLength(1);
    expect(t.mock.calls).toBe(1);
  });

  it("a reference already spent on another company is not recorded for this one", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    await t.repos.activity.recordObservation({ scope: { installationId: "inst-test", websiteId: "site-test" }, companyId: 999, observationRef: ref(1), source: "provider", observedAt: new Date() });
    const o = await runJob(t.deps, t.config, job(IP, 4_000, ref(1)));
    expect(o).toMatchObject({ status: "qualified", activity: { previously_seen: null, recorded: false, observation_ref: ref(1) } });
    expect(t.repos.activity.observations).toHaveLength(1);
    expect(activityLogs(t)).toEqual([expect.objectContaining({ event: "activity_write_failed", reason: "internal_error" })]);
  });

  it("an activity write failure still returns the qualified answer, explicitly not recorded", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    t.repos.activity.failures.recordObservation = true;
    const o = await runJob(t.deps, t.config, job());
    expect(o).toMatchObject({ status: "qualified", source: "provider", activity: { previously_seen: null, recorded: false, observation_ref: REF } });
    expect(t.repos.cache.inspect(keyFor(t.config))!.status).toBe("qualified");
    expect(activityLogs(t)).toEqual([expect.objectContaining({ event: "activity_write_failed", reason: "database_error", source: "provider" })]);
    expect((await t.snapshot()).qualified_matches).toBe(1);
  });

  it("the activity write is skipped when the deadline leaves no budget", async () => {
    const t = setup();
    const key = keyFor(t.config);
    t.repos.cache.seed(key, { status: "qualified", company: { domain: "example.com", organisationName: "Example Ltd", qualificationCategory: "COM" }, checkedAt: new Date(), ttlMs: 60_000 });
    const o = await runJob(t.deps, t.config, job(IP, 100));
    expect(o).toMatchObject({ status: "qualified", source: "cache", activity: { previously_seen: null, recorded: false } });
    expect(t.repos.activity.calls.recordObservation).toBe(0);
    expect(activityLogs(t)).toEqual([expect.objectContaining({ event: "activity_write_failed", reason: "deadline_exceeded", source: "cache" })]);
  });

  it("a slow activity write is not awaited past the deadline: answered recorded=false (not confirmed), never cancelled, and it still lands afterwards (CHR-66 F4)", async () => {
    const t = setup();
    const key = keyFor(t.config);
    t.repos.cache.seed(key, { status: "qualified", company: { domain: "example.com", organisationName: "Example Ltd", qualificationCategory: "COM" }, checkedAt: new Date(), ttlMs: 60_000 });
    t.repos.activity.delayMs = 600;
    const deferred: Promise<void>[] = [];
    const started = Date.now();
    const o = await runJob({ ...t.deps, onDeferred: (p) => deferred.push(p) }, t.config, job(IP, 400));
    expect(Date.now() - started).toBeLessThan(400);
    expect(o).toMatchObject({ status: "qualified", source: "cache", activity: { previously_seen: null, recorded: false } });
    expect(activityLogs(t)).toEqual([expect.objectContaining({ event: "activity_write_failed", reason: "deadline_exceeded" })]);
    // At answer time nothing is stored; the write is handed to the runner, not cancelled ...
    expect(t.repos.activity.observations).toHaveLength(0);
    expect(deferred).toHaveLength(1);
    // ... and commits after the answer: recorded=false meant "not confirmed", not "not stored".
    await Promise.all(deferred);
    expect(t.repos.activity.observations).toHaveLength(1);
  });

  it("delayed best-effort accounting cannot consume the activity or response budget (Warp P2-3): cache hit", async () => {
    const t = setup();
    const key = keyFor(t.config);
    t.repos.cache.seed(key, { status: "qualified", company: { domain: "example.com", organisationName: "Example Ltd", qualificationCategory: "COM" }, checkedAt: new Date(), ttlMs: 60_000 });
    t.repos.usage.accountingDelayMs = 2_000;
    const deferred: Promise<void>[] = [];
    const started = Date.now();
    const o = await runJob({ ...t.deps, onDeferred: (p) => deferred.push(p) }, t.config, job(IP, 1_200));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_200);
    expect(o).toMatchObject({ status: "qualified", source: "cache", activity: { recorded: true, previously_seen: false } });
    expect(t.repos.activity.observations).toHaveLength(1);
    // resolver_requests and cache_hits both ran past their 250 ms budget: logged, tracked, still running.
    const timeouts = t.logger.entries.filter((l) => l["event"] === "db_error" && l["category"] === "usage_counter_timeout");
    expect(timeouts).toHaveLength(2);
    expect(deferred).toHaveLength(2);
    expect((await t.snapshot()).cache_hits).toBe(0); // not yet
    await Promise.all(deferred);
    expect((await t.snapshot()).cache_hits).toBe(1); // the tracked operation completed later
  });

  it("delayed accounting on the provider path still records activity first and keeps the atomic attempt reservation", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    t.repos.usage.accountingDelayMs = 2_000;
    const deferred: Promise<void>[] = [];
    const started = Date.now();
    const o = await runJob({ ...t.deps, onDeferred: (p) => deferred.push(p) }, t.config, job(IP, 1_500));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(o).toMatchObject({ status: "qualified", source: "provider", activity: { recorded: true } });
    expect(t.repos.activity.observations).toHaveLength(1);
    const s = await t.snapshot();
    expect(s.provider_attempts).toBe(1); // reserved atomically before dispatch, never bounded
    expect(deferred.length).toBeGreaterThanOrEqual(1);
    expect(t.logger.entries.some((l) => l["event"] === "db_error" && l["category"] === "usage_credits_timeout")).toBe(true);
    await Promise.all(deferred);
    expect((await t.snapshot()).qualified_matches).toBe(1);
  });

  it("accounting is skipped, not awaited, when the deadline leaves only the reserved budget", async () => {
    const t = setup();
    const key = keyFor(t.config);
    t.repos.cache.seed(key, { status: "qualified", company: { domain: "example.com", organisationName: "Example Ltd", qualificationCategory: "COM" }, checkedAt: new Date(), ttlMs: 60_000 });
    t.repos.usage.accountingDelayMs = 2_000;
    const started = Date.now();
    const o = await runJob(t.deps, t.config, job(IP, 500));
    expect(Date.now() - started).toBeLessThan(500);
    expect(o).toMatchObject({ status: "qualified", activity: { recorded: true } });
    expect(t.logger.entries.filter((l) => l["event"] === "db_error" && l["category"] === "usage_counter_skipped")).toHaveLength(2);
  });

  it("never logs the domain, the IP or the reference in activity events", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    await runJob(t.deps, t.config, job(IP, 4_000, ref(1)));
    const text = JSON.stringify(activityLogs(t));
    expect(text).not.toContain("example.com");
    expect(text).not.toContain(IP);
    expect(text).not.toContain(ref(1));
  });
});

describe("runJob: deadline abort (in-process runner, CHR-70)", () => {
  const withSignal = (j: ResolutionJob, signal: AbortSignal): ResolutionJob => ({ ...j, signal });
  const ref = (n: number) => `obsref-${String(n).padStart(16, "0")}`;

  it("an already-aborted job stops before the cache is touched and before any provider call", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    const o = await runJob(t.deps, t.config, withSignal(job(), AbortSignal.abort()));
    expect(o).toEqual({ status: "unavailable", source: "none", reason: "deadline_exceeded" });
    expect(t.repos.cache.calls.reserve).toBe(0);
    expect(t.mock.calls).toBe(0);
    expect((await t.snapshot()).provider_attempts).toBe(0);
  });

  it("an abort during the provider call cancels it promptly; the dispatched call is committed as uncertain and nothing is recorded", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM"), delayMs: 2_000 } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const o = await runJob(t.deps, t.config, withSignal(job(IP, 4_000, ref(1)), controller.signal));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(o).toMatchObject({ status: "uncertain", source: "provider", reason: "provider_timeout" });
    expect(t.mock.calls).toBe(1);
    // The paid attempt is never repeated for this address: the fenced commit still lands.
    expect(t.repos.cache.inspect(keyFor(t.config))!.status).toBe("uncertain");
    expect(t.repos.activity.observations).toHaveLength(0);
  });

  it("an abort after the provider answered keeps the fenced commit but never starts the activity write", async () => {
    const t = setup();
    const controller = new AbortController();
    const provider: ProviderAdapter = {
      name: "aborting",
      lookup: async () => {
        controller.abort(); // the deadline passes while the answer is in flight
        return resolved("example.com", "COM");
      },
    };
    const o = await runJob({ ...t.deps, provider }, t.config, withSignal(job(IP, 4_000, ref(2)), controller.signal));
    expect(o).toMatchObject({ status: "qualified", source: "provider", activity: { recorded: false, previously_seen: null, observation_ref: ref(2) } });
    expect(t.repos.cache.inspect(keyFor(t.config))!.status).toBe("qualified");
    expect(t.repos.activity.calls.recordObservation).toBe(0);
    expect(t.logger.entries.some((e) => e["event"] === "activity_write_failed" && e["reason"] === "deadline_exceeded")).toBe(true);
  });

  it("an abort during the kill-switch check stops before the usage reservation and frees the lease", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", "COM") } });
    const controller = new AbortController();
    const isEnabled = t.repos.controls.isEnrichmentEnabled.bind(t.repos.controls);
    t.repos.controls.isEnrichmentEnabled = async (id: string) => {
      controller.abort();
      return isEnabled(id);
    };
    const o = await runJob(t.deps, t.config, withSignal(job(), controller.signal));
    expect(o).toEqual({ status: "unavailable", source: "none", reason: "deadline_exceeded" });
    expect((await t.snapshot()).provider_attempts).toBe(0);
    expect(t.mock.calls).toBe(0);
    expect(t.repos.cache.calls.release).toBe(1);
    expect(t.repos.cache.inspect(keyFor(t.config))!.token).toBeNull();
  });

  it("an abort while waiting on another worker's lookup stops polling at once", async () => {
    const t = setup();
    const config = makeConfig({ policy: { pending_wait_ms: 3_000, pending_poll_ms: 20 } });
    await t.repos.cache.reserve(keyFor(config), { leaseMs: 10_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const o = await runJob(t.deps, config, withSignal(job(), controller.signal));
    expect(o).toEqual({ status: "unavailable", source: "none", reason: "deadline_exceeded" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("an activity write that outlives the deadline is handed to the runner as a tracked background write", async () => {
    const t = setup();
    const key = keyFor(t.config);
    t.repos.cache.seed(key, { status: "qualified", company: { domain: "example.com", organisationName: "Example Ltd", qualificationCategory: "COM" }, checkedAt: new Date(), ttlMs: 60_000 });
    const record = t.repos.activity.recordObservation.bind(t.repos.activity);
    t.repos.activity.recordObservation = (input) => new Promise((r) => setTimeout(() => r(record(input)), 600));
    const deferred: Promise<void>[] = [];
    const o = await runJob({ ...t.deps, onDeferred: (op) => deferred.push(op) }, t.config, job(IP, 500, ref(3)));
    expect(o).toMatchObject({ status: "qualified", activity: { recorded: false } });
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(t.repos.activity.observations).toHaveLength(1);
  });
});

describe("runJob: published cloud and crawler ranges (HOSTING_RANGES_MODE)", () => {
  // A stub matcher: IP is in a published range, every other address is not.
  const matcher = () => {
    const seen: string[] = [];
    return {
      seen,
      generatedAt: "2026-11-09",
      prefixCount: 1,
      lookup: (canonical: string) => {
        seen.push(canonical);
        return canonical === IP ? ("aws" as const) : null;
      },
    };
  };
  const setupWith = (mode: "off" | "shadow" | "enforce", script: MockScript) => {
    const t = setup(script);
    const m = matcher();
    const deps: PipelineDeps = { ...t.deps, hostingRanges: m };
    const config = makeConfig({ policy: { hosting_ranges_mode: mode } });
    return { ...t, m, deps, config };
  };
  const events = (t: { logger: { entries: Array<Record<string, unknown>> } }, name: string) => t.logger.entries.filter((e) => e["event"] === name);

  it("shadow: a match is logged by provider name and the lookup still runs, with the network type", async () => {
    const t = setupWith("shadow", { [IP]: { outcome: resolved("host.example", "DCH") } });
    const o = await runJob(t.deps, t.config, job());
    expect(o).toEqual({ status: "excluded", source: "provider", reason: "provider_excluded_usage_type" });
    expect(t.mock.calls).toBe(1);
    expect((await t.snapshot()).provider_attempts).toBe(1);
    expect(events(t, "provider_outcome")[0]).toMatchObject({ outcome: "resolved", usage_type: "DCH", hosting_range: "aws" });
    expect(events(t, "job_finished")[0]).toMatchObject({ status: "excluded", hosting_range: "aws" });
    // The address itself is never logged.
    expect(JSON.stringify(t.logger.entries)).not.toContain(IP);
  });

  it("shadow: no match leaves the logs as they were, apart from the network type", async () => {
    const other = "203.0.113.20";
    const t = setupWith("shadow", { [other]: { outcome: resolved("example.com", "COM") } });
    const o = await runJob(t.deps, t.config, job(other));
    expect(o.status).toBe("qualified");
    expect(t.m.seen).toEqual([other]);
    expect(events(t, "provider_outcome")[0]).toMatchObject({ usage_type: "COM" });
    expect(t.logger.entries.some((e) => "hosting_range" in e)).toBe(false);
  });

  it("enforce: a match is excluded before the cache, the reservation and the provider", async () => {
    const t = setupWith("enforce", { [IP]: { outcome: resolved("host.example", "DCH") } });
    const o = await runJob(t.deps, t.config, job());
    expect(o).toEqual({ status: "excluded", source: "none", reason: "ip_hosting_range" });
    expect(t.mock.calls).toBe(0);
    expect(t.repos.cache.calls.reserve + t.repos.cache.calls.readFresh + t.repos.cache.calls.commit).toBe(0);
    const snap = await t.snapshot();
    expect(snap.provider_attempts).toBe(0);
    expect(snap.resolver_requests).toBe(1);
    expect(events(t, "job_finished")[0]).toMatchObject({ status: "excluded", reason: "ip_hosting_range", hosting_range: "aws" });
    expect(events(t, "provider_outcome")).toHaveLength(0);
  });

  it("enforce: an address outside every range is looked up as usual", async () => {
    const other = "203.0.113.21";
    const t = setupWith("enforce", { [other]: { outcome: resolved("example.com", "COM") } });
    expect((await runJob(t.deps, t.config, job(other))).status).toBe("qualified");
    expect(t.mock.calls).toBe(1);
  });

  it("off (the default): the matcher is never consulted, even when loaded", async () => {
    for (const mode of ["off", undefined] as const) {
      const t = setupWith("off", { [IP]: { outcome: resolved("host.example", "DCH") } });
      const config = mode === undefined ? makeConfig() : t.config;
      const o = await runJob(t.deps, config, job());
      expect(o.reason).toBe("provider_excluded_usage_type");
      expect(t.m.seen).toEqual([]);
      expect(t.logger.entries.some((e) => "hosting_range" in e)).toBe(false);
    }
  });

  it("an ineligible address is never matched", async () => {
    const t = setupWith("enforce", {});
    expect((await runJob(t.deps, t.config, job("10.0.0.1"))).reason).toBe("ip_ineligible");
    expect(t.m.seen).toEqual([]);
  });

  it("the network type is logged only for a found domain, never the domain or the name", async () => {
    const t = setup({ [IP]: { outcome: resolved("example.com", null, "Example Ltd") } });
    await runJob(t.deps, t.config, job());
    expect(events(t, "provider_outcome")[0]).toMatchObject({ outcome: "resolved", usage_type: "none" });
    expect(JSON.stringify(t.logger.entries)).not.toMatch(/example\.com|Example Ltd/);
    const n = setup({ [IP]: { outcome: { kind: "no_domain", creditsReported: 0 } } });
    await runJob(n.deps, n.config, job());
    expect(events(n, "provider_outcome")[0]).not.toHaveProperty("usage_type");
  });
});
