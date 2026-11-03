/**
 * reporting-feed.v1 proof suite, part 3 (CHR-71): company erasure and its
 * `company_erased` tombstone. Erasure is atomic, leaves nothing identifying
 * behind, reaches a consumer after every observation of the company that the
 * consumer can have been served (including rows committed concurrently with
 * the erasure), and re-observation after erasure behaves as documented: a new
 * company id that the tombstone never touches, in either stream order.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import type { FeedItemWire } from "../../src/contracts/reporting-feed.js";
import type { Db } from "../../src/db/index.js";
import { eraseCompany } from "../../src/db/erasure.js";
import { parseEraseArgs } from "../../src/ops/erase-company.js";
import { createTestDb, getTestDatabaseUrl, testKey } from "../helpers/db.js";
import { buildFeedServer, createCompany, FEED_SCOPE, FeedConsumer, getFeed, insertObservation, obsIds, openWriter, OTHER_SCOPE, resetFeedDb, waitForLockWaiter } from "../helpers/feed.js";
import { dumpDatabaseText, findLeaks } from "../helpers/leak-scan.js";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** Index of the tombstone for `companyId`, and whether any observation of it is delivered after that. */
function tombstoneOrder(items: FeedItemWire[], companyId: number): { tombstoneAt: number; observationsAfter: number; observationsBefore: number } {
  const tombstoneAt = items.findIndex((i) => i.type === "company_erased" && i.company_id === companyId);
  let before = 0;
  let after = 0;
  items.forEach((i, idx) => {
    if (i.type === "observation" && i.company_id === companyId) {
      if (tombstoneAt === -1 || idx < tombstoneAt) before += 1;
      else after += 1;
    }
  });
  return { tombstoneAt, observationsAfter: after, observationsBefore: before };
}

