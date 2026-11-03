/**
 * Durable company activity against real PostgreSQL: idempotent observation
 * inserts, per-company serialisation of "previously observed", survival of
 * cache pruning, bounded retention, fenced commits, and the read-only
 * reporting repository (keyset pagination, date bounds, scope isolation).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CacheKey, CommitOutcome, ObservationScope } from "../../src/contracts/db.js";
import type { Db } from "../../src/db/index.js";
import { createTestDb, resetTestDb, testKey } from "../helpers/db.js";

const T0 = new Date("2026-03-01T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 86_400_000;
const SCOPE: ObservationScope = { installationId: "test-install", websiteId: "test-site" };
const OTHER_SCOPE: ObservationScope = { installationId: "test-install", websiteId: "other-site" };
const ref = (n: number | string) => `obsref-${String(n).padStart(16, "0")}`;

function qualified(domain: string, checkedAt = at(0)): CommitOutcome {
  return { status: "qualified", company: { domain, organisationName: `${domain} Ltd`, qualificationCategory: "COM" }, checkedAt, ttlMs: 60_000 };
}

/**
 * Resolves a fingerprint through the real fenced commit and returns the
 * linked company id. Lease and expiry are database time; `now` is only the
 * commit's metadata (checked_at, first/last_seen_at of a new company).
 */
async function resolveCompany(db: Db, key: CacheKey, domain: string, now = at(0)): Promise<number> {
  const r = await db.cache.reserve(key, { leaseMs: 5_000 });
  if (r.kind !== "acquired") throw new Error(`expected acquired, got ${r.kind}`);
  const c = await db.cache.commitResolved(key, r.token, qualified(domain, now));
  if (c.kind !== "committed" || c.companyId === null) throw new Error("expected a committed company");
  return c.companyId;
}

async function counts(db: Db): Promise<{ observations: number; stats: number; companies: number; cache: number; refs: number }> {
  const r = await db.pool.query<{ observations: string; stats: string; companies: string; cache: string; refs: string }>(
    `SELECT (SELECT count(*) FROM company_observations) AS observations,
            (SELECT count(*) FROM company_scope_stats) AS stats,
            (SELECT count(*) FROM companies) AS companies,
            (SELECT count(*) FROM ip_resolution_cache) AS cache,
            (SELECT count(*) FROM company_observation_refs) AS refs`,
  );
  const row = r.rows[0]!;
  return { observations: Number(row.observations), stats: Number(row.stats), companies: Number(row.companies), cache: Number(row.cache), refs: Number(row.refs) };
}

