/**
 * Cache repository against real PostgreSQL. Lease authority is the database
 * clock: tests never pass a "now"; they use short real leases and TTLs for
 * expiry, and they manipulate rows with SQL where a test needs an instant in
 * the past. checkedAt values are synthetic metadata and never affect fencing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CacheKey, CommitOutcome } from "../../src/contracts/db.js";
import type { Db } from "../../src/db/index.js";
import { createTestDb, resetTestDb, testKey } from "../helpers/db.js";

const META = new Date("2026-03-01T12:00:00.000Z"); // result metadata only
const LEASE = 6_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function outcome(over: Partial<CommitOutcome> = {}): CommitOutcome {
  return { status: "no_match", company: null, checkedAt: META, ttlMs: 60_000, ...over };
}

async function acquire(db: Db, key: CacheKey, leaseMs = LEASE) {
  const r = await db.cache.reserve(key, { leaseMs });
  if (r.kind !== "acquired") throw new Error(`expected acquired, got ${r.kind}`);
  return r;
}

const dbNow = async (db: Db): Promise<number> => (await db.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();

describe("cache repository", () => {
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

  it("reserve on empty acquires with a database-derived lease; immediate second reserve is pending with the same lease", async () => {
    const key = testKey("a");
    const before = await dbNow(db);
    const first = await db.cache.reserve(key, { leaseMs: LEASE });
    const after = await dbNow(db);
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(before + LEASE - 1);
    expect(first.leaseExpiresAt.getTime()).toBeLessThanOrEqual(after + LEASE + 1);
    expect(first.leaseRemainingMs).toBeGreaterThan(LEASE - 200);
    expect(first.leaseRemainingMs).toBeLessThanOrEqual(LEASE);

    const second = await db.cache.reserve(key, { leaseMs: LEASE });
    expect(second.kind).toBe("pending");
    if (second.kind !== "pending") return;
    expect(second.leaseExpiresAt.getTime()).toBe(first.leaseExpiresAt.getTime());
    expect(second.leaseRemainingMs).toBeLessThanOrEqual(first.leaseRemainingMs);
    expect(second.leaseRemainingMs).toBeGreaterThan(LEASE - 500);
  });

  it("commit then reserve returns fresh with the mapped company; expires_at is database time plus ttl, checkedAt is metadata", async () => {
    const key = testKey("a");
    const r = await acquire(db, key);
    await db.companies.upsert({ domain: "example.com", organisationName: "Example Ltd" }, META);
    const before = await dbNow(db);
    const res = await db.cache.commit(key, r.token, outcome({ status: "qualified", company: { domain: "example.com", organisationName: "Example Ltd", qualificationCategory: "COM" } }));
    expect(res).toBe("committed");

    const again = await db.cache.reserve(key, { leaseMs: LEASE });
    expect(again.kind).toBe("fresh");
    if (again.kind !== "fresh") return;
    expect(again.row.status).toBe("qualified");
    expect(again.row.company).toEqual({ domain: "example.com", organisationName: "Example Ltd", qualificationCategory: "COM" });
    expect(again.row.checkedAt).toEqual(META);
    expect(again.row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000 - 1);
    expect(again.row.expiresAt.getTime()).toBeLessThan(before + 60_000 + 5_000);
    const read = await db.cache.readFresh(key);
    expect(read).toEqual(again.row);
  });

  it("expired row (by database time) is acquired again and attempts increments", async () => {
    const key = testKey("a");
    const r1 = await acquire(db, key);
    expect(await db.cache.commit(key, r1.token, outcome({ ttlMs: 100 }))).toBe("committed");
    expect((await db.cache.reserve(key, { leaseMs: LEASE })).kind).toBe("fresh");
    await sleep(150);
    const r2 = await acquire(db, key);
    expect(r2.token).not.toBe(r1.token);
    const row = await db.pool.query("SELECT attempts, status FROM ip_resolution_cache");
    expect(row.rows[0]).toMatchObject({ attempts: 2, status: "pending" });
  });

  it("takeover after an expired lease: old token loses, new token commits", async () => {
    const key = testKey("a");
    const stale = await acquire(db, key, 300);
    // Lease is live: nobody can take over.
    expect((await db.cache.reserve(key, { leaseMs: LEASE })).kind).toBe("pending");
    await sleep(400);
    // Lease expired by database time: a new worker takes over.
    const fresh = await acquire(db, key);
    expect(fresh.token).not.toBe(stale.token);

    expect(await db.cache.commit(key, stale.token, outcome())).toBe("lost_lease");
    const mid = await db.pool.query("SELECT status, reservation_token FROM ip_resolution_cache");
    expect(mid.rows[0]).toMatchObject({ status: "pending", reservation_token: fresh.token });

    expect(await db.cache.commit(key, fresh.token, outcome({ status: "unknown" }))).toBe("committed");
    // A committed token cannot be replayed.
    expect(await db.cache.commit(key, fresh.token, outcome())).toBe("lost_lease");
  });

  it("commit after the lease expired (nobody took over) is lost_lease by the database clock, whatever checkedAt claims", async () => {
    const key = testKey("a");
    const r = await acquire(db, key, 150);
    await sleep(250);
    expect(await db.cache.commit(key, r.token, outcome({ checkedAt: new Date() }))).toBe("lost_lease");
    const row = await db.pool.query("SELECT status, reservation_token FROM ip_resolution_cache");
    expect(row.rows[0]).toMatchObject({ status: "pending", reservation_token: r.token });
    const live = await acquire(db, testKey("b"));
    expect(await db.cache.commit(testKey("b"), live.token, outcome({ checkedAt: new Date(0) }))).toBe("committed");
  });

  describe("worker clock offset never changes ownership (review P1: database-authoritative lease lifecycle)", () => {
    // The repository takes no timestamps, so an offset worker clock can only show up in metadata.
    const ahead = (ms: number) => new Date(Date.now() + ms);

    it("ahead clock, lease 600 ms, commit after 690 ms: lost_lease (reproduction 1)", async () => {
      const key = testKey("a");
      const r = await acquire(db, key, 600);
      await sleep(690);
      const res = await db.cache.commitResolved(key, r.token, outcome({ status: "qualified", checkedAt: ahead(200), company: { domain: "ahead.test", organisationName: "Ahead", qualificationCategory: "COM" } }));
      expect(res).toEqual({ kind: "lost_lease" });
      expect((await db.pool.query("SELECT count(*)::int AS n FROM companies")).rows[0].n).toBe(0);
      expect((await db.pool.query("SELECT status, reservation_token, company_id FROM ip_resolution_cache")).rows[0]).toMatchObject({ status: "pending", reservation_token: r.token, company_id: null });
    });

    it("ahead clock cannot take over another worker's live reservation (reproduction 2)", async () => {
      const key = testKey("a");
      const owner = await acquire(db, key, 600);
      // A worker 250 ms "ahead" has no way to say so: takeover eligibility is the database's decision.
      const attempt = await db.cache.reserve(key, { leaseMs: 600 });
      expect(attempt.kind).toBe("pending");
      if (attempt.kind === "pending") expect(attempt.leaseExpiresAt.getTime()).toBe(owner.leaseExpiresAt.getTime());
      expect(await db.cache.commit(key, owner.token, outcome({ checkedAt: ahead(250) }))).toBe("committed");
    });

    it("behind clock commits normally inside the real lease (reproduction 3: no spurious failure)", async () => {
      const key = testKey("a");
      const r = await acquire(db, key, 600);
      await sleep(100);
      expect(await db.cache.commit(key, r.token, outcome({ checkedAt: ahead(-250) }))).toBe("committed");
      expect((await db.cache.readFresh(key))?.checkedAt.getTime()).toBeLessThan(Date.now() - 200);
    });

    it("normal expiry: a reservation is taken over only once the database clock passes its expiry", async () => {
      const key = testKey("a");
      const r = await acquire(db, key, 400);
      await sleep(250);
      expect((await db.cache.reserve(key, { leaseMs: 400 })).kind).toBe("pending");
      await sleep(200);
      const next = await db.cache.reserve(key, { leaseMs: 400 });
      expect(next.kind).toBe("acquired");
      expect(await db.cache.commit(key, r.token, outcome())).toBe("lost_lease");
    });

    it("50 concurrent reserves against a live lease never take it over, so no duplicate provider attempt can be reserved", async () => {
      const key = testKey("race-live");
      const owner = await acquire(db, key, 1_000);
      const results = await Promise.all(Array.from({ length: 50 }, () => db.cache.reserve(key, { leaseMs: 1_000 })));
      expect(results.every((x) => x.kind === "pending")).toBe(true);
      const row = await db.pool.query("SELECT reservation_token, attempts FROM ip_resolution_cache");
      expect(row.rows[0]).toMatchObject({ reservation_token: owner.token, attempts: 1 });
    });
  });

  it("a commit that waits on a lock until its lease has expired is lost_lease and writes neither company nor cache (Warp P1-1)", async () => {
    const key = testKey("a");
    const r = await acquire(db, key, 300);
    const locker = await db.pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(
        "SELECT 1 FROM ip_resolution_cache WHERE installation_id = $1 AND website_id = $2 AND key_version = $3 AND ip_fingerprint = $4 FOR UPDATE",
        [key.installationId, key.websiteId, key.keyVersion, key.ipFingerprint],
      );
      const commit = db.cache.commitResolved(key, r.token, outcome({ status: "qualified", company: { domain: "blocked.test", organisationName: "Blocked Co", qualificationCategory: "COM" } }));
      await sleep(450); // lease expired meanwhile
      await locker.query("COMMIT");
      expect(await commit).toEqual({ kind: "lost_lease" });
    } finally {
      locker.release();
    }
    expect((await db.pool.query("SELECT count(*)::int AS n FROM companies")).rows[0].n).toBe(0);
    const row = await db.pool.query("SELECT status, reservation_token, company_id, lease_expires_at FROM ip_resolution_cache");
    expect(row.rows[0]).toMatchObject({ status: "pending", reservation_token: r.token, company_id: null });
    expect(row.rows[0].lease_expires_at.getTime()).toBe(r.leaseExpiresAt.getTime());
  });

  it("a worker blocked on the companies row that loses its lease to a takeover leaves the existing company and the new reservation untouched (Warp P1-2)", async () => {
    const key = testKey("a");
    const existing = await db.companies.upsert({ domain: "example.com", organisationName: "Old Name" }, META);
    const stale = await acquire(db, key, 300);
    const locker = await db.pool.connect();
    let fresh: Awaited<ReturnType<typeof db.cache.reserve>>;
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM companies WHERE domain = 'example.com' FOR UPDATE");
      const staleCommit = db.cache.commitResolved(key, stale.token, outcome({ status: "qualified", company: { domain: "example.com", organisationName: "New Name", qualificationCategory: "COM" } }));
      await sleep(450);
      fresh = await db.cache.reserve(key, { leaseMs: LEASE });
      expect(fresh.kind).toBe("acquired");
      await locker.query("COMMIT");
      expect(await staleCommit).toEqual({ kind: "lost_lease" });
    } finally {
      locker.release();
    }
    if (fresh.kind !== "acquired") return;
    const companies = await db.pool.query("SELECT id, organisation_name FROM companies ORDER BY id");
    expect(companies.rows).toEqual([{ id: String(existing), organisation_name: "Old Name" }]);
    const row = await db.pool.query("SELECT status, reservation_token, company_id FROM ip_resolution_cache");
    expect(row.rows[0]).toMatchObject({ status: "pending", reservation_token: fresh.token, company_id: null });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM company_observations")).rows[0].n).toBe(0);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM company_scope_stats")).rows[0].n).toBe(0);
    const ok = await db.cache.commitResolved(key, fresh.token, outcome({ status: "qualified", company: { domain: "example.com", organisationName: null, qualificationCategory: "COM" } }));
    expect(ok).toEqual({ kind: "committed", companyId: existing });
    expect((await db.pool.query("SELECT organisation_name FROM companies")).rows[0].organisation_name).toBe("Old Name");
  });

  it("a stale worker creating a new domain while blocked rolls the orphan back (Warp P1-2)", async () => {
    const key = testKey("a");
    const stale = await acquire(db, key, 300);
    const locker = await db.pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(
        "SELECT 1 FROM ip_resolution_cache WHERE installation_id = $1 AND website_id = $2 AND key_version = $3 AND ip_fingerprint = $4 FOR UPDATE",
        [key.installationId, key.websiteId, key.keyVersion, key.ipFingerprint],
      );
      const staleCommit = db.cache.commitResolved(key, stale.token, outcome({ status: "qualified", company: { domain: "orphan.test", organisationName: "Orphan", qualificationCategory: "COM" } }));
      await sleep(450);
      await locker.query("COMMIT");
      const fresh = await db.cache.reserve(key, { leaseMs: LEASE });
      expect(fresh.kind).toBe("acquired");
      expect(await staleCommit).toEqual({ kind: "lost_lease" });
    } finally {
      locker.release();
    }
    expect((await db.pool.query("SELECT count(*)::int AS n FROM companies")).rows[0].n).toBe(0);
  });

  it("release makes the next reserve acquire immediately; commit after release is lost_lease", async () => {
    const key = testKey("a");
    const r = await acquire(db, key);
    await db.cache.release(key, r.token);
    expect(await db.cache.commit(key, r.token, outcome())).toBe("lost_lease");
    expect(await db.cache.readFresh(key)).toBeNull();
    const r2 = await acquire(db, key);
    expect(r2.token).not.toBe(r.token);
  });

  it("release with a wrong or stale token is a no-op", async () => {
    const key = testKey("a");
    const r = await acquire(db, key);
    await db.cache.release(key, "0".repeat(64));
    expect((await db.cache.reserve(key, { leaseMs: LEASE })).kind).toBe("pending");
    expect(await db.cache.commit(key, r.token, outcome())).toBe("committed");
    await db.cache.release(key, r.token); // already committed: must not expire the result
    expect((await db.cache.reserve(key, { leaseMs: LEASE })).kind).toBe("fresh");
  });

  it("50 concurrent reserves on one key: exactly one acquired, the rest pending", async () => {
    const key = testKey("race");
    const results = await Promise.all(Array.from({ length: 50 }, () => db.cache.reserve(key, { leaseMs: LEASE })));
    expect(results.filter((r) => r.kind === "acquired")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "pending")).toHaveLength(49);
    const n = await db.pool.query("SELECT count(*)::int AS n, max(attempts) AS a FROM ip_resolution_cache");
    expect(n.rows[0]).toEqual({ n: 1, a: 1 });
  });

  it("50 concurrent reserves racing a lease takeover: exactly one acquired", async () => {
    const key = testKey("race-takeover");
    await acquire(db, key, 100);
    await sleep(150);
    const results = await Promise.all(Array.from({ length: 50 }, () => db.cache.reserve(key, { leaseMs: LEASE })));
    expect(results.filter((r) => r.kind === "acquired")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "pending")).toHaveLength(49);
  });

  it("different keys (fingerprint, website, key version) are independent", async () => {
    const keys = [testKey("a"), testKey("b"), testKey("a", { websiteId: "other-site" }), testKey("a", { keyVersion: 2 }), testKey("a", { installationId: "other-install" })];
    const results = await Promise.all(keys.map((k) => db.cache.reserve(k, { leaseMs: LEASE })));
    expect(results.every((r) => r.kind === "acquired")).toBe(true);
    expect(new Set(results.map((r) => (r.kind === "acquired" ? r.token : ""))).size).toBe(keys.length);
  });

  it("readFresh ignores pending and expired rows", async () => {
    const key = testKey("a");
    expect(await db.cache.readFresh(key)).toBeNull();
    const r = await acquire(db, key);
    expect(await db.cache.readFresh(key)).toBeNull(); // pending
    await db.cache.commit(key, r.token, outcome({ ttlMs: 200 }));
    expect(await db.cache.readFresh(key)).not.toBeNull();
    await sleep(250);
    expect(await db.cache.readFresh(key)).toBeNull(); // expired by database time
  });

  it("pruneExpired removes only rows expired by database time, honours the limit and spares live leases", async () => {
    for (let i = 0; i < 5; i++) {
      const k = testKey(`exp-${i}`);
      const r = await acquire(db, k);
      await db.cache.commit(k, r.token, outcome({ ttlMs: 60_000 }));
    }
    await db.pool.query("UPDATE ip_resolution_cache SET expires_at = clock_timestamp() - interval '1 second'"); // the 5 become expired
    const freshKey = testKey("fresh");
    const fr = await acquire(db, freshKey);
    await db.cache.commit(freshKey, fr.token, outcome({ ttlMs: 3_600_000 }));
    const liveKey = testKey("live");
    await acquire(db, liveKey, LEASE);
    const deadKey = testKey("dead");
    await acquire(db, deadKey, 100);
    await sleep(150); // the dead lease expires

    expect(await db.cache.pruneExpired(2)).toBe(2);
    expect(await db.cache.pruneExpired(100)).toBe(4);
    expect(await db.cache.pruneExpired(100)).toBe(0);
    const left = await db.pool.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM ip_resolution_cache GROUP BY status ORDER BY status");
    expect(left.rows).toEqual([
      { status: "no_match", n: 1 },
      { status: "pending", n: 1 },
    ]);
    expect((await db.cache.reserve(liveKey, { leaseMs: LEASE })).kind).toBe("pending");
  });

  it("pruneExpired and reserve reject non-positive limits and leases", async () => {
    await expect(db.cache.pruneExpired(0)).rejects.toMatchObject({ name: "DbError", code: "INVALID_LIMIT" });
    await expect(db.cache.reserve(testKey("a"), { leaseMs: 0 })).rejects.toMatchObject({ name: "DbError", code: "INVALID_LEASE" });
  });

  it("company upsert keeps the same id and updates the name without nulling it", async () => {
    const id1 = await db.companies.upsert({ domain: "acme.test", organisationName: null }, META);
    const id2 = await db.companies.upsert({ domain: "acme.test", organisationName: "Acme" }, new Date(META.getTime() + 1_000));
    const id3 = await db.companies.upsert({ domain: "acme.test", organisationName: null }, new Date(META.getTime() + 2_000));
    expect(id2).toBe(id1);
    expect(id3).toBe(id1);
    const other = await db.companies.upsert({ domain: "other.test", organisationName: "Other" }, META);
    expect(other).not.toBe(id1);
    const row = await db.pool.query("SELECT organisation_name, first_seen_at, last_seen_at FROM companies WHERE id = $1", [id1]);
    expect(row.rows[0].organisation_name).toBe("Acme");
    expect(row.rows[0].first_seen_at).toEqual(META);
    expect(row.rows[0].last_seen_at).toEqual(new Date(META.getTime() + 2_000));
  });

  it("commit with a company whose companies row is missing creates and links it", async () => {
    const key = testKey("a");
    const r = await acquire(db, key);
    const res = await db.cache.commit(key, r.token, outcome({ status: "qualified", company: { domain: "missing.test", organisationName: "Missing Co", qualificationCategory: "ORG" } }));
    expect(res).toBe("committed");
    const read = await db.cache.readFresh(key);
    expect(read?.company).toEqual({ domain: "missing.test", organisationName: "Missing Co", qualificationCategory: "ORG" });
    const c = await db.pool.query("SELECT count(*)::int AS n FROM companies WHERE domain = 'missing.test'");
    expect(c.rows[0].n).toBe(1);
  });

  it("a lost-lease commit does not create company rows", async () => {
    const key = testKey("a");
    const r = await acquire(db, key);
    await db.cache.release(key, r.token);
    const res = await db.cache.commit(key, r.token, outcome({ company: { domain: "ghost.test", organisationName: null, qualificationCategory: "COM" }, status: "qualified" }));
    expect(res).toBe("lost_lease");
    expect((await db.pool.query("SELECT count(*)::int AS n FROM companies")).rows[0].n).toBe(0);
  });

  it("commit rejects the pending status and a negative ttl", async () => {
    const key = testKey("a");
    const r = await acquire(db, key);
    await expect(db.cache.commit(key, r.token, outcome({ status: "pending" as never }))).rejects.toMatchObject({ code: "INVALID_STATUS" });
    await expect(db.cache.commit(key, r.token, outcome({ ttlMs: -1 }))).rejects.toMatchObject({ code: "INVALID_TTL" });
  });

  it("errors are generic: no parameter values leak", async () => {
    const bad = testKey("a", { ipFingerprint: Buffer.alloc(5, 7) });
    const err = await db.cache.reserve(bad, { leaseMs: LEASE }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "DbError", code: "23514" });
    const text = `${(err as Error).message}${(err as Error).stack ?? ""}${JSON.stringify(err)}`;
    expect(text).not.toContain("test-install");
    expect(text).not.toContain("0707070707");
    expect((err as Error).cause).toBeUndefined();
  });

  it("ping reports true on a healthy pool", async () => {
    expect(await db.ping()).toBe(true);
  });
});
