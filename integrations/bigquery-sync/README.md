# BigQuery sync

A scheduled Cloud Run job that copies the resolver's company observations into one BigQuery table, so they can be charted and queried next to other website analytics (for example GA4 and PostHog exports in the same location).

It reads the read-only reporting feed (`reporting-feed.v1`, `GET /v1/reporting/observations`) with the reporting token. The resolver is unchanged and never calls out.

## How it works

Every run:

1. reads the whole feed from the oldest retained item, 500 per page;
2. drops every observation of a company that has a `company_erased` item, matched by `company_id`;
3. replaces the table in one `WRITE_TRUNCATE` load job, or truncates it when there are no rows.

Because the table is replaced in full, it always mirrors the resolver: its retention (`OBSERVATION_RETENTION_DAYS`) and its erasures carry over, and a missed run is repaired by the next one. No cursor or state is kept.

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

Create the dataset and the table before the first run. The job uses `CREATE_NEVER` and does not create them:

```sql
CREATE SCHEMA `<project>.idr` OPTIONS (location = "EU");
CREATE TABLE `<project>.idr.company_visits` (
  observation_id STRING NOT NULL, company_id INT64 NOT NULL, domain STRING NOT NULL,
  organisation_name STRING, observed_at TIMESTAMP NOT NULL, method STRING NOT NULL,
  page_key STRING, acquisition STRING, entrance_contract STRING, synced_at TIMESTAMP NOT NULL
);
```

## Configuration

| variable | |
| --- | --- |
| `IDR_REPORTING_URL` | resolver base URL, https only |
| `IDR_REPORTING_TOKEN` | the resolver's `REPORTING_AUTH_TOKEN`, from Secret Manager |
| `IDR_WEBSITE_ID` | the resolver's website id. Pages for any other website are refused |
| `BQ_PROJECT`, `BQ_DATASET`, `BQ_TABLE`, `BQ_LOCATION` | destination |
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
- Remove: delete the scheduler job, the Cloud Run job, the secret and the service account, then drop the table if it is no longer wanted.