describe("activity repository", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb({ max: 16 });
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });

  it("records the first observation as company_first and later ones as previously seen, atomically with stats and last_seen_at", async () => {
    const companyId = await resolveCompany(db, testKey("a"), "example.com");
    const before = await db.pool.query<{ first_seen_at: Date; last_seen_at: Date }>("SELECT first_seen_at, last_seen_at FROM companies WHERE id = $1", [companyId]);
    expect(before.rows[0]!.last_seen_at.getTime()).toBe(at(0).getTime());

    const first = await db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(1), source: "provider", observedAt: at(1_000) });
    expect(first).toEqual({ kind: "recorded", observationId: expect.any(Number), previouslySeen: false });
    const second = await db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(2), source: "cache", observedAt: at(2_000) });
    expect(second).toEqual({ kind: "recorded", observationId: expect.any(Number), previouslySeen: true });
    // An out-of-order (older) observation still counts, never moves the timestamps backwards.
    const older = await db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(3), source: "cache", observedAt: at(500) });
    expect(older.kind).toBe("recorded");

    const stats = await db.pool.query<{ first_observed_at: Date; last_observed_at: Date; observation_count: string }>(
      "SELECT first_observed_at, last_observed_at, observation_count FROM company_scope_stats WHERE installation_id = $1 AND website_id = $2 AND company_id = $3",
      [SCOPE.installationId, SCOPE.websiteId, companyId],
    );
    expect(stats.rows).toHaveLength(1);
    expect(stats.rows[0]!.first_observed_at.getTime()).toBe(at(500).getTime());
    expect(stats.rows[0]!.last_observed_at.getTime()).toBe(at(2_000).getTime());
    expect(stats.rows[0]!.observation_count).toBe("3");

    const after = await db.pool.query<{ first_seen_at: Date; last_seen_at: Date }>("SELECT first_seen_at, last_seen_at FROM companies WHERE id = $1", [companyId]);
    expect(after.rows[0]!.first_seen_at.getTime()).toBe(before.rows[0]!.first_seen_at.getTime());
    expect(after.rows[0]!.last_seen_at.getTime()).toBe(at(2_000).getTime());

    const rows = await db.pool.query<{ observation_ref: string; source: string; previously_seen: boolean }>(
      `SELECT o.observation_ref, o.source, r.previously_seen FROM company_observations o
       JOIN company_observation_refs r USING (installation_id, website_id, observation_ref) ORDER BY o.id`,
    );
    expect(rows.rows).toEqual([
      { observation_ref: ref(1), source: "provider", previously_seen: false },
      { observation_ref: ref(2), source: "cache", previously_seen: true },
      { observation_ref: ref(3), source: "cache", previously_seen: true },
    ]);
    // The derived company_first follows the earliest timestamp (ref 3 at +500 ms), not commit order.
    const listed = await db.reporting.listObservations(SCOPE, companyId, { limit: 10, cursor: null });
    expect(listed.items.map((o) => [o.observationRef, o.companyFirst])).toEqual([[ref(2), false], [ref(1), false], [ref(3), true]]);
  });

  it("a repeated observation reference inserts once and changes nothing", async () => {
    const companyId = await resolveCompany(db, testKey("a"), "example.com");
    const first = await db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(1), source: "provider", observedAt: at(1_000) });
    expect(first.kind).toBe("recorded");
    const dup = await db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(1), source: "cache", observedAt: at(9_000) });
    expect(dup).toEqual({ kind: "duplicate", observationId: (first as { observationId: number }).observationId, previouslySeen: false, sameCompany: true });
    const c = await counts(db);
    expect(c.observations).toBe(1);
    const stats = await db.pool.query<{ observation_count: string; last_observed_at: Date }>("SELECT observation_count, last_observed_at FROM company_scope_stats");
    expect(stats.rows[0]!.observation_count).toBe("1");
    expect(stats.rows[0]!.last_observed_at.getTime()).toBe(at(1_000).getTime());
    const company = await db.pool.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM companies WHERE id = $1", [companyId]);
    expect(company.rows[0]!.last_seen_at.getTime()).toBe(at(1_000).getTime());
  });

  it("a reference reused for a different company is reported as a duplicate of another company and records nothing", async () => {
    const a = await resolveCompany(db, testKey("a"), "a.example");
    const b = await resolveCompany(db, testKey("b"), "b.example");
    await db.activity.recordObservation({ scope: SCOPE, companyId: a, observationRef: ref(1), source: "provider", observedAt: at(1_000) });
    const r = await db.activity.recordObservation({ scope: SCOPE, companyId: b, observationRef: ref(1), source: "provider", observedAt: at(2_000) });
    expect(r).toMatchObject({ kind: "duplicate", sameCompany: false });
    expect((await counts(db)).observations).toBe(1);
    const stats = await db.pool.query("SELECT company_id FROM company_scope_stats");
    expect(stats.rows.map((x: { company_id: string }) => Number(x.company_id))).toEqual([a]);
  });

  it("the same reference in another website scope is a separate observation", async () => {
    const companyId = await resolveCompany(db, testKey("a"), "example.com");
    const one = await db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(1), source: "provider", observedAt: at(1_000) });
    const two = await db.activity.recordObservation({ scope: OTHER_SCOPE, companyId, observationRef: ref(1), source: "provider", observedAt: at(1_000) });
    expect(one).toMatchObject({ kind: "recorded", previouslySeen: false });
    expect(two).toMatchObject({ kind: "recorded", previouslySeen: false });
    expect((await counts(db)).stats).toBe(2);
  });

  it("concurrent first observations of one company yield exactly one company_first and a consistent count", async () => {
    const companyId = await resolveCompany(db, testKey("a"), "example.com");
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(100 + i), source: i % 2 ? "cache" : "provider", observedAt: at(1_000 + i) })),
    );
    expect(results.every((r) => r.kind === "recorded")).toBe(true);
    expect(results.filter((r) => r.kind === "recorded" && !r.previouslySeen)).toHaveLength(1);
    const firsts = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM company_observation_refs WHERE NOT previously_seen");
    expect(firsts.rows[0]!.n).toBe("1");
    const listed = await db.reporting.listObservations(SCOPE, companyId, { limit: 100, cursor: null });
    expect(listed.items.filter((o) => o.companyFirst)).toHaveLength(1);
    const stats = await db.pool.query<{ observation_count: string }>("SELECT observation_count FROM company_scope_stats");
    expect(stats.rows).toHaveLength(1);
    expect(stats.rows[0]!.observation_count).toBe("12");
  });

  it("concurrent writes with the same reference insert exactly once", async () => {
    const companyId = await resolveCompany(db, testKey("a"), "example.com");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(7), source: "cache", observedAt: at(1_000) })),
    );
    expect(results.filter((r) => r.kind === "recorded")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "duplicate")).toHaveLength(9);
    const ids = new Set(results.map((r) => r.observationId));
    expect(ids.size).toBe(1);
    expect((await counts(db)).observations).toBe(1);
    const stats = await db.pool.query<{ observation_count: string }>("SELECT observation_count FROM company_scope_stats");
    expect(stats.rows[0]!.observation_count).toBe("1");
  });

  it("a new fingerprint resolving to a known domain reuses the company id and is previously seen", async () => {
    const a = await resolveCompany(db, testKey("fp-1"), "example.com", at(0));
    await db.activity.recordObservation({ scope: SCOPE, companyId: a, observationRef: ref(1), source: "provider", observedAt: at(0) });
    const b = await resolveCompany(db, testKey("fp-2"), "example.com", at(10_000));
    expect(b).toBe(a);
    const r = await db.activity.recordObservation({ scope: SCOPE, companyId: b, observationRef: ref(2), source: "provider", observedAt: at(10_000) });
    expect(r).toMatchObject({ kind: "recorded", previouslySeen: true });
    expect((await counts(db)).companies).toBe(1);
  });

  it("cache pruning deletes expired fingerprint rows but preserves companies, observations and stats", async () => {
    const companyId = await resolveCompany(db, testKey("a"), "example.com", at(0));
    await db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(1), source: "provider", observedAt: at(0) });
    await db.pool.query("UPDATE ip_resolution_cache SET expires_at = clock_timestamp() - interval '1 second'");
    expect(await db.cache.pruneExpired(100)).toBe(1);
    const c = await counts(db);
    expect(c).toEqual({ observations: 1, stats: 1, companies: 1, cache: 0, refs: 1 });
    // The company id is still resolvable after the private row is gone.
    const again = await resolveCompany(db, testKey("b"), "example.com", at(130_000));
    expect(again).toBe(companyId);
    const r = await db.activity.recordObservation({ scope: SCOPE, companyId: again, observationRef: ref(2), source: "provider", observedAt: at(130_000) });
    expect(r).toMatchObject({ kind: "recorded", previouslySeen: true });
  });

  it("retention pruning is bounded, deletes only observations older than the cutoff and keeps stats and companies", async () => {
    const companyId = await resolveCompany(db, testKey("a"), "example.com");
    for (let i = 0; i < 6; i++) {
      await db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(i), source: "cache", observedAt: at(i * DAY) });
    }
    const cutoff = at(4 * DAY); // observations at days 0..3 are older
    expect(await db.activity.pruneObservationsBefore(cutoff, 3)).toBe(3);
    expect(await db.activity.pruneObservationsBefore(cutoff, 3)).toBe(1);
    expect(await db.activity.pruneObservationsBefore(cutoff, 3)).toBe(0);
    const c = await counts(db);
    expect(c.observations).toBe(2);
    expect(c.stats).toBe(1);
    expect(c.companies).toBe(1);
    const stats = await db.pool.query<{ observation_count: string; first_observed_at: Date }>("SELECT observation_count, first_observed_at FROM company_scope_stats");
    expect(stats.rows[0]!.observation_count).toBe("6");
    expect(stats.rows[0]!.first_observed_at.getTime()).toBe(at(0).getTime());
    // "Previously seen" survives the loss of the observation rows.
    const r = await db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(99), source: "cache", observedAt: at(7 * DAY) });
    expect(r).toMatchObject({ kind: "recorded", previouslySeen: true });
  });

  it("a lost-lease commit links no company and leaves nothing for a stale worker to observe", async () => {
    const key = testKey("a");
    const r = await db.cache.reserve(key, { leaseMs: 150 });
    if (r.kind !== "acquired") throw new Error("expected acquired");
    await new Promise((res) => setTimeout(res, 250));
    // Another worker takes over after the lease expires (database time).
    const takeover = await db.cache.reserve(key, { leaseMs: 1_000 });
    expect(takeover.kind).toBe("acquired");
    const stale = await db.cache.commitResolved(key, r.token, qualified("example.com", at(2_500)));
    expect(stale).toEqual({ kind: "lost_lease" });
    expect((await counts(db)).companies).toBe(0);
  });

  it("rejects an unknown company, a malformed reference and a bad source without writing", async () => {
    await expect(db.activity.recordObservation({ scope: SCOPE, companyId: 999_999, observationRef: ref(1), source: "cache", observedAt: at(0) })).rejects.toThrow();
    const companyId = await resolveCompany(db, testKey("a"), "example.com");
    await expect(db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: "bad ref with spaces", source: "cache", observedAt: at(0) })).rejects.toThrow();
    await expect(db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: "x".repeat(65), source: "cache", observedAt: at(0) })).rejects.toThrow();
    await expect(db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(1), source: "browser" as "cache", observedAt: at(0) })).rejects.toThrow();
    expect((await counts(db)).observations).toBe(0);
  });

  it("deleting a company cascades to its observations and stats (manual deletion procedure)", async () => {
    const companyId = await resolveCompany(db, testKey("a"), "example.com");
    await db.activity.recordObservation({ scope: SCOPE, companyId, observationRef: ref(1), source: "cache", observedAt: at(0) });
    // The documented procedure removes the private cache rows first, then the company.
    const cacheRows = await db.pool.query("DELETE FROM ip_resolution_cache WHERE company_id = $1", [companyId]);
    expect(cacheRows.rowCount).toBe(1);
    await db.pool.query("DELETE FROM companies WHERE id = $1", [companyId]);
    const c = await counts(db);
    expect(c).toEqual({ observations: 0, stats: 0, companies: 0, cache: 0, refs: 0 });
  });

  describe("idempotency after retention pruning (Codex P2, dcc780e)", () => {
    async function seedAndPrune(db: Db): Promise<{ a: number; b: number }> {
      const a = await resolveCompany(db, testKey("a"), "a.example");
      const b = await resolveCompany(db, testKey("b"), "b.example");
      const first = await db.activity.recordObservation({ scope: SCOPE, companyId: a, observationRef: ref(1), source: "provider", observedAt: at(0) });
      expect(first).toMatchObject({ kind: "recorded", previouslySeen: false });
      const second = await db.activity.recordObservation({ scope: SCOPE, companyId: a, observationRef: ref(2), source: "cache", observedAt: at(1_000) });
      expect(second).toMatchObject({ kind: "recorded", previouslySeen: true });
      // Retention removes both observation rows; the deduplication records and the stats stay.
      expect(await db.activity.pruneObservationsBefore(at(DAY), 100)).toBe(2);
      expect(await counts(db)).toMatchObject({ observations: 0, refs: 2, stats: 1 });
      return { a, b };
    }

    it("replaying a pruned reference for the same company inserts nothing and leaves lifetime counts unchanged", async () => {
      const { a } = await seedAndPrune(db);
      const replay1 = await db.activity.recordObservation({ scope: SCOPE, companyId: a, observationRef: ref(1), source: "cache", observedAt: at(2 * DAY) });
      expect(replay1).toEqual({ kind: "duplicate", observationId: null, previouslySeen: false, sameCompany: true });
      const replay2 = await db.activity.recordObservation({ scope: SCOPE, companyId: a, observationRef: ref(2), source: "provider", observedAt: at(2 * DAY) });
      expect(replay2).toEqual({ kind: "duplicate", observationId: null, previouslySeen: true, sameCompany: true });
      expect(await counts(db)).toMatchObject({ observations: 0, refs: 2, stats: 1 });
      const stats = await db.pool.query<{ observation_count: string; first_observed_at: Date; last_observed_at: Date }>("SELECT observation_count, first_observed_at, last_observed_at FROM company_scope_stats");
      expect(stats.rows[0]!.observation_count).toBe("2");
      expect(stats.rows[0]!.first_observed_at.getTime()).toBe(at(0).getTime());
      expect(stats.rows[0]!.last_observed_at.getTime()).toBe(at(1_000).getTime());
      const company = await db.pool.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM companies WHERE id = $1", [a]);
      expect(company.rows[0]!.last_seen_at.getTime()).toBe(at(1_000).getTime());
      // A genuinely new reference still records and is previously seen.
      const fresh = await db.activity.recordObservation({ scope: SCOPE, companyId: a, observationRef: ref(3), source: "cache", observedAt: at(2 * DAY) });
      expect(fresh).toMatchObject({ kind: "recorded", previouslySeen: true });
      expect(await counts(db)).toMatchObject({ observations: 1, refs: 3, stats: 1 });
    });

    it("reusing a pruned reference for a different company remains a conflict", async () => {
      const { b } = await seedAndPrune(db);
      const r = await db.activity.recordObservation({ scope: SCOPE, companyId: b, observationRef: ref(1), source: "provider", observedAt: at(2 * DAY) });
      expect(r).toEqual({ kind: "duplicate", observationId: null, previouslySeen: false, sameCompany: false });
      expect(await counts(db)).toMatchObject({ observations: 0, refs: 2, stats: 1 });
      expect(await db.reporting.getCompany(SCOPE, b)).toBeNull();
    });

    it("scopes stay isolated after pruning: the same reference in another website records separately", async () => {
      const { a } = await seedAndPrune(db);
      const other = await db.activity.recordObservation({ scope: OTHER_SCOPE, companyId: a, observationRef: ref(1), source: "provider", observedAt: at(2 * DAY) });
      expect(other).toMatchObject({ kind: "recorded", previouslySeen: false });
      const otherAgain = await db.activity.recordObservation({ scope: OTHER_SCOPE, companyId: a, observationRef: ref(1), source: "cache", observedAt: at(2 * DAY) });
      expect(otherAgain).toMatchObject({ kind: "duplicate", sameCompany: true, previouslySeen: false });
      expect(await counts(db)).toMatchObject({ observations: 1, refs: 3, stats: 2 });
      const original = await db.activity.recordObservation({ scope: SCOPE, companyId: a, observationRef: ref(1), source: "cache", observedAt: at(2 * DAY) });
      expect(original).toEqual({ kind: "duplicate", observationId: null, previouslySeen: false, sameCompany: true });
    });

    it("concurrent replays of pruned and new references stay safe", async () => {
      const { a, b } = await seedAndPrune(db);
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => db.activity.recordObservation({ scope: SCOPE, companyId: a, observationRef: ref(1), source: "cache", observedAt: at(2 * DAY) })),
        ...Array.from({ length: 4 }, () => db.activity.recordObservation({ scope: SCOPE, companyId: b, observationRef: ref(1), source: "provider", observedAt: at(2 * DAY) })),
        ...Array.from({ length: 6 }, () => db.activity.recordObservation({ scope: SCOPE, companyId: a, observationRef: ref(9), source: "cache", observedAt: at(2 * DAY) })),
      ]);
      const sameOld = results.slice(0, 6);
      const otherCompany = results.slice(6, 10);
      const fresh = results.slice(10);
      expect(sameOld.every((r) => r.kind === "duplicate" && r.sameCompany && r.observationId === null)).toBe(true);
      expect(otherCompany.every((r) => r.kind === "duplicate" && !r.sameCompany)).toBe(true);
      expect(fresh.filter((r) => r.kind === "recorded")).toHaveLength(1);
      expect(fresh.filter((r) => r.kind === "duplicate" && r.sameCompany && r.observationId !== null)).toHaveLength(5);
      expect(await counts(db)).toMatchObject({ observations: 1, refs: 3, stats: 1 });
      const stats = await db.pool.query<{ observation_count: string }>("SELECT observation_count FROM company_scope_stats");
      expect(stats.rows[0]!.observation_count).toBe("3");
    });

    it("deleting a company removes its deduplication records as well", async () => {
      const { a } = await seedAndPrune(db);
      await db.pool.query("DELETE FROM ip_resolution_cache WHERE company_id = $1", [a]);
      await db.pool.query("DELETE FROM companies WHERE id = $1", [a]);
      expect(await counts(db)).toMatchObject({ refs: 0, stats: 0, observations: 0 });
    });
  });
});

