# BigQuery sync

A scheduled Cloud Run job that copies the resolver's company observations and its daily visit counts into BigQuery, so they can be charted and queried next to other website analytics (for example GA4 and PostHog exports in the same location).

It reads four read-only reporting routes with the reporting token: the feed (`reporting-feed.v1`, `GET /v1/reporting/observations`), the daily activity counts (`reporting-activity.v1`, `GET /v1/reporting/activity`) and, once a day, bot and crawler visits (`bot-visit.v1`, `GET /v1/reporting/bot-visits`) and browser events (`event.v1`, `GET /v1/reporting/events`). The resolver never calls out.

## How it works

Every run:

1. reads the whole feed from the oldest retained item, 500 per page;
2. drops every observation of a company that has a `company_erased` item, matched by `company_id`;
3. replaces the table in one `WRITE_TRUNCATE` load job, or truncates it when there are no rows;
4. then reads the activity counts for the last 366 UTC days and replaces `<dataset>.daily_activity` the same way.

A failed visit sync stops the run before the counts. A resolver that does not serve the activity route yet (HTTP 404) skips the counts and the run still succeeds; any other activity failure fails the run, with the visit table already replaced.

Because the visit table is replaced in full, it always mirrors the resolver: its retention (`OBSERVATION_RETENTION_DAYS`) and its erasures carry over, and a missed run is repaired by the next one. No cursor or state is kept.

A failed feed read writes nothing, so the previous table stays in place. Logs contain counts only: no company names, domains or tokens.

## Table

`<dataset>.company_visits`, one row per company visit (page entrance):

| column | type | notes |
| --- | --- | --- |
| `observation_id` | STRING | resolver observation id |
| `company_id` | INT64 | never reused, even after an erasure |
| `domain` | STRING | |
| `organisation_name` | STRING | null when unknown |
| `observed_at` | TIMESTAMP | UTC |
| `method` | STRING | `provider` (new lookup) or `cache` (repeat visit) |
| `page_key` | STRING | landing page path |
| `acquisition` | STRING | `direct`, `search`, `social`, `email`, `paid`, `referral`, `internal`, `unknown` or null |
| `entrance_contract` | STRING | |
| `synced_at` | TIMESTAMP | when the run wrote the row |

A visit is a page entrance, not a session or a person. The table holds no IP address, fingerprint or visitor identifier.

The job uses `CREATE_NEVER` and does not create tables; the setup script creates the dataset, both tables and the view when they are missing, and keeps existing data. By hand:

```sql
CREATE SCHEMA `<project>.idr` OPTIONS (location = "EU");
CREATE TABLE `<project>.idr.company_visits` (
  observation_id STRING NOT NULL, company_id INT64 NOT NULL, domain STRING NOT NULL,
  organisation_name STRING, observed_at TIMESTAMP NOT NULL, method STRING NOT NULL,
  page_key STRING, acquisition STRING, entrance_contract STRING, synced_at TIMESTAMP NOT NULL
);
```

## Daily activity table

`<dataset>.daily_activity`, one row per usage period with activity (the resolver's `USAGE_PERIOD`, `day` in production). Rows are sparse: a period with no visits has no row; treat it as zeros. Counts only: no address, company or visitor identifier.

| column | type | notes |
| --- | --- | --- |
| `period_start` | DATE | the day, or the first day of the month |
| `period` | STRING | `day` or `month` |
| `visits_submitted` | INT64 | page entrances the website sent to the resolver (bots filtered before sending are not counted) |
| `outcome_qualified` … `outcome_unavailable` | INT64 | each entrance once, by its final status; together they add up to `visits_submitted` |
| `cache_hits` | INT64 | answered from the cache, no provider call |
| `provider_lookups` | INT64 | Enrich calls |
| `domains_found` | INT64 | calls that returned a domain (a company or a network owner) |
| `charged_lookups` | INT64 | calls holding a charge slot (charged or possibly charged) |
| `company_visits` | INT64 | company observations recorded |
| `company_first_visits` | INT64 | of those, the company's first |
| `company_returning_visits` | INT64 | `company_visits − company_first_visits` |
| `synced_at` | TIMESTAMP | when the run wrote the row |

The view `<dataset>.daily_activity_rates` adds `resolution_rate` (companies identified ÷ visits), `resolution_rate_eligible` (the same, leaving out private addresses and paused lookups) and `returning_share`. The outcome columns start at zero from the resolver's migration 0011, so the view leaves the rates empty for earlier days. The counts are best-effort (see the resolver's `reporting-activity.v1` contract, `docs/contracts/reporting-activity.v1.md`), and only the last 366 days are kept: each run replaces the table.

## Bot and crawler visits

`<dataset>.bot_visits`, one row per request from a known bot or crawler (`bot-visit.v1`, `GET /v1/reporting/bot-visits`), partitioned by day on `observed_at` and clustered by `bot_category`, `bot_name`:

