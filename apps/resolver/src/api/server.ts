/**
 * HTTP layer. Authenticates, validates and bounds every request before any
 * paid processing, then hands exactly one job to the in-process runner
 * (src/runtime/runner.ts). Nothing here computes fingerprints or touches the
 * provider.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import type { Logger } from "../log/index.js";
import { API_VERSION, RESOLUTION_STATUSES, type ErrorCode, type ErrorResponse, type ResolveResponse } from "../contracts/api.js";
import type { ReportingRepository } from "../contracts/db.js";
import { RunnerOverloadedError, RunnerStoppedError, type ResolutionOutcome, type Runner } from "../contracts/runtime.js";
import { canonicaliseIp } from "../ip/canonical.js";
import { createCredentialChecker, createFailureLimiter } from "./auth.js";
import { registerReportingRoutes, REPORTING_PREFIX } from "./reporting.js";
import { ResolveBodySchema } from "./schema.js";

export interface ServerDeps {
  config: Config;
  logger: Logger;
  runner: Runner;
  /** Readiness probe for dependencies (database). */
  ping: () => Promise<boolean>;
  /** Read-only reporting repository; reporting routes are registered only when both this and REPORTING_AUTH_TOKEN are present. */
  reporting?: ReportingRepository;
  now?: () => number;
}

/** Server-generated observation reference when the caller omits one: 16 random bytes, base64url (22 chars). */
export function generateObservationRef(): string {
  return randomBytes(16).toString("base64url");
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

function errorBody(error: ErrorCode, requestId?: string): ErrorResponse {
  return requestId ? { version: API_VERSION, error, request_id: requestId } : { version: API_VERSION, error };
}

function sendError(reply: FastifyReply, error: ErrorCode, requestId?: string): FastifyReply {
  return reply.code(STATUS_BY_ERROR[error]).send(errorBody(error, requestId));
}

/** Defensive: only pass through fields the contract allows. */
function toResponse(outcome: ResolutionOutcome, requestId: string | undefined): ResolveResponse {
  const status = (RESOLUTION_STATUSES as readonly string[]).includes(outcome.status) ? outcome.status : "unavailable";
  let company: ResolveResponse["company"] = null;
  if (status === "qualified" && outcome.company && typeof outcome.company.domain === "string") {
    const c = outcome.company;
    company = {
      domain: c.domain,
      organisation_name: typeof c.organisation_name === "string" ? c.organisation_name : null,
      qualification: {
        category: typeof c.qualification?.category === "string" ? c.qualification.category : "unknown",
        source: "provider_usage_type",
      },
      resolved_at: typeof c.resolved_at === "string" ? c.resolved_at : new Date(0).toISOString(),
    };
  }
  const source = outcome.source === "cache" || outcome.source === "provider" ? outcome.source : "none";
  const base: ResolveResponse = { version: API_VERSION, status, company, source };
  const withId = requestId ? { ...base, request_id: requestId } : base;
  // Activity fields exist only on qualified responses (server-to-server data).
  const a = outcome.activity;
  if (status !== "qualified" || !a || typeof a.company_id !== "number") return withId;
  return {
    ...withId,
    company_id: a.company_id,
    previously_seen_company: a.previously_seen === true ? true : a.previously_seen === false ? false : null,
    activity_recorded: a.recorded === true,
    observation_ref: a.observation_ref,
  };
}

/**
 * Server-side deadline race. The runner already answers by the deadline; this
 * is the independent backstop at the HTTP layer, so a runner defect can never
 * hold a response past the deadline.
 */
function answerByDeadline(run: Promise<ResolutionOutcome>, remainingMs: number): Promise<ResolutionOutcome> {
  return new Promise<ResolutionOutcome>((resolve, reject) => {
    const t = setTimeout(() => resolve({ status: "unavailable", company: null, source: "none", reason: "deadline_exceeded" }), Math.max(0, remainingMs));
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
    // Reporting traffic has its own bucket so it can never starve the website's resolve calls.
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

  app.setNotFoundHandler((_req, reply) => sendError(reply, "invalid_request"));

  // Health probes are unauthenticated and must not share the deployment rate-limit bucket.
  app.get("/healthz", { config: { rateLimit: false } }, async (_req, reply) => reply.code(200).send({ ok: true }));

  app.get("/readyz", { config: { rateLimit: false } }, async (_req, reply) => {
    let dbOk = false;
    try {
      dbOk = await deps.ping();
    } catch {
      dbOk = false;
    }
    // Not ready while every job slot is taken: a load balancer should prefer another instance.
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
    // opens /v1/resolve.
    const ok = isReportingRoute(matched) ? checkReportingCredential(req.headers["authorization"]) : checkCredential(req.headers["authorization"]);
    if (ok) return;
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

  app.post("/v1/resolve", async (req: FastifyRequest, reply: FastifyReply) => {
    const startedAt = now();
    const parsed = ResolveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn("request_rejected", { route: "/v1/resolve", error_code: "invalid_request", http_status: 400 });
      return sendError(reply, "invalid_request");
    }
    const body = parsed.data;
    const requestId = body.request_id;

    if (body.website_id !== config.WEBSITE_ID) {
      logger.warn("request_rejected", { route: "/v1/resolve", error_code: "forbidden", http_status: 403, ...(requestId ? { request_id: requestId } : {}) });
      return sendError(reply, "forbidden", requestId);
    }

    // Syntax check only; eligibility and canonical form are decided by the pipeline.
    const ipCheck = canonicaliseIp(body.ip);
    if (!ipCheck.ok) {
      logger.warn("request_rejected", { route: "/v1/resolve", error_code: "invalid_request", http_status: 400, ...(requestId ? { request_id: requestId } : {}) });
      return sendError(reply, "invalid_request", requestId);
    }

    const deadlineAtMs = startedAt + config.REQUEST_DEADLINE_MS;
    // The observation reference is the caller's idempotency key; a generated
    // one makes every request a separate observation (documented behaviour).
    const observationRef = body.observation_ref ?? generateObservationRef();
    let outcome: ResolutionOutcome;
    try {
      outcome = await answerByDeadline(runner.run({ ip: body.ip, deadlineAtMs, observationRef }), deadlineAtMs - now());
    } catch (err) {
      if (err instanceof RunnerOverloadedError) {
        logger.warn("request_rejected", { route: "/v1/resolve", error_code: "overloaded", http_status: 503 });
        return sendError(reply, "overloaded", requestId);
      }
      if (err instanceof RunnerStoppedError) {
        return sendError(reply, "not_ready", requestId);
      }
      logger.error("request_rejected", { route: "/v1/resolve", error_code: "internal", http_status: 500 });
      return sendError(reply, "internal", requestId);
    }

    const response = toResponse(outcome, requestId);
    logger.info("request_completed", {
      route: "/v1/resolve",
      http_status: 200,
      status: response.status,
      source: response.source,
      duration_ms: now() - startedAt,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(requestId ? { request_id: requestId } : {}),
      ...(response.company_id !== undefined ? { company_id: response.company_id, recorded: response.activity_recorded === true } : {}),
    });
    return reply.code(200).send(response);
  });

  if (deps.reporting && config.REPORTING_AUTH_TOKEN) {
    registerReportingRoutes(app, {
      scope: { installation_id: config.INSTALLATION_ID, website_id: config.WEBSITE_ID },
      reporting: deps.reporting,
      logger,
      sendError: (reply, error) => sendError(reply, error),
    });
  }

  return app;
}
