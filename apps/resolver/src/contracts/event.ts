/**
 * Contract `event.v1` (docs/contracts/event.v1.md, Gate 4, CHR-64): the
 * website server relays a consent-gated browser event; the resolver stores
 * one row per event_id in `browser_events` and answers `{version, recorded}`.
 *
 * Owner decision D4: browser events are NEVER associated with companies. The
 * event path reads and writes `browser_events` only: never the fingerprint
 * cache, the company or activity tables, or the provider. No IP, user agent,
 * referrer, cookie, session, visitor or free-text field exists in this
 * contract, so none can be accepted, forwarded or stored.
 */
import { API_VERSION } from "./api.js";

/** The only contract version this resolver accepts on POST /v1/events. */
export const EVENT_CONTRACT = "event.v1" as const;

/**
 * The resolver's embedded copy of the closed vocabulary
 * `event-vocabulary.v1` (docs/contracts/event-vocabulary.v1.json, pending
 * owner approval in CHR-59). This object is the ONLY place the resolver
 * defines the vocabulary: the request schema and the route derive from it,
 * and test/unit/event-contract.test.ts asserts it equals the canonical file,
 * so adding or removing a name is a one-line edit here (plus the file).
 */
export const EVENT_VOCABULARY = {
  vocabulary: "event-vocabulary.v1",
  status: "approved by the owner on 3 Nov 2026 (CHR-59)",
  types: {
    page_view: ["page_view"],
    engagement: ["scroll_50", "scroll_90", "engaged_30s", "video_start", "video_complete", "file_download", "outbound_link"],
    conversion_intent: ["cta_click", "pricing_view", "contact_view", "demo_request_start", "form_start", "form_submit"],
  },
} as const;

export type EventType = keyof typeof EVENT_VOCABULARY.types;

/** True only for a (type, name) pair listed in the vocabulary. Never true for inherited keys such as `__proto__` or `constructor`. */
export function isVocabularyPair(type: string, name: string): boolean {
  if (!Object.hasOwn(EVENT_VOCABULARY.types, type)) return false;
  const names: readonly string[] = EVENT_VOCABULARY.types[type as EventType];
  return names.includes(name);
}

/** Consent as asserted by the website server: `granted`, or `not_required` where the site's policy needs none. */
export const EVENT_CONSENT_VALUES = ["granted", "not_required"] as const;
export type EventConsent = (typeof EVENT_CONSENT_VALUES)[number];

/** EVENT_CONSENT_MODE: `required` (default) refuses `consent: not_required` with 403 consent_required. */
export const EVENT_CONSENT_MODES = ["required", "not_required"] as const;
export type EventConsentMode = (typeof EVENT_CONSENT_MODES)[number];

/** event_id: random per event, generated in the browser; the idempotency key per (installation, website). */
export const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The complete response: an acknowledgement only. `recorded: false` means this event_id was already stored. */
export interface EventResponse {
  version: typeof API_VERSION;
  recorded: boolean;
}

/** One accepted event, as stored. installation_id and website_id come from deployment configuration. */
export interface BrowserEventRecord {
  installationId: string;
  websiteId: string;
  eventId: string;
  type: string;
  name: string;
  pageKey: string;
  consent: EventConsent;
  occurredAt: Date;
}

/**
 * Persistence for browser events. The implementation (src/db/event-repo.ts)
 * issues statements on `browser_events` only.
 */
export interface EventRepository {
  /** Inserts the event once per (installation, website, event_id). true when this call stored it, false for a repeat. */
  record(event: BrowserEventRecord): Promise<boolean>;
  /** One bounded retention batch: deletes at most `limit` events received before `cutoff`. Returns rows deleted. */
  pruneBefore(cutoff: Date, limit: number): Promise<number>;
}
