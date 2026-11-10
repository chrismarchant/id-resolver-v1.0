import assert from "node:assert/strict";
import { test } from "node:test";

import { METADATA_TOKEN_URL } from "../src/bigquery.mjs";
import { BOT_VISITS_SCHEMA, botVisitDays, botVisitsDue, parseBotVisitsPage, readBotVisits, toBotVisitRowsByDay } from "../src/bot-visits.mjs";
import { readConfig } from "../src/config.mjs";
import { run } from "../src/main.mjs";
import { ENV, TOKEN, activityBody, activityItem, json, observation, page, recordingFetch } from "./helpers.mjs";

const fast = { pollMs: 0, sleep: async () => {} };
const scope = { installation_id: "example-installation", website_id: "example-website" };

function visit(observedAt, extra = {}) {
  return { observed_at: observedAt, page_key: "/pricing", bot_name: "GPTBot", bot_category: "ai_crawler", user_agent_family: "GPTBot", ...extra };
}

function botPage(items, next = null, websiteId = "example-website") {
  return { version: "1", scope: { ...scope, website_id: websiteId }, from: "x", to: "y", items, next_cursor: next };
}

/** pages: the bot visit pages served in order; tableModified: lastModifiedTime of the bot table. */
function world({ pages = [botPage([])], botStatus = 200, tableModified = Date.parse("2026-11-09T00:30:00Z"), tableStatus = 200 } = {}) {
  let served = 0;
  return recordingFetch(({ url }) => {
    if (url.startsWith("https://resolver.example.test/v1/reporting/bot-visits")) {
      if (botStatus !== 200) return json(botStatus, {});
      return json(200, pages[Math.min(served++, pages.length - 1)]);
    }
    if (url.startsWith("https://resolver.example.test/v1/reporting/activity")) return json(200, activityBody([activityItem("2026-11-09")]));
    if (url.startsWith("https://resolver.example.test/")) return json(200, page([observation(1, 7)]));
    if (url === METADATA_TOKEN_URL) return json(200, { access_token: "ya29.x" });
    if (url.endsWith("/datasets/idr/tables/bot_visits")) return tableStatus === 200 ? json(200, { lastModifiedTime: String(tableModified) }) : json(tableStatus, { error: { status: "NOT_FOUND" } });
    if (url.includes("uploadType=multipart") || url.endsWith("/jobs")) return json(200, {});
    return json(200, { status: { state: "DONE" } });
  });
}

function loads(fetch) {
  return fetch.calls
    .filter((c) => c.url.includes("uploadType=multipart"))
    .map((c) => {
      const [, meta, data] = c.init.body.split("\r\n\r\n");
      return { load: JSON.parse(meta.split("\r\n")[0]).configuration.load, rows: data.split("\r\n")[0].split("\n").map((l) => JSON.parse(l)) };
    });
}

test("botVisitsDue: once a day, from 00:15 UTC, unless the table was written since midnight UTC", () => {
  const yesterday = Date.parse("2026-11-09T00:30:00Z");
  assert.deepEqual(botVisitsDue(new Date("2026-11-10T00:10:00Z"), yesterday), { due: false, reason: "before_settle_time" });
  assert.deepEqual(botVisitsDue(new Date("2026-11-10T00:15:00Z"), yesterday), { due: true });
  assert.deepEqual(botVisitsDue(new Date("2026-11-10T13:00:00Z"), yesterday), { due: true });
  assert.deepEqual(botVisitsDue(new Date("2026-11-10T13:00:00Z"), Date.parse("2026-11-10T00:30:00Z")), { due: false, reason: "already_synced_today" });
});

test("botVisitDays: the last N complete UTC days, oldest first, never today", () => {
  assert.deepEqual(botVisitDays(new Date("2026-11-10T00:30:00Z"), 3), ["2026-11-07", "2026-11-08", "2026-11-09"]);
  assert.deepEqual(botVisitDays(new Date("2026-03-01T23:59:59Z"), 2), ["2026-02-27", "2026-02-28"]);
});

