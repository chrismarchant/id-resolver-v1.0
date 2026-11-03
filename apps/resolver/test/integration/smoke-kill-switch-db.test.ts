/**
 * CHR-72: the facts the smoke test's kill-switch phase relies on, proved
 * against PostgreSQL with the real repositories and the real pipeline:
 *
 *   - a `disabled` (kill switch) outcome writes a cache row (the reservation)
 *     but releases it already expired, so it is never served from the cache:
 *     the same address answers `disabled` again, and reaches the provider once
 *     the switch is released. (The smoke still probes a fresh address on every
 *     run: src/ops/smoke-mode.ts.)
 *   - the service has no in-process copy of the switch: a change applies to
 *     the very next cache miss with no wait (KILL_SWITCH_CACHE_TTL_MS = 0).
 *   - the phase itself (src/ops/smoke-kill-switch.ts) against the real
 *     controls repository: restores a released switch, never writes an
 *     engaged one (its reason survives), and probes while engaged.
 * Synthetic RFC 3849 addresses only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usagePeriodKey } from "../../src/contracts/db.js";
import type { CacheKey } from "../../src/contracts/db.js";
import type { PipelineConfig, ResolutionJob, ResolutionOutcome } from "../../src/contracts/runtime.js";
import type { Db } from "../../src/db/index.js";
import { canonicaliseIp } from "../../src/ip/canonical.js";
import { computeFingerprint, decodeSecret } from "../../src/ip/fingerprint.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { ENGAGE_REASON, KILL_SWITCH_CACHE_TTL_MS, RESTORE_REASON, runKillSwitchPhase } from "../../src/ops/smoke-kill-switch.js";
import { KILL_SWITCH_PROBE_PREFIX, killSwitchProbeAddress, PROBE_RANDOM_BYTES } from "../../src/ops/smoke-mode.js";
import { createMockProvider, type MockProvider } from "../../src/provider/mock.js";
import { runJob } from "../../src/resolution/pipeline.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";

const SECRET = "0123456789abcdef".repeat(4);
const INSTALLATION = "inst-test";
const WEBSITE = "site-test";

const config: PipelineConfig = {
  installation_id: INSTALLATION,
  website_id: WEBSITE,
  key_version: 1,
  ip_hmac_secret: SECRET,
  provider: { mode: "mock", base_url: "https://provider.invalid", api_key: "k", auth_header: "x-api-key", timeout_ms: 1_000 },
  policy: {
    ttl_qualified_ms: 60_000,
    ttl_no_match_ms: 60_000,
    ttl_excluded_ms: 60_000,
    ttl_unknown_ms: 60_000,
    ttl_provider_error_ms: 60_000,
    ttl_uncertain_ms: 60_000,
    lease_ms: 2_000,
    pending_wait_ms: 500,
    pending_poll_ms: 20,
    period_call_cap: 100,
    usage_period: "month",
    qualified_usage_types: ["COM"],
    excluded_usage_types: ["ISP"],
    denied_domains: [],
    allow_documentation_ranges: true,
  },
};

let seq = 0;
const job = (ip: string): ResolutionJob => ({
  context: { pageKey: "/smoke/kill-switch", acquisition: "direct", entranceContract: "entrance.v1", eligibility: "tsa-1" },
  job_id: `job-ks-${(seq += 1)}`,
  ip,
  deadline_at_ms: Date.now() + 4_000,
  observation_ref: `obsref-${String(seq).padStart(16, "0")}`,
});

/** A fresh synthetic address with fixed bytes per label, so each test owns its own. */
const address = (n: number) => killSwitchProbeAddress(KILL_SWITCH_PROBE_PREFIX, Buffer.alloc(PROBE_RANDOM_BYTES, n));

function keyFor(ip: string): CacheKey {
  const c = canonicaliseIp(ip, { allowDocumentationRanges: true });
  if (!c.ok) throw new Error("invalid test address");
  return { installationId: INSTALLATION, websiteId: WEBSITE, keyVersion: 1, ipFingerprint: computeFingerprint(decodeSecret(SECRET), INSTALLATION, WEBSITE, c.canonical) };
}

