# Contract `event.v1`: optional browser collector → website → resolver

Status: **frozen interface for Gate 4 implementation; the event vocabulary is
approved by the owner on 3 Nov 2026 (CHR-59)**. This contract is additive. It
does not change `entrance.v1` or `reporting-feed.v1`. The "Clarifications"
section at the end corrects how the frozen interface may be relied on; it
does not change the wire.

## Owner constraints (D4, 3 Nov 2026)

* **No company association.** Browser events are stored with `origin=browser`
  and are **never** joined to companies, by any means.
  * The event path never reads the fingerprint cache, the company tables or
    company observations, and it never calls a provider.
  * There is no inactive or feature-flagged matching code.
* **No identifiers.**
  * No IP is forwarded or stored for browser events.
  * No fingerprinting, no session or visitor identifier, no cookies.
  * No raw form values, text, DOM capture or session recording.
* **Consent-gated** and limited to the closed vocabulary below. The server
  enforces policy whatever the browser claims.

## Flow

```
Browser (@salescrusader/idr-collector)
  ── POST same-origin first-party route (no credentials, no cookies needed) ──▶
Website server (@salescrusader/idr-tanstack createCollectorRoute)
  checks Origin and Sec-Fetch-Site, size, rate, replay window, vocabulary and consent policy
  normalises page_key with the site's page-key mapper; drops every other field
  ── POST /v1/events with the server-held website token (non-blocking) ──▶
Resolver: validates again, stores one row per event_id in browser_events
```

## 1. Browser → first-party route (site-defined path, e.g. `/_idr/e`)

Body: JSON, at most 1 KiB, content type `application/json` or `text/plain`
(the latter for `sendBeacon`). Unknown fields are rejected.

| Field | Rule |
|---|---|
| `v` | `1` |
| `event_id` | `^[A-Za-z0-9_-]{16,64}$`, random per event (generated with `crypto.getRandomValues`) |
| `occurred_at` | RFC 3339 UTC timestamp |
| `type` | a vocabulary type |
| `name` | a vocabulary name for that type, within the site's allowlist |
| `path` | the page path only. The route rejects any query or fragment, and normalises it into `page_key` with the site's mapper; the browser value is never forwarded as-is. |
| `consent` | `granted \| not_required` |

The route answers `204` (accepted for background delivery) or a bare `4xx`. The
response carries no body and no `Set-Cookie`.

## 2. Website server → resolver: `POST /v1/events`

`Authorization: Bearer <RESOLVER_AUTH_TOKEN>` (the website credential). The
route exists **only** when the resolver's `EVENTS_ENABLED=true`. Otherwise it
answers `404` as an unknown route (default off).

| Field | Rule |
|---|---|
| `contract` | `"event.v1"` |
| `website_id` | must equal the deployment's `WEBSITE_ID` (otherwise `403`) |
| `event_id` | `^[A-Za-z0-9_-]{16,64}$`. The idempotency key per (installation, website). |
| `occurred_at` | RFC 3339 UTC; rejected (`400`) if more than 300 s from resolver time |
| `type`, `name` | must be in the vocabulary (otherwise `400`) |
| `page_key` | same rule as `entrance.v1` (path only, at most 256 characters) |
| `consent` | `granted \| not_required`. Under `EVENT_CONSENT_MODE=required` (the default), `not_required` is rejected with `403 consent_required`. |

**The request has no IP, user-agent, referrer, cookie, session, visitor,
company or free-text field.** The schema is strict, so any such field gives
`400`.

Response `200`: `{ "version": "1", "recorded": true }`. A repeated `event_id`
is not stored twice; the repeat answers `200` with `recorded: false`.

Errors use the existing mapping: `400 invalid_request`, `401 unauthorized`,
`403 forbidden | consent_required`, `413`, `429`, `503`, `500`. The body is
`{ "version": "1", "error": "<code>" }`.

## Storage and retention

* **Columns.** One row per accepted event in `browser_events`: `installation_id`,
  `website_id`, `event_id`, `type`, `name`, `page_key`, `consent`,
  `occurred_at`, `received_at`, and `origin = 'browser'` (enforced by a
  constraint).
