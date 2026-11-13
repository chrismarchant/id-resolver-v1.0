#!/usr/bin/env bash
# Run in Google Cloud Shell as a project owner. Safe to re-run.
set -euo pipefail

: "${PROJECT:?set PROJECT to the Google Cloud project id}"
: "${IDR_REPORTING_URL:?set IDR_REPORTING_URL to the resolver base URL (https)}"
: "${IDR_WEBSITE_ID:?set IDR_WEBSITE_ID to the resolver website id}"
: "${SOURCE_COMMIT:?set SOURCE_COMMIT to the reviewed commit of this repository}"
REGION="${REGION:-europe-west2}"
BQ_LOCATION="${BQ_LOCATION:-EU}"
BQ_DATASET="${BQ_DATASET:-idr}"
BQ_TABLE="${BQ_TABLE:-company_visits}"
BQ_ACTIVITY_TABLE="${BQ_ACTIVITY_TABLE:-daily_activity}"
BQ_BOT_VISITS_TABLE="${BQ_BOT_VISITS_TABLE:-bot_visits}"
BQ_EVENTS_TABLE="${BQ_EVENTS_TABLE:-browser_events}"
SCHEDULE="${SCHEDULE:-*/30 * * * *}"
REPO_URL="${REPO_URL:-https://github.com/chrismarchant/id-resolver-v1.0.git}"

JOB="idr-bigquery-sync"
SA_NAME="idr-bigquery-sync"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SECRET="idr-reporting-token"

case "$IDR_REPORTING_URL" in https://*) ;; *) echo "IDR_REPORTING_URL must start with https://" >&2; exit 1 ;; esac
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "SOURCE_COMMIT must be a full 40-character commit hash" >&2; exit 1; }
for name in "$BQ_DATASET" "$BQ_TABLE" "$BQ_ACTIVITY_TABLE" "$BQ_BOT_VISITS_TABLE" "$BQ_EVENTS_TABLE"; do
  [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]{0,1023}$ ]] || { echo "BQ_DATASET, BQ_TABLE, BQ_ACTIVITY_TABLE, BQ_BOT_VISITS_TABLE and BQ_EVENTS_TABLE must be BigQuery names (letters, digits, underscores)" >&2; exit 1; }
done
[[ "$BQ_LOCATION" =~ ^[A-Za-z0-9-]{2,40}$ ]] || { echo "BQ_LOCATION is not valid" >&2; exit 1; }

step() { printf '\n== %s\n' "$*"; }

step "Project and billing"
gcloud config set project "$PROJECT" >/dev/null
if [ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)')" != "True" ]; then
  echo "Billing is not enabled for $PROJECT. Link a billing account (Billing > Link a billing account), then re-run." >&2
  exit 1
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

step "Enabling APIs"
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com bigquery.googleapis.com iam.googleapis.com

