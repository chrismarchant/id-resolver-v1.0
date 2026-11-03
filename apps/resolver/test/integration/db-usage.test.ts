import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { USAGE_COUNTERS, type UsageScope } from "../../src/contracts/db.js";
import type { Db } from "../../src/db/index.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";

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
    const results = await Promise.all(Array.from({ length: 50 }, () => db.usage.reserveProviderAttempt(scope(), 5)));
    expect(results.filter((r) => r === "reserved")).toHaveLength(5);
    expect(results.filter((r) => r === "cap_exhausted")).toHaveLength(45);
    expect((await db.usage.snapshot(scope())).provider_attempts).toBe(5);
  });

  it("cap 0 is cap_exhausted on an empty table and creates no row", async () => {
    expect(await db.usage.reserveProviderAttempt(scope(), 0)).toBe("cap_exhausted");
    const n = await db.pool.query("SELECT count(*)::int AS n FROM usage_periods");
    expect(n.rows[0].n).toBe(0);
  });

  it("cap 1 admits exactly one, sequentially", async () => {
    expect(await db.usage.reserveProviderAttempt(scope(), 1)).toBe("reserved");
    expect(await db.usage.reserveProviderAttempt(scope(), 1)).toBe("cap_exhausted");
    expect(await db.usage.reserveProviderAttempt(scope(), 2)).toBe("reserved"); // raised cap
    expect((await db.usage.snapshot(scope())).provider_attempts).toBe(2);
  });

  it("kill switch (enrichment disabled) returns disabled, on empty and existing rows, counter unchanged", async () => {
    await db.controls.setEnrichmentEnabled("test-install", false, "test");
    expect(await db.usage.reserveProviderAttempt(scope(), 100)).toBe("disabled");
    expect((await db.usage.snapshot(scope())).provider_attempts).toBe(0);

    await db.controls.setEnrichmentEnabled("test-install", true, "back");
    expect(await db.usage.reserveProviderAttempt(scope(), 100)).toBe("reserved");
    await db.controls.setEnrichmentEnabled("test-install", false, "again");
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => db.usage.reserveProviderAttempt(scope(), 100)));
    expect(concurrent.every((r) => r === "disabled")).toBe(true);
    expect((await db.usage.snapshot(scope())).provider_attempts).toBe(1);
  });

  it("the switch of another installation does not affect this one", async () => {
    await db.controls.setEnrichmentEnabled("someone-else", false, "x");
    expect(await db.usage.reserveProviderAttempt(scope(), 3)).toBe("reserved");
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
    expect(await db.usage.reserveProviderAttempt(scope("2026-03"), 1)).toBe("reserved");
    expect(await db.usage.reserveProviderAttempt(scope("2026-03"), 1)).toBe("cap_exhausted");
    expect(await db.usage.reserveProviderAttempt(scope("2026-04"), 1)).toBe("reserved");
    expect(await db.usage.reserveProviderAttempt({ ...scope(), websiteId: "w2" }, 1)).toBe("reserved");
    await db.usage.increment(scope("2026-04"), "cache_hits", 7);
    expect((await db.usage.snapshot(scope("2026-03"))).cache_hits).toBe(0);
    expect((await db.usage.snapshot(scope("2026-04"))).cache_hits).toBe(7);
  });

  it("rejects an unknown counter name and bad numbers without touching SQL", async () => {
    await expect(db.usage.increment(scope(), "x; DROP TABLE usage_periods" as never)).rejects.toMatchObject({
      code: "INVALID_COUNTER",
    });
    await expect(db.usage.increment(scope(), "cache_hits", -1)).rejects.toMatchObject({ code: "INVALID_DELTA" });
    await expect(db.usage.increment(scope(), "cache_hits", 1.5)).rejects.toMatchObject({ code: "INVALID_DELTA" });
    await expect(db.usage.reserveProviderAttempt(scope(), -1)).rejects.toMatchObject({ code: "INVALID_CAP" });
    await expect(db.usage.addProviderCredits(scope(), { reported: -5 })).rejects.toMatchObject({ code: "INVALID_DELTA" });
    const t = await db.pool.query("SELECT to_regclass('usage_periods') AS t");
    expect(t.rows[0].t).not.toBeNull();
  });
});
