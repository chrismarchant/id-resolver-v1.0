# Contract `entrance.v1` — website server → resolver

Status: **frozen for Gate 2/3 implementation** (owner decision D2). Changes
require a new contract version.

`POST /v1/entrances` · `Authorization: Bearer <RESOLVER_AUTH_TOKEN>` ·
`Content-Type: application/json` · body ≤ `BODY_LIMIT_BYTES`.

Called only by the website's **server** (never a browser), for each eligible
document request. It replaces the inherited V0.1 `POST /v1/resolve`, which is
removed because it returns company data to the website.

## Request (strict: unknown fields are rejected)

| Field | Type / rule | Notes |
|---|---|---|
| `contract` | `"entrance.v1"` | exact |
| `website_id` | `^[a-z0-9][a-z0-9-]{0,62}$` | must equal the deployment's `WEBSITE_ID` (else 403) |
| `ip` | string ≤ 64 chars, IPv4/IPv6 literal | the trusted client IP chosen by the adapter's trust policy; transient, never stored |
| `entrance_id` | `^[A-Za-z0-9_-]{16,64}$` | random, generated server-side per entrance; the idempotency key (a repeat never records a second observation) |
| `occurred_at` | RFC 3339 UTC timestamp | rejected (400) if more than 300 s from resolver time: bounds replay of captured requests |
| `page_key` | 1–256 chars, starts with `/`, no `?`, `#`, whitespace or control chars | normalised path only |
| `acquisition` | `direct \| search \| social \| email \| paid \| referral \| internal \| unknown` | derived by the adapter from the referrer **host** and `utm_medium`; raw values are never sent |
| `eligibility` | `^[a-z0-9][a-z0-9.-]{0,31}$` | id of the adapter rule set that admitted the request (e.g. `tsa-1`) |

## Response `200`

```json
{ "version": "1", "status": "qualified", "source": "cache", "recorded": true }
```

| Field | Meaning |
|---|---|
| `status` | one of `qualified, no_match, excluded, unknown, pending, ineligible, disabled, uncertain, unavailable` (unchanged from V0.1) |
| `source` | `cache \| provider \| none` |
| `recorded` | `true` only when a company observation was **confirmed** durably recorded for this `entrance_id` before the answer (qualified outcomes only, including cache hits). `false` means **"not confirmed within the deadline"**, not "not stored": an observation write still running at the deadline is not cancelled and may commit after the answer, in which case the observation exists and the reporting feed serves it. Repeating the `entrance_id` never records a second observation. |

**The response never contains company identity, a company id, an IP, a
fingerprint or provider data** (D2). Every status lets the website continue
unchanged.

## Errors

The V0.1 mapping is unchanged: `400 invalid_request`, `401 unauthorized`,
`403 forbidden`, `413 payload_too_large`, `429 rate_limited`,
`503 overloaded | not_ready`, `500 internal`. The body is
`{ "version": "1", "error": "<code>" }`, with no messages, stack traces or
echoed input.

## Stored per qualified entrance

`company_id`, `observed_at` (resolver clock), `observation_ref`
(= `entrance_id`), `source` (cache/provider), `page_key`, `acquisition`,
`entrance_contract`, `eligibility`, `txid` (feed position). Nothing else is
stored: no IP, header, user agent, referrer or query string.
