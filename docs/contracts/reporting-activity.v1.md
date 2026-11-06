# Reporting API: daily activity (`GET /v1/reporting/activity`)

Read-only usage counts per period, for dashboards that compare the visits sent
to the resolver with what it resolved. Counts only: no address, fingerprint,
company or visitor identifier.

## Request

`GET /v1/reporting/activity?from=YYYY-MM-DD&to=YYYY-MM-DD`

- Authorisation: `Bearer <REPORTING_AUTH_TOKEN>`. The website credential is refused.
- `from` and `to` are inclusive UTC calendar dates, at most 366 days apart, with the same rules as `/v1/reporting/summary`. Anything else is `400`.
- Scope (installation and website) comes from the deployment's configuration, never from the request.

## Response `200`

```json
{
  "version": "1",
  "scope": { "installation_id": "<installation>", "website_id": "<website>" },
  "period": "day",
  "from": "2026-11-05",
  "to": "2026-11-06",
  "items": [
    {
      "period_key": "2026-11-05",
      "visits_submitted": 81,
      "outcomes": {
        "qualified": 3, "no_match": 15, "excluded": 0, "unknown": 0, "pending": 3,
        "ineligible": 0, "disabled": 60, "uncertain": 0, "unavailable": 0
      },
      "cache_hits": 4,
      "provider_lookups": 14,
      "domains_found": 2,
      "charged_lookups": 2,
      "company_visits": 3,
      "company_first_visits": 2
    }
  ]
}
```

- `period` is the deployment's `USAGE_PERIOD`. With `day`, each item is one UTC day. With `month`, each item is a month (`YYYY-MM`) that the requested dates touch.
- **Rows are sparse.** A period with no activity has no item; treat it as zeros. Items are in key order.

| field | meaning |
| --- | --- |
| `visits_submitted` | Entrances the website sent to the resolver: one per page navigation from browser-like traffic. Known bots and monitors are dropped by the website adapter before sending and are not counted. A visit is a page entrance, not a session or a person. |
| `outcomes` | Each entrance counted once, by its final status (`entrance.v1` statuses). The values add up to `visits_submitted`. A cache hit and a fresh lookup count under the same status. |
| `cache_hits` | Entrances answered from a fresh cache row, with no provider call. |
| `provider_lookups` | Provider (Enrich) calls made. |
| `domains_found` | Provider calls that returned a domain: a company, a network owner such as an ISP or host, or one that could not be qualified. |
| `charged_lookups` | Calls holding a charge slot against `PERIOD_RESOLVED_CAP`: charged, or possibly charged. |
| `company_visits` | Company observations newly recorded (qualified entrances whose activity was written). |
| `company_first_visits` | Of those, the company's first observation in this scope. Returning-company visits are `company_visits − company_first_visits`. |

## Derived figures

- **Company resolution rate:** `outcomes.qualified ÷ visits_submitted`. To exclude private or invalid addresses and paused lookups, divide by `visits_submitted − outcomes.ineligible − outcomes.disabled` instead.
- **Returning share:** `(company_visits − company_first_visits) ÷ company_visits`.
- **Filtered before the resolver:** raw page views from the website's own analytics minus `visits_submitted`. This estimates bots plus other traffic the adapter does not send; it is not an exact bot count.

## Accuracy and history

- Counters are best-effort. They are written beside the request, never delaying the answer, so a database failure can lose an increment. `provider_lookups` and `charged_lookups` are reserved atomically before each provider call and are exact.
- `outcomes`, `company_visits` and `company_first_visits` start at zero from the deployment of migration 0011.
- `visits_submitted`, `cache_hits`, `provider_lookups` and `domains_found` go back to the start of the deployment.
- Usage periods are not pruned by observation retention.
