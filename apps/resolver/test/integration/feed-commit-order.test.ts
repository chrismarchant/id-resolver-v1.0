/**
 * reporting-feed.v1 proof suite, part 1 (CHR-71): commit-safety of the
 * (txid, kind, id) cursor under out-of-order commits, open transactions and
 * randomised interleavings, against real PostgreSQL.
 *
 * Interleavings are forced with explicit transactions on separate
 * connections, stepped one statement at a time from this test, so the order
 * in which rows are inserted, committed and aborted is chosen by the test and
 * reproducible from a seed. The feed horizon is cluster-wide: unrelated
 * transactions elsewhere in the cluster can only hold it back further, never
 * let it pass an open writer, so assertions about content and order are
 * deterministic and only "how soon" needs polling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../src/db/index.js";
import { createTestDb } from "../helpers/db.js";
import {
  buildFeedServer,
  createCompany,
  currentHorizon,
  FeedConsumer,
  getFeed,
  insertObservation,
  obsIds,
  openWriter,
  resetFeedDb,
  sleep,
} from "../helpers/feed.js";

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]! };
}

describe("reporting feed: commit-safe ordering", () => {
  let db: Db;
  let app: FastifyInstance;
  const writers: pg.Client[] = [];

  beforeAll(async () => {
    db = await createTestDb({ max: 8 });
    ({ app } = await buildFeedServer(db));
    for (let i = 0; i < 6; i++) writers.push(await openWriter());
  });
  beforeEach(async () => {
    for (const w of writers) await w.query("ROLLBACK").catch(() => undefined);
    await resetFeedDb(db);
  });
  afterAll(async () => {
    for (const w of writers) await w.end().catch(() => undefined);
    await resetFeedDb(db);
    await app.close();
    await db.close();
  });

  it("P1 out-of-order commit: a page cut while T1 is open never passes T1; after T1 commits the stream continues T1 then T2, no gap, no duplicate", async () => {
    const [t1, t2] = writers as [pg.Client, pg.Client];
    const company = await createCompany(db.pool, "order.example");
    const consumer = new FeedConsumer(app, 50);
    const before = await insertObservation(db.pool, { companyId: company });
    await consumer.drain((c) => c.projection.observations.has(before.id));
    const cursorBefore = consumer.cursor;

    // T1 inserts first: lower id and lower xid. T2 inserts second and commits first.
    await t1.query("BEGIN");
    const r1 = await insertObservation(t1, { companyId: company, pageKey: "/t1" });
    await t2.query("BEGIN");
    const r2 = await insertObservation(t2, { companyId: company, pageKey: "/t2" });
    expect(BigInt(r1.id)).toBeLessThan(BigInt(r2.id));
    expect(BigInt(r1.txid)).toBeLessThan(BigInt(r2.txid));
    await t2.query("COMMIT");

    // Sensitivity: the hazard is real. T2's row is committed and visible now,
    // T1's is not, so a cursor on id or on "what is visible" would deliver T2
    // and then move past T1's lower id for good.
    const visible = await db.pool.query<{ id: string }>("SELECT id::text AS id FROM company_observations WHERE id > $1 ORDER BY id", [before.id]);
    expect(visible.rows.map((r) => r.id)).toEqual([r2.id]);

    // Pages cut while T1 is open: nothing past the horizon, which is <= T1's txid.
    const during = await getFeed(app, cursorBefore, 50);
    expect(during.status).toBe(200);
    expect(during.body.items).toEqual([]);
    expect(during.body.has_more).toBe(false);
    expect(during.body.next_cursor).toBe(cursorBefore); // same position, same encoding
    const fromStart = await getFeed(app, undefined, 500);
    expect(obsIds(fromStart.body.items)).toEqual([before.id]);
    expect(await currentHorizon(db.pool)).toBeLessThanOrEqual(BigInt(r1.txid));
    const deliveredBefore = consumer.delivered.length;
    await consumer.step(); // the consumer itself polls during the window: still nothing
    expect(consumer.delivered.length).toBe(deliveredBefore);

    await t1.query("COMMIT");
    await consumer.drain((c) => c.projection.observations.has(r2.id));
    const after = consumer.delivered.slice(deliveredBefore);
    expect(obsIds(after)).toEqual([r1.id, r2.id]);
    expect(after.map((i) => (i.type === "observation" ? i.page_key : null))).toEqual(["/t1", "/t2"]);
    // Replaying the whole stream: exactly once each, in (txid, id) order.
    const replay = await getFeed(app, undefined, 500);
    expect(obsIds(replay.body.items)).toEqual([before.id, r1.id, r2.id]);
  });

  it("P1 out-of-order commit, abort variant: T1 aborts after T2 committed; the stream holds back, then continues with T2 only", async () => {
    const [t1, t2] = writers as [pg.Client, pg.Client];
    const company = await createCompany(db.pool, "abort.example");
    const consumer = new FeedConsumer(app, 2);
    await t1.query("BEGIN");
    const r1 = await insertObservation(t1, { companyId: company });
    await t2.query("BEGIN");
    const r2a = await insertObservation(t2, { companyId: company });
    const r2b = await insertObservation(t2, { companyId: company });
    await t2.query("COMMIT");
    await consumer.step();
    expect(consumer.delivered).toEqual([]);
    await t1.query("ROLLBACK");
    await consumer.drain((c) => c.projection.observations.has(r2b.id));
    expect(obsIds(consumer.delivered)).toEqual([r2a.id, r2b.id]);
    expect(consumer.projection.observations.has(r1.id)).toBe(false);
  });

  it("P7 a long-running open transaction holds the feed back; once it ends, its rows appear in position order", async () => {
    const [long] = writers as [pg.Client];
    const company = await createCompany(db.pool, "long.example");
    const consumer = new FeedConsumer(app, 10);
    await long.query("BEGIN");
    const a = await insertObservation(long, { companyId: company, pageKey: "/long-a" });
    // Later writers commit normally while the long transaction stays open.
    const b = await insertObservation(db.pool, { companyId: company, pageKey: "/b" });
    const c = await insertObservation(db.pool, { companyId: company, pageKey: "/c" });
    for (let i = 0; i < 5; i++) {
      await consumer.step();
      expect(consumer.delivered).toEqual([]);
      await sleep(40);
    }
    const a2 = await insertObservation(long, { companyId: company, pageKey: "/long-a2" });
    await long.query("COMMIT");
    await consumer.drain((x) => x.projection.observations.has(c.id));
    // The long transaction's rows keep their (early) position: same txid, id order.
    expect(obsIds(consumer.delivered)).toEqual([a.id, a2.id, b.id, c.id]);
  });

  it("P7 the hold-back is bounded by statement_timeout: a stuck writer statement is cancelled, its transaction aborts and the feed advances even before the client sends ROLLBACK", async () => {
    const stuck = await openWriter(200);
    try {
      const company = await createCompany(db.pool, "stuck.example");
      const consumer = new FeedConsumer(app, 10);
      await stuck.query("BEGIN");
      const x = await insertObservation(stuck, { companyId: company });
      const y = await insertObservation(db.pool, { companyId: company });
      await consumer.step();
      expect(consumer.delivered).toEqual([]);
      await expect(stuck.query("SELECT pg_sleep(30)")).rejects.toMatchObject({ code: "57014" });
      // Aborted but not yet rolled back by the client: its xid is no longer running.
      await consumer.drain((cn) => cn.projection.observations.has(y.id));
      expect(obsIds(consumer.delivered)).toEqual([y.id]);
      expect(consumer.projection.observations.has(x.id)).toBe(false);
      await stuck.query("ROLLBACK");
    } finally {
      await stuck.end().catch(() => undefined);
    }
  });

  it("P7 an abandoned idle writer is ended by idle_in_transaction_session_timeout and the feed advances (the bound MAIN must configure, see report)", async () => {
    const idle = await openWriter();
    try {
      await idle.query("SET idle_in_transaction_session_timeout = 300");
      const company = await createCompany(db.pool, "idle.example");
      const consumer = new FeedConsumer(app, 10);
      await idle.query("BEGIN");
      const x = await insertObservation(idle, { companyId: company });
      const y = await insertObservation(db.pool, { companyId: company });
      const started = Date.now();
      await consumer.step();
      expect(consumer.delivered).toEqual([]);
      await consumer.drain((cn) => cn.projection.observations.has(y.id));
      expect(Date.now() - started).toBeGreaterThanOrEqual(150); // it really was held back until the timeout
      expect(obsIds(consumer.delivered)).toEqual([y.id]);
      expect(consumer.projection.observations.has(x.id)).toBe(false);
    } finally {
      await idle.end().catch(() => undefined);
    }
  });

  it("assumption check: pg_current_snapshot() reports the snapshot the reading statement itself uses, not a fresh one", async () => {
    const [t1, reader] = writers as [pg.Client, pg.Client];
    const company = await createCompany(db.pool, "snapshot.example");
    await t1.query("BEGIN");
    const r1 = await insertObservation(t1, { companyId: company });
    // A REPEATABLE READ reader keeps one snapshot across statements, which makes
    // the difference between "the active snapshot" and "a new snapshot" visible.
    await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const first = await reader.query<{ h: string }>("SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS h");
    await t1.query("COMMIT");
    const second = await reader.query<{ h: string; seen: string }>(
      "SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS h, (SELECT count(*) FROM company_observations WHERE id = $1)::text AS seen",
      [r1.id],
    );
    await reader.query("COMMIT");
    // Same horizon as the snapshot's first use, at or below T1's txid, and T1's row invisible to it:
    // the horizon and the rows always describe the same snapshot.
    expect(second.rows[0]!.h).toBe(first.rows[0]!.h);
    expect(BigInt(second.rows[0]!.h)).toBeLessThanOrEqual(BigInt(r1.txid));
    expect(second.rows[0]!.seen).toBe("0");
    // A fresh statement now sees T1 finished (polling: other cluster activity may hold the horizon briefly).
    const deadline = Date.now() + 10_000;
    while ((await currentHorizon(db.pool)) <= BigInt(r1.txid)) {
      if (Date.now() > deadline) throw new Error("horizon held back");
      await sleep(10);
    }
  });

  it("subtransactions: rows of a rolled-back SAVEPOINT never appear; rows of a released one carry the top-level txid and appear at commit", async () => {
    const [w] = writers as [pg.Client];
    const company = await createCompany(db.pool, "savepoint.example");
    await w.query("BEGIN");
    const top = await insertObservation(w, { companyId: company });
    await w.query("SAVEPOINT a");
    const gone = await insertObservation(w, { companyId: company });
    await w.query("ROLLBACK TO SAVEPOINT a");
    await w.query("SAVEPOINT b");
    const kept = await insertObservation(w, { companyId: company });
    await w.query("RELEASE SAVEPOINT b");
    const xid = (await w.query<{ x: string }>("SELECT pg_current_xact_id()::text AS x")).rows[0]!.x;
    expect([top.txid, gone.txid, kept.txid]).toEqual([xid, xid, xid]);
    // A writer cannot plant a position: the trigger overrides an explicit txid.
    const forged = await w.query<{ txid: string }>(
      "INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source, txid) VALUES ('inst-test','site-test',$1,now(),'forged-position-0001','cache','3') RETURNING txid::text AS txid",
      [company],
    );
    expect(forged.rows[0]!.txid).toBe(xid);
    await w.query("COMMIT");
    await expect(db.pool.query("UPDATE company_observations SET txid = '3' WHERE id = $1", [top.id])).rejects.toMatchObject({ code: "23514" });
    const consumer = new FeedConsumer(app, 10);
    await consumer.drain((c) => c.projection.observations.has(kept.id));
    expect(obsIds(consumer.delivered)).toEqual([top.id, kept.id, expect.any(String)]);
    expect(consumer.projection.observations.has(gone.id)).toBe(false);
  });

  // ---- P8: randomised interleavings ------------------------------------------------

  interface Outcome {
    committed: Map<string, { txid: bigint; id: bigint }>;
    aborted: Set<string>;
    maxTxid: bigint;
  }

  /**
   * One seeded scenario: up to `writers.length` explicit transactions open at
   * once on separate connections, random inserts (some inside savepoints that
   * are rolled back), random commit order, random aborts (ROLLBACK and
   * statement errors), autocommit inserts, and a consumer paging with random
   * limits between steps. Every step is awaited, so the interleaving is a
   * pure function of the seed.
   */
  async function runScenario(seed: number, steps: number): Promise<{ outcome: Outcome; consumer: FeedConsumer }> {
    const rnd = prng(seed);
    await resetFeedDb(db);
    const companies = [await createCompany(db.pool, "rnd-a.example"), await createCompany(db.pool, "rnd-b.example"), await createCompany(db.pool, "rnd-c.example")];
    const outcome: Outcome = { committed: new Map(), aborted: new Set(), maxTxid: 0n };
    const consumer = new FeedConsumer(app, 3);
    type Open = { client: pg.Client; rows: { id: string; txid: string }[]; savepoint: { id: string; txid: string }[] | null };
    const open = new Map<number, Open>();
    const note = (r: { txid: string }) => {
      const t = BigInt(r.txid);
      if (t > outcome.maxTxid) outcome.maxTxid = t;
    };
    const finish = async (slot: number, how: "commit" | "rollback" | "error") => {
      const tx = open.get(slot)!;
      const all = [...tx.rows, ...(tx.savepoint ?? [])];
      if (how === "commit") {
        await tx.client.query("COMMIT");
        for (const r of all) outcome.committed.set(r.id, { txid: BigInt(r.txid), id: BigInt(r.id) });
      } else {
        if (how === "error") await expect(tx.client.query("SELECT 1 / 0")).rejects.toMatchObject({ code: "22012" });
        await tx.client.query("ROLLBACK");
        for (const r of all) outcome.aborted.add(r.id);
      }
      open.delete(slot);
    };

    for (let s = 0; s < steps; s++) {
      const roll = rnd.next();
      const freeSlots = writers.map((_, i) => i).filter((i) => !open.has(i));
      const openSlots = [...open.keys()];
      if (roll < 0.2 && freeSlots.length > 0) {
        const slot = rnd.pick(freeSlots);
        const client = writers[slot]!;
        await client.query("BEGIN");
        const r = await insertObservation(client, { companyId: rnd.pick(companies) });
        note(r);
        open.set(slot, { client, rows: [r], savepoint: null });
      } else if (roll < 0.45 && openSlots.length > 0) {
        const tx = open.get(rnd.pick(openSlots))!;
        const r = await insertObservation(tx.client, { companyId: rnd.pick(companies) });
        note(r);
        (tx.savepoint ?? tx.rows).push(r);
      } else if (roll < 0.52 && openSlots.length > 0) {
        const tx = open.get(rnd.pick(openSlots))!;
        if (tx.savepoint === null) {
          await tx.client.query("SAVEPOINT sp");
          tx.savepoint = [];
        } else if (rnd.next() < 0.5) {
          await tx.client.query("ROLLBACK TO SAVEPOINT sp");
          for (const r of tx.savepoint) outcome.aborted.add(r.id);
          tx.savepoint = null;
        } else {
          await tx.client.query("RELEASE SAVEPOINT sp");
          tx.rows.push(...tx.savepoint);
          tx.savepoint = null;
        }
      } else if (roll < 0.72 && openSlots.length > 0) {
        const how = rnd.next();
        await finish(rnd.pick(openSlots), how < 0.7 ? "commit" : how < 0.9 ? "rollback" : "error");
      } else if (roll < 0.8) {
        const r = await insertObservation(db.pool, { companyId: rnd.pick(companies) });
        note(r);
        outcome.committed.set(r.id, { txid: BigInt(r.txid), id: BigInt(r.id) });
      } else {
        consumer.limit = rnd.int(1, 4);
        await consumer.step();
      }
    }
    for (const slot of [...open.keys()]) {
      const how = rnd.next();
      await finish(slot, how < 0.7 ? "commit" : how < 0.9 ? "rollback" : "error");
    }
    // Quiescence: a page with has_more=false whose statement started after the
    // horizon passed every writer txid of this scenario has seen everything.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const h0 = await currentHorizon(db.pool);
      const st = await consumer.step();
      if (!st.hasMore && h0 > outcome.maxTxid) break;
      if (Date.now() > deadline) throw new Error(`seed ${seed}: no quiescence`);
      if (!st.hasMore) await sleep(5);
    }
    return { outcome, consumer };
  }

  function assertExact(seed: number, outcome: Outcome, consumer: FeedConsumer): void {
    const delivered = obsIds(consumer.delivered);
    const expected = [...outcome.committed.values()].sort((a, b) => (a.txid !== b.txid ? (a.txid < b.txid ? -1 : 1) : a.id < b.id ? -1 : 1)).map((r) => r.id.toString());
    // Exactly the committed rows, each once, in (txid, id) order; no aborted row.
    expect(delivered, `seed ${seed}`).toEqual(expected);
    for (const id of delivered) expect(outcome.aborted.has(id), `seed ${seed}: aborted row ${id} delivered`).toBe(false);
    expect(consumer.projection.observations.size, `seed ${seed}`).toBe(outcome.committed.size);
  }

  it("P8 randomised interleavings, fixed seed: consumed set == committed set exactly, in position order, no aborted rows", async () => {
    const seed = 20261103;
    const { outcome, consumer } = await runScenario(seed, 600);
    expect(outcome.committed.size).toBeGreaterThan(50);
    expect(outcome.aborted.size).toBeGreaterThan(5);
    assertExact(seed, outcome, consumer);
    // The database agrees with the bookkeeping.
    const rows = await db.pool.query<{ id: string }>("SELECT id::text AS id FROM company_observations");
    expect(new Set(rows.rows.map((r) => r.id))).toEqual(new Set(outcome.committed.keys()));
  });

  it("P8 randomised interleavings, 50 seeded iterations: consumed set == committed set exactly every time", async () => {
    const started = Date.now();
    let committed = 0;
    let aborted = 0;
    for (let i = 1; i <= 50; i++) {
      const seed = 0x5eed0000 + i;
      const { outcome, consumer } = await runScenario(seed, 90);
      assertExact(seed, outcome, consumer);
      committed += outcome.committed.size;
      aborted += outcome.aborted.size;
    }
    expect(committed).toBeGreaterThan(500);
    expect(aborted).toBeGreaterThan(50);
    // About 9 s locally; reported, not asserted, so a slow runner cannot fail it.
    console.info(`P8 50 iterations: ${Date.now() - started} ms, ${committed} committed, ${aborted} aborted rows`);
  }, 60_000);

  it("P8 genuinely concurrent writers and consumer (no stepping): consumed set == committed set exactly", async () => {
    await resetFeedDb(db);
    const company = await createCompany(db.pool, "concurrent.example");
    const rnd = prng(424242);
    const plans = writers.map(() => Array.from({ length: 25 }, () => ({ rows: rnd.int(1, 3), outcome: rnd.next(), delay: rnd.int(0, 4) })));
    const committed = new Map<string, { txid: bigint; id: bigint }>();
    const aborted = new Set<string>();
    let maxTxid = 0n;
    let writing = true;
    const consumer = new FeedConsumer(app, 4);
    let consumerError: unknown = null;
    const consumerLoop = (async () => {
      while (writing) {
        await consumer.step();
        await sleep(1);
      }
    })().catch((e: unknown) => {
      consumerError = e;
    });
    await Promise.all(
      writers.map(async (w, wi) => {
        for (const p of plans[wi]!) {
          await w.query("BEGIN");
          const rows: { id: string; txid: string }[] = [];
          for (let k = 0; k < p.rows; k++) {
            rows.push(await insertObservation(w, { companyId: company }));
            await sleep(p.delay);
          }
          for (const r of rows) if (BigInt(r.txid) > maxTxid) maxTxid = BigInt(r.txid);
          if (p.outcome < 0.75) {
            await w.query("COMMIT");
            for (const r of rows) committed.set(r.id, { txid: BigInt(r.txid), id: BigInt(r.id) });
          } else {
            await w.query("ROLLBACK");
            for (const r of rows) aborted.add(r.id);
          }
        }
      }),
    );
    writing = false;
    await consumerLoop;
    expect(consumerError).toBeNull();
    expect(consumer.delivered.length).toBeGreaterThan(0); // it really consumed while writers were active
    const deadline = Date.now() + 15_000;
    for (;;) {
      const h0 = await currentHorizon(db.pool);
      const st = await consumer.step();
      if (!st.hasMore && h0 > maxTxid) break;
      if (Date.now() > deadline) throw new Error("no quiescence");
      await sleep(5);
    }
    assertExact(424242, { committed, aborted, maxTxid }, consumer);
  }, 60_000);
});
