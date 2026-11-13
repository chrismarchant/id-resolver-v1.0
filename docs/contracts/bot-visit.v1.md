# Bot and crawler visits (`bot-visit.v1`)

Visits from known bots and crawlers, recorded for reporting (which AI crawlers,
search engines, SEO tools, link previewers and monitors fetch which pages). A
bot visit is never resolved, never associated with a company and never counted
as an entrance. Human traffic is not affected: the website sends nothing for a
request that is not a known bot.

```
Bot request ─▶ website server (TanStack Start)
                 createBotVisitMiddleware (before createIdrServerMiddleware)
                   matches User-Agent against KNOWN_BOTS (packages/tanstack/src/known-bots.ts)
                   after next(): GET/HEAD answered 2xx or 304, not a framework path or page resource
                 ─▶ POST /v1/bot-visits (waitUntil, never blocking the page)
Resolver       ─▶ one INSERT into bot_visits (never the runner, cache, company tables or provider)
BigQuery sync  ─▶ GET /v1/reporting/bot-visits once a day ─▶ <dataset>.bot_visits (day partitions)
```

## What is never sent or stored

No IP address, no full user agent, no cookie, no other header, no referrer, no
query string. The website reads the `User-Agent` header only to choose a name
from its list and to cut out one product token (`user_agent_family`, letters,
digits, `_` and `-`, without the version). The resolver refuses any other field.

## `POST /v1/bot-visits`

- Authorisation: `Bearer <RESOLVER_AUTH_TOKEN>` (the website credential). The reporting credential is refused (`401`).
- Exists unless `BOT_VISITS_ENABLED=false` (default `true`); otherwise it answers `404` like any unknown route.

```json
{
  "contract": "bot-visit.v1",
  "website_id": "<website>",
  "visit_id": "<16-64 of A-Z a-z 0-9 _ ->",
  "occurred_at": "2026-11-10T09:00:00Z",
  "page_key": "/blog/:slug",
  "bot_name": "Googlebot",
  "bot_category": "search_engine",
  "user_agent_family": "Googlebot-Image"
}
```

| field | rule |
|---|---|
| `contract` | exactly `bot-visit.v1` |
| `website_id` | must equal the resolver's `WEBSITE_ID` (else `403`) |
| `visit_id` | random per visit; a repeat (a retried delivery) is acknowledged and not stored again |
| `occurred_at` | RFC 3339 UTC, within 300 s of resolver time (else `400`); stored as `observed_at` |
| `page_key` | the normalised path, the same rule as entrances (1-256 characters, starts with `/`, no `?`, `#`, whitespace or control characters) |
| `bot_name` | `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$`, a name from the website's list |
| `bot_category` | one of `ai_crawler`, `ai_search`, `ai_assistant`, `search_engine`, `seo_tool`, `social_preview`, `monitoring`, `other` (`ai_search` and `ai_assistant` since resolver migration 0014; website packages before `0.1.0-dev.3` send `ai_crawler` for every AI bot, which stays valid) |
| `user_agent_family` | `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$` |

Any other field is `400`. The resolver checks shapes and the category set only:
the list of bots lives on the website (`KNOWN_BOTS`), so adding a bot needs no
resolver change.

Response `200`: `{ "version": "1", "recorded": true }` (`false` for a repeated
`visit_id`). Errors: `400 invalid_request`, `401`, `403 forbidden`, `429
rate_limited`, `503 overloaded` (more than 4 writes in flight), `503 not_ready`
(database failure). The website drops a visit on any error; there is no queue.

Capacity: the route has its own rate-limit bucket (`RATE_LIMIT_PER_MINUTE`) and
its own 4 write slots with 4 extra pool connections, so a crawler burst can
never take capacity that entrance resolution needs.

## `GET /v1/reporting/bot-visits`

`GET /v1/reporting/bot-visits?from=YYYY-MM-DD&to=YYYY-MM-DD[&limit=1-1000][&cursor=...]`

- Authorisation: `Bearer <REPORTING_AUTH_TOKEN>`. The website credential is refused.
- `from` and `to`: inclusive UTC dates of `observed_at`, at most 31 days. `limit` defaults to 500.
- Ordered by `observed_at`, then storage order; follow `next_cursor` until it is `null`.

```json
{
  "version": "1",
  "scope": { "installation_id": "<installation>", "website_id": "<website>" },
  "from": "2026-11-09",
  "to": "2026-11-09",
  "items": [
    { "observed_at": "2026-11-09T09:00:00.000Z", "page_key": "/blog/:slug", "bot_name": "Googlebot", "bot_category": "search_engine", "user_agent_family": "Googlebot-Image" }
  ],
  "next_cursor": null
}
```

A visit can arrive up to five minutes after its `observed_at`, so read a day
only after it has ended plus a margin (the BigQuery sync waits until 00:15 UTC).

## Storage and retention

Table `bot_visits` (migration 0012): no foreign key, no trigger, not part of
the observation feed. Rows older than `OBSERVATION_RETENTION_DAYS`, by the
resolver's own `received_at` clock, are deleted by the maintenance drain with
browser events (and by `npm run ops:prune`). The BigQuery table keeps the full
history.