test("config: bot visits table and window default, validate, and stay apart from the other tables", () => {
  const cfg = readConfig(ENV);
  assert.equal(cfg.botVisitsTable, "bot_visits");
  assert.equal(cfg.botVisitsDays, 3);
  assert.equal(readConfig({ ...ENV, BQ_BOT_VISITS_DAYS: "31" }).botVisitsDays, 31);
  assert.throws(() => readConfig({ ...ENV, BQ_BOT_VISITS_DAYS: "32" }), /BQ_BOT_VISITS_DAYS/);
  assert.throws(() => readConfig({ ...ENV, BQ_BOT_VISITS_DAYS: "0" }), /BQ_BOT_VISITS_DAYS/);
  assert.throws(() => readConfig({ ...ENV, BQ_BOT_VISITS_TABLE: "company_visits" }), /must differ/);
  assert.throws(() => readConfig({ ...ENV, BQ_BOT_VISITS_TABLE: "bad-name" }), /BQ_BOT_VISITS_TABLE/);
});

test("parseBotVisitsPage: keeps exactly the five columns and refuses anything outside the contract", () => {
  const range = { from: "2026-11-09", to: "2026-11-09" };
  const ok = parseBotVisitsPage(botPage([{ ...visit("2026-11-09T10:00:00.000Z"), extra: "dropped" }]), "example-website", range);
  assert.deepEqual(ok, { items: [visit("2026-11-09T10:00:00.000Z")], nextCursor: null });
  const bad = [
    botPage([visit("2026-11-08T23:59:59.999Z")]),
    botPage([visit("2026-11-10T00:00:00.000Z")]),
    botPage([visit("2026-11-09T10:00:00Z", { bot_category: "scraper" })]),
    botPage([visit("2026-11-09T10:00:00Z", { page_key: "/a?b=c" })]),
    botPage([visit("2026-11-09T10:00:00Z", { user_agent_family: "GPTBot/1.2" })]),
    botPage([visit("2026-11-09T10:00:00Z", { bot_name: "https://x" })]),
    botPage([], "not a cursor!"),
    botPage([], null, "other-website"),
    { ...botPage([]), version: "2" },
  ];
  for (const body of bad) assert.throws(() => parseBotVisitsPage(body, "example-website", range));
});

test("toBotVisitRowsByDay groups by UTC day and adds synced_at", () => {
  const byDay = toBotVisitRowsByDay([visit("2026-11-08T23:59:59.000Z"), visit("2026-11-09T00:00:00.000Z"), visit("2026-11-09T12:00:00.000Z")], "2026-11-10T00:30:00.000Z");
  assert.deepEqual([...byDay.keys()], ["2026-11-08", "2026-11-09"]);
  assert.equal(byDay.get("2026-11-09").length, 2);
  assert.deepEqual(Object.keys(byDay.get("2026-11-08")[0]), [...BOT_VISITS_SCHEMA.map((f) => f.name)]);
});

test("readBotVisits follows next_cursor and returns null when the route is not deployed", async () => {
  const cfg = readConfig(ENV);
  const fetch = world({ pages: [botPage([visit("2026-11-09T01:00:00Z")], "c1"), botPage([visit("2026-11-09T02:00:00Z")], null)] });
  const items = await readBotVisits(cfg, { from: "2026-11-09", to: "2026-11-09", fetch });
  assert.equal(items.length, 2);
  const urls = fetch.calls.map((c) => new URL(c.url));
  assert.deepEqual(urls.map((u) => u.searchParams.get("cursor")), [null, "c1"]);
  assert.ok(urls.every((u) => u.searchParams.get("limit") === "1000" && u.searchParams.get("from") === "2026-11-09"));
  assert.ok(fetch.calls.every((c) => c.init.headers.authorization === `Bearer ${TOKEN}`));
  assert.equal(await readBotVisits(cfg, { from: "2026-11-09", to: "2026-11-09", fetch: world({ botStatus: 404 }) }), null);
});

