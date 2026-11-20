# Source comparison counters (`source-shadow.v1`)

A watch-only measurement of how three extra IP-intelligence sources would do
next to the existing Enrich lookup, so the owner can decide on a "waterfall"
(the cheaper sources first, Enrich only when they cannot decide). It never
changes how a visit is resolved, qualified or recorded, and it is off by
default (`SHADOW_SOURCES_MODE=off`).

```
cache miss ─▶ pipeline (unchanged) ─▶ Enrich (when enabled, within cap) ─▶ outcome
     │                                      │
     └▶ observe() ─▶ queue ─▶ ipapi.is ┐    └▶ complete(what Enrich did)
                              IPLocate ├─▶ compare ─▶ one upsert into source_shadow_counts
                              IPNetDB  ┘             (daily counts per metric)
GET /v1/reporting/source-shadow ◀── reporting credential
```

## What is stored

Daily aggregate counts only: one number per installation, website, UTC day
and metric name. No address, fingerprint, company name, domain or ASN is
stored or logged anywhere; the sources' answers exist in memory only for the
comparison of one address. Each address is measured at most once per UTC day
(later visits that day count as `dropped_duplicate`).

## Request

`GET /v1/reporting/source-shadow?from=YYYY-MM-DD&to=YYYY-MM-DD`

- Authorisation: `Bearer <REPORTING_AUTH_TOKEN>`. The website credential is refused (`401`).
- `from` and `to` are inclusive UTC calendar dates, at most 31 days, with the same rules as `/v1/reporting/activity`. Anything else is `400`.
- Scope (installation and website) comes from the deployment's configuration, never from the request.
- Served whether or not `SHADOW_SOURCES_MODE` is on: with nothing measured, `days` is empty.

## Response `200`

```json
{
  "version": "1",
  "scope": { "installation_id": "<installation>", "website_id": "<website>" },
  "from": "2026-11-16",
  "to": "2026-11-22",
  "days": [
    {
      "date": "2026-11-19",
      "metrics": {
        "observed": 40,
        "ipapi_requests": 40, "ipapi_business": 6, "ipapi_isp": 25, "ipapi_hosting": 5, "ipapi_mobile": 4,
        "iplocate_requests": 40, "iplocate_business": 5, "iplocate_isp": 28, "iplocate_hosting": 6, "iplocate_none": 1,
        "ipnetdb_found": 39, "ipnetdb_not_found": 1, "ipnetdb_corroborates": 31,
        "enrich_resolved_business": 4, "enrich_resolved_other": 9, "enrich_no_domain": 27,
        "waterfall_high": 4, "waterfall_medium": 2, "waterfall_vetoed": 9, "waterfall_conflict": 1, "waterfall_inconclusive": 24,
        "enrich_call_avoidable": 15, "enrich_call_needed": 25,
        "enrich_agrees": 4,
        "dropped_duplicate": 61
      }
    }
  ]
}
```

- **Sparse.** A day without any counter has no entry; a metric without a count that day is absent. Treat both as zero. Days are in date order.
- Every address counted in `observed` gets exactly one value of each group below (one `ipapi_*` verdict, one `iplocate_*` verdict, one `ipnetdb_*` verdict, one `enrich_*` category, one `waterfall_*` verdict, and `enrich_call_avoidable` or `enrich_call_needed`), so each group adds up to `observed`.

## Metrics

