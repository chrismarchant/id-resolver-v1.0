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
 * selects or serves items. Malformed cursors stay 400. The owner approved
 * this as a clarification of frozen guarantee 3 (3 Nov 2026).
 *
 * "cursor regression matrix" names one test per cursor category (valid,
 * expired, rotated, forged, malformed) and proves, with a statement-level spy
 * on the repository's pool, that untrusted cursor bytes never reach the
 * database: a malformed cursor causes no call at all, and a cursor whose tag
 * does not verify causes exactly one statement, the watermark read bound to
 * the configured scope, and never the feed query.
 *
 * Real PostgreSQL, the real server wiring (cursor key derived from
 * IP_HMAC_SECRET by server.ts), and, end to end, the reference Supabase Edge
 * engine (integrations/supabase-edge/src/core/engine.ts) talking HTTP to the
 * real resolver over loopback, projecting through the real projection SQL
 * (integrations/supabase-edge/sql/0001_idr_projection.sql, applied next to
 * the resolver's tables in the same test database, as CI already does).
 *
 * Synthetic data only: example.* domains, no IPs.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { decodeFeedCursor, deriveFeedCursorKey, encodeFeedCursor, FEED_ROUTE, unverifiedFeedCursorPosition } from "../../src/api/reporting.js";
import { FEED_KIND_OBSERVATION, FEED_KIND_TOMBSTONE, FEED_START, type FeedPosition } from "../../src/contracts/reporting-feed.js";
import type { ReportingRepository } from "../../src/contracts/db.js";
import type { Db } from "../../src/db/index.js";
import type { Pool } from "../../src/db/pool.js";
import { createReportingRepository, FEED_SQL } from "../../src/db/reporting-repo.js";
import { createFeedRetention, FEED_WATERMARK_SQL, retentionCutoff, type FeedRetention } from "../../src/db/retention.js";
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
// The reference consumer engine and its SQL projection store, imported from
// their own workspace so this suite drives the exact code a client deploys.
import { runSync } from "../../../../integrations/supabase-edge/src/core/engine.ts";
import type { Store, SyncConfig } from "../../../../integrations/supabase-edge/src/core/types.ts";
import { asRole, ensureProjection, gapRows, newPool, PgStore, truncateAll } from "../../../../integrations/supabase-edge/test/helpers/db.ts";
import type pg from "pg";

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
    // serves nothing and signals a potential continuity gap to the consumer.
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

// ---- regression matrix: forged, expired, rotated, malformed, valid ------------
//
// Owner clarification (3 Nov 2026) of guarantee 3. Every request goes through
// a reporting repository built over a pool that records each statement and
// its parameters, and through a proxy that records each repository method
// called, so "no database call", "no feed query" and "only the watermark read,
// parameterised by the configured scope" are facts, not inferences.

const EXPIRED_RAW = '{"version":"1","error":"cursor_expired"}';
const INVALID_RAW = '{"version":"1","error":"invalid_request"}';

interface Spy {
  reporting: ReportingRepository;
  statements: Array<{ text: string; values: unknown[] }>;
  methods: string[];
  reset(): void;
}

function spiedReporting(db: Db): Spy {
  const statements: Spy["statements"] = [];
  const methods: string[] = [];
  const pool = {
    query: (text: string, values?: unknown[]) => {
      statements.push({ text, values: [...(values ?? [])] });
      return db.pool.query(text, values);
    },
  } as unknown as Pool;
  const inner = createReportingRepository(pool);
  const reporting = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        methods.push(String(prop));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    reporting,
    statements,
    methods,
    reset() {
      statements.length = 0;
      methods.length = 0;
    },
  };
}

/** A well-formed cursor (canonical, format 1, valid kind and id) whose 16-byte tag is random. */
function forgedCursor(p: FeedPosition): string {
  const b = Buffer.from(encodeFeedCursor(p, NEW_KEY, SCOPE_WIRE), "base64url");
  randomBytes(16).copy(b, 18);
  return b.toString("base64url");
}

