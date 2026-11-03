import { z } from "zod";
import {
  IDENTIFIER_PATTERN,
  MAX_IP_LENGTH,
  OBSERVATION_REF_PATTERN,
  REPORTING_DEFAULT_LIMIT,
  REPORTING_MAX_LIMIT,
  REQUEST_ID_PATTERN,
} from "../contracts/api.js";

export const ResolveBodySchema = z
  .object({
    website_id: z.string().regex(IDENTIFIER_PATTERN),
    ip: z.string().min(1).max(MAX_IP_LENGTH),
    request_id: z.string().regex(REQUEST_ID_PATTERN).optional(),
    observation_ref: z.string().regex(OBSERVATION_REF_PATTERN).optional(),
  })
  .strict();

export type ResolveBody = z.infer<typeof ResolveBodySchema>;

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
export const CompanyIdParamSchema = z.object({ id: z.string().regex(/^[1-9]\d{0,15}$/) }).strict();
