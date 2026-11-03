/**
 * reporting-feed.v1 (CHR-66 N1): a cursor-key rotation must not mask a 410.
 *
 * The cursor MAC key derives from IP_HMAC_SECRET, so rotating that secret
 * makes every outstanding cursor fail verification. A consumer answers 400
 * with an automatic restart from the start of the buffer, which is safe only
 * when retention has pruned nothing after its position. The resolver therefore
 * compares the position a WELL-FORMED but unverified cursor claims with the
 * scope's retention watermark: strictly before it -> 410 cursor_expired (what
 * the same cursor got before the rotation); otherwise 400. The claim never
 * selects or serves items. Malformed cursors stay 400.
 *
 * Real PostgreSQL, the real server wiring (cursor key derived from
 * IP_HMAC_SECRET by server.ts), and, end to end, the reference Supabase Edge
 * engine (integrations/supabase-edge/src/core/engine.ts) talking HTTP to the
 * real resolver over loopback with an in-memory projection store.
 *
 * Synthetic data only: example.* domains, no IPs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { decodeFeedCursor, deriveFeedCursorKey, encodeFeedCursor, FEED_ROUTE, unverifiedFeedCursorPosition } from "../../src/api/reporting.js";
import { FEED_KIND_OBSERVATION, FEED_KIND_TOMBSTONE, FEED_START, type FeedPosition } from "../../src/contracts/reporting-feed.js";
import type { Db } from "../../src/db/index.js";
import { createFeedRetention, retentionCutoff, type FeedRetention } from "../../src/db/retention.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { createTestDb } from "../helpers/db.js";
import { TEST_HMAC_SECRET, testConfig } from "../helpers/env.js";
import {
  buildFeedServer,
  createCompany,
  FEED_REPORTING_TOKEN,
  FEED_SCOPE,
  FeedConsumer,
  getFeed,
  idleRunner,
  insertObservation,
  obsIds,
  OTHER_SCOPE,
  reportingAuth,
  resetFeedDb,
  type InsertedObservation,
} from "../helpers/feed.js";
// The reference consumer engine, imported from its own workspace so this suite
// drives the exact code a client deploys (it has no runtime dependencies).
import { runSync } from "../../../../integrations/supabase-edge/src/core/engine.ts";
import type {
  ApplyPageArgs,
  ApplyPageResult,
  LocalCounts,
  RecordStatusArgs,
  Store,
  SyncConfig,
  SyncState,
} from "../../../../integrations/supabase-edge/src/core/types.ts";

const DAY = 86_400_000;
const EXPIRED = { version: "1", error: "cursor_expired" };
const INVALID = { version: "1", error: "invalid_request" };
const SCOPE_WIRE = { installation_id: FEED_SCOPE.installationId, website_id: FEED_SCOPE.websiteId };
/** The secret before the rotation; the servers under test run with TEST_HMAC_SECRET after it. */
const OLD_SECRET = ["pre", "rotation", "hmac", "secret", "0123456789abcdef0123456789abcdef"].join("-");
const OLD_KEY = deriveFeedCursorKey(OLD_SECRET);
const NEW_KEY = deriveFeedCursorKey(TEST_HMAC_SECRET);

const pos = (o: InsertedObservation, kind: FeedPosition["kind"] = FEED_KIND_OBSERVATION): FeedPosition => ({ txid: BigInt(o.txid), kind, id: BigInt(o.id) });
const staleCursor = (p: FeedPosition) => encodeFeedCursor(p, OLD_KEY, SCOPE_WIRE);

async function rawFeed(app: FastifyInstance, after: string): Promise<{ status: number; body: unknown }> {
  const r = await app.inject({ method: "GET", url: `${FEED_ROUTE}?after=${encodeURIComponent(after)}`, headers: reportingAuth });
  return { status: r.statusCode, body: r.json() };
}

