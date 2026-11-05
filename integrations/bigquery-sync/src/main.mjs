import { pathToFileURL } from "node:url";

import { metadataAccessToken, replaceTable } from "./bigquery.mjs";
import { readConfig } from "./config.mjs";
import { readFeed } from "./feed.mjs";
import { toRows } from "./rows.mjs";

export async function run({
  env = process.env,
  fetch = globalThis.fetch,
  now = () => new Date(),
  log = (entry) => console.log(JSON.stringify(entry)),
  bigQueryOptions = {},
} = {}) {
  const started = Date.now();
  let cfg;
  try {
    cfg = readConfig(env);
    const items = await readFeed(cfg, { fetch });
    const { rows, erasedCompanies } = toRows(items, now().toISOString());
    const accessToken = await metadataAccessToken({ fetch });
    const jobId = await replaceTable(cfg, rows, accessToken, { fetch, ...bigQueryOptions });
    log({
      severity: "INFO",
      event: "idr_bigquery_sync",
      outcome: "ok",
      feed_items: items.length,
      rows: rows.length,
      erased_companies: erasedCompanies,
      table: `${cfg.dataset}.${cfg.table}`,
      job_id: jobId,
      duration_ms: Date.now() - started,
    });
    return { ok: true, rows: rows.length };
  } catch (e) {
    log({
      severity: "ERROR",
      event: "idr_bigquery_sync",
      outcome: "failed",
      error: redact(`${e?.name ?? "Error"}: ${e?.message ?? String(e)}`, cfg?.token ?? env.IDR_REPORTING_TOKEN),
      duration_ms: Date.now() - started,
    });
    return { ok: false };
  }
}

export function redact(text, secret) {
  if (typeof secret !== "string" || secret.length < 8) return text;
  return text.split(secret).join("[redacted]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run();
  if (!result.ok) process.exitCode = 1;
}
