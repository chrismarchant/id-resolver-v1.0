import assert from "node:assert/strict";
import { test } from "node:test";

import { METADATA_TOKEN_URL } from "../src/bigquery.mjs";
import { readConfig } from "../src/config.mjs";
import { EVENTS_SCHEMA, parseEventItems, readEvents } from "../src/events.mjs";
import { run } from "../src/main.mjs";
import { ENV, TOKEN, activityBody, activityItem, json, observation, page, recordingFetch } from "./helpers.mjs";

const fast = { pollMs: 0, sleep: async () => {} };
const scope = { installation_id: "example-installation", website_id: "example-website" };

function event(occurredAt, extra = {}) {
  return { occurred_at: occurredAt, page_key: "/pricing", type: "page_view", name: "page_view", consent: "granted", ...extra };
}

function eventsPage(items, next = null, websiteId = "example-website") {
  return { version: "1", scope: { ...scope, website_id: websiteId }, from: "x", to: "y", items, next_cursor: next };
}

/** The bot visits table was written today (its step skips); the events table yesterday (its step is due at 00:30). */
function world({ pages = [eventsPage([])], eventsStatus = 200, eventsTableModified = Date.parse("2026-11-09T00:30:00Z") } = {}) {
  let served = 0;
  return recordingFetch(({ url }) => {
    if (url.startsWith("https://resolver.example.test/v1/reporting/events")) {
      if (eventsStatus !== 200) return json(eventsStatus, {});
      return json(200, pages[Math.min(served++, pages.length - 1)]);
    }
    if (url.startsWith("https://resolver.example.test/v1/reporting/bot-visits")) throw new Error("bot visits must not be read here");
    if (url.startsWith("https://resolver.example.test/v1/reporting/activity")) return json(200, activityBody([activityItem("2026-11-09")]));
    if (url.startsWith("https://resolver.example.test/")) return json(200, page([observation(1, 7)]));
    if (url === METADATA_TOKEN_URL) return json(200, { access_token: "ya29.x" });
    if (url.endsWith("/datasets/idr/tables/bot_visits")) return json(200, { lastModifiedTime: String(Date.parse("2026-11-10T00:20:00Z")) });
    if (url.endsWith("/datasets/idr/tables/browser_events")) return json(200, { lastModifiedTime: String(eventsTableModified) });
    if (url.includes("uploadType=multipart") || url.endsWith("/jobs")) return json(200, {});
    return json(200, { status: { state: "DONE" } });
  });
}

function eventLoads(fetch) {
  return fetch.calls
    .filter((c) => c.url.includes("uploadType=multipart"))
    .map((c) => {
      const [, meta, data] = c.init.body.split("\r\n\r\n");
      return { load: JSON.parse(meta.split("\r\n")[0]).configuration.load, rows: data.split("\r\n")[0].split("\n").map((l) => JSON.parse(l)) };
    })
    .filter((l) => l.load.destinationTable.tableId.startsWith("browser_events"));
}

test("config: the events table defaults to browser_events and must differ from the other tables", () => {
  assert.equal(readConfig(ENV).eventsTable, "browser_events");
  assert.throws(() => readConfig({ ...ENV, BQ_EVENTS_TABLE: "bot_visits" }), /must differ/);
  assert.throws(() => readConfig({ ...ENV, BQ_EVENTS_TABLE: "bad-name" }), /BQ_EVENTS_TABLE/);
});

test("parseEventItems keeps exactly five columns, renamed for BigQuery, and refuses anything outside the contract", () => {
  const range = { from: "2026-11-09", to: "2026-11-09" };
  assert.deepEqual(parseEventItems([{ ...event("2026-11-09T10:00:00.000Z"), event_id: "dropped" }], range), [
    { occurred_at: "2026-11-09T10:00:00.000Z", page_key: "/pricing", event_type: "page_view", event_name: "page_view", consent: "granted" },
  ]);
  for (const bad of [
    event("2026-11-08T23:59:59.999Z"),
    event("2026-11-10T00:00:00.000Z"),
    event("2026-11-09T10:00:00Z", { type: "custom" }),
    event("2026-11-09T10:00:00Z", { name: "Bad Name" }),
    event("2026-11-09T10:00:00Z", { consent: "maybe" }),
    event("2026-11-09T10:00:00Z", { page_key: "/a?b=c" }),
  ]) {
    assert.throws(() => parseEventItems([bad], range));
  }
});