| column | type | notes |
| --- | --- | --- |
| `observed_at` | TIMESTAMP | when the bot requested the page (UTC) |
| `page_key` | STRING | path only, identifiers replaced as for company visits |
| `bot_name` | STRING | from the website's bot list, e.g. `GPTBot`, `Googlebot`, `Generic crawler` |
| `bot_category` | STRING | `ai_crawler`, `search_engine`, `seo_tool`, `social_preview`, `monitoring` or `other` |
| `user_agent_family` | STRING | the product token that identified the bot, without its version, e.g. `Googlebot-Image` |
| `synced_at` | TIMESTAMP | when the sync wrote the row |

No IP address, full user agent or cookie exists anywhere in this path.

This table is loaded **daily**, not every run. The first run after 00:15 UTC (visits can reach the resolver up to five minutes late) checks the table's last-modified time (metadata only, no query) and, when the table has not been written since midnight UTC, reads the last `BQ_BOT_VISITS_DAYS` complete UTC days and replaces each of those day partitions (`WRITE_TRUNCATE` into `bot_visits$YYYYMMDD`). Later runs that day skip the step. Re-loading a day replaces it, so nothing is duplicated, and days older than the window are never touched: the table keeps the full history, beyond the resolver's retention window. When a day had no bot visits nothing is written, and the step is simply tried again on the next run. A resolver without the route (HTTP 404) skips the step; any other failure fails the run after the other two tables were replaced.

## Browser events

`<dataset>.browser_events`, one row per event from the website's own consent-gated collector (`@salescrusader/idr-collector` through the site's `/idr/e` route, `event.v1`), partitioned by day on `occurred_at` and clustered by `event_type`, `event_name`:

| column | type | notes |
| --- | --- | --- |
| `occurred_at` | TIMESTAMP | when the event happened in the browser (UTC) |
| `page_key` | STRING | path only, identifiers replaced as for company visits |
| `event_type` | STRING | `page_view`, `engagement` or `conversion_intent` |
| `event_name` | STRING | e.g. `page_view`, `scroll_50`, `scroll_90`, `engaged_30s`, `cta_click`, `form_start`, `form_submit` |
| `consent` | STRING | `granted` (the site sends events only after the visitor allows analytics) |
| `synced_at` | TIMESTAMP | when the sync wrote the row |

There is no session, visitor, cookie, address or company column, and none can be added from this data: events are never linked to companies (owner decision D4). Counts are indicative telemetry, not evidence (`docs/contracts/event.v1.md`). Loaded daily exactly like bot visits (same `BQ_BOT_VISITS_DAYS` window, `browser_events$YYYYMMDD` partitions); a resolver without the route skips the step.

## Configuration

| variable | |
| --- | --- |
| `IDR_REPORTING_URL` | resolver base URL, https only |
| `IDR_REPORTING_TOKEN` | the resolver's `REPORTING_AUTH_TOKEN`, from Secret Manager |
| `IDR_WEBSITE_ID` | the resolver's website id. Pages for any other website are refused |
| `BQ_PROJECT`, `BQ_DATASET`, `BQ_TABLE`, `BQ_LOCATION` | destination |
| `BQ_ACTIVITY_TABLE` | optional, default `daily_activity`; must differ from `BQ_TABLE` |
| `BQ_BOT_VISITS_TABLE` | optional, default `bot_visits`; must differ from the other two |
| `BQ_BOT_VISITS_DAYS` | optional, default 3 (1 to 31): complete UTC days reloaded by each daily load (bot visits and browser events). Raise it for one run to backfill after an outage |
| `BQ_EVENTS_TABLE` | optional, default `browser_events`; must differ from the other three |
| `IDR_MAX_PAGES` | optional, default 200, so at most 100,000 visits per run |

## Deploy

The project needs billing enabled; BigQuery sandbox projects cannot run Cloud Run.

Run [`deploy/setup-cloud-run.sh`](deploy/setup-cloud-run.sh) in Google Cloud Shell, where `gcloud` is already signed in:

```bash
PROJECT=<project> IDR_REPORTING_URL=https://<resolver-host> IDR_WEBSITE_ID=<website-id> \
SOURCE_COMMIT=<40-character commit> bash setup-cloud-run.sh
```

It:

- enables the APIs;
- creates the dataset, the four tables and the `daily_activity_rates` view when missing (existing data is kept);
- creates the service account `idr-bigquery-sync`, with BigQuery Job User on the project and BigQuery Data Editor on the dataset only;
- stores the reporting token in Secret Manager, typed with hidden input;
- deploys the job from the pinned commit;
- runs it once;
- schedules it every 30 minutes with Cloud Scheduler.

No service-account key is created. It is safe to re-run; pass `SKIP_TOKEN=1` to keep the stored token.

## Operations

- Run now: `gcloud run jobs execute idr-bigquery-sync --region europe-west2 --wait`
- Logs: Cloud Run > Jobs > `idr-bigquery-sync` > Logs. Each run logs one `idr_bigquery_sync` line.
- Pause: `gcloud scheduler jobs pause idr-bigquery-sync --location europe-west2`
- Rotate the token: re-run the setup script after the resolver's token changes.
- Update the job to a newer commit: re-run the setup script with the new `SOURCE_COMMIT` and `SKIP_TOKEN=1`.
- Remove: delete the scheduler job, the Cloud Run job, the secret and the service account, then drop the table if it is no longer wanted.
