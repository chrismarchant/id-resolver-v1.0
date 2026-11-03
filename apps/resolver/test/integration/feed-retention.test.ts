/**
 * reporting-feed.v1 proof suite, part 4 (CHR-71): retention as a bounded
 * synchronisation buffer (owner decision D3). Pruning advances a per-scope
 * watermark atomically with the delete; a cursor strictly before it gets
 * 410 cursor_expired, a cursor at or after it continues, and no deletion path
 * other than an erasure (which writes a tombstone instead) can remove a feed
 * item silently. Retention never writes tombstones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { FEED_KIND_OBSERVATION } from "../../src/contracts/reporting-feed.js";
import type { Db } from "../../src/db/index.js";
import { eraseCompany } from "../../src/db/erasure.js";
import { createFeedRetention, PRUNE_FEED_OBSERVATIONS_SQL, retentionCutoff, type FeedRetention } from "../../src/db/retention.js";
import { createTestDb } from "../helpers/db.js";
import { buildFeedServer, createCompany, FEED_SCOPE, FeedConsumer, getFeed, insertObservation, obsIds, openWriter, resetFeedDb, type InsertedObservation } from "../helpers/feed.js";

const DAY = 86_400_000;
const EXPIRED = { version: "1", error: "cursor_expired" };

describe("reporting feed: retention watermark", () => {
  let db: Db;
  let app: FastifyInstance;
  let retention: FeedRetention;
  let holder: pg.Client;

  beforeAll(async () => {
    db = await createTestDb({ max: 6 });
    ({ app } = await buildFeedServer(db));
    retention = createFeedRetention(db.pool);
    holder = await openWriter();
  });
  beforeEach(async () => {
    await holder.query("ROLLBACK").catch(() => undefined);
    await resetFeedDb(db);
  });
  afterAll(async () => {
    await holder.end().catch(() => undefined);
    await resetFeedDb(db);
    await app.close();
    await db.close();
  });

  const now = Date.now();
  async function seed(): Promise<{ old: InsertedObservation[]; fresh: InsertedObservation[]; company: number }> {
    const company = await createCompany(db.pool, "buffer.example");
    const old: InsertedObservation[] = [];
    const fresh: InsertedObservation[] = [];
    for (let i = 0; i < 5; i++) old.push(await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - (10 - i) * DAY) }));
    for (let i = 0; i < 3; i++) fresh.push(await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - i * 60_000) }));
    return { old, fresh, company };
  }

  /** A consumer that has applied exactly the first `n` items of the stream. */
  async function consumerAt(n: number): Promise<FeedConsumer> {
    const c = new FeedConsumer(app, n);
    if (n > 0) await c.step();
    expect(c.delivered).toHaveLength(n);
    return c;
  }

  it("P9 retention: pruning past a consumer's cursor gives 410 cursor_expired; cursors at or after the watermark, and a fresh start, keep working", async () => {
    const { old, fresh } = await seed();
    const behind = await consumerAt(2); // cursor at old[1]
    const exact = await consumerAt(5); // cursor at old[4], the last item retention will remove
    const ahead = await consumerAt(8); // fully caught up
    const r = await retention.pruneAllBefore(retentionCutoff(new Date(now), 5), { batch: 2 });
    expect(r).toEqual({ deleted: 5, batches: 3, backlog: false });
    expect(await retention.watermark(FEED_SCOPE)).toEqual({ txid: BigInt(old[4]!.txid), kind: FEED_KIND_OBSERVATION, id: BigInt(old[4]!.id) });

    const expired = await getFeed(app, behind.cursor);
    expect(expired.status).toBe(410);
    expect(expired.body).toEqual(EXPIRED);
    // Retrying an expired cursor stays expired; it never silently continues.
    expect((await getFeed(app, behind.cursor, 1)).status).toBe(410);

    const atWatermark = await getFeed(app, exact.cursor);
    expect(atWatermark.status).toBe(200);
    expect(obsIds(atWatermark.body.items)).toEqual(fresh.map((f) => f.id));
    const caughtUp = await getFeed(app, ahead.cursor);
    expect(caughtUp.body).toMatchObject({ items: [], has_more: false, next_cursor: ahead.cursor });

    // The documented recovery: alert, then resynchronise from the start of the retained buffer.
    const start = await getFeed(app);
    expect(obsIds(start.body.items)).toEqual(fresh.map((f) => f.id));
    // Retention is not erasure: no tombstones, companies and stats untouched.
    expect((await db.pool.query("SELECT 1 FROM feed_tombstones")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM companies")).rowCount).toBe(1);
  });

  it("P9 the watermark commits atomically with the delete: an uncommitted prune changes nothing for readers; its commit expires the cursor; a rolled-back prune never does", async () => {
    const { old } = await seed();
    const behind = await consumerAt(1);
    const cutoff = new Date(now - 5 * DAY);
    for (const outcome of ["ROLLBACK", "COMMIT"] as const) {
      await holder.query("BEGIN");
      const del = await holder.query(PRUNE_FEED_OBSERVATIONS_SQL, [cutoff, 100]);
      expect(del.rowCount).toBe(5);
      // Readers see neither the delete nor the watermark yet.
      const during = await getFeed(app, behind.cursor, 10);
      expect(during.status).toBe(200);
      expect(obsIds(during.body.items).slice(0, 4)).toEqual(old.slice(1).map((o) => o.id));
      await holder.query(outcome);
      const after = await getFeed(app, behind.cursor, 10);
      if (outcome === "ROLLBACK") {
        expect(after.status).toBe(200);
        expect(await retention.watermark(FEED_SCOPE)).toBeNull();
      } else {
        expect(after.status).toBe(410);
      }
    }
  });

  it("P9 every non-erasure deletion path advances the watermark (inherited activity prune, FK cascade, manual delete); erasure writes a tombstone instead", async () => {
    // Inherited ActivityRepository prune: safe even before MAIN rewires the prune loop.
    let s = await seed();
    let behind = await consumerAt(1);
    expect(await db.activity.pruneObservationsBefore(new Date(now - 7 * DAY), 100)).toBe(3);
    expect(await retention.watermark(FEED_SCOPE)).toEqual({ txid: BigInt(s.old[2]!.txid), kind: FEED_KIND_OBSERVATION, id: BigInt(s.old[2]!.id) });
    expect((await getFeed(app, behind.cursor)).status).toBe(410);

    // Manual delete of one row in the middle of the stream.
    await resetFeedDb(db);
    s = await seed();
    behind = await consumerAt(1);
    const ahead = await consumerAt(6);
    await db.pool.query("DELETE FROM company_observations WHERE id = $1", [s.fresh[0]!.id]);
    expect((await getFeed(app, behind.cursor)).status).toBe(410);
    expect((await getFeed(app, ahead.cursor)).status).toBe(200); // at the deleted row's own position

    // FK cascade from a manual company delete.
    await resetFeedDb(db);
    s = await seed();
    behind = await consumerAt(3);
    await db.pool.query("DELETE FROM company_scope_stats");
    await db.pool.query("DELETE FROM companies WHERE id = $1", [s.company]);
    expect((await getFeed(app, behind.cursor)).status).toBe(410);
    expect((await db.pool.query("SELECT 1 FROM feed_tombstones")).rowCount).toBe(0);

    // Erasure: tombstone, no watermark movement, the consumer continues.
    await resetFeedDb(db);
    s = await seed();
    behind = await consumerAt(1);
    await eraseCompany(db.pool, { companyId: s.company });
    expect(await retention.watermark(FEED_SCOPE)).toBeNull();
    const cont = await getFeed(app, behind.cursor);
    expect(cont.status).toBe(200);
    expect(cont.body.items.map((i) => i.type)).toEqual(["company_erased"]);
  });

  it("P9 retention batches are bounded, oldest first, only before the cutoff, never write tombstones, and refuse invalid input", async () => {
    const { old } = await seed();
    const cutoff = new Date(now - 5 * DAY);
    expect(await retention.pruneBefore(cutoff, 2)).toBe(2);
    const left = await db.pool.query<{ id: string }>("SELECT id::text AS id FROM company_observations ORDER BY id");
    expect(left.rows.map((r) => r.id).slice(0, 3)).toEqual(old.slice(2).map((o) => o.id));
    expect(await retention.pruneAllBefore(cutoff, { batch: 2, maxBatches: 1 })).toEqual({ deleted: 2, batches: 1, backlog: true });
    expect(await retention.pruneAllBefore(cutoff, { batch: 10 })).toEqual({ deleted: 1, batches: 1, backlog: false });
    expect(await retention.pruneAllBefore(cutoff, { batch: 10 })).toEqual({ deleted: 0, batches: 0, backlog: false });
    expect((await db.pool.query("SELECT 1 FROM company_observations")).rowCount).toBe(3);
    expect((await db.pool.query("SELECT 1 FROM feed_tombstones")).rowCount).toBe(0);
    for (const bad of [0, -1, 1.5, 100_001]) await expect(retention.pruneBefore(cutoff, bad)).rejects.toMatchObject({ name: "DbError", code: "INVALID_LIMIT" });
    await expect(retention.pruneBefore(new Date(Number.NaN), 1)).rejects.toMatchObject({ code: "INVALID_CUTOFF" });
    expect(() => retentionCutoff(new Date(), 0)).toThrow();
    // The watermark only moves forward: deleting a lower position later leaves it where it is.
    const rest = (await db.pool.query<{ id: string; txid: string }>("SELECT id::text AS id, txid::text AS txid FROM company_observations ORDER BY txid, id")).rows;
    await db.pool.query("DELETE FROM company_observations WHERE id = $1", [rest[2]!.id]);
    const high = { txid: BigInt(rest[2]!.txid), kind: FEED_KIND_OBSERVATION, id: BigInt(rest[2]!.id) };
    expect(await retention.watermark(FEED_SCOPE)).toEqual(high);
    await db.pool.query("DELETE FROM company_observations WHERE id = $1", [rest[0]!.id]);
    expect(await retention.watermark(FEED_SCOPE)).toEqual(high);
  });

  it("P9 retention racing a paging consumer (20 seeds): every 200 page continues the stream contiguously; any loss surfaces as 410, never as a silent gap", async () => {
    let totalExpired = 0;
    for (let seedNo = 1; seedNo <= 20; seedNo++) {
      await resetFeedDb(db);
      let state = seedNo * 7919;
      const rnd = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
      const company = await createCompany(db.pool, "race-buffer.example");
      const stream: string[] = [];
      for (let i = 0; i < 30; i++) stream.push((await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - (60 - i) * DAY) })).id);
      let cursor: string | undefined;
      let lastIndex = -1;
      let cutoffDays = 61;
      for (let step = 0; step < 400; step++) {
        if (lastIndex === stream.length - 1 && cutoffDays <= 18) break;
        const roll = rnd();
        if (roll < 0.55) {
          // Retention runs, sometimes far ahead of the consumer.
          cutoffDays = Math.max(18, cutoffDays - Math.floor(rnd() * 5));
          await retention.pruneBefore(new Date(now - cutoffDays * DAY), 1 + Math.floor(rnd() * 5));
          continue;
        }
        if (roll < 0.65) {
          stream.push((await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - 10 * DAY) })).id);
          continue;
        }
        const r = await getFeed(app, cursor, 1 + Math.floor(rnd() * 2));
        if (r.status === 410) {
          expect(r.body).toEqual(EXPIRED);
          totalExpired += 1;
          cursor = undefined; // alert + resynchronise from the start of the buffer
          continue;
        }
        expect(r.status).toBe(200);
        const ids = obsIds(r.body.items);
        if (ids.length > 0) {
          const first = stream.indexOf(ids[0]!);
          if (cursor === undefined) {
            // A fresh start begins at the first surviving item: everything before it is gone.
            expect((await db.pool.query("SELECT 1 FROM company_observations WHERE id < $1", [ids[0]])).rowCount).toBe(0);
          } else {
            expect(first, `seed ${seedNo} step ${step}: silent gap`).toBe(lastIndex + 1);
          }
          ids.forEach((id, k) => expect(stream.indexOf(id)).toBe(first + k));
          lastIndex = first + ids.length - 1;
        }
        cursor = r.body.next_cursor;
      }
      expect(lastIndex, `seed ${seedNo}`).toBe(stream.length - 1);
    }
    expect(totalExpired).toBeGreaterThan(5); // the scenarios really exercised expiry
  });
});
