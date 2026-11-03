/**
 * Shared machinery for the reporting-feed.v1 proof suite (CHR-71):
 *
 *  - a server with the real authentication, rate limiting and error mapping
 *    of src/api/server.ts and the feed route registered exactly as MAIN must
 *    wire it (cursor key derived from IP_HMAC_SECRET);
 *  - direct-SQL writers on separate connections, so tests can hold explicit
 *    transactions open and choose the commit order;
 *  - a small reference consumer that applies pages idempotently (keyed by
 *    observation_id and tombstone_id, dropping erased company ids) and can be
 *    "crashed" between fetching, applying and saving its cursor.
 *
 * Synthetic data only: example.* domains, no IPs.
 */
import pg from "pg";
import type { FastifyInstance, FastifyReply } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { deriveFeedCursorKey, FEED_ROUTE, registerReportingRoutes } from "../../src/api/reporting.js";
import type { ErrorCode } from "../../src/contracts/api.js";
import type { ChildManager } from "../../src/contracts/child-manager.js";
import type { ObservationScope } from "../../src/contracts/db.js";
import type { FeedItemWire, FeedObservationWire, ReportingFeedResponse } from "../../src/contracts/reporting-feed.js";
import type { Db } from "../../src/db/index.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { getTestDatabaseUrl } from "./db.js";
import { TEST_AUTH_TOKEN, testConfig } from "./env.js";

export const FEED_REPORTING_TOKEN = ["test", "reporting", "token", "0123456789abcdef0123456789abcdef"].join("-");
export const FEED_SCOPE: ObservationScope = { installationId: "inst-test", websiteId: "site-test" };
export const OTHER_SCOPE: ObservationScope = { installationId: "inst-test", websiteId: "other-site" };
export const reportingAuth = { authorization: `Bearer ${FEED_REPORTING_TOKEN}` };
export const websiteAuth = { authorization: `Bearer ${TEST_AUTH_TOKEN}` };

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  payload_too_large: 413,
  rate_limited: 429,
  overloaded: 503,
  not_ready: 503,
  internal: 500,
};

const idleChildManager: ChildManager = {
  activeCount: () => 0,
  capacity: () => 1,
  run: async () => ({ status: "unavailable", company: null, source: "none", reason: "test" }),
  shutdown: async () => {},
};

/**
 * The real server (auth hook, "reporting" rate-limit bucket, error handler)
 * with the reporting routes registered as server.ts must do once MAIN wires
 * the feed: registerReportingRoutes(app, { ..., feed: { cursorKey:
 * deriveFeedCursorKey(config.IP_HMAC_SECRET) } }).
 */
export async function buildFeedServer(db: Db, overrides: Record<string, string> = {}) {
  // The proof suites page thousands of times a minute; the bucket itself is tested separately.
  const config = testConfig({ REPORTING_AUTH_TOKEN: FEED_REPORTING_TOKEN, RATE_LIMIT_PER_MINUTE: "100000", ...overrides });
  const logger = createMemoryLogger();
  const app = await buildServer({ config, logger, childManager: idleChildManager, ping: () => db.ping() });
  registerReportingRoutes(app, {
    scope: { installation_id: config.INSTALLATION_ID, website_id: config.WEBSITE_ID },
    reporting: db.reporting,
    logger,
    sendError: (reply: FastifyReply, error: ErrorCode) => reply.code(STATUS[error]).send({ version: "1", error }),
    feed: { cursorKey: deriveFeedCursorKey(config.IP_HMAC_SECRET) },
  });
  await app.ready();
  return { app, logger, config };
}

export interface FeedHttpResult {
  status: number;
  body: ReportingFeedResponse;
  raw: string;
}

export async function getFeed(app: FastifyInstance, after?: string, limit?: number, headers: Record<string, string> = reportingAuth): Promise<FeedHttpResult> {
  const qs = new URLSearchParams();
  if (after !== undefined) qs.set("after", after);
  if (limit !== undefined) qs.set("limit", String(limit));
  const q = qs.toString();
  const r = await app.inject({ method: "GET", url: q ? `${FEED_ROUTE}?${q}` : FEED_ROUTE, headers });
  return { status: r.statusCode, body: r.json() as ReportingFeedResponse, raw: r.body };
}

// ---- database fixtures --------------------------------------------------------

export type Queryable = Pick<pg.Pool | pg.PoolClient | pg.Client, "query">;

/** Truncates every application table including the feed tables (resetTestDb predates them). */
export async function resetFeedDb(db: Db): Promise<void> {
  await db.pool.query(
    "TRUNCATE TABLE feed_tombstones, feed_retention_watermarks, company_observation_refs, company_observations, company_scope_stats, ip_resolution_cache, companies, usage_periods, deployment_controls RESTART IDENTITY CASCADE",
  );
}

export async function createCompany(q: Queryable, domain: string, name: string | null = `${domain} Ltd`): Promise<number> {
  const r = await q.query<{ id: string }>(
    "INSERT INTO companies (domain, organisation_name, first_seen_at, last_seen_at) VALUES ($1, $2, now(), now()) RETURNING id",
    [domain, name],
  );
  return Number(r.rows[0]!.id);
}

let refCounter = 0;
export const nextRef = () => `feedref-${String(++refCounter).padStart(16, "0")}`;

export interface InsertedObservation {
  id: string;
  txid: string;
}

/**
 * Direct-SQL observation insert, the shape the entrance path writes (page_key,
 * acquisition, entrance_contract, eligibility). txid comes from the database.
 */