describe("reporting feed: cursor-key rotation vs the retention watermark (N1)", () => {
  let db: Db;
  /** Pre-rotation resolver: cursor key from OLD_SECRET. */
  let before: FastifyInstance;
  /** Post-rotation resolver: cursor key from TEST_HMAC_SECRET. */
  let app: FastifyInstance;
  let logger: ReturnType<typeof createMemoryLogger>;
  let retention: FeedRetention;

  beforeAll(async () => {
    db = await createTestDb({ max: 6 });
    ({ app: before } = await buildFeedServer(db, { IP_HMAC_SECRET: OLD_SECRET }));
    ({ app, logger } = await buildFeedServer(db));
    retention = createFeedRetention(db.pool);
  });
  beforeEach(async () => {
    await resetFeedDb(db);
  });
  afterAll(async () => {
    await resetFeedDb(db);
    await before.close();
    await app.close();
    await db.close();
  });

  const now = Date.now();
  /** Five observations retention will prune (old[4] becomes the watermark) and three it keeps. */
  async function seed(): Promise<{ old: InsertedObservation[]; fresh: InsertedObservation[] }> {
    const company = await createCompany(db.pool, "rotation.example");
    const old: InsertedObservation[] = [];
    const fresh: InsertedObservation[] = [];
    for (let i = 0; i < 5; i++) old.push(await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - (10 - i) * DAY) }));
    for (let i = 0; i < 3; i++) fresh.push(await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - i * 60_000) }));
    return { old, fresh };
  }
  async function prune(): Promise<void> {
    const r = await retention.pruneAllBefore(retentionCutoff(new Date(now), 5), { batch: 100 });
    expect(r.deleted).toBe(5);
  }

  it("a stale-key cursor strictly before the watermark gets 410 cursor_expired, exactly as before the rotation", async () => {
    const { old } = await seed();
    // A consumer of the pre-rotation resolver that applied two items and stalled.
    const stalled = new FeedConsumer(before, 2);
    await stalled.step();
    expect(obsIds(stalled.delivered)).toEqual([old[0]!.id, old[1]!.id]);
    const cursor = stalled.cursor!;
    expect(decodeFeedCursor(cursor, NEW_KEY, SCOPE_WIRE)).toBeUndefined(); // the rotation invalidated it

    // Before pruning nothing was missed: the stale cursor is a plain 400 (safe reset).
    expect(await rawFeed(app, cursor)).toEqual({ status: 400, body: INVALID });

    await prune();
    expect(await retention.watermark(FEED_SCOPE)).toEqual(pos(old[4]!));
    // Control: the pre-rotation resolver answers 410 for the same cursor.
    expect(await rawFeed(before, cursor)).toEqual({ status: 410, body: EXPIRED });
    // The rotated resolver must answer the same, not 400.
    const logStart = logger.entries.length;
    expect(await rawFeed(app, cursor)).toEqual({ status: 410, body: EXPIRED });
    expect(logger.entries.slice(logStart)).toContainEqual(
      expect.objectContaining({ event: "request_rejected", error_code: "cursor_expired", http_status: 410, reason: "unverified_cursor" }),
    );

    // Every stale position strictly before the watermark: observations and
    // tombstones of earlier transactions, the last pruned row's predecessor,
    // and the stream start a consumer of an empty feed holds.
    const wm = pos(old[4]!);
    const behind: FeedPosition[] = [
      FEED_START,
      pos(old[0]!),
      pos(old[3]!),
      pos(old[3]!, FEED_KIND_TOMBSTONE),
      { txid: wm.txid, kind: FEED_KIND_OBSERVATION, id: wm.id - 1n },
      { txid: wm.txid - 1n, kind: FEED_KIND_TOMBSTONE, id: 9_223_372_036_854_775_807n },
    ];
    for (const p of behind) expect(await rawFeed(app, staleCursor(p)), String(p.id)).toEqual({ status: 410, body: EXPIRED });
  });

  it("a stale-key cursor at or after the watermark gets 400 invalid_request (the safe reset still applies)", async () => {
    const { old, fresh } = await seed();
    await prune();
    const wm = pos(old[4]!);
    const atOrAfter: FeedPosition[] = [
      wm, // exactly at the watermark: nothing after it was pruned
      { txid: wm.txid, kind: FEED_KIND_TOMBSTONE, id: 0n }, // same txid, tombstones sort after observations
      { txid: wm.txid, kind: FEED_KIND_OBSERVATION, id: wm.id + 1n },
      pos(fresh[0]!),
      pos(fresh[2]!),
      { txid: 18_446_744_073_709_551_615n, kind: FEED_KIND_TOMBSTONE, id: 9_223_372_036_854_775_807n }, // far future
    ];
    for (const p of atOrAfter) expect(await rawFeed(app, staleCursor(p)), String(p.id)).toEqual({ status: 400, body: INVALID });

    // Cursors handed out by the pre-rotation resolver at and after the watermark.
    const exact = new FeedConsumer(before, 5);
    await exact.step();
    expect(await rawFeed(before, exact.cursor!)).toMatchObject({ status: 200 });
    expect(await rawFeed(app, exact.cursor!)).toEqual({ status: 400, body: INVALID });
  });

  it("only this scope's watermark counts: a watermark in another scope leaves a stale cursor at 400", async () => {
    const company = await createCompany(db.pool, "other-scope.example");
    const theirs: InsertedObservation[] = [];
    for (let i = 0; i < 3; i++) theirs.push(await insertObservation(db.pool, { companyId: company, scope: OTHER_SCOPE, observedAt: new Date(now - (10 - i) * DAY) }));
    const mine = await insertObservation(db.pool, { companyId: company, observedAt: new Date(now) });
    const r = await retention.pruneAllBefore(retentionCutoff(new Date(now), 5), { batch: 100 });
    expect(r.deleted).toBe(3);
    expect(await retention.watermark(FEED_SCOPE)).toBeNull();
    expect(await retention.watermark(OTHER_SCOPE)).toEqual(pos(theirs[2]!));
    expect(await rawFeed(app, staleCursor(pos(theirs[0]!)))).toEqual({ status: 400, body: INVALID });
    expect(await rawFeed(app, staleCursor(FEED_START))).toEqual({ status: 400, body: INVALID });
    expect(obsIds((await getFeed(app)).body.items)).toEqual([mine.id]);
  });

  it("malformed and garbage cursors stay 400 even when the claimed position would be expired; tampered cursors at or after the watermark stay 400", async () => {
    const { old, fresh } = await seed();
    await prune();
    const stale = staleCursor(pos(old[0]!));
    expect((await rawFeed(app, stale)).status).toBe(410); // the reference: well-formed, behind the watermark
    const bytes = Buffer.from(stale, "base64url");
    const withByte = (i: number, v: number) => {
      const b = Buffer.from(bytes);
      b[i] = v;
      return b.toString("base64url");
    };
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = stale[stale.length - 1]!;
    const malformed = [
      stale.slice(0, -1), // 45 characters
      stale + "A", // 47 characters
      stale.slice(0, -1) + alphabet[(alphabet.indexOf(last) & ~0b1111) | ((alphabet.indexOf(last) + 1) & 0b1111)]!, // non-canonical encoding of the same bytes
      withByte(0, 2), // unknown cursor format
      withByte(0, 0),
      withByte(9, 2), // invalid kind
      withByte(9, 0xff),
      withByte(10, 0x80), // id above the signed 64-bit range
      "A".repeat(46), // all-zero bytes: format 0
      "x".repeat(46),
      Buffer.from(JSON.stringify({ t: 1, o: 1 })).toString("base64url"), // a legacy reporting cursor
      "not-a-cursor",
    ];
    for (const m of malformed) {
      expect(unverifiedFeedCursorPosition(m), m).toBeUndefined();
      expect(await rawFeed(app, m), m).toEqual({ status: 400, body: INVALID });
    }
    for (const m of ["not base64url!", "%00", "A".repeat(129)]) {
      const r = await app.inject({ method: "GET", url: `${FEED_ROUTE}?after=${encodeURIComponent(m)}`, headers: reportingAuth });
      expect(r.statusCode, m).toBe(400);
    }

    // A current-key cursor tampered with: a flipped tag bit or a payload change
    // that still claims a position at or after the watermark is a plain 400.
    const good = (await getFeed(app, undefined, 1)).body.next_cursor;
    expect(decodeFeedCursor(good, NEW_KEY, SCOPE_WIRE)).toEqual(pos(fresh[0]!));
    const g = Buffer.from(good, "base64url");
    const flipped = (i: number, bit: number) => {
      const b = Buffer.from(g);
      b[i]! ^= 1 << bit;
      return b.toString("base64url");
    };
    for (const t of [flipped(33, 0), flipped(20, 7), flipped(17, 0), flipped(17, 1), flipped(1, 0)]) {
      expect(await rawFeed(app, t), t).toEqual({ status: 400, body: INVALID });
    }
    // A forged cursor claiming a pruned position is indistinguishable from a
    // stale one (that is what the tag is for), so it gets 410: an error that
    // serves nothing and asks the consumer to resynchronise.
    expect(await rawFeed(app, encodeFeedCursor(pos(old[2]!), deriveFeedCursorKey(["forged", "secret", "0123456789abcdef0123456789abcdef"].join("-")), SCOPE_WIRE))).toEqual({ status: 410, body: EXPIRED });
  });

  it("valid cursors are unchanged: behind the watermark 410 (no unverified reason), at it 200 with the retained items, caught up 200 empty", async () => {
    const { fresh } = await seed();
    const behind = new FeedConsumer(app, 2);
    await behind.step();
    const exact = new FeedConsumer(app, 5);
    await exact.step();
    const ahead = new FeedConsumer(app, 8);
    await ahead.step();
    await prune();

    const logStart = logger.entries.length;
    expect(await rawFeed(app, behind.cursor!)).toEqual({ status: 410, body: EXPIRED });
    const expiredLog = logger.entries.slice(logStart).find((e) => e["error_code"] === "cursor_expired");
    expect(expiredLog).toBeDefined();
    expect(expiredLog!["reason"]).toBeUndefined();
    const atWatermark = await getFeed(app, exact.cursor);
    expect(atWatermark.status).toBe(200);
    expect(obsIds(atWatermark.body.items)).toEqual(fresh.map((f) => f.id));
    const caughtUp = await getFeed(app, ahead.cursor);
    expect(caughtUp.status).toBe(200);
    expect(caughtUp.body).toMatchObject({ items: [], has_more: false, next_cursor: ahead.cursor });
  });

  it("a failed watermark read answers 500, never a 400 that would let the consumer reset silently", async () => {
    const config = testConfig({ REPORTING_AUTH_TOKEN: FEED_REPORTING_TOKEN, RATE_LIMIT_PER_MINUTE: "100000" });
    let reads = 0;
    const failing = {
      ...db.reporting,
      feedWatermark: async () => {
        reads += 1;
        throw new Error("watermark unavailable");
      },
    };
    const broken = await buildServer({ config, logger: createMemoryLogger(), runner: idleRunner, ping: () => db.ping(), reporting: failing });
    await broken.ready();
    try {
      const { old } = await seed();
      await prune();
      expect(await rawFeed(broken, staleCursor(pos(old[0]!)))).toEqual({ status: 500, body: { version: "1", error: "internal" } });
      expect(reads).toBe(1);
      // Malformed cursors never reach the database; valid cursors never need the extra read.
      expect((await rawFeed(broken, "A".repeat(46))).status).toBe(400);
      expect((await getFeed(broken)).status).toBe(200);
      expect(reads).toBe(1);
    } finally {
      await broken.close();
    }
  });
});

