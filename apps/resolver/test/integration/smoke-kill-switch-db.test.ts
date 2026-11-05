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
 *     database through its conditional statements (src/ops/smoke-controls.ts):
 *     restores a released switch, never writes an engaged one (its reason
 *     survives), probes while engaged, never releases an engagement made by
 *     someone else during the run (compare-and-set, Gate 4 review G4-L3), and
 *     never touches a switch left engaged by an earlier smoke run (G4-L2).
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
import { createSmokeKillSwitchControls } from "../../src/ops/smoke-controls.js";
import { engageReason, KILL_SWITCH_CACHE_TTL_MS, restoreReason, runKillSwitchPhase, smokeExitCode } from "../../src/ops/smoke-kill-switch.js";
import { KILL_SWITCH_PROBE_PREFIX, killSwitchProbeAddress, PROBE_RANDOM_BYTES } from "../../src/ops/smoke-mode.js";
import { createMockProvider, type MockProvider } from "../../src/provider/mock.js";
import { runJob } from "../../src/resolution/pipeline.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";

const SECRET = "0123456789abcdef".repeat(4);
const INSTALLATION = "inst-test";
const WEBSITE = "site-test";
const RUN = "5eed000001";

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
    period_resolved_cap: 100,
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
      controls: createSmokeKillSwitchControls(db.pool, INSTALLATION),
      run: RUN,
      probe: async () => {
        // The probe runs while the switch is engaged by the smoke, with this run's reason.
        expect(await control()).toEqual([{ enrichment_enabled: false, reason: engageReason(RUN) }]);
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
    expect(await control()).toEqual([{ enrichment_enabled: true, reason: restoreReason(RUN) }]);
    expect(await db.controls.isEnrichmentEnabled(INSTALLATION)).toBe(true);
    expect(provider.calls).toBe(0);
    expect((await run(address(7))).status).toBe("no_match");
  });

  it("phase, prior engaged by an operator: probes, never writes, and the operator's reason survives", async () => {
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, "operator: budget spike");
    const before = (await db.pool.query<{ updated_at: Date }>("SELECT updated_at FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows[0]!.updated_at;
    const r = await runKillSwitchPhase({
      controls: createSmokeKillSwitchControls(db.pool, INSTALLATION),
      run: RUN,
      probe: () => run(address(8)),
    });
    expect(r).toMatchObject({ prior: "engaged", engage: "already_engaged", probe: { kind: "result", value: { status: "disabled", reason: "kill_switch" } }, restore: "left_engaged_as_found", final: "engaged" });
    expect(await control()).toEqual([{ enrichment_enabled: false, reason: "operator: budget spike" }]);
    const after = (await db.pool.query<{ updated_at: Date }>("SELECT updated_at FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows[0]!.updated_at;
    expect(after.getTime()).toBe(before.getTime());
  });

  it("G4-L3: an operator engages the switch while the smoke holds it: the compare-and-set restore leaves the operator's engagement untouched (exit 2)", async () => {
    const r = await runKillSwitchPhase({
      controls: createSmokeKillSwitchControls(db.pool, INSTALLATION),
      run: RUN,
      probe: async () => {
        const answer = await run(address(9));
        // ops:kill-switch on: the operator's unconditional upsert, while the smoke holds the switch.
        await db.controls.setEnrichmentEnabled(INSTALLATION, false, "operator: incident");
        return answer;
      },
    });
    expect(r).toMatchObject({ prior: "released", engage: "engaged_by_smoke", probe: { kind: "result", value: { status: "disabled" } }, restore: "changed_during_run", final: "engaged" });
    expect(await control()).toEqual([{ enrichment_enabled: false, reason: "operator: incident" }]);
    expect(smokeExitCode(0, r.restore)).toBe(2);
  });

  it("G4-L2: a switch left engaged by an earlier smoke run (Gate 4 reason or this build's) is neither probed nor written (exit 2)", async () => {
    for (const reason of ["smoke test (CHR-72): engaged temporarily to verify the disabled outcome", engageReason("0ddba11")]) {
      await db.controls.setEnrichmentEnabled(INSTALLATION, false, reason);
      const before = (await db.pool.query<{ updated_at: Date }>("SELECT updated_at FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows[0]!.updated_at;
      let probed = false;
      const r = await runKillSwitchPhase({
        controls: createSmokeKillSwitchControls(db.pool, INSTALLATION),
        run: RUN,
        probe: async () => {
          probed = true;
          return run(address(10));
        },
      });
      expect(r, reason).toEqual({ prior: "engaged", engage: "smoke_orphan", probe: { kind: "not_run" }, restore: "orphan_left_engaged", final: "engaged" });
      expect(probed).toBe(false);
      expect(await control()).toEqual([{ enrichment_enabled: false, reason }]);
      const after = (await db.pool.query<{ updated_at: Date }>("SELECT updated_at FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows[0]!.updated_at;
      expect(after.getTime()).toBe(before.getTime());
      expect(smokeExitCode(0, r.restore)).toBe(2);
    }
  });
});

describe("smoke kill-switch statements (src/ops/smoke-controls.ts)", () => {
  let db: Db;
  const control = async () =>
    (await db.pool.query<{ enrichment_enabled: boolean; reason: string | null }>("SELECT enrichment_enabled, reason FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows;

  beforeAll(async () => {
    db = await createTestDb({ max: 2 });
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });

  it("read: an absent row reads released with no reason; a row reads its state and reason", async () => {
    const c = createSmokeKillSwitchControls(db.pool, INSTALLATION);
    expect(await c.read()).toEqual({ state: "released", reason: null });
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, "operator: x");
    expect(await c.read()).toEqual({ state: "engaged", reason: "operator: x" });
    // Scoped to this installation only.
    expect(await createSmokeKillSwitchControls(db.pool, "other-inst").read()).toEqual({ state: "released", reason: null });
  });

  it("engageIfReleased engages an absent or released row, and never overwrites an engagement", async () => {
    const c = createSmokeKillSwitchControls(db.pool, INSTALLATION);
    expect(await c.engageIfReleased(engageReason(RUN))).toBe(true);
    expect(await control()).toEqual([{ enrichment_enabled: false, reason: engageReason(RUN) }]);
    expect(await c.engageIfReleased(engageReason("abc"))).toBe(false);
    expect(await control()).toEqual([{ enrichment_enabled: false, reason: engageReason(RUN) }]);
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, "operator: incident");
    expect(await c.engageIfReleased(engageReason(RUN))).toBe(false);
    expect(await control()).toEqual([{ enrichment_enabled: false, reason: "operator: incident" }]);
    await db.controls.setEnrichmentEnabled(INSTALLATION, true, "operator: over");
    expect(await c.engageIfReleased(engageReason(RUN))).toBe(true);
    expect(await control()).toEqual([{ enrichment_enabled: false, reason: engageReason(RUN) }]);
  });

  it("releaseIfHeld releases only an engagement with exactly the given reason", async () => {
    const c = createSmokeKillSwitchControls(db.pool, INSTALLATION);
    expect(await c.releaseIfHeld(engageReason(RUN), restoreReason(RUN))).toBe(false); // no row
    expect(await control()).toEqual([]);
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, "operator: incident");
    expect(await c.releaseIfHeld(engageReason(RUN), restoreReason(RUN))).toBe(false);
    expect(await control()).toEqual([{ enrichment_enabled: false, reason: "operator: incident" }]);
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, engageReason("abc"));
    expect(await c.releaseIfHeld(engageReason(RUN), restoreReason(RUN))).toBe(false); // another run's engagement
    expect(await control()).toEqual([{ enrichment_enabled: false, reason: engageReason("abc") }]);
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, engageReason(RUN));
    expect(await c.releaseIfHeld(engageReason(RUN), restoreReason(RUN))).toBe(true);
    expect(await control()).toEqual([{ enrichment_enabled: true, reason: restoreReason(RUN) }]);
    expect(await c.releaseIfHeld(engageReason(RUN), restoreReason(RUN))).toBe(false); // already released
  });

  it("database errors surface as a sanitised DbError, without statement text or values", async () => {
    const broken = createSmokeKillSwitchControls(
      { query: (async () => Promise.reject(Object.assign(new Error(`failed for ${engageReason(RUN)}`), { code: "57014" }))) as never },
      INSTALLATION,
    );
    await expect(broken.read()).rejects.toMatchObject({ name: "DbError", code: "57014", message: "database error (57014)" });
    await expect(broken.engageIfReleased(engageReason(RUN))).rejects.toMatchObject({ name: "DbError" });
    await expect(broken.releaseIfHeld(engageReason(RUN), restoreReason(RUN))).rejects.toMatchObject({ name: "DbError" });
  });
});
