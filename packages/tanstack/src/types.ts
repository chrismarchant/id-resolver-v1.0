/** Closed acquisition enum of the `entrance.v1` contract. */
export const ACQUISITION_VALUES = ["direct", "search", "social", "email", "paid", "referral", "internal", "unknown"] as const;
export type Acquisition = (typeof ACQUISITION_VALUES)[number];

/** Id of the eligibility rule set implemented by this package (sent as `eligibility`). */
export const ELIGIBILITY_RULE_SET_ID = "tsa-1";

export const ENTRANCE_CONTRACT = "entrance.v1";

/**
 * How the adapter learns the client IP. Always explicit: there is no default,
 * because a wrong choice lets a visitor choose which IP the resolver looks up.
 */
export type TrustPolicy =
  /** Use `CF-Connecting-IP`. Only valid when the app runs on or behind Cloudflare, which overwrites the header. */
  | { mode: "cloudflare" }
  /** Use `X-Forwarded-For`, counting `trustedHops` trusted proxies from the right. */
  | { mode: "xff"; trustedHops: number }
  /** Use one single-valued header that a trusted proxy sets (and overwrites). */
  | { mode: "header"; name: string }
  /** Never read an IP; nothing is sent. */
  | { mode: "none" };

export type IpRejectReason =
  | "policy_none"
  | "header_missing"
  | "header_multiple"
  | "header_malformed"
  | "ip_malformed"
  | "ip_non_public"
  | "xff_too_few_hops"
  | "xff_too_long";

export type IpSelection = { ok: true; ip: string; family: 4 | 6 } | { ok: false; reason: IpRejectReason };

export interface EntrancePayload {
  contract: typeof ENTRANCE_CONTRACT;
  website_id: string;
  ip: string;
  entrance_id: string;
  occurred_at: string;
  page_key: string;
  acquisition: Acquisition;
  eligibility: typeof ELIGIBILITY_RULE_SET_ID;
}

export const EVENT_CONTRACT = "event.v1";

/**
 * Body of `POST /v1/events` (docs/contracts/event.v1.md, section 2). It has no IP, user-agent, referrer, cookie,
 * session, visitor, company or free-text field.
 */
export interface EventPayload {
  contract: typeof EVENT_CONTRACT;
  website_id: string;
  event_id: string;
  occurred_at: string;
  type: string;
  name: string;
  page_key: string;
  consent: "granted" | "not_required";
}

export const BOT_VISIT_CONTRACT = "bot-visit.v1";

/**
 * Body of `POST /v1/bot-visits` (docs/contracts/bot-visit.v1.md). It has no IP, full user-agent, referrer, cookie,
 * header, session or visitor field: only the bot's name and category from the package's bot list, one short product
 * token, the page key and the time.
 */
export interface BotVisitPayload {
  contract: typeof BOT_VISIT_CONTRACT;
  website_id: string;
  visit_id: string;
  occurred_at: string;
  page_key: string;
  bot_name: string;
  bot_category: string;
  user_agent_family: string;
}