test("the daily run loads each complete day with rows into its own partition, replacing it", async () => {
  const logs = [];
  const fetch = world({
    pages: [
      botPage([visit("2026-11-07T08:00:00Z"), visit("2026-11-09T09:00:00Z", { bot_name: "Googlebot", bot_category: "search_engine", user_agent_family: "Googlebot-Image" })], "c1"),
      botPage([visit("2026-11-09T23:59:00Z")], null),
    ],
  });
  const result = await run({ env: ENV, fetch, log: (e) => logs.push(e), now: () => new Date("2026-11-10T00:30:00Z"), bigQueryOptions: fast });
  assert.deepEqual(result, { ok: true, rows: 1, activity_rows: 1, bot_visit_rows: 3 });
  const reads = fetch.calls.filter((c) => c.url.includes("/v1/reporting/bot-visits")).map((c) => new URL(c.url).searchParams);
  assert.deepEqual([reads[0].get("from"), reads[0].get("to")], ["2026-11-07", "2026-11-09"]);
  const botLoads = loads(fetch).filter((l) => l.load.destinationTable.tableId.startsWith("bot_visits"));
  assert.deepEqual(botLoads.map((l) => l.load.destinationTable.tableId), ["bot_visits$20261107", "bot_visits$20261109"]);
  for (const l of botLoads) {
    assert.equal(l.load.writeDisposition, "WRITE_TRUNCATE");
    assert.equal(l.load.createDisposition, "CREATE_NEVER");
    assert.deepEqual(l.load.schema.fields.map((f) => f.name), ["observed_at", "page_key", "bot_name", "bot_category", "user_agent_family", "synced_at"]);
  }
  assert.deepEqual(botLoads[1].rows[0], {
    observed_at: "2026-11-09T09:00:00.000Z",
    page_key: "/pricing",
    bot_name: "Googlebot",
    bot_category: "search_engine",
    user_agent_family: "Googlebot-Image",
    synced_at: "2026-11-10T00:30:00.000Z",
  });
  assert.equal(botLoads[1].rows.length, 2);
  const log = logs.find((l) => l.event === "idr_bigquery_bot_visits_sync");
  assert.deepEqual([log.outcome, log.days_loaded, log.rows, log.table], ["ok", 2, 3, "idr.bot_visits"]);
  assert.ok(!JSON.stringify(logs).includes("/pricing") && !JSON.stringify(logs).includes(TOKEN));
});

test("not due: before 00:15 UTC, or already written today, nothing is read from the resolver", async () => {
  for (const [now, modified, reason] of [
    ["2026-11-10T00:05:00Z", Date.parse("2026-11-09T00:30:00Z"), "before_settle_time"],
    ["2026-11-10T09:00:00Z", Date.parse("2026-11-10T00:30:00Z"), "already_synced_today"],
  ]) {
    const logs = [];
    const fetch = world({ tableModified: modified });
    const result = await run({ env: ENV, fetch, log: (e) => logs.push(e), now: () => new Date(now), bigQueryOptions: fast });
    assert.equal(result.ok, true);
    assert.equal(result.bot_visit_rows, null);
    assert.ok(!fetch.calls.some((c) => c.url.includes("/v1/reporting/bot-visits")));
    assert.deepEqual([logs[2].outcome, logs[2].reason], ["skipped", reason]);
  }
});

test("no bot visits in the window: nothing is written, so the next run retries", async () => {
  const fetch = world({ pages: [botPage([])] });
  const result = await run({ env: ENV, fetch, log: () => {}, now: () => new Date("2026-11-10T00:30:00Z"), bigQueryOptions: fast });
  assert.equal(result.ok, true);
  assert.equal(result.bot_visit_rows, 0);
  assert.equal(loads(fetch).filter((l) => l.load.destinationTable.tableId.startsWith("bot_visits")).length, 0);
});

test("a resolver without the bot visits route is skipped, not failed; a missing table or a read error fails the step only", async () => {
  const logs = [];
  const skipped = await run({ env: ENV, fetch: world({ botStatus: 404 }), log: (e) => logs.push(e), now: () => new Date("2026-11-10T00:30:00Z"), bigQueryOptions: fast });
  assert.equal(skipped.ok, true);
  assert.deepEqual([logs[2].outcome, logs[2].reason], ["skipped", "bot_visits_route_not_deployed"]);

  for (const w of [world({ botStatus: 500 }), world({ tableStatus: 404 })]) {
    const errs = [];
    const result = await run({ env: ENV, fetch: w, log: (e) => errs.push(e), now: () => new Date("2026-11-10T00:30:00Z"), bigQueryOptions: fast });
    assert.equal(result.ok, false);
    assert.equal(result.rows, 1);
    assert.equal(result.activity_rows, 1);
    assert.deepEqual([errs[2].event, errs[2].severity], ["idr_bigquery_bot_visits_sync", "ERROR"]);
    assert.ok(!JSON.stringify(errs).includes(TOKEN));
  }
});