// ---- end to end: the reference Edge engine against the real resolver ---------

/** In-memory Store with the same compare-and-set semantics as the SQL projection. */
class MemStore implements Store {
  cursor: string | null = null;
  needsResync = false;
  readonly observations = new Map<string, unknown>();
  readonly statuses: string[] = [];
  resets = 0;
  async getState(): Promise<SyncState> {
    return { cursor: this.cursor, needsResync: this.needsResync };
  }
  async applyPage(a: ApplyPageArgs): Promise<ApplyPageResult> {
    if (a.expectedCursor !== this.cursor) return { applied: false, observations: 0, tombstones: 0 };
    let n = 0;
    for (const it of a.items) {
      if (it.type === "observation") {
        this.observations.set(it.observation_id, it);
        n += 1;
      }
    }
    this.cursor = a.nextCursor;
    return { applied: true, observations: n, tombstones: 0 };
  }
  async recordStatus(a: RecordStatusArgs): Promise<void> {
    this.statuses.push(a.status);
    if (a.needsResync !== null) this.needsResync = a.needsResync;
  }
  async localCounts(): Promise<LocalCounts> {
    return { observations: this.observations.size, observedCompanies: 0 };
  }
  async resetCursor(expected: string): Promise<boolean> {
    if (this.cursor !== expected || this.needsResync) return false;
    this.cursor = null;
    this.resets += 1;
    return true;
  }
}

