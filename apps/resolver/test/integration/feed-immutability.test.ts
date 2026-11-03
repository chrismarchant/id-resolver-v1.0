/**
 * CHR-66 F5 (migration 0007): a feed item that may have been served can
 * neither change nor disappear without a feed event. Observations keep every
 * served column; tombstones are append-only; TRUNCATE of either is refused;
 * the retention watermark only moves forward. The legitimate paths (inserts,
 * retention and every other observation DELETE, FK cascades, erasure) keep
 * working.
 *
 * Synthetic data only: example.* domains, no IPs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FEED_KIND_OBSERVATION } from "../../src/contracts/reporting-feed.js";
import type { Db } from "../../src/db/index.js";
import { eraseCompany } from "../../src/db/erasure.js";
import { createFeedRetention, type FeedRetention } from "../../src/db/retention.js";
import { createTestDb, RESET_TABLES_SQL } from "../helpers/db.js";
import { createCompany, FEED_SCOPE, insertObservation, resetFeedDb } from "../helpers/feed.js";

const CHECK_VIOLATION = { code: "23514" };
const DAY = 86_400_000;

describe("feed immutability guards (migration 0007)", () => {
  let db: Db;
  let retention: FeedRetention;

  beforeAll(async () => {
    db = await createTestDb({ max: 4 });
    retention = createFeedRetention(db.pool);
  });
  beforeEach(async () => {
    await resetFeedDb(db);
  });
  afterAll(async () => {
    await resetFeedDb(db);
    await db.close();
  });

  const observation = async (id: string) =>
    (await db.pool.query("SELECT company_id, page_key, acquisition, entrance_contract, eligibility, observed_at, source, observation_ref, txid::text AS txid FROM company_observations WHERE id = $1", [id])).rows[0];

  it("an UPDATE of any served observation column is rejected, the 0006 position and scope guard still holds, and the row is unchanged", async () => {
    const a = await createCompany(db.pool, "moved-from.example");
    const b = await createCompany(db.pool, "moved-to.example");
    const o = await insertObservation(db.pool, { companyId: a });
    const before = await observation(o.id);
    const updates: Array<[string, unknown]> = [
      ["company_id = $2", b],
      ["page_key = $2", "/rewritten"],
      ["acquisition = $2", "paid"],
      ["entrance_contract = $2", "entrance.v2"],
      ["eligibility = $2", "tsa-9"],
      ["observed_at = $2", new Date(Date.now() - DAY)],
      ["source = $2", "provider"],
      ["observation_ref = $2", "rewritten-ref-000000"],
      ["acquisition = $2", null],
      // 0006 guard, unchanged by 0007.
      ["txid = $2", "3"],
      ["website_id = $2", "other-site"],
    ];
    for (const [set, value] of updates) {
      await expect(db.pool.query(`UPDATE company_observations SET ${set} WHERE id = $1`, [o.id, value]), set).rejects.toMatchObject(CHECK_VIOLATION);
    }
    expect(await observation(o.id)).toEqual(before);
  });

  it("tombstones are append-only: UPDATE and DELETE are rejected and the erasure stays announced", async () => {
    const c = await createCompany(db.pool, "erased.example");
    await insertObservation(db.pool, { companyId: c });
    const erased = await eraseCompany(db.pool, { companyId: c });
    expect(erased).toMatchObject({ erased: true, tombstones: 1, observations: 1 });
    const tombstones = async () => (await db.pool.query("SELECT id::text, company_id, txid::text FROM feed_tombstones")).rows;
    const before = await tombstones();
    expect(before).toHaveLength(1);
    await expect(db.pool.query("UPDATE feed_tombstones SET company_id = company_id + 1")).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(db.pool.query("UPDATE feed_tombstones SET erased_at = now() - interval '1 day'")).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(db.pool.query("DELETE FROM feed_tombstones")).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(db.pool.query("DELETE FROM feed_tombstones WHERE company_id = $1", [c])).rejects.toMatchObject(CHECK_VIOLATION);
    expect(await tombstones()).toEqual(before);
  });

  it("TRUNCATE of observations or tombstones is rejected, directly or by cascade, and leaves the rows", async () => {
    const c = await createCompany(db.pool, "truncate.example");
    await insertObservation(db.pool, { companyId: c });
    const d = await createCompany(db.pool, "truncate-erased.example");
    await insertObservation(db.pool, { companyId: d });
    await eraseCompany(db.pool, { companyId: d });
    for (const sql of [
      "TRUNCATE company_observations",
      "TRUNCATE feed_tombstones",
      "TRUNCATE feed_retention_watermarks",
      "TRUNCATE companies CASCADE",
      "TRUNCATE company_observations, feed_tombstones RESTART IDENTITY",
    ]) {
      await expect(db.pool.query(sql), sql).rejects.toMatchObject(CHECK_VIOLATION);
    }
    expect((await db.pool.query("SELECT 1 FROM company_observations")).rowCount).toBe(1);
    expect((await db.pool.query("SELECT 1 FROM feed_tombstones")).rowCount).toBe(1);
    expect((await db.pool.query("SELECT 1 FROM companies")).rowCount).toBe(1);
  });

  it("the retention watermark only moves forward and cannot be deleted; retention still advances it", async () => {
    const c = await createCompany(db.pool, "watermark.example");
    const old: Array<{ id: string; txid: string }> = [];
    for (let i = 0; i < 4; i++) old.push(await insertObservation(db.pool, { companyId: c, observedAt: new Date(Date.now() - (40 - i) * DAY) }));
    const cutoff = new Date(Date.now() - 30 * DAY);
    // Two batches: the second advances the existing watermark row through the 0006 upsert (allowed: forward).
    expect(await retention.pruneAllBefore(cutoff, { batch: 2 })).toEqual({ deleted: 4, batches: 2, backlog: false });
    const high = { txid: BigInt(old[3]!.txid), kind: FEED_KIND_OBSERVATION, id: BigInt(old[3]!.id) };
    expect(await retention.watermark(FEED_SCOPE)).toEqual(high);
    await expect(db.pool.query("UPDATE feed_retention_watermarks SET pruned_through_id = pruned_through_id - 1")).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(db.pool.query("UPDATE feed_retention_watermarks SET pruned_through_txid = '3'")).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(db.pool.query("UPDATE feed_retention_watermarks SET website_id = 'other-site'")).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(db.pool.query("DELETE FROM feed_retention_watermarks")).rejects.toMatchObject(CHECK_VIOLATION);
    expect(await retention.watermark(FEED_SCOPE)).toEqual(high);
    // Moving it forward stays possible (it is what every deletion path does).
    await db.pool.query("UPDATE feed_retention_watermarks SET pruned_through_id = pruned_through_id + 1, updated_at = now()");
    expect(await retention.watermark(FEED_SCOPE)).toEqual({ ...high, id: high.id + 1n });
  });

  it("the legitimate paths still work: inserts, manual and cascaded observation deletes (watermark advances), erasure", async () => {
    const c = await createCompany(db.pool, "legit.example");
    const a = await insertObservation(db.pool, { companyId: c });
    await insertObservation(db.pool, { companyId: c });
    // Manual DELETE: allowed, and visible through the watermark.
    await db.pool.query("DELETE FROM company_observations WHERE id = $1", [a.id]);
    expect(await retention.watermark(FEED_SCOPE)).toEqual({ txid: BigInt(a.txid), kind: FEED_KIND_OBSERVATION, id: BigInt(a.id) });
    // FK cascade from a company delete: allowed.
    await db.pool.query("DELETE FROM company_scope_stats");
    await db.pool.query("DELETE FROM company_observation_refs");
    await db.pool.query("DELETE FROM companies WHERE id = $1", [c]);
    expect((await db.pool.query("SELECT 1 FROM company_observations")).rowCount).toBe(0);
    // Erasure through the repository API: tombstone written, observations deleted.
    const e = await createCompany(db.pool, "legit-erased.example");
    await db.activity.recordObservation({ scope: FEED_SCOPE, companyId: e, observationRef: "legit-ref-0000000001", source: "cache", observedAt: new Date() });
    expect(await eraseCompany(db.pool, { domain: "legit-erased.example" })).toMatchObject({ erased: true, tombstones: 1, observations: 1, refs: 1, stats: 1 });
  });

  it("only the out-of-band replica-mode session (superuser, test resets) bypasses the guards, and only for its own transaction", async () => {
    const c = await createCompany(db.pool, "reset.example");
    await insertObservation(db.pool, { companyId: c });
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(RESET_TABLES_SQL);
      await client.query("COMMIT");
      // The setting ended with the transaction: the guards apply again on the same connection.
      expect((await client.query("SHOW session_replication_role")).rows[0]).toEqual({ session_replication_role: "origin" });
      await expect(client.query("TRUNCATE company_observations")).rejects.toMatchObject(CHECK_VIOLATION);
    } finally {
      client.release();
    }
    expect((await db.pool.query("SELECT 1 FROM company_observations")).rowCount).toBe(0);
  });
});