describe("reporting feed: cursor regression matrix (owner clarification of guarantee 3)", () => {
  let db: Db;
  let spy: Spy;
  let app: FastifyInstance;
  let retention: FeedRetention;
  const SCOPE_PARAMS = [FEED_SCOPE.installationId, FEED_SCOPE.websiteId];

  beforeAll(async () => {
    db = await createTestDb({ max: 6 });
    spy = spiedReporting(db);
    const config = testConfig({ REPORTING_AUTH_TOKEN: FEED_REPORTING_TOKEN, RATE_LIMIT_PER_MINUTE: "100000" });
    app = await buildServer({ config, logger: createMemoryLogger(), runner: idleRunner, ping: () => db.ping(), reporting: spy.reporting });
    await app.ready();
    retention = createFeedRetention(db.pool);
  });
  beforeEach(async () => {
    await resetFeedDb(db);
  });
  afterAll(async () => {
    await resetFeedDb(db);
    await app.close();
    await db.close();
  });

  const now = Date.now();
  /** obs 0-4 are pruned (obs 4 becomes the watermark), obs 5-7 are retained. */
  async function seedAndPrune(): Promise<{ old: InsertedObservation[]; fresh: InsertedObservation[]; wm: FeedPosition }> {
    const company = await createCompany(db.pool, "matrix.example");
    const old: InsertedObservation[] = [];
    const fresh: InsertedObservation[] = [];
    for (let i = 0; i < 5; i++) old.push(await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - (10 - i) * DAY) }));
    for (let i = 0; i < 3; i++) fresh.push(await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - i * 60_000) }));
    expect((await retention.pruneAllBefore(retentionCutoff(new Date(now), 5), { batch: 100 })).deleted).toBe(5);
    const wm = pos(old[4]!);
    expect(await retention.watermark(FEED_SCOPE)).toEqual(wm);
    spy.reset();
    return { old, fresh, wm };
  }
  async function request(after: string): Promise<{ status: number; raw: string }> {
    spy.reset();
    const r = await app.inject({ method: "GET", url: `${FEED_ROUTE}?after=${encodeURIComponent(after)}`, headers: reportingAuth });
    return { status: r.statusCode, raw: r.body };
  }
  /** The error path made exactly one statement: the watermark read, bound to the configured scope only. */
  function expectOnlyScopedWatermarkRead(label: string): void {
    expect(spy.methods, label).toEqual(["feedWatermark"]);
    expect(spy.statements, label).toEqual([{ text: FEED_WATERMARK_SQL, values: SCOPE_PARAMS }]);
  }

  it("valid: a current-key cursor at or after the watermark -> 200 with the retained items; one feed statement, no separate watermark read", async () => {
    const { fresh, wm } = await seedAndPrune();
    const r = await request(encodeFeedCursor(wm, NEW_KEY, SCOPE_WIRE));
    expect(r.status).toBe(200);
    expect(obsIds(JSON.parse(r.raw).items)).toEqual(fresh.map((f) => f.id));
    expect(spy.methods).toEqual(["feed"]);
    expect(spy.statements.map((x) => x.text)).toEqual([FEED_SQL]);
    // A valid cursor with no watermark at all is served normally too.
    await resetFeedDb(db);
    const company = await createCompany(db.pool, "matrix-valid.example");
    const a = await insertObservation(db.pool, { companyId: company });
    const b = await insertObservation(db.pool, { companyId: company });
    const page = await request(encodeFeedCursor(pos(a), NEW_KEY, SCOPE_WIRE));
    expect(page.status).toBe(200);
    expect(obsIds(JSON.parse(page.raw).items)).toEqual([b.id]);
  });

  it("expired: a current-key (valid tag) cursor strictly before the watermark -> 410 with exactly {version, error} and no items", async () => {
    const { old } = await seedAndPrune();
    for (const p of [FEED_START, pos(old[0]!), pos(old[3]!)]) {
      const r = await request(encodeFeedCursor(p, NEW_KEY, SCOPE_WIRE));
      expect(r.status, String(p.id)).toBe(410);
      expect(r.raw).toBe(EXPIRED_RAW);
      expect(spy.methods).toEqual(["feed"]); // a verified cursor: the watermark is read in the feed statement's snapshot
    }
  });

  it("rotated: a stale-key cursor below the watermark -> 410 with no items and no feed query; at or after it -> 400", async () => {
    const { old, fresh, wm } = await seedAndPrune();
    for (const p of [FEED_START, pos(old[0]!), pos(old[3]!), { ...wm, id: wm.id - 1n }]) {
      const r = await request(staleCursor(p));
      expect(r.status, String(p.id)).toBe(410);
      expect(r.raw).toBe(EXPIRED_RAW);
      expectOnlyScopedWatermarkRead(`rotated below ${p.id}`);
    }
    for (const p of [wm, { txid: wm.txid, kind: FEED_KIND_TOMBSTONE, id: 0n } as FeedPosition, pos(fresh[0]!), pos(fresh[2]!)]) {
      const r = await request(staleCursor(p));
      expect(r.status, String(p.id)).toBe(400);
      expect(r.raw).toBe(INVALID_RAW);
      expectOnlyScopedWatermarkRead(`rotated at/after ${p.id}`);
    }
  });

  it("forged: a well-formed cursor with a random tag claiming a pruned position -> 410, no items, no feed query; claiming a position within retention -> 400", async () => {
    const { old, fresh, wm } = await seedAndPrune();
    for (const p of [FEED_START, pos(old[1]!), { ...wm, id: wm.id - 1n }]) {
      const c = forgedCursor(p);
      expect(decodeFeedCursor(c, NEW_KEY, SCOPE_WIRE)).toBeUndefined();
      const r = await request(c);
      expect(r.status, String(p.id)).toBe(410);
      expect(r.raw).toBe(EXPIRED_RAW);
      expectOnlyScopedWatermarkRead(`forged below ${p.id}`);
    }
    for (const p of [wm, pos(fresh[1]!), { txid: 18_446_744_073_709_551_615n, kind: FEED_KIND_TOMBSTONE, id: 9_223_372_036_854_775_807n } as FeedPosition]) {
      const r = await request(forgedCursor(p));
      expect(r.status, String(p.id)).toBe(400);
      expect(r.raw).toBe(INVALID_RAW);
      expectOnlyScopedWatermarkRead(`forged within retention ${p.id}`);
    }
    // A forged cursor with no watermark in the scope at all -> 400.
    await resetFeedDb(db);
    const r = await request(forgedCursor(FEED_START));
    expect(r.status).toBe(400);
    expectOnlyScopedWatermarkRead("forged, no watermark");
  });

  it("malformed: 400 with no database call at all, even when the bytes would claim a pruned position", async () => {
    const { old } = await seedAndPrune();
    const stale = staleCursor(pos(old[0]!));
    const bytes = Buffer.from(stale, "base64url");
    const withByte = (i: number, v: number) => {
      const b = Buffer.from(bytes);
      b[i] = v;
      return b.toString("base64url");
    };
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = stale[stale.length - 1]!;
    const malformed = [
      stale.slice(0, -1),
      stale + "A",
      stale.slice(0, -1) + alphabet[(alphabet.indexOf(last) & ~0b1111) | ((alphabet.indexOf(last) + 1) & 0b1111)]!,
      withByte(0, 2),
      withByte(9, 2),
      withByte(10, 0x80),
      "A".repeat(46),
      Buffer.from(JSON.stringify({ t: 1, o: 1 })).toString("base64url"),
      "not-a-cursor",
      "not base64url!",
      "%00",
      "A".repeat(129),
    ];
    for (const m of malformed) {
      const r = await request(m);
      expect(r.status, m).toBe(400);
      expect(r.raw, m).toBe(INVALID_RAW);
      expect(spy.methods, m).toEqual([]);
      expect(spy.statements, m).toEqual([]);
    }
  });

  it("untrusted cursor bytes never parameterise a query: every MAC failure issues the identical scope-only statement, whatever the cursor claims", async () => {
    const { old, fresh } = await seedAndPrune();
    const failures = [staleCursor(pos(old[0]!)), staleCursor(pos(fresh[2]!)), forgedCursor(pos(old[2]!)), forgedCursor(pos(fresh[0]!))];
    const seen: string[] = [];
    for (const c of failures) {
      await request(c);
      expectOnlyScopedWatermarkRead(c);
      const values = JSON.stringify(spy.statements[0]!.values);
      // No part of the claimed position (txid or id, in any base) reaches the parameters.
      const claimed = unverifiedFeedCursorPosition(c)!;
      for (const part of [claimed.txid.toString(), claimed.id.toString()]) expect(values).not.toContain(part);
      seen.push(JSON.stringify(spy.statements));
    }
    expect(new Set(seen).size).toBe(1);
    // The claim is decoded from the fixed 34-byte buffer only: other lengths have no claim.
    for (const len of [33, 35]) expect(unverifiedFeedCursorPosition(randomBytes(len).toString("base64url"))).toBeUndefined();
  });
});

