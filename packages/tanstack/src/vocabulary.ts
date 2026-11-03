/**
 * The one embedded copy of `docs/contracts/event-vocabulary.v1.json` in this
 * package. `test/vocabulary.test.ts` asserts that it equals the canonical file
 * exactly. Do not edit it by hand: a new name or type needs a new vocabulary
 * version in the contract first.
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
export type EventName = (typeof EVENT_VOCABULARY.types)[EventType][number];