describe("end to end: Supabase Edge engine across a cursor-key rotation (N1)", () => {
  let db: Db;
  let before: FastifyInstance;
  let after: FastifyInstance;
  let beforeUrl: string;
  let afterUrl: string;
  let retention: FeedRetention;

  beforeAll(async () => {
    db = await createTestDb({ max: 6 });
    ({ app: before } = await buildFeedServer(db, { IP_HMAC_SECRET: OLD_SECRET }));
    ({ app: after } = await buildFeedServer(db));
    beforeUrl = await before.listen({ host: "127.0.0.1", port: 0 });
    afterUrl = await after.listen({ host: "127.0.0.1", port: 0 });
    retention = createFeedRetention(db.pool);
  });
  beforeEach(async () => {
    await resetFeedDb(db);
  });
  afterAll(async () => {
    await resetFeedDb(db);
    await before.close();
    await after.close();
    await db.close();
  });

  const cfg = (baseUrl: string, over: Partial<SyncConfig> = {}): SyncConfig => ({
    baseUrl,
    token: FEED_REPORTING_TOKEN,
    installationId: FEED_SCOPE.installationId,
    pageLimit: 2,
    maxPages: 50,
    budgetMs: 30_000,
    requestTimeoutMs: 5_000,
    maxRetries: 0,
    baseDelayMs: 1,
    maxDelayMs: 1,
    reconcileDays: 0,
    ...over,
  });
  const deps = (store: Store) => ({ fetch, store, now: () => Date.now(), sleep: async () => undefined, random: () => 0.5 });

  const now = Date.now();
  async function seed(): Promise<{ old: InsertedObservation[]; fresh: InsertedObservation[]; company: number }> {
    const company = await createCompany(db.pool, "engine.example");
    const old: InsertedObservation[] = [];
    const fresh: InsertedObservation[] = [];
    for (let i = 0; i < 4; i++) old.push(await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - 40 * DAY + i * 60_000) }));
    for (let i = 0; i < 2; i++) fresh.push(await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - i * 60_000) }));
    return { old, fresh, company };
  }

  it("retention pruned past a stalled consumer, then the key rotated: the engine ends in needs_resync, not cursor_rejected", async () => {
    const { old } = await seed();
    const store = new MemStore();
    // One page (obs 1, 2) from the pre-rotation resolver, then the consumer stalls.
    expect((await runSync(cfg(beforeUrl, { maxPages: 1 }), deps(store))).status).toBe("partial");
    expect([...store.observations.keys()]).toEqual([old[0]!.id, old[1]!.id]);
    const stalledAt = store.cursor;
    // Retention (30 days) prunes obs 1-4: obs 3 and 4 were never delivered.
    expect((await retention.pruneAllBefore(retentionCutoff(new Date(now), 30), { batch: 100 })).deleted).toBe(4);

    // The resolver's IP_HMAC_SECRET is rotated; the engine now talks to it.
    const r = await runSync(cfg(afterUrl), deps(store));
    expect(r.status).toBe("needs_resync");
    expect(store.needsResync).toBe(true);
    expect(store.statuses).not.toContain("cursor_rejected");
    expect(store.resets).toBe(0);
    expect(store.cursor).toBe(stalledAt); // never reset, never advanced past the loss
    expect([...store.observations.keys()]).toEqual([old[0]!.id, old[1]!.id]);
    // And it stays that way until an operator resynchronises.
    expect((await runSync(cfg(afterUrl), deps(store))).status).toBe("needs_resync");
  });

  it("control: a rotation while the consumer is at or after the watermark still resets once and replays the retained buffer (cursor_rejected)", async () => {
    const { fresh, company } = await seed();
    const store = new MemStore();
    expect((await runSync(cfg(beforeUrl), deps(store))).status).toBe("ok");
    expect((await retention.pruneAllBefore(retentionCutoff(new Date(now), 30), { batch: 100 })).deleted).toBe(4);
    const extra = await insertObservation(db.pool, { companyId: company });

    const r = await runSync(cfg(afterUrl), deps(store));
    expect(r.status).toBe("cursor_rejected");
    expect(store.needsResync).toBe(false);
    expect(store.resets).toBe(1);
    for (const f of [...fresh, extra]) expect(store.observations.has(f.id)).toBe(true);
    expect((await runSync(cfg(afterUrl), deps(store))).status).toBe("ok");
  });
});
