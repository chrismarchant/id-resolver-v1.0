/**
 * POST /v1/events, contract event.v1 (docs/contracts/event.v1.md, Gate 4,
 * CHR-64). Registered by src/api/server.ts only when EVENTS_ENABLED=true;
 * otherwise the route does not exist and answers 404 like any unknown route.
 *
 * Owner decision D4: browser events are never associated with companies.
 * This handler validates the request and makes one insert through the event
 * repository, which touches `browser_events` only. It never calls the
 * runner, the pipeline, the fingerprint cache, a company or activity
 * repository or the provider, and it imports none of them
 * (test/integration/events-isolation.test.ts checks the imports, every
 * statement issued, and runs the route under a database role that can reach
 * browser_events only). No IP, header or other request detail is read
 * besides the credential (checked by the server's onRequest hook, before the
 * body is parsed) and the validated body.
 *
 * Order: strict schema and vocabulary (400) -> website_id (403 forbidden)
 * -> occurred_at within 300 s of resolver time (400) -> consent policy (403
 * consent_required) -> write slot (503 overloaded) -> insert (503 not_ready
 * on a database failure) -> 200 {version, recorded}.
 *
 * Logging: only the allowlisted events request_completed / request_rejected
 * with the route, status, error code, a fixed reason and `recorded`. The
 * event_id, page_key, type, name, body and headers are never logged.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_VERSION, OCCURRED_AT_MAX_SKEW_MS, parseOccurredAt, type ErrorCode } from "../contracts/api.js";
import type { EventConsentMode, EventRepository, EventResponse } from "../contracts/event.js";
import type { Logger } from "../log/index.js";
import { EventBodySchema } from "./schema.js";

export const EVENTS_ROUTE = "/v1/events";

/**
 * At most this many event inserts are in flight at once; one more is refused
 * with 503 overloaded. The service adds the same number of connections to its
 * pool when events are enabled (src/main.ts), so event writes can never take
 * a connection that resolution jobs are sized for.
 */
export const EVENT_WRITES_MAX_IN_FLIGHT = 4;

export interface EventRouteDeps {
  /** Deployment scope; never taken from the request. */
  scope: { installationId: string; websiteId: string };
  consentMode: EventConsentMode;
  events: EventRepository;
  logger: Logger;
  now: () => number;
  sendError: (reply: FastifyReply, error: ErrorCode) => FastifyReply;
  statusOf: (error: ErrorCode) => number;
}

type RejectReason = "schema" | "website_id" | "occurred_at" | "consent" | "capacity" | "database";

export function registerEventRoute(app: FastifyInstance, deps: EventRouteDeps): void {
  const { scope, consentMode, events, logger, now, sendError, statusOf } = deps;
  let inFlight = 0;

  const reject = (reply: FastifyReply, error: ErrorCode, reason: RejectReason): FastifyReply => {
    logger.warn("request_rejected", { route: EVENTS_ROUTE, error_code: error, http_status: statusOf(error), reason });
    return sendError(reply, error);
  };

  app.post(EVENTS_ROUTE, async (req: FastifyRequest, reply: FastifyReply) => {
    const startedAt = now();
    const parsed = EventBodySchema.safeParse(req.body);
    if (!parsed.success) return reject(reply, "invalid_request", "schema");
    const body = parsed.data;

    if (body.website_id !== scope.websiteId) return reject(reply, "forbidden", "website_id");

    // Bounds replay of a captured request to a window around resolver time, as for entrances.
    const occurredAt = parseOccurredAt(body.occurred_at);
    if (occurredAt === null || Math.abs(startedAt - occurredAt) > OCCURRED_AT_MAX_SKEW_MS) return reject(reply, "invalid_request", "occurred_at");

    // The server enforces the consent policy whatever the browser or website claims.
    if (consentMode === "required" && body.consent !== "granted") return reject(reply, "consent_required", "consent");

    if (inFlight >= EVENT_WRITES_MAX_IN_FLIGHT) return reject(reply, "overloaded", "capacity");
    inFlight += 1;
    let recorded: boolean;
    try {
      recorded = await events.record({
        installationId: scope.installationId,
        websiteId: scope.websiteId,
        eventId: body.event_id,
        type: body.type,
        name: body.name,
        pageKey: body.page_key,
        consent: body.consent,
        occurredAt: new Date(occurredAt),
      });
    } catch {
      // The repository already logged db_error{category}; nothing of the request is logged.
      return reject(reply, "not_ready", "database");
    } finally {
      inFlight -= 1;
    }

    const response: EventResponse = { version: API_VERSION, recorded: recorded === true };
    logger.info("request_completed", { route: EVENTS_ROUTE, http_status: 200, recorded: response.recorded, duration_ms: now() - startedAt });
    return reply.code(200).send(response);
  });
}
