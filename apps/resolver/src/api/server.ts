/**
 * HTTP layer. Authenticates, validates and bounds every request before any
 * paid processing, then hands exactly one job to the in-process runner
 * (src/runtime/runner.ts). Nothing here computes fingerprints or touches the
 * provider.
 *
 * Website route: POST /v1/entrances (contract entrance.v1, owner decision
 * D2). The response is an acknowledgement `{version, status, source,
 * recorded}`: it never carries company identity, a company id, an IP, a
 * fingerprint or provider data.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import type { Logger } from "../log/index.js";
import {
  API_VERSION,
  ENTRANCE_CONTRACT,
  OCCURRED_AT_MAX_SKEW_MS,
  parseOccurredAt,
  RESOLUTION_STATUSES,
  type EntranceResponse,
  type ErrorCode,
  type ErrorResponse,
} from "../contracts/api.js";
import type { ReportingRepository } from "../contracts/db.js";
import { RunnerOverloadedError, RunnerStoppedError, type ResolutionOutcome, type Runner } from "../contracts/runtime.js";
import { canonicaliseIp } from "../ip/canonical.js";
import { createCredentialChecker, createFailureLimiter } from "./auth.js";
import { createCachedProbe, READINESS_CACHE_MS } from "./readiness.js";
import { deriveFeedCursorKey, registerReportingRoutes, REPORTING_PREFIX } from "./reporting.js";
import { EntranceBodySchema } from "./schema.js";

export const ENTRANCES_ROUTE = "/v1/entrances";

export interface ServerDeps {
  config: Config;
  logger: Logger;
  runner: Runner;
  /** Readiness probe for dependencies (database). /readyz caches its result and never runs two at once (src/api/readiness.ts). */
  ping: () => Promise<boolean>;
  /** How long /readyz reuses one ping result. Default READINESS_CACHE_MS (1 s). */
  readinessCacheMs?: number;
  /** Read-only reporting repository; reporting routes are registered only when both this and REPORTING_AUTH_TOKEN are present. */
  reporting?: ReportingRepository;
  now?: () => number;
}