* **No other data.** There is no company, IP, fingerprint or observation
  reference.
* **Retention.** Rows are pruned within the same bounded synchronisation buffer
  as observations (`OBSERVATION_RETENTION_DAYS`), by the bounded maintenance
  drain.
* **Reporting.** Browser events are **not** exposed through
  `reporting-feed.v1`. How they reach Insights (for example an aggregate-only
  summary) is a separate owner decision. It is not part of this contract.

## Reporting: `GET /v1/reporting/events`

Read-only, for the BigQuery sync (`integrations/bigquery-sync`, table `browser_events`):
`GET /v1/reporting/events?from=YYYY-MM-DD&to=YYYY-MM-DD[&limit=1-1000][&cursor=...]`.

* The reporting credential only (the website credential is refused). Served whatever `EVENTS_ENABLED` says: it only
  reads what is stored.
* `from` and `to` are inclusive UTC dates of `occurred_at`, at most 31 days; `limit` defaults to 500; keyset pages on
  `(occurred_at, id)`, follow `next_cursor` until it is `null`.
* Each item is exactly `{occurred_at, page_key, type, name, consent}`. The `event_id` is not returned. The statements
  read `browser_events` alone (index `browser_events_report_idx`, migration 0013), never a company-side table (D4).

## Vocabulary `event-vocabulary.v1` (approved by the owner, 3 Nov 2026, CHR-59)

The canonical list is
[`event-vocabulary.v1.json`](event-vocabulary.v1.json). Every package embeds a
copy, and a test asserts it matches this file.

| Type | Names | Meaning (no values are ever captured) |
|---|---|---|
| `page_view` | `page_view` | an SPA route change or initial view |
| `engagement` | `scroll_50`, `scroll_90` | page scrolled past 50% or 90% (at most once per page view) |
| | `engaged_30s` | page visible and active for 30 s |
| | `video_start`, `video_complete` | an element marked `data-idr-event` |
| | `file_download`, `outbound_link` | a click on a marked link; the URL is **not** captured |
| `conversion_intent` | `cta_click`, `pricing_view`, `contact_view`, `demo_request_start` | a marked element or route |
| | `form_start`, `form_submit` | first focus or submit of a form marked `data-idr-form`; field values are **never** read |

The site allowlist is a subset of the vocabulary. Adding a name or type
requires a new vocabulary version.

## Clarifications

### Clarification (CHR-66 G4-I1): browser events are forgeable telemetry

**No wire change.** The fields, rules, vocabulary, status codes and storage
above are unchanged. This states what a browser event can and cannot be
trusted for.

* **Anyone can send one.** `Origin` and `Sec-Fetch-Site` checks stop a
  browser from posting cross-site; they do not stop a script or a server,
  which can set `Origin` to the site's own origin. Such a client can post
  plausible events through the first-party route: any allowlisted name, any
  path, `consent: "granted"`, a fresh `event_id` each time.
* **This is inherent to D4, not a defect.** The route has no visitor identity,
  session, cookie or IP to authenticate or key a sender by, and must not get
  one. The resolver's `/v1/events` needs the website token, which stays on
  the website's server, so a sender without it goes through the site's
  route; but that route is public.
* **What bounds it:** the closed vocabulary and the site allowlist; the consent
  policy (a sender can claim consent, and `Sec-GPC: 1` is always refused); the
  `occurred_at` window and the replay cache; the 1 KiB body; the route's
  per-instance rate budget and the resolver's separate `events` rate bucket and
  in-flight limit. The rate budget is not per client, so one sender can also
  use it up and crowd out real events (availability, not integrity). Forged
  events are stored like real ones and, like them, are never joined to a
  company. The entrance path (`entrance.v1`) is unaffected: it is a different
  route with its own bucket.
* **Therefore browser events must never be used for security or billing
  decisions**: not for access control, fraud or abuse detection, rate limiting
  of anyone, invoicing, contractual or performance metrics, or any decision
  about a person or a company. Treat them as indicative, aggregate telemetry
  that may contain noise.
