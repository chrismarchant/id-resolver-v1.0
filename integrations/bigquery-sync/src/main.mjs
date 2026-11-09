import { pathToFileURL } from "node:url";

import { ACTIVITY_SCHEMA, readActivity, toActivityRows } from "./activity.mjs";
import { metadataAccessToken, replaceTable } from "./bigquery.mjs";
import { readConfig } from "./config.mjs";
import { readFeed } from "./feed.mjs";
import { toRows } from "./rows.mjs";

/**
 * One run: company visits first (the reporting feed into BQ_TABLE), then the
 * daily activity counts (into BQ_ACTIVITY_TABLE). A failed visit sync stops
 * the run. A resolver without the activity route (HTTP 404, before
 * reporting-activity.v1 is deployed) skips the counts without failing.
 */
export async function run({
  env = process.env,
  fetch = globalThis.fetch,
  now = () => new Date(),
  log = (entry) => console.log(JSON.stringify(entry)),
  bigQueryOptions = {},
} = {}) {
  const started = Date.now();
  let cfg;
  let accessToken;
  let rows;
  try {
    cfg = readConfig(env);
    const items = await readFeed(cfg, { fetch });
    const mapped = toRows(items, now().toISOString());
    rows = mapped.rows;
    accessToken = await metadataAccessToken({ fetch });
    const jobId = await replaceTable(cfg, rows, accessToken, { fetch, ...bigQueryOptions });
    log({
      severity: "INFO",
      event: "idr_bigquery_sync",
      outcome: "ok",
      feed_items: items.length,
      rows: rows.length,
      erased_companies: mapped.erasedCompanies,
      table: `${cfg.dataset}.${cfg.table}`,
      job_id: jobId,
      duration_ms: Date.now() - started,
    });
  } catch (e) {
    log(failure("idr_bigquery_sync", e, cfg?.token ?? env.IDR_REPORTING_TOKEN, started));
    return { ok: false };
  }

  const activity = await syncActivity({ cfg, accessToken, fetch, now, log, bigQueryOptions });
  return { ok: activity.ok, rows: rows.length, activity_rows: activity.rows };
}

/** Daily activity counts into BQ_ACTIVITY_TABLE. Returns { ok, rows } (rows null when skipped or failed). */
async function syncActivity({ cfg, accessToken, fetch, now, log, bigQueryOptions }) {
  const started = Date.now();
  const table = `${cfg.dataset}.${cfg.activityTable}`;
  try {
    const activity = await readActivity(cfg, { fetch, now });
    if (activity === null) {
      log({ severity: "INFO", event: "idr_bigquery_activity_sync", outcome: "skipped", reason: "activity_route_not_deployed", table, duration_ms: Date.now() - started });
      return { ok: true, rows: null };
    }
    const rows = toActivityRows(activity, now().toISOString());
    const jobId = await replaceTable(cfg, rows, accessToken, { fetch, ...bigQueryOptions, table: cfg.activityTable, schema: ACTIVITY_SCHEMA });
    log({ severity: "INFO", event: "idr_bigquery_activity_sync", outcome: "ok", period: activity.period, rows: rows.length, table, job_id: jobId, duration_ms: Date.now() - started });
    return { ok: true, rows: rows.length };
  } catch (e) {
    log(failure("idr_bigquery_activity_sync", e, cfg.token, started));
    return { ok: false, rows: null };
  }
}

function failure(event, e, secret, started) {
  return {
    severity: "ERROR",
    event,
    outcome: "failed",
    error: redact(`${e?.name ?? "Error"}: ${e?.message ?? String(e)}`, secret),
    duration_ms: Date.now() - started,
  };
}

export function redact(text, secret) {
  if (typeof secret !== "string" || secret.length < 8) return text;
  return text.split(secret).join("[redacted]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run();
  if (!result.ok) process.exitCode = 1;
}