describe("smoke kill-switch phase against PostgreSQL", () => {
  let db: Db;
  let provider: MockProvider;
  const run = (ip: string): Promise<ResolutionOutcome> =>
    runJob({ cache: db.cache, usage: db.usage, controls: db.controls, companies: db.companies, activity: db.activity, provider, logger: createMemoryLogger() }, config, job(ip));
  const cacheRows = async (ip: string) => {
    const k = keyFor(ip);
    const res = await db.pool.query<{ status: string; expired: boolean; lease_expires_at: Date | null; reservation_token: string | null }>(
      `SELECT status, expires_at <= clock_timestamp() AS expired, lease_expires_at, reservation_token FROM ip_resolution_cache
       WHERE installation_id = $1 AND website_id = $2 AND key_version = $3 AND ip_fingerprint = $4`,
      [k.installationId, k.websiteId, k.keyVersion, k.ipFingerprint],
    );
    return res.rows;
  };
  const control = async () =>
    (await db.pool.query<{ enrichment_enabled: boolean; reason: string }>("SELECT enrichment_enabled, reason FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows;

  beforeAll(async () => {
    db = await createTestDb({ max: 4 });
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetTestDb(db);
    provider = createMockProvider();
  });

  it("a disabled outcome leaves only an already-expired reservation row: never a cache hit, so the same address stays disabled across runs", async () => {
    const ip = address(1);
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, "test: engaged");

    const first = await run(ip);
    expect(first).toEqual({ status: "disabled", source: "none", reason: "kill_switch" });
    expect(provider.calls).toBe(0);
    // The row the reservation inserted, released: not pending, no lease, expired at once.
    expect(await cacheRows(ip)).toEqual([{ status: "unknown", expired: true, lease_expires_at: null, reservation_token: null }]);
    expect(await db.cache.readFresh(keyFor(ip))).toBeNull();

    // A second run with the same address is a cache MISS again (not a cached answer).
    const second = await run(ip);
    expect(second).toEqual({ status: "disabled", source: "none", reason: "kill_switch" });
    expect(await cacheRows(ip)).toHaveLength(1);
    expect(provider.calls).toBe(0);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM company_observations")).rows[0].n).toBe(0);
    expect((await db.usage.snapshot({ installationId: INSTALLATION, websiteId: WEBSITE, periodKey: usagePeriodKey("month", new Date()) })).provider_attempts).toBe(0);

    // Released: the same address reaches the provider (unscripted -> no_domain -> no_match).
    await db.controls.setEnrichmentEnabled(INSTALLATION, true, "test: released");
    expect(await run(ip)).toEqual({ status: "no_match", source: "provider", reason: "provider_no_domain" });
    expect(provider.calls).toBe(1);
  });

  it("the switch applies to the very next cache miss with no wait: there is no in-process copy", async () => {
    expect(KILL_SWITCH_CACHE_TTL_MS).toBe(0);
    expect((await run(address(2))).status).toBe("no_match");
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, "test: engaged");
    expect(await run(address(3))).toMatchObject({ status: "disabled", reason: "kill_switch" });
    await db.controls.setEnrichmentEnabled(INSTALLATION, true, "test: released");
    expect((await run(address(4))).status).toBe("no_match");
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, "test: engaged");
    expect(await run(address(5))).toMatchObject({ status: "disabled", reason: "kill_switch" });
    expect(provider.calls).toBe(2);
  });

  it("phase, prior released (no row at all): engages, the probe is disabled, then released again and verified", async () => {
    expect(await control()).toEqual([]);
    const ip = address(6);
    const r = await runKillSwitchPhase({
      controls: {
        isEnrichmentEnabled: () => db.controls.isEnrichmentEnabled(INSTALLATION),
        setEnrichmentEnabled: (enabled, reason) => db.controls.setEnrichmentEnabled(INSTALLATION, enabled, reason),
      },
      probe: async () => {
        // The probe runs while the switch is engaged by the smoke.
        expect(await control()).toEqual([{ enrichment_enabled: false, reason: ENGAGE_REASON }]);
        return run(ip);
      },
    });
    expect(r).toEqual({
      prior: "released",
      engage: "engaged_by_smoke",
      probe: { kind: "result", value: { status: "disabled", source: "none", reason: "kill_switch" } },
      restore: "restored",
      final: "released",
    });
    // Absent row == released; the restore leaves an explicit released row with the smoke's reason.
    expect(await control()).toEqual([{ enrichment_enabled: true, reason: RESTORE_REASON }]);
    expect(await db.controls.isEnrichmentEnabled(INSTALLATION)).toBe(true);
    expect(provider.calls).toBe(0);
    expect((await run(address(7))).status).toBe("no_match");
  });

  it("phase, prior engaged by an operator: probes, never writes, and the operator's reason survives", async () => {
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, "operator: budget spike");
    const before = (await db.pool.query<{ updated_at: Date }>("SELECT updated_at FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows[0]!.updated_at;
    const r = await runKillSwitchPhase({
      controls: {
        isEnrichmentEnabled: () => db.controls.isEnrichmentEnabled(INSTALLATION),
        setEnrichmentEnabled: (enabled, reason) => db.controls.setEnrichmentEnabled(INSTALLATION, enabled, reason),
      },
      probe: () => run(address(8)),
    });
    expect(r).toMatchObject({ prior: "engaged", engage: "already_engaged", probe: { kind: "result", value: { status: "disabled", reason: "kill_switch" } }, restore: "left_engaged_as_found", final: "engaged" });
    expect(await control()).toEqual([{ enrichment_enabled: false, reason: "operator: budget spike" }]);
    const after = (await db.pool.query<{ updated_at: Date }>("SELECT updated_at FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows[0]!.updated_at;
    expect(after.getTime()).toBe(before.getTime());
  });
});
