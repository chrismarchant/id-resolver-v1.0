import { z } from "zod";
import {
  ACQUISITION_CLASSES,
  ELIGIBILITY_PATTERN,
  ENTRANCE_CONTRACT,
  ENTRANCE_ID_PATTERN,
  IDENTIFIER_PATTERN,
  isValidPageKey,
  MAX_IP_LENGTH,
  OCCURRED_AT_PATTERN,
  parseOccurredAt,
  REPORTING_DEFAULT_LIMIT,
  REPORTING_MAX_LIMIT,
} from "../contracts/api.js";
import { EVENT_CONSENT_VALUES, EVENT_CONTRACT, EVENT_ID_PATTERN, isVocabularyPair } from "../contracts/event.js";

/**
 * POST /v1/entrances body, contract entrance.v1 (docs/contracts/entrance.v1.md).
 * Strict: unknown fields are rejected. The occurred_at clock-skew bound needs
 * the resolver clock and is checked by the route handler.
 */
export const EntranceBodySchema = z
  .object({
    contract: z.literal(ENTRANCE_CONTRACT),
    website_id: z.string().regex(IDENTIFIER_PATTERN),
    ip: z.string().min(1).max(MAX_IP_LENGTH),
    entrance_id: z.string().regex(ENTRANCE_ID_PATTERN),
    occurred_at: z
      .string()
      .max(40)
      .regex(OCCURRED_AT_PATTERN)
      .refine((v) => parseOccurredAt(v) !== null),
    page_key: z.string().min(1).max(1_024).refine(isValidPageKey),
    acquisition: z.enum(ACQUISITION_CLASSES),
    eligibility: z.string().regex(ELIGIBILITY_PATTERN),
  })
  .strict();

export type EntranceBody = z.infer<typeof EntranceBodySchema>;

/**
 * POST /v1/events body, contract event.v1 (docs/contracts/event.v1.md).
 * Strict: unknown fields are rejected, so no IP, user agent, referrer,
 * cookie, session, visitor, company or free-text field can be accepted (D4).
 * type and name must form a pair of the embedded vocabulary
 * (src/contracts/event.ts). The occurred_at skew bound, the website_id match
 * and the consent policy need deployment state and are checked by the route.
 */
export const EventBodySchema = z
  .object({
    contract: z.literal(EVENT_CONTRACT),
    website_id: z.string().regex(IDENTIFIER_PATTERN),
    event_id: z.string().regex(EVENT_ID_PATTERN),
    occurred_at: z
      .string()
      .max(40)
      .regex(OCCURRED_AT_PATTERN)
      .refine((v) => parseOccurredAt(v) !== null),
    type: z.string().max(32),
    name: z.string().max(32),
    page_key: z.string().min(1).max(1_024).refine(isValidPageKey),
    consent: z.enum(EVENT_CONSENT_VALUES),
  })
  .strict()
  .refine((b) => isVocabularyPair(b.type, b.name));

export type EventBody = z.infer<typeof EventBodySchema>;

// ---- Reporting query parameters (all optional, all bounded) ----------------

const limit = z.coerce.number().int().min(1).max(REPORTING_MAX_LIMIT).default(REPORTING_DEFAULT_LIMIT);
/** Opaque cursor as issued by the API: base64url of a small JSON object, at most 128 characters. */
const cursor = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional();
/** UTC calendar date. */
export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const date = z.string().regex(DATE_PATTERN);

/** Company listing order: `id` (stable enumeration, default) or `recent` (display order, not stable across pages). */
const order = z.enum(["id", "recent"]).default("id");
export const CompaniesQuerySchema = z.object({ limit, cursor, order }).strict();
export const ObservationsQuerySchema = z.object({ limit, cursor }).strict();
export const SummaryQuerySchema = z.object({ from: date, to: date }).strict();
export const ActivityQuerySchema = SummaryQuerySchema;
export const CompanyIdParamSchema = z.object({ id: z.string().regex(/^[1-9]\d{0,15}$/) }).strict();
