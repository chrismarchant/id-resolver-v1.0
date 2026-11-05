import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { USAGE_COUNTERS, type UsageScope } from "../../src/contracts/db.js";
import type { Db } from "../../src/db/index.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";

const UNCAPPED = 10_000_000;

const scope = (periodKey = "2026-03"): UsageScope => ({ installationId: "test-install", websiteId: "test-site", periodKey });

describe("usage repository", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb({ max: 12 });
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });

  it("cap 5 with 50 concurrent reservations: exactly 5 reserved", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => db.usage.reserveProviderAttempt(scope(), 5, UNCAPPED)));
    expect(results.filter((r) => r === "reserved")).toHaveLength(5);
    expect(results.filter((r) => r === "cap_exhausted")).toHaveLength(45);
    expect((await db.usage.snapshot(scope())).provider_attempts).toBe(5);
  });

  it("cap 0 is cap_exhausted on an empty table and creates no row", async () => {
    expect(await db.usage.reserveProviderAttempt(scope(), 0, UNCAPPED)).toBe("cap_exhausted");
    const n = await db.pool.query("SELECT count(*)::int AS n FROM usage_periods");
    expect(n.rows[0].n).toBe(0);
  });

  it("cap 1 admits exactly one, sequentially", async () => {
    expect(await db.usage.reserveProviderAttempt(scope(), 1, UNCAPPED)).toBe("reserved");
    expect(await db.usage.reserveProviderAttempt(scope(), 1, UNCAPPED)).toBe("cap_exhausted");
    expect(await db.usage.reserveProviderAttempt(scope(), 2, UNCAPPED)).toBe("reserved"); // raised cap
    expect((await db.usage.snapshot(scope())).provider_attempts).toBe(2);
  });

  it("kill switch (enrichment disabled) returns disabled, on empty and existing rows, counter unchanged", async () => {
    await db.controls.setEnrichmentEnabled("test-install", false, "test");
    expect(await db.usage.reserveProviderAttempt(scope(), 100, UNCAPPED)).toBe("disabled");
    expect((await db.usage.snapshot(scope())).provider_attempts).toBe(0);

    await db.controls.setEnrichmentEnabled("test-install", true, "back");
    expect(await db.usage.reserveProviderAttempt(scope(), 100, UNCAPPED)).toBe("reserved");
    await db.controls.setEnrichmentEnabled("test-install", false, "again");
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => db.usage.reserveProviderAttempt(scope(), 100, UNCAPPED)));
    expect(concurrent.every((r) => r === "disabled")).toBe(true);
    expect((await db.usage.snapshot(scope())).provider_attempts).toBe(1);
  });

  it("the switch of another installation does not affect this one", async () => {
    await db.controls.setEnrichmentEnabled("someone-else", false, "x");
    expect(await db.usage.reserveProviderAttempt(scope(), 3, UNCAPPED)).toBe("reserved");
  });

  it("increment and addProviderCredits accumulate; snapshot separates reported from estimated", async () => {
    const s = scope();
    await db.usage.increment(s, "resolver_requests");
    await db.usage.increment(s, "resolver_requests", 4);
    await db.usage.increment(s, "cache_hits", 2);
    await db.usage.increment(s, "failures", 0); // no-op
    await Promise.all(Array.from({ length: 20 }, () => db.usage.increment(s, "qualified_matches")));
    await db.usage.addProviderCredits(s, { reported: 100 });
    await db.usage.addProviderCredits(s, { estimated: 100 });
    await db.usage.addProviderCredits(s, { reported: 100, estimated: 50 });
    await db.usage.addProviderCredits(s, {});

    const snap = await db.usage.snapshot(s);
    expect(snap.periodKey).toBe("2026-03");
    expect(snap.resolver_requests).toBe(5);
    expect(snap.cache_hits).toBe(2);
    expect(snap.qualified_matches).toBe(20);
    expect(snap.failures).toBe(0);
    expect(snap.providerCreditsReported).toBe(200);
    expect(snap.providerCreditsEstimated).toBe(150);
  });

  it("every declared counter is incrementable", async () => {
    for (const c of USAGE_COUNTERS) await db.usage.increment(scope(), c, 3);
    const snap = await db.usage.snapshot(scope());
    for (const c of USAGE_COUNTERS) expect(snap[c]).toBe(3);
  });

  it("snapshot of an unknown period is all zeros", async () => {
    const snap = await db.usage.snapshot(scope("1999-01"));
    for (const c of USAGE_COUNTERS) expect(snap[c]).toBe(0);
    expect(snap.providerCreditsReported).toBe(0);
    expect(snap.providerCreditsEstimated).toBe(0);
  });

  it("periods, websites and installations are independent", async () => {
    expect(await db.usage.reserveProviderAttempt(scope("2026-03"), 1, UNCAPPED)).toBe("reserved");
    expect(await db.usage.reserveProviderAttempt(scope("2026-03"), 1, UNCAPPED)).toBe("cap_exhausted");
    expect(await db.usage.reserveProviderAttempt(scope("2026-04"), 1, UNCAPPED)).toBe("reserved");
    expect(await db.usage.reserveProviderAttempt({ ...scope(), websiteId: "w2" }, 1, UNCAPPED)).toBe("reserved");
    await db.usage.increment(scope("2026-04"), "cache_hits", 7);
    expect((await db.usage.snapshot(scope("2026-03"))).cache_hits).toBe(0);
    expect((await db.usage.snapshot(scope("2026-04"))).cache_hits).toBe(7);
  });

  it("resolved cap 5 with 50 concurrent reservations: exactly 5 reserved, the rest resolved_cap_exhausted", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => db.usage.reserveProviderAttempt(scope(), 1_000, 5)));
    expect(results.filter((r) => r === "reserved")).toHaveLength(5);
    expect(results.filter((r) => r === "resolved_cap_exhausted")).toHaveLength(45);
    const snap = await db.usage.snapshot(scope());
    expect(snap.provider_attempts).toBe(5);
    expect(snap.providerChargeSlots).toBe(5);
  });

  it("a released slot can be reserved again; provider_attempts keeps counting every call", async () => {
    expect(await db.usage.reserveProviderAttempt(scope(), 100, 1)).toBe("reserved");
    expect(await db.usage.reserveProviderAttempt(scope(), 100, 1)).toBe("resolved_cap_exhausted");
    await db.usage.releaseChargeSlot(scope());
    expect(await db.usage.reserveProviderAttempt(scope(), 100, 1)).toBe("reserved");
    const snap = await db.usage.snapshot(scope());
    expect(snap.provider_attempts).toBe(2);
    expect(snap.providerChargeSlots).toBe(1);
  });

  it("concurrent reservations and releases never exceed the resolved cap", async () => {
    let maxHeld = 0;
    const worker = async (i: number) => {
      const r = await db.usage.reserveProviderAttempt(scope(), 1_000, 3);
      if (r !== "reserved") return r;
      const held = (await db.usage.snapshot(scope())).providerChargeSlots;
      maxHeld = Math.max(maxHeld, held);
      if (i % 2 === 0) await db.usage.releaseChargeSlot(scope());
      return r;
    };
    await Promise.all(Array.from({ length: 40 }, (_, i) => worker(i)));
    expect(maxHeld).toBeLessThanOrEqual(3);
    expect((await db.usage.snapshot(scope())).providerChargeSlots).toBeLessThanOrEqual(3);
  });

  it("the call cap is reported before the resolved cap, and the kill switch before both", async () => {
    expect(await db.usage.reserveProviderAttempt(scope(), 1, 1)).toBe("reserved");
    expect(await db.usage.reserveProviderAttempt(scope(), 1, 1)).toBe("cap_exhausted");
    expect(await db.usage.reserveProviderAttempt(scope(), 0, 0)).toBe("cap_exhausted");
    expect(await db.usage.reserveProviderAttempt(scope("2026-05"), 5, 0)).toBe("resolved_cap_exhausted");
    const n = await db.pool.query("SELECT count(*)::int AS n FROM usage_periods WHERE period_key = '2026-05'");
    expect(n.rows[0].n).toBe(0);
    await db.controls.setEnrichmentEnabled("test-install", false, "test");
    expect(await db.usage.reserveProviderAttempt(scope("2026-06"), 0, 0)).toBe("disabled");
  });

  it("release never goes below zero and never creates a row", async () => {
    await db.usage.releaseChargeSlot(scope("2026-07"));
    const none = await db.pool.query("SELECT count(*)::int AS n FROM usage_periods WHERE period_key = '2026-07'");
    expect(none.rows[0].n).toBe(0);
    expect(await db.usage.reserveProviderAttempt(scope("2026-07"), 10, 10)).toBe("reserved");
    await db.usage.releaseChargeSlot(scope("2026-07"));
    await db.usage.releaseChargeSlot(scope("2026-07"));
    expect((await db.usage.snapshot(scope("2026-07"))).providerChargeSlots).toBe(0);
  });

  it("rollback: the previous build's reservation statement (before 0010) still runs and leaves the slots untouched", async () => {
    const previousReserveSql = `
INSERT INTO usage_periods (installation_id, website_id, period_key, provider_attempts, updated_at)
SELECT $1::text, $2::text, $3::text, 1, now()
WHERE $4::bigint > 0
  AND COALESCE((SELECT enrichment_enabled FROM deployment_controls WHERE installation_id = $1::text), true)
ON CONFLICT (installation_id, website_id, period_key) DO UPDATE SET
  provider_attempts = usage_periods.provider_attempts + 1,
  updated_at = now()
WHERE usage_periods.provider_attempts < $4::bigint
  AND COALESCE((SELECT enrichment_enabled FROM deployment_controls WHERE installation_id = $1::text), true)
RETURNING provider_attempts`;
    const s = scope();
    for (let i = 0; i < 2; i++) {
      const r = await db.pool.query(previousReserveSql, [s.installationId, s.websiteId, s.periodKey, 5]);
      expect(r.rowCount).toBe(1);
    }
    const snap = await db.usage.snapshot(s);
    expect(snap.provider_attempts).toBe(2);
    expect(snap.providerChargeSlots).toBe(0);
  });

  it("the column refuses a negative value", async () => {
    expect(await db.usage.reserveProviderAttempt(scope(), 10, 10)).toBe("reserved");
    await expect(
      db.pool.query("UPDATE usage_periods SET provider_charge_slots = -1 WHERE installation_id = 'test-install'"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an unknown counter name and bad numbers without touching SQL", async () => {
    await expect(db.usage.increment(scope(), "x; DROP TABLE usage_periods" as never)).rejects.toMatchObject({
      code: "INVALID_COUNTER",
    });
    await expect(db.usage.increment(scope(), "cache_hits", -1)).rejects.toMatchObject({ code: "INVALID_DELTA" });
    await expect(db.usage.increment(scope(), "cache_hits", 1.5)).rejects.toMatchObject({ code: "INVALID_DELTA" });
    await expect(db.usage.reserveProviderAttempt(scope(), -1, UNCAPPED)).rejects.toMatchObject({ code: "INVALID_CAP" });
    await expect(db.usage.reserveProviderAttempt(scope(), 5, -1)).rejects.toMatchObject({ code: "INVALID_CAP" });
    await expect(db.usage.reserveProviderAttempt(scope(), 5, 1.5)).rejects.toMatchObject({ code: "INVALID_CAP" });
    await expect(db.usage.addProviderCredits(scope(), { reported: -5 })).rejects.toMatchObject({ code: "INVALID_DELTA" });
    const t = await db.pool.query("SELECT to_regclass('usage_periods') AS t");
    expect(t.rows[0].t).not.toBeNull();
  });
});