export async function insertObservation(
  q: Queryable,
  o: {
    companyId: number;
    scope?: ObservationScope;
    ref?: string;
    observedAt?: Date;
    source?: "cache" | "provider";
    pageKey?: string | null;
    acquisition?: string | null;
  },
): Promise<InsertedObservation> {
  const scope = o.scope ?? FEED_SCOPE;
  const r = await q.query<{ id: string; txid: string }>(
    `INSERT INTO company_observations
       (installation_id, website_id, company_id, observed_at, observation_ref, source, page_key, acquisition, entrance_contract, eligibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'entrance.v1', 'tsa-1')
     RETURNING id::text AS id, txid::text AS txid`,
    [
      scope.installationId,
      scope.websiteId,
      o.companyId,
      o.observedAt ?? new Date(),
      o.ref ?? nextRef(),
      o.source ?? "cache",
      o.pageKey === undefined ? "/pricing" : o.pageKey,
      o.acquisition === undefined ? "search" : o.acquisition,
    ],
  );
  return r.rows[0]!;
}

/** A dedicated connection for holding an explicit transaction open. */
export async function openWriter(statementTimeoutMs = 15_000): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: getTestDatabaseUrl(), application_name: "feed-proof-writer" });
  c.on("error", () => undefined);
  await c.connect();
  await c.query(`SET statement_timeout = ${statementTimeoutMs}`);
  return c;
}

/** The current snapshot horizon as a fresh statement sees it. */
export async function currentHorizon(q: Queryable): Promise<bigint> {
  const r = await q.query<{ h: string }>("SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS h");
  return BigInt(r.rows[0]!.h);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Waits until some backend of this database is blocked on a lock while running
 * a statement that starts with `statementPrefix`: makes "the other transaction
 * is now waiting" a fact rather than a sleep.
 */
export async function waitForLockWaiter(q: Queryable, statementPrefix: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await q.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND left(ltrim(query), $2) = $1",
      [statementPrefix, statementPrefix.length],
    );
    if ((r.rowCount ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`no backend waiting on a lock in: ${statementPrefix}`);
    await sleep(5);
  }
}

// ---- reference consumer ---------------------------------------------------------

/**
 * Idempotent projection of the feed, as docs/contracts/reporting-feed.v1.md
 * prescribes: observations keyed by observation_id; a tombstone removes every
 * observation of its company_id and records the id as erased, after which
 * observations of that id are ignored (company ids are never reused).
 */
export class Projection {
  readonly observations = new Map<string, FeedObservationWire>();
  readonly erased = new Set<number>();
  readonly tombstones = new Set<string>();

  apply(items: FeedItemWire[]): void {
    for (const it of items) {
      if (it.type === "observation") {
        if (this.erased.has(it.company_id)) continue;
        this.observations.set(it.observation_id, it);
      } else {
        this.tombstones.add(it.tombstone_id);
        this.erased.add(it.company_id);
        for (const [id, o] of this.observations) if (o.company_id === it.company_id) this.observations.delete(id);
      }
    }
  }

  /** Canonical, order-independent serialisation for equality checks. */
  canonical(): string {
    const obs = [...this.observations.values()].sort((a, b) => (BigInt(a.observation_id) < BigInt(b.observation_id) ? -1 : 1));
    return JSON.stringify({ obs, erased: [...this.erased].sort((a, b) => a - b), tombstones: [...this.tombstones].sort() });
  }

  clone(): Projection {
    const p = new Projection();
    for (const [k, v] of this.observations) p.observations.set(k, v);
    for (const e of this.erased) p.erased.add(e);
    for (const t of this.tombstones) p.tombstones.add(t);
    return p;
  }
}

/**
 * A consumer whose durable state is (projection, cursor). `step` runs one
 * fetch-apply-save cycle and can crash at the two dangerous points.
 */
export class FeedConsumer {
  projection = new Projection();
  cursor: string | undefined;
  /** Every item applied, in order, including duplicates caused by crashes. */
  readonly delivered: FeedItemWire[] = [];

  constructor(
    private readonly app: FastifyInstance,
    /** Page size; tests may change it between steps. */
    public limit = 3,
  ) {}

  async step(crash: "none" | "after_fetch" | "after_apply" = "none"): Promise<{ items: number; hasMore: boolean }> {
    const r = await getFeed(this.app, this.cursor, this.limit);
    if (r.status !== 200) throw new Error(`feed status ${r.status}: ${r.raw}`);
    if (crash === "after_fetch") return { items: r.body.items.length, hasMore: true };
    this.projection.apply(r.body.items);
    this.delivered.push(...r.body.items);
    if (crash === "after_apply") return { items: r.body.items.length, hasMore: true };
    this.cursor = r.body.next_cursor;
    return { items: r.body.items.length, hasMore: r.body.has_more };
  }

  /** Pages until a page reports no more items and `until` holds (polling while the horizon is held back). */
  async drain(until: (c: FeedConsumer) => boolean = () => true, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.step();
      if (!s.hasMore && until(this)) return;
      if (Date.now() > deadline) throw new Error("drain: timed out (feed horizon held back?)");
      if (!s.hasMore) await sleep(10);
    }
  }
}

/** Delivered observation ids in order. */
export const obsIds = (items: FeedItemWire[]) => items.filter((i): i is FeedObservationWire => i.type === "observation").map((i) => i.observation_id);
