/**
 * POST /v1/bot-visits, contract bot-visit.v1 (docs/contracts/bot-visit.v1.md).
 * Registered by src/api/server.ts unless BOT_VISITS_ENABLED=false; then the
 * route does not exist and answers 404 like any unknown route.
 *
 * A bot visit is recorded for reporting only. This handler validates the
 * request and makes one insert through the bot visit repository, which touches
 * `bot_visits` only. It never calls the runner, the pipeline, the fingerprint
 * cache, a company or activity repository or the provider, and it imports none
 * of them. No IP, header or other request detail is read besides the
 * credential (checked by the server's onRequest hook, before the body is
 * parsed) and the validated body.
 *
 * Capacity: the route has its own rate-limit bucket (src/api/server.ts) and
 * its own write slots, with matching extra pool connections (src/main.ts), so
 * a crawler burst can never take capacity that entrance resolution needs. An
 * excess request is refused (429 or 503) and the website drops it.
 *
 * Order: strict schema (400) -> website_id (403 forbidden) -> occurred_at
 * within 300 s of resolver time (400) -> write slot (503 overloaded) ->
 * insert (503 not_ready on a database failure) -> 200 {version, recorded}.
 *
 * Logging: request_completed at debug level (a crawler can send many), and
 * request_rejected with the route, status, error code and a fixed reason.
 * The visit_id, page_key, bot name, user agent family, body and headers are
 * never logged.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_VERSION, OCCURRED_AT_MAX_SKEW_MS, parseOccurredAt, type ErrorCode } from "../contracts/api.js";
import type { BotVisitRepository, BotVisitResponse } from "../contracts/bot-visit.js";
import type { Logger } from "../log/index.js";
import { BotVisitBodySchema } from "./bot-visit-schema.js";

export const BOT_VISITS_ROUTE = "/v1/bot-visits";

/**
 * At most this many bot-visit inserts are in flight at once; one more is
 * refused with 503 overloaded. The service adds the same number of
 * connections to its pool when the route is enabled (src/main.ts).
 */
export const BOT_VISIT_WRITES_MAX_IN_FLIGHT = 4;

export interface BotVisitRouteDeps {
  /** Deployment scope; never taken from the request. */
  scope: { installationId: string; websiteId: string };
  botVisits: BotVisitRepository;
  logger: Logger;
  now: () => number;
  sendError: (reply: FastifyReply, error: ErrorCode) => FastifyReply;
  statusOf: (error: ErrorCode) => number;
}

type RejectReason = "schema" | "website_id" | "occurred_at" | "capacity" | "database";

export function registerBotVisitRoute(app: FastifyInstance, deps: BotVisitRouteDeps): void {
  const { scope, botVisits, logger, now, sendError, statusOf } = deps;
  let inFlight = 0;

  const reject = (reply: FastifyReply, error: ErrorCode, reason: RejectReason): FastifyReply => {
    logger.warn("request_rejected", { route: BOT_VISITS_ROUTE, error_code: error, http_status: statusOf(error), reason });
    return sendError(reply, error);
  };

  app.post(BOT_VISITS_ROUTE, async (req: FastifyRequest, reply: FastifyReply) => {
    const startedAt = now();
    const parsed = BotVisitBodySchema.safeParse(req.body);
    if (!parsed.success) return reject(reply, "invalid_request", "schema");
    const body = parsed.data;

    if (body.website_id !== scope.websiteId) return reject(reply, "forbidden", "website_id");

    // Bounds replay of a captured request to a window around resolver time, as for entrances.
    const occurredAt = parseOccurredAt(body.occurred_at);
    if (occurredAt === null || Math.abs(startedAt - occurredAt) > OCCURRED_AT_MAX_SKEW_MS) return reject(reply, "invalid_request", "occurred_at");

    if (inFlight >= BOT_VISIT_WRITES_MAX_IN_FLIGHT) return reject(reply, "overloaded", "capacity");
    inFlight += 1;
    let recorded: boolean;
    try {
      recorded = await botVisits.record({
        installationId: scope.installationId,
        websiteId: scope.websiteId,
        visitId: body.visit_id,
        observedAt: new Date(occurredAt),
        pageKey: body.page_key,
        botName: body.bot_name,
        botCategory: body.bot_category,
        userAgentFamily: body.user_agent_family,
      });
    } catch {
      // The repository already logged db_error{category}; nothing of the request is logged.
      return reject(reply, "not_ready", "database");
    } finally {
      inFlight -= 1;
    }

    const response: BotVisitResponse = { version: API_VERSION, recorded: recorded === true };
    logger.debug("request_completed", { route: BOT_VISITS_ROUTE, http_status: 200, recorded: response.recorded, duration_ms: now() - startedAt });
    return reply.code(200).send(response);
  });
}
