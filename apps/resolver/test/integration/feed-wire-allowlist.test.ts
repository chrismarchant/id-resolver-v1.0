/**
 * reporting-feed.v1 wire allowlist on the real HTTP surface (docs/GUARDRAILS.md
 * G6): every envelope, scope, observation item and tombstone item the feed
 * serves has exactly the keys of the explicit allowlist in
 * test/helpers/feed-wire.ts, for entrance-path rows (all context set), rows of
 * the inherited path (context null), cache-linked companies (an IP cache row
 * exists for them) and erased companies, across pages; and so does the 410.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/index.js";
import { eraseCompany } from "../../src/db/erasure.js";
import { createTestDb, testKey } from "../helpers/db.js";
import { buildFeedServer, createCompany, FEED_SCOPE, getFeed, insertObservation, resetFeedDb } from "../helpers/feed.js";
import { feedWireViolations } from "../helpers/feed-wire.js";

describe("reporting feed wire allowlist (G6)", () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDb({ max: 4 });
    ({ app } = await buildFeedServer(db));
  });
  beforeEach(async () => {
    await resetFeedDb(db);
  });
  afterAll(async () => {
    await resetFeedDb(db);
    await app.close();
    await db.close();
  });

  it("every page served, item by item, carries exactly the allowlisted keys", async () => {
    // A company linked from the IP cache, the way the resolver records a resolution.
    const key = testKey("wire", { installationId: FEED_SCOPE.installationId, websiteId: FEED_SCOPE.websiteId });
    const r = await db.cache.reserve(key, { leaseMs: 5_000 });
    if (r.kind !== "acquired") throw new Error("expected acquired");
    const c = await db.cache.commitResolved(key, r.token, { status: "qualified", company: { domain: "wire.example", organisationName: "Wire Ltd", qualificationCategory: "COM" }, checkedAt: new Date(), ttlMs: 60_000 });
    if (c.kind !== "committed" || c.companyId === null) throw new Error("expected committed");
    await insertObservation(db.pool, { companyId: c.companyId });
    await insertObservation(db.pool, { companyId: c.companyId, pageKey: null, acquisition: null });
    const legacy = await db.activity.recordObservation({ scope: FEED_SCOPE, companyId: c.companyId, observationRef: "wire-legacy-0000000001", source: "provider", observedAt: new Date() });
    expect(legacy.kind).toBe("recorded");
    const nameless = await createCompany(db.pool, "nameless.example", null);
    await insertObservation(db.pool, { companyId: nameless });
    const gone = await createCompany(db.pool, "gone-wire.example");
    await insertObservation(db.pool, { companyId: gone });
    await eraseCompany(db.pool, { companyId: gone });

    const seen = { observation: 0, company_erased: 0, pages: 0 };
    let cursor: string | undefined;
    for (;;) {
      const res = await getFeed(app, cursor, 2);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.raw) as { items: Array<{ type: string }>; next_cursor: string; has_more: boolean };
      expect(feedWireViolations(body)).toEqual([]);
      for (const i of body.items) seen[i.type as "observation" | "company_erased"]++;
      seen.pages++;
      cursor = body.next_cursor;
      if (!body.has_more) break;
    }
    expect(seen).toMatchObject({ observation: 4, company_erased: 1 });
    expect(seen.pages).toBeGreaterThan(1);
  });

  it("the 410 cursor_expired body carries exactly version and error", async () => {
    // A well-formed cursor whose tag does not verify, claiming a position before a retention watermark.
    const company = await createCompany(db.pool, "expired-wire.example");
    await insertObservation(db.pool, { companyId: company });
    const first = await getFeed(app);
    await insertObservation(db.pool, { companyId: company });
    await insertObservation(db.pool, { companyId: company });
    // Retention prunes everything (advancing the watermark past the first cursor's position).
    await db.pool.query("DELETE FROM company_observations WHERE installation_id = $1 AND website_id = $2", [FEED_SCOPE.installationId, FEED_SCOPE.websiteId]);
    const res = await getFeed(app, first.body.next_cursor);
    expect(res.status).toBe(410);
    expect(feedWireViolations(JSON.parse(res.raw))).toEqual([]);
  });
});