step "Dataset, tables and views (tables created when missing, existing data kept; views replaced)"
DS="\`${PROJECT}.${BQ_DATASET}\`"
bq query --quiet --nouse_legacy_sql --location="$BQ_LOCATION" "
CREATE SCHEMA IF NOT EXISTS ${DS} OPTIONS (location = '${BQ_LOCATION}');
CREATE TABLE IF NOT EXISTS \`${PROJECT}.${BQ_DATASET}.${BQ_TABLE}\` (
  observation_id STRING NOT NULL, company_id INT64 NOT NULL, domain STRING NOT NULL,
  organisation_name STRING, observed_at TIMESTAMP NOT NULL, method STRING NOT NULL,
  page_key STRING, acquisition STRING, entrance_contract STRING, synced_at TIMESTAMP NOT NULL);
CREATE TABLE IF NOT EXISTS \`${PROJECT}.${BQ_DATASET}.${BQ_ACTIVITY_TABLE}\` (
  period_start DATE NOT NULL, period STRING NOT NULL, visits_submitted INT64 NOT NULL,
  outcome_qualified INT64 NOT NULL, outcome_no_match INT64 NOT NULL, outcome_excluded INT64 NOT NULL,
  outcome_unknown INT64 NOT NULL, outcome_pending INT64 NOT NULL, outcome_ineligible INT64 NOT NULL,
  outcome_disabled INT64 NOT NULL, outcome_uncertain INT64 NOT NULL, outcome_unavailable INT64 NOT NULL,
  cache_hits INT64 NOT NULL, provider_lookups INT64 NOT NULL, domains_found INT64 NOT NULL,
  charged_lookups INT64 NOT NULL, company_visits INT64 NOT NULL, company_first_visits INT64 NOT NULL,
  company_returning_visits INT64 NOT NULL, synced_at TIMESTAMP NOT NULL);
-- Bot and crawler visits: one row per request, loaded once a day per day partition (kept beyond the resolver's retention).
CREATE TABLE IF NOT EXISTS \`${PROJECT}.${BQ_DATASET}.${BQ_BOT_VISITS_TABLE}\` (
  observed_at TIMESTAMP NOT NULL, page_key STRING NOT NULL, bot_name STRING NOT NULL,
  bot_category STRING NOT NULL, user_agent_family STRING NOT NULL, synced_at TIMESTAMP NOT NULL)
PARTITION BY DATE(observed_at)
CLUSTER BY bot_category, bot_name;
-- Browser events from the site's own consent-gated collector: no identifier of any kind, never linked to companies.
CREATE TABLE IF NOT EXISTS \`${PROJECT}.${BQ_DATASET}.${BQ_EVENTS_TABLE}\` (
  occurred_at TIMESTAMP NOT NULL, page_key STRING NOT NULL, event_type STRING NOT NULL,
  event_name STRING NOT NULL, consent STRING NOT NULL, synced_at TIMESTAMP NOT NULL)
PARTITION BY DATE(occurred_at)
CLUSTER BY event_type, event_name;
CREATE OR REPLACE VIEW \`${PROJECT}.${BQ_DATASET}.${BQ_ACTIVITY_TABLE}_rates\` AS
SELECT
  period_start, period, visits_submitted, outcome_qualified AS companies_identified,
  -- Outcome counts start when the resolver's migration 0011 is deployed: no rate before then.
  SAFE_DIVIDE(outcome_qualified, IF(outcomes = 0, NULL, visits_submitted)) AS resolution_rate,
  SAFE_DIVIDE(outcome_qualified, IF(outcomes = 0, NULL, visits_submitted - outcome_ineligible - outcome_disabled)) AS resolution_rate_eligible,
  company_visits, company_first_visits, company_returning_visits,
  SAFE_DIVIDE(company_returning_visits, company_visits) AS returning_share,
  provider_lookups, domains_found, charged_lookups
FROM (
  SELECT *, outcome_qualified + outcome_no_match + outcome_excluded + outcome_unknown + outcome_pending
    + outcome_ineligible + outcome_disabled + outcome_uncertain + outcome_unavailable AS outcomes
  FROM \`${PROJECT}.${BQ_DATASET}.${BQ_ACTIVITY_TABLE}\`);
-- Bot analytics (README, section Bot analytics). Rows stored before the resolver's migration 0014 carry ai_crawler
-- for every AI bot; the classified view gives them the AI split the website package now reports itself.
CREATE OR REPLACE VIEW \`${PROJECT}.${BQ_DATASET}.${BQ_BOT_VISITS_TABLE}_classified\` AS
SELECT
  *,
  bot_category IN ('ai_crawler', 'ai_search', 'ai_assistant') AS is_ai,
  page_key IN ('/robots.txt', '/llms.txt', '/llms-full.txt')
    OR (STARTS_WITH(page_key, '/sitemap') AND ENDS_WITH(page_key, '.xml')) AS is_discovery_file
FROM (
  SELECT
    observed_at,
    DATE(observed_at) AS visit_date,
    page_key,
    bot_name,
    CASE
      WHEN bot_category = 'ai_crawler' AND bot_name IN ('ChatGPT-User', 'Claude-User', 'Perplexity-User') THEN 'ai_assistant'
      WHEN bot_category = 'ai_crawler' AND bot_name IN ('OAI-SearchBot', 'PerplexityBot') THEN 'ai_search'
      ELSE bot_category
    END AS bot_category,
    user_agent_family,
    synced_at
  FROM \`${PROJECT}.${BQ_DATASET}.${BQ_BOT_VISITS_TABLE}\`);
CREATE OR REPLACE VIEW \`${PROJECT}.${BQ_DATASET}.${BQ_BOT_VISITS_TABLE}_daily\` AS
SELECT
  visit_date, bot_category, bot_name,
  COUNT(*) AS visits,
  COUNT(DISTINCT page_key) AS pages,
  COUNTIF(is_discovery_file) AS discovery_file_visits
FROM \`${PROJECT}.${BQ_DATASET}.${BQ_BOT_VISITS_TABLE}_classified\`
GROUP BY visit_date, bot_category, bot_name;
CREATE OR REPLACE VIEW \`${PROJECT}.${BQ_DATASET}.${BQ_BOT_VISITS_TABLE}_pages\` AS
SELECT
  page_key,
  COUNT(*) AS visits,
  COUNTIF(is_ai) AS ai_visits,
  COUNTIF(bot_category = 'ai_assistant') AS ai_assistant_visits,
  COUNTIF(bot_category = 'ai_search') AS ai_search_visits,
  COUNTIF(bot_category = 'ai_crawler') AS ai_crawler_visits,
  COUNTIF(bot_category = 'search_engine') AS search_engine_visits,
  COUNT(DISTINCT bot_name) AS bots,
  MIN(observed_at) AS first_visit,
  MAX(observed_at) AS last_visit
FROM \`${PROJECT}.${BQ_DATASET}.${BQ_BOT_VISITS_TABLE}_classified\`
GROUP BY page_key;
" >/dev/null

step "Service account"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name="ID Resolver BigQuery sync"
fi
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA}" \
  --role=roles/bigquery.jobUser --condition=None --quiet >/dev/null
bq query --quiet --nouse_legacy_sql --location="$BQ_LOCATION" \
  "GRANT \`roles/bigquery.dataEditor\` ON SCHEMA \`${PROJECT}.${BQ_DATASET}\` TO \"serviceAccount:${SA}\"" >/dev/null
GSA_DEV_DOMAIN="developer.gserviceaccount.com"
BUILD_SA="${PROJECT_NUMBER}-compute@${GSA_DEV_DOMAIN}"
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${BUILD_SA}" \
  --role=roles/run.builder --condition=None --quiet >/dev/null

step "Reporting token in Secret Manager"
if ! gcloud secrets describe "$SECRET" >/dev/null 2>&1; then
  gcloud secrets create "$SECRET" --replication-policy=user-managed --locations="$REGION"
fi
if [ "${SKIP_TOKEN:-0}" != "1" ]; then
  read -rsp "Paste the resolver REPORTING_AUTH_TOKEN (input hidden), then press Enter: " TOKEN
  echo
  if [ "${#TOKEN}" -lt 32 ]; then echo "That token is too short." >&2; exit 1; fi
  printf '%s' "$TOKEN" | gcloud secrets versions add "$SECRET" --data-file=- >/dev/null
  unset TOKEN
  echo "Stored a new secret version."
fi
gcloud secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:${SA}" \
  --role=roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null

step "Source at ${SOURCE_COMMIT}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --quiet --filter=blob:none "$REPO_URL" "$WORK/repo"
git -C "$WORK/repo" -c advice.detachedHead=false checkout --quiet "$SOURCE_COMMIT"
[ "$(git -C "$WORK/repo" rev-parse HEAD)" = "$SOURCE_COMMIT" ] || { echo "Checkout does not match SOURCE_COMMIT" >&2; exit 1; }

step "Cloud Run job"
gcloud run jobs deploy "$JOB" \
  --source="$WORK/repo/integrations/bigquery-sync" \
  --region="$REGION" \
  --service-account="$SA" \
  --set-secrets="IDR_REPORTING_TOKEN=${SECRET}:latest" \
  --set-env-vars="IDR_REPORTING_URL=${IDR_REPORTING_URL},IDR_WEBSITE_ID=${IDR_WEBSITE_ID},BQ_PROJECT=${PROJECT},BQ_DATASET=${BQ_DATASET},BQ_TABLE=${BQ_TABLE},BQ_ACTIVITY_TABLE=${BQ_ACTIVITY_TABLE},BQ_BOT_VISITS_TABLE=${BQ_BOT_VISITS_TABLE},BQ_EVENTS_TABLE=${BQ_EVENTS_TABLE},BQ_LOCATION=${BQ_LOCATION}" \
  --labels="source=id-resolver,commit=${SOURCE_COMMIT:0:12}" \
  --tasks=1 --max-retries=1 --task-timeout=300s \
  --quiet

step "First run"
gcloud run jobs execute "$JOB" --region="$REGION" --wait

step "Schedule (${SCHEDULE}, UTC)"
gcloud run jobs add-iam-policy-binding "$JOB" --region="$REGION" \
  --member="serviceAccount:${SA}" --role=roles/run.invoker --quiet >/dev/null
URI="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run"
if gcloud scheduler jobs describe "$JOB" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" --location="$REGION" --schedule="$SCHEDULE" --time-zone=Etc/UTC \
    --uri="$URI" --http-method=POST --oauth-service-account-email="$SA" \
    --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform --quiet >/dev/null
else
  gcloud scheduler jobs create http "$JOB" --location="$REGION" --schedule="$SCHEDULE" --time-zone=Etc/UTC \
    --uri="$URI" --http-method=POST --oauth-service-account-email="$SA" \
    --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform --quiet >/dev/null
fi

step "Done"
echo "Job ${JOB} runs ${SCHEDULE} (UTC) in ${REGION} and replaces ${PROJECT}.${BQ_DATASET}.${BQ_TABLE} and ${PROJECT}.${BQ_DATASET}.${BQ_ACTIVITY_TABLE}; once a day it loads ${PROJECT}.${BQ_DATASET}.${BQ_BOT_VISITS_TABLE} and ${PROJECT}.${BQ_DATASET}.${BQ_EVENTS_TABLE}. Bot analytics views: ${BQ_BOT_VISITS_TABLE}_classified, ${BQ_BOT_VISITS_TABLE}_daily, ${BQ_BOT_VISITS_TABLE}_pages."