describe("reporting feed: company erasure and tombstones", () => {
  let db: Db;
  let app: FastifyInstance;
  const clients: pg.Client[] = [];

  beforeAll(async () => {
    db = await createTestDb({ max: 8 });
    ({ app } = await buildFeedServer(db));
    for (let i = 0; i < 3; i++) clients.push(await openWriter());
  });
  beforeEach(async () => {
    for (const c of clients) await c.query("ROLLBACK").catch(() => undefined);
    await resetFeedDb(db);
  });
  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    await resetFeedDb(db);
    await app.close();
    await db.close();
  });

  /** Resolve a domain the way the resolver does: fenced cache commit creating or reusing the company row. */
  async function resolveDomain(label: string, domain: string): Promise<number> {
    const key = testKey(label, { installationId: FEED_SCOPE.installationId, websiteId: FEED_SCOPE.websiteId });
    const r = await db.cache.reserve(key, { leaseMs: 5_000 });
    if (r.kind !== "acquired") throw new Error(`expected acquired, got ${r.kind}`);
    const c = await db.cache.commitResolved(key, r.token, { status: "qualified", company: { domain, organisationName: `Organisation ${label}`, qualificationCategory: "COM" }, checkedAt: new Date(), ttlMs: 60_000 });
    if (c.kind !== "committed" || c.companyId === null) throw new Error("expected committed");
    return c.companyId;
  }

  it("P5 tombstone: an erasure after consumption reaches the consumer after the company's observations and the projection drops the company", async () => {
    const x = await resolveDomain("x", "erase-me.example");
    const y = await resolveDomain("y", "keep-me.example");
    const xFp = (await db.pool.query<{ fp: string }>("SELECT encode(ip_fingerprint, 'hex') AS fp FROM ip_resolution_cache WHERE company_id = $1", [x])).rows[0]!.fp;
    for (let i = 0; i < 3; i++) await db.activity.recordObservation({ scope: FEED_SCOPE, companyId: x, observationRef: `erase-ref-${i}-000000000`, source: "cache", observedAt: new Date() });
    await insertObservation(db.pool, { companyId: x, pageKey: "/x-entrance" });
    await insertObservation(db.pool, { companyId: x, scope: OTHER_SCOPE });
    const yObs = await insertObservation(db.pool, { companyId: y });

    const consumer = new FeedConsumer(app, 2);
    await consumer.drain((c) => c.projection.observations.has(yObs.id));
    expect([...consumer.projection.observations.values()].filter((o) => o.company_id === x)).toHaveLength(4);

    const r = await eraseCompany(db.pool, { domain: "Erase-Me.Example." });
    expect(r).toEqual({ erased: true, companyId: x, tombstones: 2, observations: 5, refs: 3, stats: 1, cacheRows: 1 });

    await consumer.drain((c) => c.projection.erased.has(x));
    const order = tombstoneOrder(consumer.delivered, x);
    expect(order).toEqual({ tombstoneAt: consumer.delivered.length - 1, observationsBefore: 4, observationsAfter: 0 });
    expect([...consumer.projection.observations.values()].map((o) => o.company_id)).toEqual([y]);

    // Replay from the start: the erased observations are gone, the tombstone remains, same projection.
    const replay = new FeedConsumer(app, 50);
    await replay.drain();
    expect(replay.delivered.filter((i) => i.type === "observation" && i.company_id === x)).toEqual([]);
    expect(replay.delivered.filter((i) => i.type === "company_erased").map((i) => i.company_id)).toEqual([x]);
    expect(replay.projection.canonical()).toBe(consumer.projection.canonical());

    // The other scope's feed carries its own tombstone.
    const other = await db.reporting.feed(OTHER_SCOPE, { after: null, limit: 10 });
    expect(other.items.map((i) => [i.type, i.companyId])).toEqual([["company_erased", x]]);

    // Nothing identifying remains anywhere in the database, and erasure is not retention.
    const dump = await dumpDatabaseText(db.pool);
    expect(dump).toContain("Organisation y"); // the scan does see company data that should remain
    expect(findLeaks(dump, ["erase-me.example", "Organisation x", xFp, "/x-entrance", "erase-ref-0"])).toEqual([]);
    for (const t of ["companies", "company_observations", "company_observation_refs", "company_scope_stats", "ip_resolution_cache"]) {
      const n = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t} WHERE ${t === "companies" ? "id" : "company_id"} = $1`, [x]);
      expect(n.rows[0]!.n, t).toBe("0");
    }
    expect((await db.pool.query("SELECT 1 FROM feed_retention_watermarks")).rowCount).toBe(0);
    // y untouched.
    expect((await db.pool.query("SELECT 1 FROM ip_resolution_cache WHERE company_id = $1", [y])).rowCount).toBe(1);
  });

  it("P5 erasure racing an in-flight observation writer: a row committed before the erasure takes its lock may be served, but always before the tombstone, then dropped", async () => {
    const [w, l] = clients as [pg.Client, pg.Client];
    const x = await createCompany(db.pool, "race.example");
    const old = await insertObservation(db.pool, { companyId: x });
    const consumer = new FeedConsumer(app, 10);
    await consumer.drain((c) => c.projection.observations.has(old.id));

    // W: the observation writer's protocol (lock the company row, insert).
    await w.query("BEGIN");
    await w.query("SELECT id FROM companies WHERE id = $1 FOR UPDATE", [x]);
    const wRow = await insertObservation(w, { companyId: x, pageKey: "/racing" });
    // L: holds a row lock the erasure's DELETE will need, taken after W got its xid.
    await l.query("BEGIN");
    await l.query("SELECT id FROM company_observations WHERE id = $1 FOR UPDATE", [old.id]);
    const erasure = eraseCompany(db.pool, { companyId: x });
    await waitForLockWaiter(db.pool, "SELECT id FROM companies WHERE id"); // the erasure waits for W's company lock
    await w.query("COMMIT");
    await waitForLockWaiter(db.pool, "DELETE FROM company_observations"); // lock taken, tombstone written, DELETE waits for L

    // W's row (txid below every still-open transaction) is served now, before any tombstone.
    await consumer.drain((c) => c.projection.observations.has(wRow.id));
    expect(consumer.delivered.some((i) => i.type === "company_erased")).toBe(false);
    await l.query("COMMIT");
    expect(await erasure).toMatchObject({ erased: true, companyId: x, observations: 2, tombstones: 1 });
    await consumer.drain((c) => c.projection.erased.has(x));
    expect(tombstoneOrder(consumer.delivered, x)).toMatchObject({ observationsBefore: 2, observationsAfter: 0 });
    expect(consumer.projection.observations.size).toBe(0);
  });

  it("P5 erasure holding the lock first: a concurrent observation write for the company is rejected, never recorded", async () => {
    const [l] = clients as [pg.Client];
    const x = await createCompany(db.pool, "first.example");
    const old = await insertObservation(db.pool, { companyId: x });
    await l.query("BEGIN");
    await l.query("SELECT id FROM company_observations WHERE id = $1 FOR UPDATE", [old.id]);
    const erasure = eraseCompany(db.pool, { companyId: x });
    await waitForLockWaiter(db.pool, "DELETE FROM company_observations"); // erasure holds the company lock and waits on L
    const write = db.activity.recordObservation({ scope: FEED_SCOPE, companyId: x, observationRef: "late-writer-0000000001", source: "cache", observedAt: new Date() });
    write.catch(() => undefined); // asserted below
    await waitForLockWaiter(db.pool, "SELECT id FROM companies WHERE id"); // the writer waits for the erasure's company lock
    await l.query("COMMIT");
    expect(await erasure).toMatchObject({ erased: true });
    await expect(write).rejects.toMatchObject({ name: "DbError", code: "NO_COMPANY" });
    const consumer = new FeedConsumer(app, 10);
    await consumer.drain((c) => c.projection.erased.has(x));
    expect(consumer.delivered.map((i) => i.type)).toEqual(["company_erased"]);
  });

  it("P5 re-observation after erasure: the domain gets a NEW company id whose observations follow the tombstone and survive it", async () => {
    const x = await resolveDomain("re-1", "again.example");
    const first = await db.activity.recordObservation({ scope: FEED_SCOPE, companyId: x, observationRef: "again-ref-000000000001", source: "provider", observedAt: new Date() });
    const consumer = new FeedConsumer(app, 3);
    await consumer.drain((c) => c.projection.observations.size === 1);
    await eraseCompany(db.pool, { domain: "again.example" });
    // The same visitor address comes back: the cache row was erased, so this is a fresh resolution.
    const x2 = await resolveDomain("re-1", "again.example");
    expect(x2).not.toBe(x);
    expect(x2).toBeGreaterThan(x); // ids are never reused
    const again = await db.activity.recordObservation({ scope: FEED_SCOPE, companyId: x2, observationRef: "again-ref-000000000002", source: "provider", observedAt: new Date() });
    if (first.kind !== "recorded" || again.kind !== "recorded") throw new Error("expected recorded");
    // Not "previously seen": the erased history no longer exists.
    expect(again.previouslySeen).toBe(false);
    await consumer.drain((c) => c.projection.observations.has(String(again.observationId)));
    expect(consumer.delivered.map((i) => [i.type, i.company_id])).toEqual([
      ["observation", x],
      ["company_erased", x],
      ["observation", x2],
    ]);
    expect([...consumer.projection.observations.values()].map((o) => [o.company_id, o.domain])).toEqual([[x2, "again.example"]]);
  });

  it("P5 re-observation ordered BEFORE the tombstone (writer took its txid before the erasure): the tombstone still removes only the erased id", async () => {
    const [re] = clients as [pg.Client];
    const x = await createCompany(db.pool, "early.example");
    const old = await insertObservation(db.pool, { companyId: x });
    const consumer = new FeedConsumer(app, 10);
    await consumer.drain((c) => c.projection.observations.has(old.id));
    // A writer that obtained its transaction id before the erasure started...
    await re.query("BEGIN");
    const reXid = (await re.query<{ x: string }>("SELECT pg_current_xact_id()::text AS x")).rows[0]!.x;
    const erased = await eraseCompany(db.pool, { companyId: x });
    expect(erased.erased).toBe(true);
    // ...then creates the company again (new id) and records an observation.
    const x2 = await createCompany(re, "early.example");
    const reRow = await insertObservation(re, { companyId: x2 });
    expect(reRow.txid).toBe(reXid);
    const tomb = await db.pool.query<{ txid: string }>("SELECT txid::text AS txid FROM feed_tombstones WHERE company_id = $1", [x]);
    expect(BigInt(reRow.txid)).toBeLessThan(BigInt(tomb.rows[0]!.txid));
    await consumer.step();
    expect(consumer.delivered.map((i) => i.type)).toEqual(["observation"]); // tombstone held back by the open writer
    await re.query("COMMIT");
    await consumer.drain((c) => c.projection.erased.has(x));
    expect(consumer.delivered.map((i) => [i.type, i.company_id])).toEqual([
      ["observation", x],
      ["observation", x2],
      ["company_erased", x],
    ]);
    expect([...consumer.projection.observations.keys()]).toEqual([reRow.id]);
  });

  it("erasure of an unknown company changes nothing; invalid targets are refused", async () => {
    await createCompany(db.pool, "stays.example");
    expect(await eraseCompany(db.pool, { domain: "absent.example" })).toEqual({ erased: false, companyId: null, tombstones: 0, observations: 0, refs: 0, stats: 0, cacheRows: 0 });
    expect(await eraseCompany(db.pool, { companyId: 999_999 })).toMatchObject({ erased: false });
    expect((await db.pool.query("SELECT 1 FROM feed_tombstones")).rowCount).toBe(0);
    for (const bad of [{ domain: "" }, { domain: "no spaces.example" }, { domain: "x".repeat(300) }, { domain: "'; DROP TABLE companies; --" }, { companyId: 0 }, { companyId: -1 }, { companyId: 1.5 }]) {
      await expect(eraseCompany(db.pool, bad as never)).rejects.toMatchObject({ name: "DbError" });
    }
    expect((await db.pool.query("SELECT 1 FROM companies")).rowCount).toBe(1);
  });

  it("ops:erase-company parses exactly one target and prints counts but never the domain", async () => {
    expect(parseEraseArgs(["--domain", "a.example"])).toEqual({ domain: "a.example" });
    expect(parseEraseArgs(["--company-id", "42"])).toEqual({ companyId: 42 });
    for (const bad of [[], ["--domain"], ["--domain", "a.example", "--company-id", "1"], ["--company-id", "0"], ["--company-id", "abc"], ["--domain", "--company-id"], ["--name", "a.example"]]) {
      expect(() => parseEraseArgs(bad), bad.join(" ")).toThrow();
    }
    const x = await resolveDomain("cli", "cli-erase.example");
    await insertObservation(db.pool, { companyId: x });
    const tsx = resolve(ROOT, "..", "..", "node_modules", ".bin", "tsx");
    const run = spawnSync(tsx, ["src/ops/erase-company.ts", "--domain", "cli-erase.example"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env["PATH"] ?? "", DATABASE_URL: getTestDatabaseUrl(), DATABASE_SSL: "disable", INSTALLATION_ID: "inst-test", WEBSITE_ID: "site-test" },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ erased: true, company_id: x, tombstones: 1, observations_deleted: 1, refs_deleted: 0, stats_deleted: 0, cache_rows_deleted: 1 });
    expect(run.stdout + run.stderr).not.toContain("cli-erase.example");
    const items = (await getFeed(app)).body.items;
    expect(items).toEqual([{ type: "company_erased", tombstone_id: "1", company_id: x, erased_at: expect.any(String) }]);
    expect(obsIds(items)).toEqual([]);
  });
});