// ---- end to end: the reference Edge engine against the real resolver ---------

describe("end to end: Supabase Edge engine across a cursor-key rotation (N1)", () => {
  let db: Db;
  let before: FastifyInstance;
  let after: FastifyInstance;
  let beforeUrl: string;
  let afterUrl: string;
  let retention: FeedRetention;
  /** The projection (idr_* tables and functions) lives in the same database, called as service_role. */
  let projection: pg.Pool;
  let store: PgStore;
  const INSTALLATION = FEED_SCOPE.installationId;

  beforeAll(async () => {
    db = await createTestDb({ max: 6 });
    ({ app: before } = await buildFeedServer(db, { IP_HMAC_SECRET: OLD_SECRET }));
    ({ app: after } = await buildFeedServer(db));
    beforeUrl = await before.listen({ host: "127.0.0.1", port: 0 });
    afterUrl = await after.listen({ host: "127.0.0.1", port: 0 });
    retention = createFeedRetention(db.pool);
    projection = newPool();
    await ensureProjection(projection);
    store = new PgStore(projection, INSTALLATION);
  });
  beforeEach(async () => {
    await resetFeedDb(db);
    await truncateAll(projection);
  });
  afterAll(async () => {
    await resetFeedDb(db);
    await truncateAll(projection);
    await projection.end();
    await before.close();
    await after.close();
    await db.close();
  });

  const cfg = (baseUrl: string, over: Partial<SyncConfig> = {}): SyncConfig => ({
    baseUrl,
    token: FEED_REPORTING_TOKEN,
    installationId: INSTALLATION,
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
  const deps = (s: Store) => ({ fetch, store: s, now: () => Date.now(), sleep: async () => undefined, random: () => 0.5 });
  const projected = async () =>
    (await projection.query<{ id: string }>("select observation_id::text as id from public.idr_observations where installation_id = $1 order by observation_id", [INSTALLATION])).rows.map((r) => r.id);
  const syncState = async () =>
    (await projection.query<{ cursor: string | null; status: string; needs_resync: boolean }>("select cursor, status, needs_resync from public.idr_sync_state where installation_id = $1", [INSTALLATION])).rows[0];

  const now = Date.now();
  async function seed(): Promise<{ old: InsertedObservation[]; fresh: InsertedObservation[]; company: number }> {
    const company = await createCompany(db.pool, "engine.example");
    const old: InsertedObservation[] = [];
    const fresh: InsertedObservation[] = [];
    for (let i = 0; i < 4; i++) old.push(await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - 40 * DAY + i * 60_000) }));
    for (let i = 0; i < 2; i++) fresh.push(await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - i * 60_000) }));
    return { old, fresh, company };
  }

  it("retention pruned past a stalled consumer, then the key rotated: needs_resync AND an idr_sync_gaps row, not cursor_rejected; the row survives the resync", async () => {
    const { old, fresh } = await seed();
    // One page (obs 1, 2) from the pre-rotation resolver, then the consumer stalls.
    expect((await runSync(cfg(beforeUrl, { maxPages: 1 }), deps(store))).status).toBe("partial");
    expect(await projected()).toEqual([old[0]!.id, old[1]!.id]);
    const stalledAt = (await syncState())!.cursor;
    // Retention (30 days) prunes obs 1-4: obs 3 and 4 were never delivered.
    expect((await retention.pruneAllBefore(retentionCutoff(new Date(now), 30), { batch: 100 })).deleted).toBe(4);

    // The resolver's IP_HMAC_SECRET is rotated; the engine now talks to it.
    const resets: string[] = [];
    const watching: Store = {
      getState: () => store.getState(),
      applyPage: (a) => store.applyPage(a),
      recordStatus: (a) => store.recordStatus(a),
      localCounts: (a, b) => store.localCounts(a, b),
      resetCursor: (c) => {
        resets.push(c);
        return store.resetCursor(c);
      },
      recordGap: (k) => store.recordGap(k),
      resolveGaps: () => store.resolveGaps(),
    };
    const r = await runSync(cfg(afterUrl), deps(watching));
    expect(r.status).toBe("needs_resync");
    expect(r.gap).toEqual({ recorded: true, newGap: true, superseded: false });
    expect(resets).toEqual([]); // never reset, never cursor_rejected
    expect(await syncState()).toEqual({ cursor: stalledAt, status: "needs_resync", needs_resync: true });
    expect(await projected()).toEqual([old[0]!.id, old[1]!.id]);
    const gaps = await gapRows(projection);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ installation_id: INSTALLATION, kind: "cursor_expired", expired_cursor: stalledAt, resolved_at: null, resolution: null });

    // It stays that way (one row) until an operator resynchronises.
    expect((await runSync(cfg(afterUrl), deps(store))).gap).toEqual({ recorded: true, newGap: false, superseded: false });
    expect(await gapRows(projection)).toHaveLength(1);

    // Operator resync: the drained run marks the gap resolved; obs 3 and 4 stay missing; the row stays.
    await asRole(projection, "service_role", (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION]));
    const resynced = await runSync(cfg(afterUrl), deps(store));
    expect(resynced).toMatchObject({ status: "ok", gapsResolved: 1 });
    expect(await projected()).toEqual([old[0]!.id, old[1]!.id, ...fresh.map((f) => f.id)]);
    const [gap] = await gapRows(projection);
    expect(gap).toMatchObject({ kind: "cursor_expired", resolution: "full_resync" });
    expect(gap!.resolved_at).toBeInstanceOf(Date);
  });

  it("R2-5: 400-reset, the first cursorless fetch fails, retention then passes the old position: the next run re-presents the rejected cursor, gets 410 and records the gap", async () => {
    const company = await createCompany(db.pool, "reset-race.example");
    const ids: string[] = [];
    for (const d of [40, 35, 34]) ids.push((await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - d * DAY) })).id);
    for (let i = 0; i < 2; i++) ids.push((await insertObservation(db.pool, { companyId: company, observedAt: new Date(now - i * 60_000) })).id);
    expect((await runSync(cfg(beforeUrl, { maxPages: 1 }), deps(store))).status).toBe("partial"); // obs 1, 2
    const p = (await syncState())!.cursor;
    expect((await retention.pruneAllBefore(retentionCutoff(new Date(now), 38), { batch: 100 })).deleted).toBe(1); // obs 1: watermark < P

    let failed = false;
    const failFirstCursorless = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!failed && !new URL(String(url)).searchParams.has("after")) {
        failed = true;
        return new Response("", { status: 503 });
      }
      return fetch(url, init);
    }) as typeof fetch;
    const r1 = await runSync(cfg(afterUrl), { ...deps(store), fetch: failFirstCursorless }); // 400 -> reset -> replay start fails
    expect(r1.status).toBe("upstream_error");
    const reset = await projection.query<{ cursor: string | null; reset_from_cursor: string | null }>("select cursor, reset_from_cursor from public.idr_sync_state");
    expect(reset.rows[0]).toEqual({ cursor: null, reset_from_cursor: p });

    expect((await retention.pruneAllBefore(retentionCutoff(new Date(now), 33), { batch: 100 })).deleted).toBe(2); // obs 2, 3: past P
    const r2 = await runSync(cfg(afterUrl), deps(store));
    expect(r2).toMatchObject({ status: "needs_resync", gap: { recorded: true, newGap: true, superseded: false } });
    const gaps = await gapRows(projection);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "cursor_expired", expired_cursor: p, resolved_at: null });
    expect(await projected()).toEqual([ids[0], ids[1]]); // obs 3 never arrived, and that is on record
  });

  it("control: a rotation while the consumer is at or after the watermark still resets once and replays the retained buffer (cursor_rejected, no gap)", async () => {
    const { fresh, company } = await seed();
    expect((await runSync(cfg(beforeUrl), deps(store))).status).toBe("ok");
    expect((await retention.pruneAllBefore(retentionCutoff(new Date(now), 30), { batch: 100 })).deleted).toBe(4);
    const extra = await insertObservation(db.pool, { companyId: company });

    const r = await runSync(cfg(afterUrl), deps(store));
    expect(r.status).toBe("cursor_rejected");
    expect(r.gap).toBeNull();
    expect((await syncState())!.needs_resync).toBe(false);
    const ids = await projected();
    for (const f of [...fresh, extra]) expect(ids).toContain(f.id);
    expect(await gapRows(projection)).toHaveLength(0);
    expect((await runSync(cfg(afterUrl), deps(store))).status).toBe("ok");
  });
});
