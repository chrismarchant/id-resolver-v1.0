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
 */
import type { FastifyInstance, FastifyReply } from "fastify";
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
import type { Logger } from "../log/index.js";
import { CompaniesQuerySchema, CompanyIdParamSchema, ObservationsQuerySchema, SummaryQuerySchema } from "./schema.js";

export const REPORTING_PREFIX = "/v1/reporting";

export interface ReportingDeps {
  scope: ReportingScope;
  reporting: ReportingRepository;
  logger: Logger;
  sendError: (reply: FastifyReply, error: ErrorCode) => FastifyReply;
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
}
