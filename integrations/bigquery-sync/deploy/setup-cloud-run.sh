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
SCHEDULE="${SCHEDULE:-*/30 * * * *}"
REPO_URL="${REPO_URL:-https://github.com/chrismarchant/id-resolver-v1.0.git}"

JOB="idr-bigquery-sync"
SA_NAME="idr-bigquery-sync"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SECRET="idr-reporting-token"

case "$IDR_REPORTING_URL" in https://*) ;; *) echo "IDR_REPORTING_URL must start with https://" >&2; exit 1 ;; esac
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "SOURCE_COMMIT must be a full 40-character commit hash" >&2; exit 1; }

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
  --set-env-vars="IDR_REPORTING_URL=${IDR_REPORTING_URL},IDR_WEBSITE_ID=${IDR_WEBSITE_ID},BQ_PROJECT=${PROJECT},BQ_DATASET=${BQ_DATASET},BQ_TABLE=${BQ_TABLE},BQ_LOCATION=${BQ_LOCATION}" \
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
echo "Job ${JOB} runs ${SCHEDULE} (UTC) in ${REGION} and replaces ${PROJECT}.${BQ_DATASET}.${BQ_TABLE}."