describe("reporting repository", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb({ max: 8 });
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });

  async function seedCompanies(n: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = await resolveCompany(db, testKey(`c-${i}`), `company-${i}.example`, at(0));
      await db.activity.recordObservation({ scope: SCOPE, companyId: id, observationRef: ref(`c${i}`), source: "provider", observedAt: at(i * 1_000) });
      ids.push(id);
    }
    return ids;
  }

  it("enumerates companies stably by id: a company that becomes active between pages is neither missed nor repeated (Warp P2-4)", async () => {
    const ids = await seedCompanies(7);
    const seen: number[] = [];
    const p1 = await db.reporting.listCompanies(SCOPE, { limit: 3, cursor: null, order: "id" });
    seen.push(...p1.items.map((c) => c.companyId));
    expect(seen).toEqual([ids[0], ids[1], ids[2]]);
    expect(p1.nextCursor).toEqual({ order: "id", companyId: ids[2] });
    // An unseen company (index 5) becomes the most recently active between pages; another seen one (index 0) too.
    await db.activity.recordObservation({ scope: SCOPE, companyId: ids[5]!, observationRef: ref("late-5"), source: "cache", observedAt: at(500_000) });
    await db.activity.recordObservation({ scope: SCOPE, companyId: ids[0]!, observationRef: ref("late-0"), source: "cache", observedAt: at(600_000) });
    const p2 = await db.reporting.listCompanies(SCOPE, { limit: 3, cursor: p1.nextCursor, order: "id" });
    seen.push(...p2.items.map((c) => c.companyId));
    const p3 = await db.reporting.listCompanies(SCOPE, { limit: 3, cursor: p2.nextCursor, order: "id" });
    seen.push(...p3.items.map((c) => c.companyId));
    expect(p3.nextCursor).toBeNull();
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(ids.length);
    // A company first observed during the walk, with an id above the cursor, appears on a later page; a cursor of the other order is refused.
    const newcomer = await resolveCompany(db, testKey("newcomer"), "newcomer.example", at(0));
    await db.activity.recordObservation({ scope: SCOPE, companyId: newcomer, observationRef: ref("new"), source: "provider", observedAt: at(700_000) });
    const tail = await db.reporting.listCompanies(SCOPE, { limit: 3, cursor: { order: "id", companyId: ids[6]! }, order: "id" });
    expect(tail.items.map((c) => c.companyId)).toEqual([newcomer]);
    await expect(db.reporting.listCompanies(SCOPE, { limit: 3, cursor: { order: "recent", lastObservedAt: at(0), companyId: 1 }, order: "id" })).rejects.toThrow();
  });

  it("lists companies by most recent activity (display order, documented as not stable across pages), scoped by website", async () => {
    const ids = await seedCompanies(7);
    // Company 2 becomes the most recent; an out-of-scope observation must not appear.
    await db.activity.recordObservation({ scope: SCOPE, companyId: ids[2]!, observationRef: ref("bump"), source: "cache", observedAt: at(100_000) });
    const foreign = await resolveCompany(db, testKey("foreign"), "foreign.example", at(0));
    await db.activity.recordObservation({ scope: OTHER_SCOPE, companyId: foreign, observationRef: ref("f"), source: "provider", observedAt: at(200_000) });

    const p1 = await db.reporting.listCompanies(SCOPE, { limit: 3, cursor: null, order: "recent" });
    expect(p1.items.map((c) => c.companyId)).toEqual([ids[2], ids[6], ids[5]]);
    expect(p1.items[0]).toMatchObject({ domain: "company-2.example", organisationName: "company-2.example Ltd", observationCount: 2 });
    expect(p1.items[0]!.firstObservedAt.getTime()).toBe(at(2_000).getTime());
    expect(p1.items[0]!.lastObservedAt.getTime()).toBe(at(100_000).getTime());
    expect(p1.nextCursor).not.toBeNull();

    // Activity arriving between pages (a newer observation for company 0) does not shift the later pages.
    await db.activity.recordObservation({ scope: SCOPE, companyId: ids[0]!, observationRef: ref("late"), source: "cache", observedAt: at(300_000) });
    const p2 = await db.reporting.listCompanies(SCOPE, { limit: 3, cursor: p1.nextCursor, order: "recent" });
    expect(p2.items.map((c) => c.companyId)).toEqual([ids[4], ids[3], ids[1]]);
    // Company 0 moved ahead of the cursor: it is not repeated, and this walk misses it (the documented reason the id order is the enumeration order).
    expect(p2.nextCursor).toBeNull();
    const all = await db.reporting.listCompanies(SCOPE, { limit: 100, cursor: null, order: "recent" });
    expect(all.items.map((c) => c.companyId)).toEqual([ids[0], ids[2], ids[6], ids[5], ids[4], ids[3], ids[1]]);
    expect(all.items.map((c) => c.domain)).not.toContain("foreign.example");
    expect(all.nextCursor).toBeNull();
    const other = await db.reporting.listCompanies(OTHER_SCOPE, { limit: 100, cursor: null, order: "recent" });
    expect(other.items.map((c) => c.domain)).toEqual(["foreign.example"]);
  });

  it("returns a company only within its scope and pages its observations newest first", async () => {
    const [id] = await seedCompanies(1);
    for (let i = 1; i <= 5; i++) {
      await db.activity.recordObservation({ scope: SCOPE, companyId: id!, observationRef: ref(`o${i}`), source: i % 2 ? "cache" : "provider", observedAt: at(i * 10_000) });
    }
    expect(await db.reporting.getCompany(OTHER_SCOPE, id!)).toBeNull();
    expect(await db.reporting.getCompany(SCOPE, 424242)).toBeNull();
    const c = await db.reporting.getCompany(SCOPE, id!);
    expect(c).toMatchObject({ companyId: id, domain: "company-0.example", observationCount: 6 });
    const p1 = await db.reporting.listObservations(SCOPE, id!, { limit: 4, cursor: null });
    expect(p1.items.map((o) => o.observationRef)).toEqual([ref("o5"), ref("o4"), ref("o3"), ref("o2")]);
    expect(p1.items.map((o) => o.companyFirst)).toEqual([false, false, false, false]);
    expect(p1.items[0]).toMatchObject({ source: "cache", observationId: expect.any(Number) });
    const p2 = await db.reporting.listObservations(SCOPE, id!, { limit: 4, cursor: p1.nextCursor });
    expect(p2.items.map((o) => o.observationRef)).toEqual([ref("o1"), ref("c0")]);
    expect(p2.items[1]!.companyFirst).toBe(true);
    expect(p2.nextCursor).toBeNull();
    expect((await db.reporting.listObservations(OTHER_SCOPE, id!, { limit: 4, cursor: null })).items).toEqual([]);
  });

  it("summarises a half-open instant range: observations, distinct companies, newly and previously observed", async () => {
    const [a, b] = await seedCompanies(2); // a first at T0, b first at T0+1s
    await db.activity.recordObservation({ scope: SCOPE, companyId: a!, observationRef: ref("a2"), source: "cache", observedAt: at(DAY + 5_000) });
    await db.activity.recordObservation({ scope: SCOPE, companyId: b!, observationRef: ref("b2"), source: "cache", observedAt: at(DAY + 6_000) });
    const c = await resolveCompany(db, testKey("c"), "company-c.example", at(DAY));
    await db.activity.recordObservation({ scope: SCOPE, companyId: c, observationRef: ref("cc1"), source: "provider", observedAt: at(DAY + 7_000) });
    // Exactly at the upper bound: excluded.
    await db.activity.recordObservation({ scope: SCOPE, companyId: c, observationRef: ref("cc2"), source: "cache", observedAt: at(2 * DAY) });

    const day1 = await db.reporting.summary(SCOPE, { from: at(0), to: at(DAY) });
    expect(day1).toEqual({ observations: 2, observedCompanies: 2, newlyObservedCompanies: 2, previouslyObservedCompanies: 0 });
    const day2 = await db.reporting.summary(SCOPE, { from: at(DAY), to: at(2 * DAY) });
    expect(day2).toEqual({ observations: 3, observedCompanies: 3, newlyObservedCompanies: 1, previouslyObservedCompanies: 2 });
    const both = await db.reporting.summary(SCOPE, { from: at(0), to: at(3 * DAY) });
    expect(both).toEqual({ observations: 6, observedCompanies: 3, newlyObservedCompanies: 3, previouslyObservedCompanies: 0 });
    const none = await db.reporting.summary(OTHER_SCOPE, { from: at(0), to: at(3 * DAY) });
    expect(none).toEqual({ observations: 0, observedCompanies: 0, newlyObservedCompanies: 0, previouslyObservedCompanies: 0 });
    await expect(db.reporting.summary(SCOPE, { from: at(DAY), to: at(DAY) })).rejects.toThrow();
  });

  it("classifies newly and previously observed companies by the earliest timestamp when commits arrive out of order across UTC midnight (Codex P2, dcc780e)", async () => {
    const midnight = new Date("2026-03-02T00:00:00.000Z");
    const day1 = { from: new Date("2026-03-01T00:00:00.000Z"), to: midnight };
    const day2 = { from: midnight, to: new Date("2026-03-03T00:00:00.000Z") };
    const both = { from: day1.from, to: day2.to };
    const x = await resolveCompany(db, testKey("x"), "x.example", day1.from);
    const y = await resolveCompany(db, testKey("y"), "y.example", day1.from);
    // Company x: the observation timestamped just AFTER midnight commits first (a cache follower),
    // the one timestamped just BEFORE midnight commits second (the provider worker that captured
    // checkedAt earlier but wrote activity after its usage-counter writes).
    const late = await db.activity.recordObservation({ scope: SCOPE, companyId: x, observationRef: ref("x-after"), source: "cache", observedAt: new Date(midnight.getTime() + 5) });
    const early = await db.activity.recordObservation({ scope: SCOPE, companyId: x, observationRef: ref("x-before"), source: "provider", observedAt: new Date(midnight.getTime() - 5) });
    expect(late).toMatchObject({ kind: "recorded", previouslySeen: false }); // committed-history answer at record time
    expect(early).toMatchObject({ kind: "recorded", previouslySeen: true });
    // Company y: first observed on day 1, again on day 2, in order.
    await db.activity.recordObservation({ scope: SCOPE, companyId: y, observationRef: ref("y-1"), source: "provider", observedAt: new Date(midnight.getTime() - 3_600_000) });
    await db.activity.recordObservation({ scope: SCOPE, companyId: y, observationRef: ref("y-2"), source: "cache", observedAt: new Date(midnight.getTime() + 3_600_000) });

    const stats = await db.reporting.getCompany(SCOPE, x);
    expect(stats!.firstObservedAt.getTime()).toBe(midnight.getTime() - 5);
    expect(stats!.observationCount).toBe(2);

    // Day 1: x and y both first observed -> newly 2, previously 0.
    expect(await db.reporting.summary(SCOPE, day1)).toEqual({ observations: 2, observedCompanies: 2, newlyObservedCompanies: 2, previouslyObservedCompanies: 0 });
    // Day 2: x and y both active, neither new (x's earliest observation is on day 1 despite commit order).
    expect(await db.reporting.summary(SCOPE, day2)).toEqual({ observations: 2, observedCompanies: 2, newlyObservedCompanies: 0, previouslyObservedCompanies: 2 });
    // Combined range: 4 observations, 2 companies, both new within the range.
    expect(await db.reporting.summary(SCOPE, both)).toEqual({ observations: 4, observedCompanies: 2, newlyObservedCompanies: 2, previouslyObservedCompanies: 0 });
    // The derived company_first follows the timestamp, not the commit order.
    const list = await db.reporting.listObservations(SCOPE, x, { limit: 10, cursor: null });
    expect(list.items.map((o) => [o.observationRef, o.companyFirst])).toEqual([[ref("x-after"), false], [ref("x-before"), true]]);

    // Retention: pruning day-1 observations keeps day 2 classified as previously observed via the lifetime stats.
    expect(await db.activity.pruneObservationsBefore(midnight, 100)).toBe(2);
    expect(await db.reporting.summary(SCOPE, day2)).toEqual({ observations: 2, observedCompanies: 2, newlyObservedCompanies: 0, previouslyObservedCompanies: 2 });
    expect(await db.reporting.summary(SCOPE, day1)).toEqual({ observations: 0, observedCompanies: 0, newlyObservedCompanies: 0, previouslyObservedCompanies: 0 });
    const afterPrune = await db.reporting.listObservations(SCOPE, x, { limit: 10, cursor: null });
    expect(afterPrune.items.map((o) => [o.observationRef, o.companyFirst])).toEqual([[ref("x-after"), false]]);
  });

  it("equal timestamps: the earlier accepted observation is the first; pruning that row never promotes the survivor (review P2)", async () => {
    const id = await resolveCompany(db, testKey("tie"), "tie.example", at(0));
    const t = at(5_000);
    const a = await db.activity.recordObservation({ scope: SCOPE, companyId: id, observationRef: ref("tie-a"), source: "provider", observedAt: t });
    const b = await db.activity.recordObservation({ scope: SCOPE, companyId: id, observationRef: ref("tie-b"), source: "cache", observedAt: t });
    expect(a).toMatchObject({ kind: "recorded", previouslySeen: false });
    expect(b).toMatchObject({ kind: "recorded", previouslySeen: true });
    const identity = () => db.pool.query<{ first_observation_ref: string | null; first_observed_at: Date; observation_count: string }>("SELECT first_observation_ref, first_observed_at, observation_count FROM company_scope_stats WHERE company_id = $1 AND website_id = $2", [id, SCOPE.websiteId]);
    expect((await identity()).rows[0]).toMatchObject({ first_observation_ref: ref("tie-a"), observation_count: "2" });
    const list = await db.reporting.listObservations(SCOPE, id, { limit: 10, cursor: null });
    expect(list.items.map((o) => [o.observationRef, o.companyFirst])).toEqual([[ref("tie-b"), false], [ref("tie-a"), true]]);
    const day = { from: at(0), to: at(DAY) };
    expect(await db.reporting.summary(SCOPE, day)).toEqual({ observations: 2, observedCompanies: 1, newlyObservedCompanies: 1, previouslyObservedCompanies: 0 });
    // Prune exactly the first row (oldest, lowest id) with batch limit 1.
    expect(await db.activity.pruneObservationsBefore(at(6_000), 1)).toBe(1);
    const survivors = await db.pool.query<{ observation_ref: string }>("SELECT observation_ref FROM company_observations");
    expect(survivors.rows.map((r) => r.observation_ref)).toEqual([ref("tie-b")]);
    const after = await db.reporting.listObservations(SCOPE, id, { limit: 10, cursor: null });
    expect(after.items.map((o) => [o.observationRef, o.companyFirst])).toEqual([[ref("tie-b"), false]]);
    expect((await identity()).rows[0]).toMatchObject({ first_observation_ref: ref("tie-a"), observation_count: "2" });
    expect(await db.reporting.getCompany(SCOPE, id)).toMatchObject({ observationCount: 2, firstObservedAt: t });
    expect(await db.reporting.summary(SCOPE, day)).toEqual({ observations: 1, observedCompanies: 1, newlyObservedCompanies: 1, previouslyObservedCompanies: 0 });
    // Replaying the pruned first reference changes nothing (durable record), and its identity stays.
    expect(await db.activity.recordObservation({ scope: SCOPE, companyId: id, observationRef: ref("tie-a"), source: "cache", observedAt: at(9_000) })).toEqual({ kind: "duplicate", observationId: null, previouslySeen: false, sameCompany: true });
    expect((await identity()).rows[0]!.first_observation_ref).toBe(ref("tie-a"));
    // Scope isolation: the other website has its own identity for the same company.
    await db.activity.recordObservation({ scope: OTHER_SCOPE, companyId: id, observationRef: ref("other-first"), source: "cache", observedAt: t });
    expect((await db.pool.query("SELECT first_observation_ref FROM company_scope_stats WHERE website_id = $1", [OTHER_SCOPE.websiteId])).rows[0].first_observation_ref).toBe(ref("other-first"));
    expect((await identity()).rows[0]!.first_observation_ref).toBe(ref("tie-a"));
  });

  it("a strictly earlier timestamp accepted later takes over the first-observation identity; an equal one does not", async () => {
    const id = await resolveCompany(db, testKey("later"), "later.example", at(0));
    await db.activity.recordObservation({ scope: SCOPE, companyId: id, observationRef: ref("l-1"), source: "cache", observedAt: at(10_000) });
    await db.activity.recordObservation({ scope: SCOPE, companyId: id, observationRef: ref("l-2"), source: "cache", observedAt: at(10_000) }); // equal: keeps l-1
    await db.activity.recordObservation({ scope: SCOPE, companyId: id, observationRef: ref("l-0"), source: "provider", observedAt: at(4_000) }); // earlier: takes over
    const row = (await db.pool.query<{ first_observation_ref: string; first_observed_at: Date }>("SELECT first_observation_ref, first_observed_at FROM company_scope_stats WHERE company_id = $1 AND website_id = $2", [id, SCOPE.websiteId])).rows[0]!;
    expect(row.first_observation_ref).toBe(ref("l-0"));
    expect(row.first_observed_at.getTime()).toBe(at(4_000).getTime());
    const list = await db.reporting.listObservations(SCOPE, id, { limit: 10, cursor: null });
    expect(list.items.map((o) => [o.observationRef, o.companyFirst])).toEqual([[ref("l-2"), false], [ref("l-1"), false], [ref("l-0"), true]]);
    // Later, an even earlier instant still wins; pruning the older rows keeps the identity on the pruned reference, flags nothing.
    await db.activity.recordObservation({ scope: SCOPE, companyId: id, observationRef: ref("l-00"), source: "provider", observedAt: at(1_000) });
    expect(await db.activity.pruneObservationsBefore(at(5_000), 10)).toBe(2);
    const after = await db.reporting.listObservations(SCOPE, id, { limit: 10, cursor: null });
    expect(after.items.map((o) => o.companyFirst)).toEqual([false, false]);
    expect((await db.pool.query("SELECT first_observation_ref FROM company_scope_stats WHERE company_id = $1 AND website_id = $2", [id, SCOPE.websiteId])).rows[0].first_observation_ref).toBe(ref("l-00"));
  });

  it("validates limits, ids and cursors before touching the database", async () => {
    await expect(db.reporting.listCompanies(SCOPE, { limit: 0, cursor: null, order: "id" })).rejects.toThrow();
    await expect(db.reporting.listCompanies(SCOPE, { limit: 101, cursor: null, order: "id" })).rejects.toThrow();
    await expect(db.reporting.listCompanies(SCOPE, { limit: 10, cursor: null, order: "name" as "id" })).rejects.toThrow();
    await expect(db.reporting.getCompany(SCOPE, 0)).rejects.toThrow();
    await expect(db.reporting.listObservations(SCOPE, 1, { limit: 10, cursor: { observedAt: at(0), observationId: -1 } })).rejects.toThrow();
  });
});
