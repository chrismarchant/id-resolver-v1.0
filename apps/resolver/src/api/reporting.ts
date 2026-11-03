/**
 * Reporting API (version 1): read-only, server-to-server, scoped by
 * deployment configuration, authenticated with the separate reporting
 * credential (checked in the server's onRequest hook before any handler
 * runs). Handlers only touch the reporting repository, which never joins the
 * fingerprint cache, so no response can carry an IP, a fingerprint or a
 * provider payload.
 *
 * Pagination: keyset cursors (opaque base64url JSON), ordered by most recent
 * activity then id, stable under concurrent inserts. Date ranges: inclusive
 * UTC calendar dates, converted to the half-open instant range
 * [from 00:00:00Z, to + 1 day 00:00:00Z); at most REPORTING_MAX_RANGE_DAYS days.
 *
 * The observation feed (reporting-feed.v1, GET /v1/reporting/observations) is
 * registered only when `feed.cursorKey` is supplied: its cursors are
 * integrity-protected (HMAC) positions, see encodeFeedCursor below.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  REPORTING_API_VERSION,
  REPORTING_MAX_RANGE_DAYS,
  type ErrorCode,
  type ReportingCompaniesResponse,
  type ReportingCompany,
  type ReportingCompanyDetailResponse,
  type ReportingObservation,
  type ReportingScope,
  type ReportingSummaryResponse,
} from "../contracts/api.js";
import type { CompaniesCursor, CompanyActivitySummary, CompanyOrder, ObservationItem, ObservationsCursor, ReportingRepository } from "../contracts/db.js";
import {
  compareFeedPositions,
  FEED_CONTRACT,
  FEED_CURSOR_EXPIRED_STATUS,
  FEED_DEFAULT_LIMIT,
  FEED_KIND_OBSERVATION,
  FEED_KIND_TOMBSTONE,
  FEED_MAX_LIMIT,
  FEED_START,
  FEED_VERSION,
  type FeedCursorExpiredResponse,
  type FeedItemWire,
  type FeedPosition,
  type FeedRecord,
  type ReportingFeedResponse,
} from "../contracts/reporting-feed.js";
import type { Logger } from "../log/index.js";
import { CompaniesQuerySchema, CompanyIdParamSchema, ObservationsQuerySchema, SummaryQuerySchema } from "./schema.js";

export const REPORTING_PREFIX = "/v1/reporting";
export const FEED_ROUTE = `${REPORTING_PREFIX}/observations`;

export interface ReportingFeedOptions {
  /** 32-byte key for the cursor MAC; derive it with deriveFeedCursorKey from a server-only secret. */
  cursorKey: Buffer;
}

export interface ReportingDeps {
  scope: ReportingScope;
  reporting: ReportingRepository;
  logger: Logger;
  sendError: (reply: FastifyReply, error: ErrorCode) => FastifyReply;
  /** Enables GET /v1/reporting/observations. Absent: the route does not exist (fail closed). */
  feed?: ReportingFeedOptions;
}

const DAY_MS = 86_400_000;

// ---- cursors ---------------------------------------------------------------

function encodeCursor(obj: Record<string, number>): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined, keys: readonly string[]): Record<string, number> | null | undefined {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const o = parsed as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length) return undefined;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return undefined;
    out[k] = v;
  }
  return out;
}

