/**
 * reporting-feed.v1 proof suite, part 2 (CHR-71): the HTTP surface of
 * GET /v1/reporting/observations: credential and rate-limit separation, the
 * response contract, leak scanning, pagination at limit boundaries
 * (including many rows in one transaction), cursor integrity, retries,
 * duplicate delivery and interruption recovery of an idempotent consumer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { decodeFeedCursor, deriveFeedCursorKey, encodeFeedCursor, FEED_ROUTE, registerReportingRoutes } from "../../src/api/reporting.js";
import { FEED_KIND_OBSERVATION, FEED_KIND_TOMBSTONE } from "../../src/contracts/reporting-feed.js";
import type { Db } from "../../src/db/index.js";
import { eraseCompany } from "../../src/db/erasure.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { createTestDb, testKey } from "../helpers/db.js";
import { TEST_AUTH_TOKEN, TEST_HMAC_SECRET, testConfig } from "../helpers/env.js";
import {
  buildFeedServer,
  createCompany,
  FEED_REPORTING_TOKEN,
  FEED_SCOPE,
  FeedConsumer,
  getFeed,
  insertObservation,
  obsIds,
  openWriter,
  OTHER_SCOPE,
  Projection,
  reportingAuth,
  resetFeedDb,
  websiteAuth,
} from "../helpers/feed.js";
import { FORBIDDEN_PROVIDER_FIELDS, findLeaks, ipVariants } from "../helpers/leak-scan.js";

const TEST_IP = "203.0.113.77";
const SCOPE_WIRE = { installation_id: "inst-test", website_id: "site-test" };

describe("reporting feed API", () => {
  let db: Db;
  let app: FastifyInstance;
  let logger: ReturnType<typeof createMemoryLogger>;

  beforeAll(async () => {
    db = await createTestDb({ max: 6 });
    ({ app, logger } = await buildFeedServer(db));
  });
  beforeEach(async () => {
    await resetFeedDb(db);
  });
  afterAll(async () => {
    await resetFeedDb(db);
    await app.close();
    await db.close();
  });

  /** A qualified cache row (fingerprint -> company), the way the resolver links them. */
  async function seedCachedCompany(label: string, domain: string): Promise<number> {
    const key = testKey(label, { installationId: FEED_SCOPE.installationId, websiteId: FEED_SCOPE.websiteId });
    const r = await db.cache.reserve(key, { leaseMs: 5_000 });
    if (r.kind !== "acquired") throw new Error("expected acquired");
    const c = await db.cache.commitResolved(key, r.token, { status: "qualified", company: { domain, organisationName: `${domain} Ltd`, qualificationCategory: "COM" }, checkedAt: new Date(), ttlMs: 60_000 });
    if (c.kind !== "committed" || c.companyId === null) throw new Error("expected committed");
    return c.companyId;
  }

  describe("credentials and isolation", () => {
    it("rejects the website token, a missing token and a malformed token on the feed with 401; accepts only the reporting token", async () => {
      for (const headers of [websiteAuth, {}, { authorization: "Bearer nope" }, { authorization: FEED_REPORTING_TOKEN }]) {
        const r = await getFeed(app, undefined, undefined, headers as Record<string, string>);
        expect(r.status).toBe(401);
        expect(r.body).toEqual({ version: "1", error: "unauthorized" });
      }
      expect((await getFeed(app)).status).toBe(200);
      // And the reporting token never opens the website route.
      const resolve = await app.inject({ method: "POST", url: "/v1/resolve", headers: { ...reportingAuth, "content-type": "application/json" }, payload: { website_id: "site-test", ip: TEST_IP } });
      expect(resolve.statusCode).toBe(401);
    });

    it("uses the separate reporting rate-limit bucket: exhausting it never limits the website route", async () => {
      const { app: small } = await buildFeedServer(db, { RATE_LIMIT_PER_MINUTE: "3" });
      try {
        for (let i = 0; i < 3; i++) expect((await getFeed(small)).status).toBe(200);
        const limited = await getFeed(small);
        expect(limited.status).toBe(429);
        expect(limited.body).toEqual({ version: "1", error: "rate_limited" });
        const website = await small.inject({ method: "POST", url: "/v1/resolve", headers: { ...websiteAuth, "content-type": "application/json" }, payload: { website_id: "site-test", ip: TEST_IP } });
        expect(website.statusCode).not.toBe(429);
      } finally {
        await small.close();
      }
    });

    it("fails closed without a cursor key: the route does not exist", async () => {
      const config = testConfig({ REPORTING_AUTH_TOKEN: FEED_REPORTING_TOKEN });
      const bare = await buildServer({ config, logger: createMemoryLogger(), childManager: { activeCount: () => 0, capacity: () => 1, run: async () => ({ status: "unavailable", company: null, source: "none" }), shutdown: async () => {} }, ping: () => db.ping() });
      registerReportingRoutes(bare, { scope: SCOPE_WIRE, reporting: db.reporting, logger: createMemoryLogger(), sendError: (reply, error) => reply.code(error === "unauthorized" ? 401 : 400).send({ version: "1", error }) });
      await bare.ready();
      try {
        const r = await bare.inject({ method: "GET", url: FEED_ROUTE, headers: reportingAuth });
        expect([400, 401]).toContain(r.statusCode);
        expect(r.body).not.toContain("items");
      } finally {
        await bare.close();
      }
      expect(() => registerReportingRoutes(app, { scope: SCOPE_WIRE, reporting: db.reporting, logger, sendError: (reply) => reply, feed: { cursorKey: Buffer.alloc(8) } })).toThrow(/cursor key/);
    });

    it("serves only the configured scope", async () => {
      const company = await createCompany(db.pool, "scoped.example");
      const mine = await insertObservation(db.pool, { companyId: company });
      await insertObservation(db.pool, { companyId: company, scope: OTHER_SCOPE });
      const r = await getFeed(app);
      expect(obsIds(r.body.items)).toEqual([mine.id]);
    });
  });

  describe("response contract", () => {
    it("returns the frozen shape: decimal-string ids, nullable entrance context for older rows, tombstones, opaque cursor", async () => {
      const company = await createCompany(db.pool, "shape.example", "Shape Ltd");
      const at = new Date("2026-11-03T12:00:00.000Z");
      const entrance = await insertObservation(db.pool, { companyId: company, observedAt: at, source: "cache", pageKey: "/pricing", acquisition: "search" });
      // An observation recorded through the inherited V0.1 path has no entrance context.
      const legacy = await db.activity.recordObservation({ scope: FEED_SCOPE, companyId: company, observationRef: "legacy-ref-0000000001", source: "provider", observedAt: at });
      if (legacy.kind !== "recorded") throw new Error("expected recorded");
      const gone = await createCompany(db.pool, "gone.example");
      await insertObservation(db.pool, { companyId: gone });
      const erased = await eraseCompany(db.pool, { companyId: gone });
      expect(erased).toMatchObject({ erased: true, tombstones: 1 });

      const r = await getFeed(app);
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["contract", "has_more", "items", "next_cursor", "scope", "version"]);
      expect(r.body).toMatchObject({ version: "1", contract: "reporting-feed.v1", scope: SCOPE_WIRE, has_more: false });
      expect(r.body.next_cursor).toMatch(/^[A-Za-z0-9_-]{46}$/);
      expect(r.body.items).toEqual([
        { type: "observation", observation_id: entrance.id, company_id: company, domain: "shape.example", organisation_name: "Shape Ltd", observed_at: at.toISOString(), method: "cache", page_key: "/pricing", acquisition: "search", entrance_contract: "entrance.v1" },
        { type: "observation", observation_id: String(legacy.observationId), company_id: company, domain: "shape.example", organisation_name: "Shape Ltd", observed_at: at.toISOString(), method: "provider", page_key: null, acquisition: null, entrance_contract: null },
        { type: "company_erased", tombstone_id: "1", company_id: gone, erased_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) },
      ]);
      // An empty feed still returns a cursor (the start position), stable across calls.
      await resetFeedDb(db);
      const empty1 = await getFeed(app);
      const empty2 = await getFeed(app);
      expect(empty1.body).toMatchObject({ items: [], has_more: false });
      expect(empty1.body.next_cursor).toBe(empty2.body.next_cursor);
      expect((await getFeed(app, empty1.body.next_cursor)).body.next_cursor).toBe(empty1.body.next_cursor);
    });

    it("leak scan: feed responses and logs carry no IP, fingerprint, provider field, observation reference, eligibility or credential", async () => {
      const company = await seedCachedCompany("leak", "leak.example");
      const fp = (await db.pool.query<{ fp: string }>("SELECT encode(ip_fingerprint, 'hex') AS fp FROM ip_resolution_cache")).rows[0]!.fp;
      const ref = "leakref-000000000000001";
      await insertObservation(db.pool, { companyId: company, ref });
      await db.activity.recordObservation({ scope: FEED_SCOPE, companyId: company, observationRef: "leakref-000000000000002", source: "provider", observedAt: new Date() });
      const other = await seedCachedCompany("leak-2", "erased-leak.example");
      await insertObservation(db.pool, { companyId: other });
      await eraseCompany(db.pool, { domain: "erased-leak.example" });
      const logStart = logger.entries.length;
      const first = await getFeed(app, undefined, 2);
      const second = await getFeed(app, first.body.next_cursor, 2);
      const bodies = [first.raw, second.raw, (await getFeed(app, "x".repeat(46))).raw].join("\n");
      const haystack = bodies + "\n" + JSON.stringify(logger.entries.slice(logStart));
      const needles = [fp, fp.slice(0, 16), Buffer.from(fp, "hex").toString("base64"), ...ipVariants(TEST_IP), "ip_fingerprint", ...FORBIDDEN_PROVIDER_FIELDS, "usageType", ref, "leakref-000000000000002", "observation_ref", "tsa-1", "eligibility", "txid", FEED_REPORTING_TOKEN, TEST_AUTH_TOKEN, TEST_HMAC_SECRET, "erased-leak.example"];
      expect(findLeaks(haystack, needles)).toEqual([]);
      const keys = new Set<string>();
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
      };
      for (const b of [first.raw, second.raw]) walk(JSON.parse(b));
      expect([...keys].sort()).toEqual([
        "acquisition",
        "company_id",
        "contract",
        "domain",
        "entrance_contract",
        "erased_at",
        "has_more",
        "installation_id",
        "items",
        "method",
        "next_cursor",
        "observation_id",
        "observed_at",
        "organisation_name",
        "page_key",
        "scope",
        "tombstone_id",
        "type",
        "version",
        "website_id",
      ]);
    });
  });

  describe("P4 pagination", () => {
    it("P4 limit boundaries with several rows in one transaction (same txid): every page boundary, no gap, no duplicate, has_more exact", async () => {
      const company = await createCompany(db.pool, "page.example");
      const w = await openWriter();
      try {
        const single = await insertObservation(db.pool, { companyId: company });
        await w.query("BEGIN");
        const batch: string[] = [];
        for (let i = 0; i < 7; i++) batch.push((await insertObservation(w, { companyId: company })).id);
        await w.query("COMMIT");
        const tail = await createCompany(db.pool, "tail.example");
        await insertObservation(db.pool, { companyId: tail });
        await eraseCompany(db.pool, { companyId: tail }); // a tombstone at the end of the stream
        const after = await insertObservation(db.pool, { companyId: company });
        const all = (await getFeed(app, undefined, 500)).body.items;
        expect(obsIds(all)).toEqual([single.id, ...batch, after.id]);
        expect(all.map((i) => i.type)).toEqual([...Array(8).fill("observation"), "company_erased", "observation"]);
        for (const limit of [1, 2, 3, 4, 7, 8, 10, 11, 12]) {
          const seen: unknown[] = [];
          let cursor: string | undefined;
          let pages = 0;
          for (;;) {
            const r = await getFeed(app, cursor, limit);
            expect(r.status).toBe(200);
            expect(r.body.items.length).toBeLessThanOrEqual(limit);
            seen.push(...r.body.items);
            pages += 1;
            cursor = r.body.next_cursor;
            if (!r.body.has_more) break;
            expect(r.body.items.length, `limit ${limit}: has_more on a short page`).toBe(limit);
          }
          expect(seen, `limit ${limit}`).toEqual(all);
          expect(pages, `limit ${limit}`).toBe(Math.max(1, Math.ceil(all.length / limit)));
          // At the end the cursor is stable and returns nothing new.
          const again = await getFeed(app, cursor, limit);
          expect(again.body).toMatchObject({ items: [], has_more: false, next_cursor: cursor });
        }
      } finally {
        await w.end();
      }
    });

    it("P4 default and maximum limits: 200 by default, 500 at most, out-of-range and malformed limits rejected", async () => {
      const company = await createCompany(db.pool, "bulk.example");
      await db.pool.query(
        `INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source)
         SELECT 'inst-test', 'site-test', $1, now(), 'bulk-' || lpad(g::text, 16, '0'), 'cache' FROM generate_series(1, 501) g`,
        [company],
      );
      const d = await getFeed(app);
      expect(d.body.items).toHaveLength(200);
      expect(d.body.has_more).toBe(true);
      const max = await getFeed(app, undefined, 500);
      expect(max.body.items).toHaveLength(500);
      expect(max.body.has_more).toBe(true);
      const rest = await getFeed(app, max.body.next_cursor, 500);
      expect(rest.body.items).toHaveLength(1);
      expect(rest.body.has_more).toBe(false);
      for (const q of ["limit=0", "limit=501", "limit=-1", "limit=abc", "limit=1.5", "limit=", "cursor=abc", "after=", "foo=1", "limit=1&limit=2"]) {
        const r = await app.inject({ method: "GET", url: `${FEED_ROUTE}?${q}`, headers: reportingAuth });
        expect(r.statusCode, q).toBe(400);
        expect(r.json(), q).toEqual({ version: "1", error: "invalid_request" });
      }
    });

    it("P4 tampered, foreign and garbage cursors are rejected with 400 and never move the consumer", async () => {
      const company = await createCompany(db.pool, "tamper.example");
      for (let i = 0; i < 3; i++) await insertObservation(db.pool, { companyId: company });
      const good = (await getFeed(app, undefined, 1)).body.next_cursor;
      expect((await getFeed(app, good, 1)).status).toBe(200);
      const bytes = Buffer.from(good, "base64url");
      const variants: string[] = [];
      // Flip every bit of every byte (payload: version, txid, kind, id; and the tag).
      for (let i = 0; i < bytes.length; i++) {
        for (let bit = 0; bit < 8; bit++) {
          const b = Buffer.from(bytes);
          b[i]! ^= 1 << bit;
          variants.push(b.toString("base64url"));
        }
      }
      const key = deriveFeedCursorKey(TEST_HMAC_SECRET);
      const pos = decodeFeedCursor(good, key, SCOPE_WIRE)!;
      expect(pos.kind).toBe(FEED_KIND_OBSERVATION);
      variants.push(
        encodeFeedCursor({ ...pos, id: pos.id + 1n }, deriveFeedCursorKey("another-secret-0123456789abcdef0123456789abcdef"), SCOPE_WIRE), // other key
        encodeFeedCursor(pos, key, { installation_id: "inst-test", website_id: "other-site" }), // other scope
        encodeFeedCursor({ ...pos, kind: FEED_KIND_TOMBSTONE }, key, SCOPE_WIRE).slice(0, 30) + good.slice(30), // spliced tag
        good.slice(0, -1),
        good + "A",
        good.slice(0, -1) + (good.endsWith("A") ? "B" : "A"),
        "A".repeat(46),
        "x".repeat(46),
        Buffer.from(JSON.stringify({ t: 1, o: 1 })).toString("base64url"),
        "not base64url!",
        "%00",
        "A".repeat(129),
      );
      // Non-canonical base64url of the same bytes (stray low bits in the last character).
      const last = good[good.length - 1]!;
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const idx = alphabet.indexOf(last);
      variants.push(good.slice(0, -1) + alphabet[(idx & ~0b1111) | ((idx + 1) & 0b1111)]!);
      let rejected = 0;
      for (const v of variants) {
        if (v === good) continue;
        const r = await app.inject({ method: "GET", url: `${FEED_ROUTE}?after=${encodeURIComponent(v)}`, headers: reportingAuth });
        expect(r.statusCode, v).toBe(400);
        expect(r.json()).toEqual({ version: "1", error: "invalid_request" });
        rejected += 1;
      }
      expect(rejected).toBeGreaterThan(280);
      expect(decodeFeedCursor(good, key, SCOPE_WIRE)).toEqual(pos);
    });
  });

  describe("P2 retries, P3 duplicate delivery, P6 interruption recovery", () => {
    it("P2 retries: re-requesting the same cursor returns identical items, plus possibly more at the end", async () => {
      const company = await createCompany(db.pool, "retry.example");
      for (let i = 0; i < 5; i++) await insertObservation(db.pool, { companyId: company });
      const p1 = await getFeed(app, undefined, 2);
      const c1 = p1.body.next_cursor;
      const a = await getFeed(app, c1, 10);
      const b = await getFeed(app, c1, 10);
      expect(b.raw).toBe(a.raw); // byte-identical, including next_cursor
      expect((await getFeed(app, undefined, 2)).raw).toBe(p1.raw);
      const more = [await insertObservation(db.pool, { companyId: company }), await insertObservation(db.pool, { companyId: company })];
      const c = await getFeed(app, c1, 10);
      expect(c.body.items.slice(0, a.body.items.length)).toEqual(a.body.items);
      expect(obsIds(c.body.items.slice(a.body.items.length))).toEqual(more.map((m) => m.id));
      // A retry with a smaller limit is a prefix of the larger one.
      const small = await getFeed(app, c1, 1);
      expect(small.body.items).toEqual(c.body.items.slice(0, 1));
    });

    it("P3 duplicate delivery: applying a page twice, re-applying old pages and replaying from the start all give the identical projection", async () => {
      const a = await createCompany(db.pool, "dup-a.example");
      const b = await createCompany(db.pool, "dup-b.example");
      for (let i = 0; i < 4; i++) await insertObservation(db.pool, { companyId: i % 2 ? a : b });
      const reference = new FeedConsumer(app, 2);
      await reference.drain();

      const dup = new Projection();
      const pages: Awaited<ReturnType<typeof getFeed>>[] = [];
      let cursor: string | undefined;
      for (;;) {
        const r = await getFeed(app, cursor, 2);
        pages.push(r);
        dup.apply(r.body.items);
        dup.apply(r.body.items); // the same page delivered twice
        cursor = r.body.next_cursor;
        if (!r.body.has_more) break;
      }
      for (const p of pages) dup.apply(p.body.items); // every page again, in order
      expect(dup.canonical()).toBe(reference.projection.canonical());

      // Erase one company, then replay EVERYTHING old (stale pages included) after the tombstone.
      await eraseCompany(db.pool, { companyId: a });
      await reference.drain((c) => c.projection.erased.has(a));
      const tail = await getFeed(app, cursor, 50);
      dup.apply(tail.body.items);
      for (const p of pages) dup.apply(p.body.items); // stale observations of the erased company must not resurrect it
      expect(dup.canonical()).toBe(reference.projection.canonical());
      expect([...dup.observations.values()].every((o) => o.company_id === b)).toBe(true);

      const replay = new FeedConsumer(app, 3);
      await replay.drain();
      expect(replay.projection.canonical()).toBe(reference.projection.canonical());
    });

    it("P6 interruption recovery: crashes after fetch (before apply) and after apply (before saving the cursor) resume to the same final projection", async () => {
      const a = await createCompany(db.pool, "crash-a.example");
      const b = await createCompany(db.pool, "crash-b.example");
      let companies = [a, b, b];
      const write = async (n: number) => {
        for (let i = 0; i < n; i++) await insertObservation(db.pool, { companyId: companies[i % 3]! });
      };
      await write(5);
      const crashing = new FeedConsumer(app, 2);
      const crashes: Array<"after_fetch" | "after_apply"> = [];
      // Deterministic crash schedule interleaved with new writes and an erasure.
      const schedule: Array<"none" | "after_fetch" | "after_apply"> = ["none", "after_fetch", "none", "after_apply", "after_apply", "none", "after_fetch", "after_apply", "none", "none", "none", "none", "none", "none"];
      for (let i = 0; i < schedule.length; i++) {
        const mode = schedule[i]!;
        const savedCursor = crashing.cursor;
        const savedProjection = crashing.projection.canonical();
        await crashing.step(mode);
        if (mode === "after_fetch") {
          // Nothing durable changed: neither projection nor cursor.
          expect(crashing.cursor).toBe(savedCursor);
          expect(crashing.projection.canonical()).toBe(savedProjection);
          crashes.push(mode);
        } else if (mode === "after_apply") {
          expect(crashing.cursor).toBe(savedCursor); // the page will be fetched and applied again
          crashes.push(mode);
        }
        if (i === 2) await write(3);
        if (i === 5) {
          await eraseCompany(db.pool, { companyId: a });
          companies = [b, await createCompany(db.pool, "crash-c.example"), b];
        }
        if (i === 7) await write(2);
      }
      await crashing.drain();
      const reference = new FeedConsumer(app, 2);
      await reference.drain();
      expect(crashes).toEqual(["after_fetch", "after_apply", "after_apply", "after_fetch", "after_apply"]);
      expect(crashing.projection.canonical()).toBe(reference.projection.canonical());
      // Crashes after apply produced real duplicate deliveries, absorbed idempotently.
      expect(crashing.delivered.length).toBeGreaterThan(reference.delivered.length);
      expect(crashing.projection.erased.has(a)).toBe(true);
      expect([...crashing.projection.observations.values()].some((o) => o.company_id === a)).toBe(false);
    });
  });
});