test("readEvents follows next_cursor, refuses another website's page, and returns null when the route is not deployed", async () => {
  const cfg = readConfig(ENV);
  const fetch = world({ pages: [eventsPage([event("2026-11-09T01:00:00Z")], "c1"), eventsPage([event("2026-11-09T02:00:00Z")], null)] });
  const items = await readEvents(cfg, { from: "2026-11-09", to: "2026-11-09", fetch });
  assert.equal(items.length, 2);
  const cursors = fetch.calls.filter((c) => c.url.includes("/v1/reporting/events")).map((c) => new URL(c.url).searchParams.get("cursor"));
  assert.deepEqual(cursors, [null, "c1"]);
  await assert.rejects(readEvents(cfg, { from: "2026-11-09", to: "2026-11-09", fetch: world({ pages: [eventsPage([], null, "other-website")] }) }), /different website/);
  assert.equal(await readEvents(cfg, { from: "2026-11-09", to: "2026-11-09", fetch: world({ eventsStatus: 404 }) }), null);
});

test("the daily run loads each complete day with events into its own browser_events partition, replacing it", async () => {
  const logs = [];
  const fetch = world({
    pages: [
      eventsPage([event("2026-11-07T08:00:00Z"), event("2026-11-09T09:00:00Z", { type: "conversion_intent", name: "cta_click" })], "c1"),
      eventsPage([event("2026-11-09T23:59:00Z", { type: "engagement", name: "scroll_50" })], null),
    ],
  });
  const result = await run({ env: ENV, fetch, log: (e) => logs.push(e), now: () => new Date("2026-11-10T00:30:00Z"), bigQueryOptions: fast });
  assert.deepEqual(result, { ok: true, rows: 1, activity_rows: 1, bot_visit_rows: null, event_rows: 3 });
  const read = fetch.calls.find((c) => c.url.includes("/v1/reporting/events"));
  assert.deepEqual([new URL(read.url).searchParams.get("from"), new URL(read.url).searchParams.get("to")], ["2026-11-07", "2026-11-09"]);
  assert.equal(read.init.headers.authorization, `Bearer ${TOKEN}`);
  const loads = eventLoads(fetch);
  assert.deepEqual(loads.map((l) => l.load.destinationTable.tableId), ["browser_events$20261107", "browser_events$20261109"]);
  for (const l of loads) {
    assert.equal(l.load.writeDisposition, "WRITE_TRUNCATE");
    assert.equal(l.load.createDisposition, "CREATE_NEVER");
    assert.deepEqual(l.load.schema.fields.map((f) => f.name), EVENTS_SCHEMA.map((f) => f.name));
  }
  assert.deepEqual(loads[1].rows[0], {
    occurred_at: "2026-11-09T09:00:00.000Z",
    page_key: "/pricing",
    event_type: "conversion_intent",
    event_name: "cta_click",
    consent: "granted",
    synced_at: "2026-11-10T00:30:00.000Z",
  });
  const log = logs.find((l) => l.event === "idr_bigquery_events_sync");
  assert.deepEqual([log.outcome, log.days_loaded, log.rows, log.table], ["ok", 2, 3, "idr.browser_events"]);
  assert.ok(!JSON.stringify(logs).includes("/pricing") && !JSON.stringify(logs).includes(TOKEN));
});

test("events: not due, or the route not deployed, is skipped; a read error fails only the run's exit status", async () => {
  const notDue = world({ eventsTableModified: Date.parse("2026-11-10T00:20:00Z") });
  const skipped = await run({ env: ENV, fetch: notDue, log: () => {}, now: () => new Date("2026-11-10T00:30:00Z"), bigQueryOptions: fast });
  assert.equal(skipped.ok, true);
  assert.ok(!notDue.calls.some((c) => c.url.includes("/v1/reporting/events")));

  const logs = [];
  const old = await run({ env: ENV, fetch: world({ eventsStatus: 404 }), log: (e) => logs.push(e), now: () => new Date("2026-11-10T00:30:00Z"), bigQueryOptions: fast });
  assert.equal(old.ok, true);
  assert.deepEqual([logs.at(-1).event, logs.at(-1).reason], ["idr_bigquery_events_sync", "events_route_not_deployed"]);

  const errs = [];
  const failed = await run({ env: ENV, fetch: world({ eventsStatus: 500 }), log: (e) => errs.push(e), now: () => new Date("2026-11-10T00:30:00Z"), bigQueryOptions: fast });
  assert.equal(failed.ok, false);
  assert.equal(failed.rows, 1);
  assert.equal(failed.activity_rows, 1);
  assert.deepEqual([errs.at(-1).event, errs.at(-1).severity], ["idr_bigquery_events_sync", "ERROR"]);
  assert.ok(!JSON.stringify(errs).includes(TOKEN));
});
