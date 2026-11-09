import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIVITY_SCHEMA, OUTCOMES, activityWindow, parseActivity, readActivity, toActivityRows } from "../src/activity.mjs";
import { readConfig } from "../src/config.mjs";
import { FeedError } from "../src/feed.mjs";
import { ENV, TOKEN, activityBody, activityItem, json, recordingFetch } from "./helpers.mjs";

const cfg = readConfig(ENV);
const now = () => new Date("2026-11-06T23:59:00Z");

test("asks for the last 366 UTC days, the most the resolver accepts", () => {
  assert.deepEqual(activityWindow(now()), { from: "2025-11-06", to: "2026-11-06" });
  // 2024 was a leap year: the window still spans exactly 366 days.
  assert.deepEqual(activityWindow(new Date("2025-03-01T00:00:00Z")), { from: "2024-03-01", to: "2025-03-01" });
});

test("reads the activity route with the reporting token, no redirects", async () => {
  const fetch = recordingFetch(() => json(200, activityBody([activityItem("2026-11-05")])));
  const a = await readActivity(cfg, { fetch, now });
  assert.equal(a.period, "day");
  assert.equal(a.items.length, 1);
  const call = fetch.calls[0];
  assert.equal(call.url, "https://resolver.example.test/v1/reporting/activity?from=2025-11-06&to=2026-11-06");
  assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(call.init.redirect, "error");
});

test("a resolver without the route (404) is not an error; other failures are", async () => {
  assert.equal(await readActivity(cfg, { fetch: recordingFetch(() => json(404, { error: "not_found" })), now }), null);
  await assert.rejects(readActivity(cfg, { fetch: recordingFetch(() => json(401, {})), now }), /HTTP 401/);
  await assert.rejects(readActivity(cfg, { fetch: recordingFetch(() => json(500, {})), now }), FeedError);
  await assert.rejects(
    readActivity(cfg, {
      fetch: recordingFetch(() => {
        throw new TypeError("network");
      }),
      now,
    }),
    /request failed: TypeError/,
  );
});

test("validates the response strictly", () => {
  const ok = activityBody([activityItem("2026-11-04"), activityItem("2026-11-05")]);
  assert.equal(parseActivity(ok, "example-website").items.length, 2);
  const bad = [
    [{ ...ok, version: "2" }, /version/],
    [{ ...ok, scope: { website_id: "other" } }, /different website/],
    [{ ...ok, period: "week" }, /unknown period/],
    [{ ...ok, items: null }, /items/],
    [activityBody([activityItem("2026-11-5")]), /period_key/],
    [activityBody([activityItem("2026-02-30")]), /period_key/],
    [activityBody([activityItem("2026-11")]), /period_key/],
    [activityBody([activityItem("2026-11-05"), activityItem("2026-11-04")]), /out of order/],
    [activityBody([activityItem("2026-11-05"), activityItem("2026-11-05")]), /out of order/],
    [activityBody([activityItem("2026-11-05", { cache_hits: -1 })]), /invalid count/],
    [activityBody([activityItem("2026-11-05", { visits_submitted: 1.5 })]), /invalid count/],
    [activityBody([activityItem("2026-11-05", { company_visits: "3" })]), /invalid count/],
    [activityBody([activityItem("2026-11-05", { outcomes: { qualified: 1 } })]), /invalid outcomes/],
    [activityBody([activityItem("2026-11-05")], { period: "month" }), /period_key/],
  ];
  for (const [body, re] of bad) assert.throws(() => parseActivity(body, "example-website"), re);
  assert.equal(parseActivity(activityBody([activityItem("2026-10"), activityItem("2026-11")], { period: "month" }), "example-website").items.length, 2);
});

test("maps each period to one row whose fields match the table schema", () => {
  const syncedAt = "2026-11-06T10:00:00.000Z";
  const [row] = toActivityRows(parseActivity(activityBody([activityItem("2026-11-05")]), "example-website"), syncedAt);
  assert.deepEqual(Object.keys(row), ACTIVITY_SCHEMA.map((f) => f.name));
  assert.equal(row.period_start, "2026-11-05");
  assert.equal(row.period, "day");
  assert.equal(row.visits_submitted, 81);
  assert.equal(row.outcome_qualified, 3);
  assert.equal(row.outcome_disabled, 60);
  assert.equal(row.company_returning_visits, 1);
  assert.equal(row.synced_at, syncedAt);
  assert.equal(OUTCOMES.reduce((n, o) => n + row[`outcome_${o}`], 0), row.visits_submitted);

  const [month] = toActivityRows(parseActivity(activityBody([activityItem("2026-11")], { period: "month" }), "example-website"), syncedAt);
  assert.equal(month.period_start, "2026-11-01");
  assert.equal(month.period, "month");

  // Best-effort counters can disagree; the derived column never goes negative.
  const [odd] = toActivityRows(parseActivity(activityBody([activityItem("2026-11-05", { company_visits: 1, company_first_visits: 2 })]), "example-website"), syncedAt);
  assert.equal(odd.company_returning_visits, 0);
});

test("the schema holds counts only", () => {
  const names = ACTIVITY_SCHEMA.map((f) => f.name).join(" ");
  assert.doesNotMatch(names, /domain\b|name|ip|address|fingerprint|visitor/);
});
