import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, readConfig } from "../src/config.mjs";
import { ENV, TOKEN } from "./helpers.mjs";

test("reads a complete configuration", () => {
  const cfg = readConfig({ ...ENV, IDR_REPORTING_URL: "https://resolver.example.test/" });
  assert.equal(cfg.reportingUrl, "https://resolver.example.test");
  assert.equal(cfg.token, TOKEN);
  assert.equal(cfg.pageSize, 500);
  assert.equal(cfg.maxPages, 200);
});

test("names every missing variable", () => {
  assert.throws(() => readConfig({}), (e) => e instanceof ConfigError && e.message.includes("IDR_REPORTING_TOKEN") && e.message.includes("BQ_LOCATION"));
});

test("refuses a non-https resolver URL", () => {
  assert.throws(() => readConfig({ ...ENV, IDR_REPORTING_URL: "http://resolver.example.test" }), /https/);
});

test("refuses a resolver URL with credentials or a query", () => {
  assert.throws(() => readConfig({ ...ENV, IDR_REPORTING_URL: "https://u:p@resolver.example.test" }), ConfigError);
  assert.throws(() => readConfig({ ...ENV, IDR_REPORTING_URL: "https://resolver.example.test/?x=1" }), ConfigError);
});

test("refuses a short token without echoing it", () => {
  assert.throws(
    () => readConfig({ ...ENV, IDR_REPORTING_TOKEN: "short-token" }),
    (e) => e instanceof ConfigError && !e.message.includes("short-token"),
  );
});

test("refuses invalid BigQuery identifiers", () => {
  assert.throws(() => readConfig({ ...ENV, BQ_DATASET: "idr; DROP" }), /BQ_DATASET/);
  assert.throws(() => readConfig({ ...ENV, BQ_TABLE: "a`b" }), /BQ_TABLE/);
  assert.throws(() => readConfig({ ...ENV, BQ_PROJECT: "X" }), /BQ_PROJECT/);
});

test("validates IDR_MAX_PAGES", () => {
  assert.equal(readConfig({ ...ENV, IDR_MAX_PAGES: "5" }).maxPages, 5);
  assert.throws(() => readConfig({ ...ENV, IDR_MAX_PAGES: "0" }), /IDR_MAX_PAGES/);
});

test("BQ_ACTIVITY_TABLE defaults to daily_activity and must be a different, valid table", () => {
  assert.equal(readConfig(ENV).activityTable, "daily_activity");
  assert.equal(readConfig({ ...ENV, BQ_ACTIVITY_TABLE: " visit_counts " }).activityTable, "visit_counts");
  assert.equal(readConfig({ ...ENV, BQ_ACTIVITY_TABLE: "" }).activityTable, "daily_activity");
  assert.throws(() => readConfig({ ...ENV, BQ_ACTIVITY_TABLE: "bad-name" }), /BQ_ACTIVITY_TABLE is not a valid/);
  assert.throws(() => readConfig({ ...ENV, BQ_ACTIVITY_TABLE: "company_visits" }), /must differ/);
});