const STATUS_BY_ERROR: Record<ErrorCode, number> = {
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

function errorBody(error: ErrorCode): ErrorResponse {
  return { version: API_VERSION, error };
}

function sendError(reply: FastifyReply, error: ErrorCode): FastifyReply {
  return reply.code(STATUS_BY_ERROR[error]).send(errorBody(error));
}

/**
 * Defensive: the response is rebuilt from four allowlisted fields, so nothing
 * else in an outcome (activity block, company id, reason) can reach the
 * website. `recorded` is true only for a qualified outcome whose observation
 * for this entrance_id was confirmed durably recorded in time; false means
 * "not confirmed" (a write past the deadline may still commit, CHR-66 F4).
 */
function toResponse(outcome: ResolutionOutcome): EntranceResponse {
  const status = (RESOLUTION_STATUSES as readonly string[]).includes(outcome.status) ? outcome.status : "unavailable";
  const source = outcome.source === "cache" || outcome.source === "provider" ? outcome.source : "none";
  const recorded = status === "qualified" && outcome.activity?.recorded === true;
  return { version: API_VERSION, status, source, recorded };
}

/**
 * Server-side deadline race. The runner already answers by the deadline; this
 * is the independent backstop at the HTTP layer, so a runner defect can never
 * hold a response past the deadline.
 */
function answerByDeadline(run: Promise<ResolutionOutcome>, remainingMs: number): Promise<ResolutionOutcome> {
  return new Promise<ResolutionOutcome>((resolve, reject) => {
    const t = setTimeout(() => resolve({ status: "unavailable", source: "none", reason: "deadline_exceeded" }), Math.max(0, remainingMs));
    t.unref();
    run.then(
      (o) => {
        clearTimeout(t);
        resolve(o);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, logger, runner } = deps;
  const now = deps.now ?? (() => Date.now());
  const checkCredential = createCredentialChecker(config.RESOLVER_AUTH_TOKEN);
  // The reporting credential is separate and read-only; without it the reporting routes refuse everything.
  const checkReportingCredential = config.REPORTING_AUTH_TOKEN ? createCredentialChecker(config.REPORTING_AUTH_TOKEN) : () => false;
  const isReportingRoute = (matched: string | undefined) => matched !== undefined && matched.startsWith(REPORTING_PREFIX);
  // Unauthenticated probes must not turn 1:1 into pool demand (CHR-66 F6): cached ~1 s, single-flight.
  const readinessPing = createCachedProbe(deps.ping, { ttlMs: deps.readinessCacheMs ?? READINESS_CACHE_MS, now });

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: config.BODY_LIMIT_BYTES,
    ignoreTrailingSlash: false,
    caseSensitive: true,
    forceCloseConnections: "idle",
    connectionTimeout: 10_000,
    requestTimeout: config.REQUEST_DEADLINE_MS + 2_000,
    // Requests that arrive while closing get the contract's generic error, not Fastify's default body.
    return503OnClosing: false,
    genReqId: () => randomUUID(),
  });
  let closing = false;
  app.addHook("preClose", async () => {
    closing = true;
  });

  // Security headers on every response; never any CORS header.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.removeHeader("Access-Control-Allow-Origin");
    return payload;
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: 60_000,
    // Reporting traffic has its own bucket so it can never starve the website's entrance calls.
    keyGenerator: (req) => (isReportingRoute(req.routeOptions?.url) ? "reporting" : "deployment"),
    addHeaders: { "x-ratelimit-limit": false, "x-ratelimit-remaining": false, "x-ratelimit-reset": false, "retry-after": true },
    addHeadersOnExceeding: { "x-ratelimit-limit": false, "x-ratelimit-remaining": false, "x-ratelimit-reset": false },
    // The plugin routes this object through the error handler; statusCode selects the mapping.
    errorResponseBuilder: () => ({ statusCode: 429, ...errorBody("rate_limited") }),
  });

  // Generic error mapping: never leak messages, stack traces or bodies.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const code = err.code ?? "";
    if (err.statusCode === 413 || code === "FST_ERR_CTP_BODY_TOO_LARGE") return sendError(reply, "payload_too_large");
    if (err.statusCode === 429) return sendError(reply, "rate_limited");
    if (
      err.statusCode === 400 ||
      err.statusCode === 415 ||
      code.startsWith("FST_ERR_CTP_") ||
      code === "FST_ERR_VALIDATION"
    ) {
      return sendError(reply, "invalid_request");
    }
    logger.error("request_rejected", { route: req.routeOptions?.url ?? "unmatched", error_code: "internal", http_status: 500 });
    return sendError(reply, "internal");
  });

  // An unknown route (or method) answers 404 not_found, the same for every
  // path, so a route that is not registered (POST /v1/events while
  // EVENTS_ENABLED=false, the reporting routes without their credential)
  // cannot be told apart from one that never existed (event.v1 section 2).
  // Authentication runs first: without the website credential an unknown
  // route answers 401 like every other route.
  app.setNotFoundHandler((_req, reply) => sendError(reply, "not_found"));

  // Health probes are unauthenticated and must not share the deployment rate-limit bucket.
  app.get("/healthz", { config: { rateLimit: false } }, async (_req, reply) => reply.code(200).send({ ok: true }));

  app.get("/readyz", { config: { rateLimit: false } }, async (_req, reply) => {
    // Never rejects: a throwing ping counts as not ready (and is cached as such).
    const dbOk = await readinessPing();
    // Not ready while every job slot is taken: a load balancer should prefer another instance. Checked on every request.
    const ready = dbOk && runner.activeCount() < runner.capacity();
    logger.debug("readiness", { ready });
    return reply.code(ready ? 200 : 503).send({ ok: ready });
  });

  // Authentication runs before body parsing so unauthenticated bodies are never read.
  // Deny by default: only the two health probes are exempt, decided by the MATCHED
  // route (never the raw request target, which may be percent-encoded or absolute-form).
  const PUBLIC_ROUTES = new Set(["/healthz", "/readyz"]);
  const failures = createFailureLimiter({ max: config.AUTH_FAILURE_LIMIT_PER_MINUTE, windowMs: 60_000 });
  app.addHook("onRequest", async (req, reply) => {
    if (closing) return sendError(reply, "not_ready");
    const matched = req.routeOptions?.url;
    if (matched !== undefined && PUBLIC_ROUTES.has(matched)) return;
    // A valid credential always proceeds to the authenticated rate limit and
    // capacity controls. Only invalid credentials are throttled, keyed on the
    // peer socket address (never a forwarded header), so a caller behind a
    // shared proxy address is not locked out by someone else's failures.
    // Each route group accepts exactly its own credential: the website's
    // resolver token never opens reporting and the reporting token never
    // opens /v1/entrances.
    const ok = isReportingRoute(matched) ? checkReportingCredential(req.headers["authorization"]) : checkCredential(req.headers["authorization"]);
    // An authenticated request for an unknown route is answered here, before
    // its body is parsed, so every unknown route answers 404 whatever the
    // body (a malformed body cannot turn it into a 400).
    if (ok) return matched === undefined ? sendError(reply, "not_found") : undefined;
    const peer = req.socket?.remoteAddress ?? "unknown";
    const limited = failures.isLimited(peer);
    failures.record(peer);
    if (limited) {
      logger.warn("request_rejected", { route: matched ?? "unmatched", error_code: "rate_limited", http_status: 429 });
      return sendError(reply, "rate_limited");
    }
    logger.warn("request_rejected", { route: matched ?? "unmatched", error_code: "unauthorized", http_status: 401 });
    return sendError(reply, "unauthorized");
  });

  const reject = (reply: FastifyReply, error: ErrorCode, reason?: string): FastifyReply => {
    logger.warn("request_rejected", { route: ENTRANCES_ROUTE, error_code: error, http_status: STATUS_BY_ERROR[error], ...(reason ? { reason } : {}) });
    return sendError(reply, error);
  };

  app.post(ENTRANCES_ROUTE, async (req: FastifyRequest, reply: FastifyReply) => {
    const startedAt = now();
    const parsed = EntranceBodySchema.safeParse(req.body);
    if (!parsed.success) return reject(reply, "invalid_request", "schema");
    const body = parsed.data;

    if (body.website_id !== config.WEBSITE_ID) return reject(reply, "forbidden");

    // Syntax check only; eligibility and canonical form are decided by the pipeline.
    if (!canonicaliseIp(body.ip).ok) return reject(reply, "invalid_request", "ip");

    // Bounds replay of a captured request to a window around resolver time.
    const occurredAt = parseOccurredAt(body.occurred_at);
    if (occurredAt === null || Math.abs(startedAt - occurredAt) > OCCURRED_AT_MAX_SKEW_MS) return reject(reply, "invalid_request", "occurred_at");

    const deadlineAtMs = startedAt + config.REQUEST_DEADLINE_MS;
    let outcome: ResolutionOutcome;
    try {
      outcome = await answerByDeadline(
        runner.run({
          ip: body.ip,
          deadlineAtMs,
          // The entrance_id is the observation idempotency key: a repeat never records a second observation.
          observationRef: body.entrance_id,
          context: { pageKey: body.page_key, acquisition: body.acquisition, entranceContract: ENTRANCE_CONTRACT, eligibility: body.eligibility },
        }),
        deadlineAtMs - now(),
      );
    } catch (err) {
      if (err instanceof RunnerOverloadedError) return reject(reply, "overloaded");
      if (err instanceof RunnerStoppedError) return sendError(reply, "not_ready");
      logger.error("request_rejected", { route: ENTRANCES_ROUTE, error_code: "internal", http_status: 500 });
      return sendError(reply, "internal");
    }

    const response = toResponse(outcome);
    logger.info("request_completed", {
      route: ENTRANCES_ROUTE,
      http_status: 200,
      status: response.status,
      source: response.source,
      recorded: response.recorded,
      duration_ms: now() - startedAt,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      // Internal correlation with activity_recorded; never part of the response.
      ...(response.status === "qualified" && outcome.activity ? { company_id: outcome.activity.company_id } : {}),
    });
    return reply.code(200).send(response);
  });

  if (deps.reporting && config.REPORTING_AUTH_TOKEN) {
    registerReportingRoutes(app, {
      scope: { installation_id: config.INSTALLATION_ID, website_id: config.WEBSITE_ID },
      reporting: deps.reporting,
      logger,
      sendError,
      // reporting-feed.v1 (CHR-71): cursor MAC key derived from the server-only
      // IP_HMAC_SECRET with a dedicated label; the consumer holds the reporting
      // token, so it must not key the cursor. Rotating the secret invalidates
      // outstanding cursors: 410 for one behind the retention watermark (a
      // potential continuity gap), otherwise 400 and an idempotent replay
      // (docs/contracts/reporting-feed.v1.md, CHR-66 N1).
      feed: { cursorKey: deriveFeedCursorKey(config.IP_HMAC_SECRET) },
    });
  }

  return app;
}
