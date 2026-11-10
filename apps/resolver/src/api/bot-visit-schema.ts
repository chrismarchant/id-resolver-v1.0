/**
 * Request schema of POST /v1/bot-visits, kept apart from src/api/schema.ts so
 * that the event route's import closure (test/integration/events-isolation)
 * and the bot visit route's stay separate.
 */
import { z } from "zod";
import { IDENTIFIER_PATTERN, isValidPageKey, OCCURRED_AT_PATTERN, parseOccurredAt } from "../contracts/api.js";
import { BOT_CATEGORIES, BOT_NAME_PATTERN, BOT_VISIT_CONTRACT, BOT_VISIT_ID_PATTERN, USER_AGENT_FAMILY_PATTERN } from "../contracts/bot-visit.js";

/**
 * POST /v1/bot-visits body, contract bot-visit.v1 (docs/contracts/bot-visit.v1.md).
 * Strict: unknown fields are rejected, so no IP, full user agent, referrer,
 * cookie, header, session or visitor field can be accepted. bot_name and
 * user_agent_family are short tokens, bot_category one of the closed set. The
 * occurred_at skew bound and the website_id match need deployment state and
 * are checked by the route.
 */
export const BotVisitBodySchema = z
  .object({
    contract: z.literal(BOT_VISIT_CONTRACT),
    website_id: z.string().regex(IDENTIFIER_PATTERN),
    visit_id: z.string().regex(BOT_VISIT_ID_PATTERN),
    occurred_at: z
      .string()
      .max(40)
      .regex(OCCURRED_AT_PATTERN)
      .refine((v) => parseOccurredAt(v) !== null),
    page_key: z.string().min(1).max(1_024).refine(isValidPageKey),
    bot_name: z.string().regex(BOT_NAME_PATTERN),
    bot_category: z.enum(BOT_CATEGORIES),
    user_agent_family: z.string().regex(USER_AGENT_FAMILY_PATTERN),
  })
  .strict();

export type BotVisitBody = z.infer<typeof BotVisitBodySchema>;
