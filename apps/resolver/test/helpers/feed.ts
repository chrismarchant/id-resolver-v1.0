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
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server.js";
import { deriveFeedCursorKey, FEED_ROUTE } from "../../src/api/reporting.js";
import type { Runner } from "../../src/contracts/runtime.js";
import type { ObservationScope } from "../../src/contracts/db.js";
import type { FeedItemWire, FeedObservationWire, ReportingFeedResponse } from "../../src/contracts/reporting-feed.js";
import type { Db } from "../../src/db/index.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { getTestDatabaseUrl, resetTestDb } from "./db.js";
import { TEST_AUTH_TOKEN, testConfig } from "./env.js";

export const FEED_REPORTING_TOKEN = ["test", "reporting", "token", "0123456789abcdef0123456789abcdef"].join("-");
export const FEED_SCOPE: ObservationScope = { installationId: "inst-test", websiteId: "site-test" };
export const OTHER_SCOPE: ObservationScope = { installationId: "inst-test", websiteId: "other-site" };
export const reportingAuth = { authorization: `Bearer ${FEED_REPORTING_TOKEN}` };
export const websiteAuth = { authorization: `Bearer ${TEST_AUTH_TOKEN}` };


export const idleRunner: Runner = {
  activeCount: () => 0,
  capacity: () => 1,
  run: async () => ({ status: "unavailable", source: "none", reason: "internal_error" }),
  shutdown: async () => ({ drained: true, activeJobs: 0, pendingWrites: 0 }),
};

/**
 * The real server exactly as production builds it: server.ts registers the
 * reporting routes, including the feed with its cursor key derived from
 * IP_HMAC_SECRET, so these suites exercise the real wiring.
 */
export async function buildFeedServer(db: Db, overrides: Record<string, string> = {}) {
  // The proof suites page thousands of times a minute; the bucket itself is tested separately.
  const config = testConfig({ REPORTING_AUTH_TOKEN: FEED_REPORTING_TOKEN, RATE_LIMIT_PER_MINUTE: "100000", ...overrides });
  const logger = createMemoryLogger();
  const app = await buildServer({ config, logger, runner: idleRunner, ping: () => db.ping(), reporting: db.reporting });
  await app.ready();
  return { app, logger, config };
}

/** The cursor key the server derives for a given config (for tests that forge or check cursors). */
export function feedCursorKeyFor(config: { IP_HMAC_SECRET: string }): Buffer {
  return deriveFeedCursorKey(config.IP_HMAC_SECRET);
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

/** Truncates every application table including the feed tables, through resetTestDb (the 0007 guards reject a plain TRUNCATE). */
export async function resetFeedDb(db: Db): Promise<void> {
  await resetTestDb(db);
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
