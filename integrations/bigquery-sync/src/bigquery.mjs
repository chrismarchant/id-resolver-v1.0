import { randomUUID } from "node:crypto";

export const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const API = "https://bigquery.googleapis.com/bigquery/v2";
const UPLOAD_API = "https://bigquery.googleapis.com/upload/bigquery/v2";

export const SCHEMA = [
  { name: "observation_id", type: "STRING", mode: "REQUIRED", description: "Resolver observation id" },
  { name: "company_id", type: "INTEGER", mode: "REQUIRED", description: "Resolver company id; never reused" },
  { name: "domain", type: "STRING", mode: "REQUIRED", description: "Company domain" },
  { name: "organisation_name", type: "STRING", mode: "NULLABLE", description: "Company name, when known" },
  { name: "observed_at", type: "TIMESTAMP", mode: "REQUIRED", description: "Visit time (UTC)" },
  { name: "method", type: "STRING", mode: "REQUIRED", description: "provider: new lookup; cache: repeat visit" },
  { name: "page_key", type: "STRING", mode: "NULLABLE", description: "Landing page path" },
  { name: "acquisition", type: "STRING", mode: "NULLABLE", description: "Traffic source class" },
  { name: "entrance_contract", type: "STRING", mode: "NULLABLE", description: "Entrance contract version" },
  { name: "synced_at", type: "TIMESTAMP", mode: "REQUIRED", description: "When this sync run wrote the row (UTC)" },
];

export class BigQueryError extends Error {
  name = "BigQueryError";
}

export async function metadataAccessToken({ fetch = globalThis.fetch, timeoutMs = 5_000 } = {}) {
  let res;
  try {
    res = await fetch(METADATA_TOKEN_URL, {
      headers: { "metadata-flavor": "Google" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new BigQueryError(`metadata token request failed: ${e?.name ?? "error"}`);
  }
  if (!res.ok) throw new BigQueryError(`metadata token request answered HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (typeof body?.access_token !== "string" || body.access_token === "") {
    throw new BigQueryError("metadata token response has no access_token");
  }
  return body.access_token;
}

export async function replaceTable(cfg, rows, accessToken, opts = {}) {
  const { fetch = globalThis.fetch, jobId = `idr_sync_${Date.now()}_${randomUUID().slice(0, 8)}` } = opts;
  const auth = { authorization: `Bearer ${accessToken}` };
  const jobReference = { projectId: cfg.project, jobId, location: cfg.location };
  const labels = { source: "idr-bigquery-sync" };

  if (rows.length === 0) {
    const query = `TRUNCATE TABLE \`${cfg.project}.${cfg.dataset}.${cfg.table}\``;
    const res = await fetch(`${API}/projects/${cfg.project}/jobs`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        jobReference,
        configuration: { query: { query, useLegacySql: false }, labels },
      }),
    });
    await checkJobResponse(res, "truncate");
  } else {
    const boundary = `idr-${randomUUID()}`;
    const metadata = {
      jobReference,
      configuration: {
        labels,
        load: {
          destinationTable: { projectId: cfg.project, datasetId: cfg.dataset, tableId: cfg.table },
          sourceFormat: "NEWLINE_DELIMITED_JSON",
          writeDisposition: "WRITE_TRUNCATE",
          createDisposition: "CREATE_NEVER",
          schema: { fields: SCHEMA },
          maxBadRecords: 0,
          ignoreUnknownValues: false,
        },
      },
    };
    const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
    const body =
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n${ndjson}\r\n` +
      `--${boundary}--\r\n`;
    const res = await fetch(`${UPLOAD_API}/projects/${cfg.project}/jobs?uploadType=multipart`, {
      method: "POST",
      headers: { ...auth, "content-type": `multipart/related; boundary=${boundary}` },
      body,
    });
    await checkJobResponse(res, "load");
  }

  await waitForJob(cfg, jobId, accessToken, opts);
  return jobId;
}

async function checkJobResponse(res, kind) {
  if (res.ok) return;
  const body = await res.json().catch(() => null);
  throw new BigQueryError(`BigQuery ${kind} job was refused: HTTP ${res.status}${reason(body?.error)}`);
}

export async function waitForJob(cfg, jobId, accessToken, opts = {}) {
  const { fetch = globalThis.fetch, pollMs = 2_000, maxPolls = 120, sleep = defaultSleep } = opts;
  const url = `${API}/projects/${cfg.project}/jobs/${jobId}?location=${encodeURIComponent(cfg.location)}`;
  for (let i = 0; i < maxPolls; i += 1) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new BigQueryError(`BigQuery job status answered HTTP ${res.status}`);
    const job = await res.json();
    if (job?.status?.state === "DONE") {
      if (job.status.errorResult) {
        throw new BigQueryError(`BigQuery job ${jobId} failed${reason(job.status.errorResult)}`);
      }
      return job;
    }
    await sleep(pollMs);
  }
  throw new BigQueryError(`BigQuery job ${jobId} did not finish in time`);
}

function reason(err) {
  if (!err || typeof err !== "object") return "";
  const r = typeof err.reason === "string" ? err.reason : (err.status ?? "");
  const m = typeof err.message === "string" ? err.message.slice(0, 200) : "";
  return r || m ? ` (${[r, m].filter(Boolean).join(": ")})` : "";
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