/** Epoch milliseconds that form a valid Date and a positive id; anything else is a malformed cursor. */
function cursorInstant(ms: number): Date | undefined {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function companiesCursorFrom(raw: string | undefined, order: CompanyOrder): CompaniesCursor | null | undefined {
  if (order === "id") {
    const c = decodeCursor(raw, ["c"]);
    if (!c) return c;
    if (c["c"]! < 1) return undefined;
    return { order: "id", companyId: c["c"]! };
  }
  const c = decodeCursor(raw, ["t", "c"]);
  if (!c) return c;
  const t = cursorInstant(c["t"]!);
  if (!t || c["c"]! < 1) return undefined;
  return { order: "recent", lastObservedAt: t, companyId: c["c"]! };
}

export function encodeCompaniesCursor(c: CompaniesCursor): string {
  return c.order === "id" ? encodeCursor({ c: c.companyId }) : encodeCursor({ t: c.lastObservedAt.getTime(), c: c.companyId });
}

export function observationsCursorFrom(raw: string | undefined): ObservationsCursor | null | undefined {
  const c = decodeCursor(raw, ["t", "o"]);
  if (!c) return c;
  const t = cursorInstant(c["t"]!);
  if (!t || c["o"]! < 1) return undefined;
  return { observedAt: t, observationId: c["o"]! };
}

// ---- date ranges -----------------------------------------------------------

/** Inclusive UTC dates -> half-open instants; undefined when invalid or too wide. */
export function dateRange(from: string, to: string): { from: Date; to: Date } | undefined {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  // Reject impossible calendar dates that Date.parse normalises (e.g. 02-31).
  if (new Date(a).toISOString().slice(0, 10) !== from || new Date(b).toISOString().slice(0, 10) !== to) return undefined;
  if (b < a) return undefined;
  const days = (b - a) / DAY_MS + 1;
  if (days > REPORTING_MAX_RANGE_DAYS) return undefined;
  return { from: new Date(a), to: new Date(b + DAY_MS) };
}

// ---- feed cursors (reporting-feed.v1) ----------------------------------------
//
// A cursor is base64url(payload || tag) where payload is 18 bytes:
//   [0] format version (1) | [1..8] txid u64 BE | [9] kind | [10..17] id u64 BE
// and tag is the first 16 bytes of HMAC-SHA-256(key, label | scope | payload).
// The scope is bound into the tag, so a cursor from another deployment scope is
// rejected. 34 bytes encode to exactly 46 base64url characters. Positions are
// not secret (a consumer could infer them); the tag only makes a tampered or
// fabricated position detectable (400, or 410 when the claimed position lies
// before the retention watermark) instead of silently skipping data.

const FEED_CURSOR_FORMAT = 1;
const FEED_CURSOR_PAYLOAD_BYTES = 18;
const FEED_CURSOR_TAG_BYTES = 16;
const FEED_CURSOR_PATTERN = /^[A-Za-z0-9_-]{46}$/;
const FEED_CURSOR_KEY_LABEL = "id-resolver/reporting-feed.v1/cursor-key";
const FEED_CURSOR_TAG_LABEL = "id-resolver/reporting-feed.v1/cursor";
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const I64_MAX = 0x7fff_ffff_ffff_ffffn;

/**
 * Derives the cursor MAC key from an existing server-only secret (MAIN wires
 * IP_HMAC_SECRET; the reporting token is unsuitable because the consumer holds
 * it). Domain-separated from every other use of that secret by its label, so
 * the derived key reveals nothing about the fingerprint key. Rotating the
 * secret invalidates outstanding cursors: a stale cursor whose position lies
 * strictly before the scope's retention watermark gets 410 cursor_expired
 * (data was missed; see registerFeedRoute), any other gets 400, after which
 * the consumer resynchronises from the start of the buffer, which is safe
 * because nothing after its position was pruned and it applies idempotently.
 */
export function deriveFeedCursorKey(secret: string): Buffer {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("feed cursor key: secret too short");
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(FEED_CURSOR_KEY_LABEL, "utf8").digest();
}

function feedCursorTag(key: Buffer, scope: ReportingScope, payload: Buffer): Buffer {
  const h = createHmac("sha256", key);
  for (const part of [FEED_CURSOR_TAG_LABEL, scope.installation_id, scope.website_id]) {
    const b = Buffer.from(part, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    h.update(len).update(b);
  }
  h.update(payload);
  return h.digest().subarray(0, FEED_CURSOR_TAG_BYTES);
}

export function encodeFeedCursor(position: FeedPosition, key: Buffer, scope: ReportingScope): string {
  if (position.txid < 0n || position.txid > U64_MAX || position.id < 0n || position.id > I64_MAX) throw new Error("feed cursor: position out of range");
  const payload = Buffer.alloc(FEED_CURSOR_PAYLOAD_BYTES);
  payload.writeUInt8(FEED_CURSOR_FORMAT, 0);
  payload.writeBigUInt64BE(position.txid, 1);
  payload.writeUInt8(position.kind, 9);
  payload.writeBigUInt64BE(position.id, 10);
  return Buffer.concat([payload, feedCursorTag(key, scope, payload)]).toString("base64url");
}

/** Payload and tag of a canonical 46-character cursor, or undefined when it is not one. Verifies nothing. */
function splitFeedCursor(raw: string): { payload: Buffer; tag: Buffer } | undefined {
  if (typeof raw !== "string" || !FEED_CURSOR_PATTERN.test(raw)) return undefined;
  const buf = Buffer.from(raw, "base64url");
  // Reject non-canonical encodings (stray low bits in the last character).
  if (buf.length !== FEED_CURSOR_PAYLOAD_BYTES + FEED_CURSOR_TAG_BYTES || buf.toString("base64url") !== raw) return undefined;
  return { payload: buf.subarray(0, FEED_CURSOR_PAYLOAD_BYTES), tag: buf.subarray(FEED_CURSOR_PAYLOAD_BYTES) };
}

/** The position an 18-byte payload encodes, or undefined when its format, kind or id is invalid. */
function feedCursorPayloadPosition(payload: Buffer): FeedPosition | undefined {
  if (payload.readUInt8(0) !== FEED_CURSOR_FORMAT) return undefined;
  const kind = payload.readUInt8(9);
  if (kind !== FEED_KIND_OBSERVATION && kind !== FEED_KIND_TOMBSTONE) return undefined;
  const id = payload.readBigUInt64BE(10);
  if (id > I64_MAX) return undefined;
  return { txid: payload.readBigUInt64BE(1), kind, id };
}

/** The position a cursor encodes, or undefined when it is malformed, tampered with or issued for another scope or key. */
export function decodeFeedCursor(raw: string, key: Buffer, scope: ReportingScope): FeedPosition | undefined {
  const c = splitFeedCursor(raw);
  if (!c) return undefined;
  if (!timingSafeEqual(c.tag, feedCursorTag(key, scope, c.payload))) return undefined;
  return feedCursorPayloadPosition(c.payload);
}

/**
 * The position a well-formed cursor CLAIMS, WITHOUT verifying its tag:
 * undefined when the cursor is malformed (wrong length or alphabet,
 * non-canonical encoding, unknown format, invalid kind or id). The claim may
 * be stale (issued under a rotated key), from another scope, or forged, so it
 * is used for exactly one decision: whether a cursor that failed
 * verification lies strictly before the retention watermark (410 instead of
 * 400). It must never select or serve items. Positions are not secret, so
 * reading the claim leaks nothing.
 */
export function unverifiedFeedCursorPosition(raw: string): FeedPosition | undefined {
  const c = splitFeedCursor(raw);
  return c ? feedCursorPayloadPosition(c.payload) : undefined;
}

export const FeedQuerySchema = z
  .object({
    after: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    limit: z.coerce.number().int().min(1).max(FEED_MAX_LIMIT).default(FEED_DEFAULT_LIMIT),
  })
  .strict();

function toFeedItem(r: FeedRecord): FeedItemWire {
  if (r.type === "company_erased") {
    return { type: "company_erased", tombstone_id: r.tombstoneId.toString(), company_id: r.companyId, erased_at: r.erasedAt.toISOString() };
  }
  return {
    type: "observation",
    observation_id: r.observationId.toString(),
    company_id: r.companyId,
    domain: r.domain,
    organisation_name: r.organisationName,
    observed_at: r.observedAt.toISOString(),
    method: r.method,
    page_key: r.pageKey,
    acquisition: r.acquisition,
    entrance_contract: r.entranceContract,
  };
}

// ---- projections -----------------------------------------------------------

function toCompany(c: CompanyActivitySummary): ReportingCompany {
  return {
    company_id: c.companyId,
    domain: c.domain,
    organisation_name: c.organisationName,
    first_observed_at: c.firstObservedAt.toISOString(),
    last_observed_at: c.lastObservedAt.toISOString(),
    observation_count: c.observationCount,
  };
}

function toObservation(o: ObservationItem): ReportingObservation {
  return {
    observation_id: o.observationId,
    observed_at: o.observedAt.toISOString(),
    source: o.source,
    observation_ref: o.observationRef,
    company_first: o.companyFirst,
  };
}

export function registerReportingRoutes(app: FastifyInstance, deps: ReportingDeps): void {
  const { scope, reporting, logger, sendError } = deps;
  // Validate before registering anything, so a bad key never leaves a half-registered API.
  if (deps.feed && (!Buffer.isBuffer(deps.feed.cursorKey) || deps.feed.cursorKey.length < 32)) throw new Error("feed cursor key must be at least 32 bytes");
  const rejected = (reply: FastifyReply, route: string, error: ErrorCode, http: number) => {
    logger.warn("request_rejected", { route, error_code: error, http_status: http });
    return sendError(reply, error);
  };
  const dbFailed = (reply: FastifyReply, route: string) => {
    logger.error("request_rejected", { route, error_code: "internal", http_status: 500 });
    return sendError(reply, "internal");
  };

  app.get(`${REPORTING_PREFIX}/companies`, async (req, reply) => {
    const route = `${REPORTING_PREFIX}/companies`;
    const q = CompaniesQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return rejected(reply, route, "invalid_request", 400);
    const cursor = companiesCursorFrom(q.data.cursor, q.data.order);
    if (cursor === undefined) return rejected(reply, route, "invalid_request", 400);
    try {
      const page = await reporting.listCompanies({ installationId: scope.installation_id, websiteId: scope.website_id }, { limit: q.data.limit, cursor, order: q.data.order });
      const body: ReportingCompaniesResponse = {
        version: REPORTING_API_VERSION,
        scope,
        order: q.data.order,
        items: page.items.map(toCompany),
        next_cursor: page.nextCursor ? encodeCompaniesCursor(page.nextCursor) : null,
      };
      logger.info("request_completed", { route, http_status: 200, count: body.items.length });
      return reply.code(200).send(body);
    } catch {
      return dbFailed(reply, route);
    }
  });

  app.get(`${REPORTING_PREFIX}/companies/:id`, async (req, reply) => {
    const route = `${REPORTING_PREFIX}/companies/:id`;
    const p = CompanyIdParamSchema.safeParse(req.params ?? {});
    const q = ObservationsQuerySchema.safeParse(req.query ?? {});
    if (!p.success || !q.success) return rejected(reply, route, "invalid_request", 400);
    const companyId = Number(p.data.id);
    const cursor = observationsCursorFrom(q.data.cursor);
    if (cursor === undefined) return rejected(reply, route, "invalid_request", 400);
    const s = { installationId: scope.installation_id, websiteId: scope.website_id };
    try {
      const company = await reporting.getCompany(s, companyId);
      // Companies never observed in this scope are indistinguishable from non-existent ones.
      if (!company) return rejected(reply, route, "not_found", 404);
      const page = await reporting.listObservations(s, companyId, { limit: q.data.limit, cursor });
      const body: ReportingCompanyDetailResponse = {
        version: REPORTING_API_VERSION,
        scope,
        company: toCompany(company),
        observations: page.items.map(toObservation),
        next_cursor: page.nextCursor ? encodeCursor({ t: page.nextCursor.observedAt.getTime(), o: page.nextCursor.observationId }) : null,
      };
      logger.info("request_completed", { route, http_status: 200, count: body.observations.length });
      return reply.code(200).send(body);
    } catch {
      return dbFailed(reply, route);
    }
  });

  app.get(`${REPORTING_PREFIX}/summary`, async (req, reply) => {
    const route = `${REPORTING_PREFIX}/summary`;
    const q = SummaryQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return rejected(reply, route, "invalid_request", 400);
    const range = dateRange(q.data.from, q.data.to);
    if (!range) return rejected(reply, route, "invalid_request", 400);
    try {
      const r = await reporting.summary({ installationId: scope.installation_id, websiteId: scope.website_id }, range);
      const body: ReportingSummaryResponse = {
        version: REPORTING_API_VERSION,
        scope,
        from: q.data.from,
        to: q.data.to,
        observations: r.observations,
        observed_companies: r.observedCompanies,
        newly_observed_companies: r.newlyObservedCompanies,
        previously_observed_companies: r.previouslyObservedCompanies,
      };
      logger.info("request_completed", { route, http_status: 200 });
      return reply.code(200).send(body);
    } catch {
      return dbFailed(reply, route);
    }
  });

  if (deps.feed) registerFeedRoute(app, deps, deps.feed);
}

/**
 * GET /v1/reporting/observations?after=&limit= (reporting-feed.v1). Shares the
 * reporting credential check and the separate "reporting" rate-limit bucket
 * with the other reporting routes (both keyed on the /v1/reporting prefix in
 * the server). All ordering and commit-safety guarantees live in one database
 * statement (src/db/reporting-repo.ts, FEED_SQL); this handler only validates,
 * signs and projects.
 *
 * A cursor whose tag does not verify is never served. It is usually stale:
 * the cursor key derives from IP_HMAC_SECRET, so rotating that secret
 * invalidates every outstanding cursor. A consumer answers 400 with an
 * automatic restart from the start of the buffer, which is only safe when
 * nothing after its position was pruned. So when the cursor is well-formed
 * and the position it claims lies strictly before the scope's retention
 * watermark, the answer is 410 cursor_expired (data was missed, the consumer
 * must alert), exactly what the same cursor would have received before the
 * rotation; otherwise 400. The claimed position decides only between these two
 * errors. If the watermark cannot be read the answer is 500, never a 400 that
 * could trigger a silent reset.
 */
function registerFeedRoute(app: FastifyInstance, deps: ReportingDeps, feed: ReportingFeedOptions): void {
  const { scope, reporting, logger, sendError } = deps;
  const key = Buffer.from(feed.cursorKey);
  const s = { installationId: scope.installation_id, websiteId: scope.website_id };
  const route = FEED_ROUTE;

  const sendExpired = (reply: FastifyReply, unverified: boolean) => {
    logger.warn("request_rejected", { route, error_code: "cursor_expired", http_status: FEED_CURSOR_EXPIRED_STATUS, ...(unverified ? { reason: "unverified_cursor" } : {}) });
    const expired: FeedCursorExpiredResponse = { version: FEED_VERSION, error: "cursor_expired" };
    return reply.code(FEED_CURSOR_EXPIRED_STATUS).send(expired);
  };

  const rejectUnverifiedCursor = async (reply: FastifyReply, raw: string) => {
    const claimed = unverifiedFeedCursorPosition(raw);
    if (claimed) {
      let watermark: FeedPosition | null;
      try {
        watermark = await reporting.feedWatermark(s);
      } catch {
        logger.error("request_rejected", { route, error_code: "internal", http_status: 500 });
        return sendError(reply, "internal");
      }
      if (watermark && compareFeedPositions(claimed, watermark) < 0) return sendExpired(reply, true);
    }
    logger.warn("request_rejected", { route, error_code: "invalid_request", http_status: 400 });
    return sendError(reply, "invalid_request");
  };

  app.get(FEED_ROUTE, async (req, reply) => {
    const q = FeedQuerySchema.safeParse(req.query ?? {});
    if (!q.success) {
      logger.warn("request_rejected", { route, error_code: "invalid_request", http_status: 400 });
      return sendError(reply, "invalid_request");
    }
    let after: FeedPosition | null = null;
    if (q.data.after !== undefined) {
      const verified = decodeFeedCursor(q.data.after, key, scope);
      if (verified === undefined) return rejectUnverifiedCursor(reply, q.data.after);
      after = verified;
    }
    try {
      const page = await reporting.feed(s, { after, limit: q.data.limit });
      if (page.expired) return sendExpired(reply, false);
      const last = page.items[page.items.length - 1];
      const position = last ? last.position : (after ?? FEED_START);
      const body: ReportingFeedResponse = {
        version: FEED_VERSION,
        contract: FEED_CONTRACT,
        scope,
        items: page.items.map(toFeedItem),
        next_cursor: encodeFeedCursor(position, key, scope),
        has_more: page.hasMore,
      };
      logger.info("request_completed", { route, http_status: 200, count: body.items.length });
      return reply.code(200).send(body);
    } catch {
      logger.error("request_rejected", { route, error_code: "internal", http_status: 500 });
      return sendError(reply, "internal");
    }
  });
}
