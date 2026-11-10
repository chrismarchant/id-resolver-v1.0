import assert from "node:assert/strict";
import { test } from "node:test";

import { METADATA_TOKEN_URL } from "../src/bigquery.mjs";
import { redact, run } from "../src/main.mjs";
import { ENV, TOKEN, activityBody, activityItem, json, observation, page, recordingFetch } from "./helpers.mjs";

const fast = { pollMs: 0, sleep: async () => {} };

// By default the bot visits table was written today, so the daily bot step is skipped (bot-visits.test.mjs covers it).
function world({ feedStatus = 200, items = [observation(1, 7), observation(2, 8)], activityStatus = 200, activity = [activityItem("2026-11-04"), activityItem("2026-11-05")], botTableModified = Date.parse("2026-11-06T00:30:00Z") } = {}) {
  return recordingFetch(({ url }) => {
    if (url.startsWith("https://resolver.example.test/v1/reporting/activity")) return activityStatus === 200 ? json(200, activityBody(activity)) : json(activityStatus, {});
    if (url.includes("/tables/bot_visits?")) return json(200, { lastModifiedTime: String(botTableModified) });
    if (url.startsWith("https://resolver.example.test/")) return feedStatus === 200 ? json(200, page(items)) : json(feedStatus, {});
    if (url === METADATA_TOKEN_URL) return json(200, { access_token: "ya29.x" });
    if (url.includes("uploadType=multipart") || url.endsWith("/jobs")) return json(200, {});
    return json(200, { status: { state: "DONE" } });
  });
}

test("a successful run logs counts only", async () => {
  const logs = [];
  const fetch = world();
  const result = await run({ env: ENV, fetch, log: (e) => logs.push(e), now: () => new Date("2026-11-06T10:00:00Z"), bigQueryOptions: fast });
  assert.deepEqual(result, { ok: true, rows: 2, activity_rows: 2, bot_visit_rows: null });
  assert.equal(logs.length, 3);
  assert.deepEqual([logs[2].event, logs[2].outcome, logs[2].reason], ["idr_bigquery_bot_visits_sync", "skipped", "already_synced_today"]);
  assert.equal(logs[0].outcome, "ok");
  assert.equal(logs[0].rows, 2);
  assert.equal(logs[0].feed_items, 2);
  assert.deepEqual([logs[1].event, logs[1].outcome, logs[1].rows, logs[1].table], ["idr_bigquery_activity_sync", "ok", 2, "idr.daily_activity"]);
  const text = JSON.stringify(logs);
  assert.ok(!text.includes("Company 7") && !text.includes("company7.example") && !text.includes(TOKEN));
});

test("a failed feed read writes nothing to BigQuery", async () => {
  const logs = [];
  const fetch = world({ feedStatus: 401 });
  const result = await run({ env: ENV, fetch, log: (e) => logs.push(e), bigQueryOptions: fast });
  assert.deepEqual(result, { ok: false });
  assert.equal(logs[0].severity, "ERROR");
  assert.match(logs[0].error, /HTTP 401/);
  assert.ok(fetch.calls.every((c) => c.url.startsWith("https://resolver.example.test/")));
});

test("configuration errors are reported without the token", async () => {
  const logs = [];
  const result = await run({ env: { ...ENV, BQ_LOCATION: "" }, fetch: world(), log: (e) => logs.push(e) });
  assert.equal(result.ok, false);
  assert.match(logs[0].error, /BQ_LOCATION/);
  assert.ok(!JSON.stringify(logs).includes(TOKEN));
});

test("redact removes every occurrence of the secret", () => {
  assert.equal(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN), "a [redacted] b [redacted]");
  assert.equal(redact("nothing here", TOKEN), "nothing here");
});

function loads(fetch) {
  return fetch.calls
    .filter((c) => c.url.includes("uploadType=multipart"))
    .map((c) => JSON.parse(c.init.body.split("\r\n\r\n")[1].split("\r\n")[0]).configuration.load);
}

test("the daily counts go to their own table with their own schema", async () => {
  const fetch = world();
  await run({ env: ENV, fetch, log: () => {}, now: () => new Date("2026-11-06T10:00:00Z"), bigQueryOptions: fast });
  const [visits, activity] = loads(fetch);
  assert.equal(visits.destinationTable.tableId, "company_visits");
  assert.equal(activity.destinationTable.tableId, "daily_activity");
  assert.equal(activity.writeDisposition, "WRITE_TRUNCATE");
  assert.equal(activity.createDisposition, "CREATE_NEVER");
  assert.ok(activity.schema.fields.some((f) => f.name === "outcome_qualified" && f.type === "INTEGER"));
  // One metadata token serves both loads.
  assert.equal(fetch.calls.filter((c) => c.url === METADATA_TOKEN_URL).length, 1);
});

test("a resolver without the activity route still syncs visits and succeeds", async () => {
  const logs = [];
  const fetch = world({ activityStatus: 404 });
  const result = await run({ env: ENV, fetch, log: (e) => logs.push(e), now: () => new Date("2026-11-06T10:00:00Z"), bigQueryOptions: fast });
  assert.deepEqual(result, { ok: true, rows: 2, activity_rows: null, bot_visit_rows: null });
  assert.deepEqual([logs[1].outcome, logs[1].reason], ["skipped", "activity_route_not_deployed"]);
  assert.equal(loads(fetch).length, 1);
});

test("a failed activity read fails the run but keeps the visit sync", async () => {
  const logs = [];
  const fetch = world({ activityStatus: 401 });
  const result = await run({ env: ENV, fetch, log: (e) => logs.push(e), now: () => new Date("2026-11-06T10:00:00Z"), bigQueryOptions: fast });
  assert.equal(result.ok, false);
  assert.equal(result.rows, 2);
  assert.equal(logs[0].outcome, "ok");
  assert.deepEqual([logs[1].event, logs[1].severity], ["idr_bigquery_activity_sync", "ERROR"]);
  assert.match(logs[1].error, /HTTP 401/);
  assert.ok(!JSON.stringify(logs).includes(TOKEN));
  assert.equal(loads(fetch).length, 1);
});

test("a failed visit sync stops the run before the counts", async () => {
  const fetch = world({ feedStatus: 500 });
  const logs = [];
  await run({ env: ENV, fetch, log: (e) => logs.push(e), bigQueryOptions: fast });
  assert.equal(logs.length, 1);
  assert.ok(!fetch.calls.some((c) => c.url.includes("/v1/reporting/activity")));
});
