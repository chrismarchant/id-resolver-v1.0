import { pathToFileURL } from "node:url";

import { ACTIVITY_SCHEMA, readActivity, toActivityRows } from "./activity.mjs";
import { metadataAccessToken, replacePartition, replaceTable, tableLastModified } from "./bigquery.mjs";
import { BOT_VISITS_SCHEMA, readBotVisits, toBotVisitRowsByDay } from "./bot-visits.mjs";
import { completeDays, dailyDue } from "./daily.mjs";
import { EVENTS_SCHEMA, readEvents, toEventRowsByDay } from "./events.mjs";
import { readConfig } from "./config.mjs";
import { readFeed } from "./feed.mjs";
import { toRows } from "./rows.mjs";

/**
 * One run: company visits first (the reporting feed into BQ_TABLE), then the
 * daily activity counts (into BQ_ACTIVITY_TABLE), then, once a day, bot visits
 * (into BQ_BOT_VISITS_TABLE) and browser events (into BQ_EVENTS_TABLE). A
 * failed visit sync stops the run; the later steps are independent of each
 * other. A resolver without one of the later routes (HTTP 404, an older build)
 * skips that step without failing.
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
  const bots = await syncDailyTable({
    cfg, accessToken, fetch, now, log, bigQueryOptions,
    event: "idr_bigquery_bot_visits_sync",
    table: cfg.botVisitsTable,
    schema: BOT_VISITS_SCHEMA,
    read: readBotVisits,
    toRowsByDay: toBotVisitRowsByDay,
    notDeployed: "bot_visits_route_not_deployed",
  });
  const events = await syncDailyTable({
    cfg, accessToken, fetch, now, log, bigQueryOptions,
    event: "idr_bigquery_events_sync",
    table: cfg.eventsTable,
    schema: EVENTS_SCHEMA,
    read: readEvents,
    toRowsByDay: toEventRowsByDay,
    notDeployed: "events_route_not_deployed",
  });
  return { ok: activity.ok && bots.ok && events.ok, rows: rows.length, activity_rows: activity.rows, bot_visit_rows: bots.rows, event_rows: events.rows };
}

/**
 * One daily table (bot visits, browser events), once a day: the last
 * BQ_BOT_VISITS_DAYS complete UTC days, each replacing its own day partition.
 * Skipped (not failed) when not due yet today or when the resolver does not
 * serve the route. Returns { ok, rows } (rows null when skipped or failed).
 */
async function syncDailyTable({ cfg, accessToken, fetch, now, log, bigQueryOptions, event, table: tableId, schema, read, toRowsByDay, notDeployed }) {
  const started = Date.now();
  const table = `${cfg.dataset}.${tableId}`;
  const skip = (reason) => {
    log({ severity: "INFO", event, outcome: "skipped", reason, table, duration_ms: Date.now() - started });
    return { ok: true, rows: null };
  };
  try {
    const at = now();
    const lastModified = await tableLastModified(cfg, tableId, accessToken, { fetch });
    const due = dailyDue(at, lastModified);
    if (!due.due) return skip(due.reason);
    const days = completeDays(at, cfg.botVisitsDays);
    const items = await read(cfg, { from: days[0], to: days[days.length - 1], fetch });
    if (items === null) return skip(notDeployed);
    const byDay = toRowsByDay(items, at.toISOString());
    const jobs = [];
    for (const day of days) {
      const rows = byDay.get(day);
      if (!rows || rows.length === 0) continue;
      jobs.push(await replacePartition(cfg, tableId, day, rows, accessToken, { fetch, ...bigQueryOptions, schema }));
    }
    log({ severity: "INFO", event, outcome: "ok", from: days[0], to: days[days.length - 1], days_loaded: jobs.length, rows: items.length, table, duration_ms: Date.now() - started });
    return { ok: true, rows: items.length };
  } catch (e) {
    log(failure(event, e, cfg.token, started));
    return { ok: false, rows: null };
  }
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