| metric | meaning |
| --- | --- |
| `observed` | Addresses measured: cache misses of eligible addresses, once per address and UTC day. Cache hits, pending lookups, ineligible addresses and addresses excluded by `HOSTING_RANGES_MODE=enforce` are never measured. |
| `ipapi_requests`, `iplocate_requests` | Requests counted against the daily limit (`SHADOW_IPAPI_DAILY_LIMIT`, `SHADOW_IPLOCATE_DAILY_LIMIT`), reserved atomically before each request is sent. |
| `<source>_business` | The source names an organisation (type business, education, government or banking) with a usable domain. |
| `<source>_business_no_domain` | The same without a usable domain. |
| `<source>_isp` | An internet provider's network. |
| `<source>_hosting` | A data centre or hosting network (veto). |
| `<source>_mobile` | A mobile network (veto; ipapi.is only, IPLocate has no mobile flag). |
| `<source>_anonymous` | VPN, proxy, Tor or relay traffic (veto). |
| `<source>_none` | No company and no telling type. |
| `<source>_error`, `_timeout`, `_quota`, `_auth` | The lookup failed: an error (network, 5xx, malformed answer), no answer within `SHADOW_TIMEOUT_MS`, the daily limit or the provider's quota reached (no request sent when the limit is reached locally), the key rejected. |
| `<source>_disabled` | The source has no key configured. |
| `ipnetdb_found`, `_not_found`, `_bogon`, `_unavailable`, `_disabled` | IPNetDB (a local copy of its prefix database): a record, none, a bogon prefix, the database not loaded yet, `IPNETDB_ENABLED=false`. |
| `ipnetdb_corroborates` | IPNetDB's prefix or AS organisation is the same organisation as a company named by ipapi.is, IPLocate or Enrich. |
| `hosting_range_matched` | The address is in a published cloud or crawler range (only with `HOSTING_RANGES_MODE=shadow`). Counts as a veto. |
| `enrich_resolved_business` | Enrich returned a domain the resolver qualified as a company. |
| `enrich_resolved_other` | Enrich returned a domain that was excluded or could not be qualified (an ISP, a host, an unknown usage type). |
| `enrich_no_domain`, `enrich_error`, `enrich_timeout` | Enrich found nothing, failed, or did not answer in time. |
| `enrich_not_called` | Enrich was not called: provider disabled, kill switch, cap reached, too little time left, a database error, or no answer from the pipeline within 30 s. |
| `waterfall_*` | The verdict below; exactly one per address. |
| `enrich_call_avoidable` | The waterfall would have decided without Enrich: `high`, `medium` or `vetoed`. |
| `enrich_call_needed` | Every other verdict. |
| `enrich_agrees`, `enrich_disagrees` | Enrich qualified a company and ipapi.is or IPLocate named a business domain: the same domain (or one a subdomain of the other) every time, or not. |
| `dropped_duplicate` | Visits of an address already measured that UTC day. |
| `dropped_overload` | Addresses not measured because the queue (`SHADOW_QUEUE_MAX`) was full. |

Business claims are a `business` verdict from ipapi.is or IPLocate and
Enrich's domain when it qualified. Vetoes are hosting, anonymous or mobile
from either source, or a published hosting range. The waterfall verdict is
decided in this order:

| verdict | when |
| --- | --- |
| `conflict` | A business claim together with a veto, or business claims naming different domains. |
| `vetoed` | A veto and no business claim. |
| `high` | Two or more claims name the same domain, at least one from ipapi.is or IPLocate. |
| `medium` | Exactly one claim, from ipapi.is or IPLocate. |
| `no_data` | ipapi.is and IPLocate both failed or are not configured, and IPNetDB is unavailable or disabled. |
| `inconclusive` | Otherwise: isp, none or business without a domain. Enrich would still be needed. A business only Enrich knew lands here. |

## Derived figures

- **Share of Enrich calls a waterfall could save:** `enrich_call_avoidable ÷ observed`.
- **Agreement with Enrich on companies:** `enrich_agrees ÷ (enrich_agrees + enrich_disagrees)`.
- **Companies a waterfall would lose:** look at `waterfall_conflict` and `waterfall_inconclusive` together with `enrich_resolved_business`.
- **Daily quota use:** `ipapi_requests` and `iplocate_requests` against the free tiers' 1,000 a day.

## Accuracy

- Counters are written beside the request, never delaying it; a database failure can lose a day's counts for one address (logged as `shadow_write_failed`). The request counters are exact.
- Counts are kept (not pruned by observation retention): they hold no identifier.
