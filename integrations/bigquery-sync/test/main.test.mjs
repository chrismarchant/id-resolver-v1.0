import assert from "node:assert/strict";
import { test } from "node:test";

import { METADATA_TOKEN_URL } from "../src/bigquery.mjs";
import { redact, run } from "../src/main.mjs";
import { ENV, TOKEN, json, observation, page, recordingFetch } from "./helpers.mjs";

const fast = { pollMs: 0, sleep: async () => {} };

function world({ feedStatus = 200, items = [observation(1, 7), observation(2, 8)] } = {}) {
  return recordingFetch(({ url }) => {
    if (url.startsWith("https://resolver.example.test/")) return feedStatus === 200 ? json(200, page(items)) : json(feedStatus, {});
    if (url === METADATA_TOKEN_URL) return json(200, { access_token: "ya29.x" });
    if (url.includes("uploadType=multipart") || url.endsWith("/jobs")) return json(200, {});
    return json(200, { status: { state: "DONE" } });
  });
}

test("a successful run logs counts only", async () => {
  const logs = [];
  const fetch = world();
  const result = await run({ env: ENV, fetch, log: (e) => logs.push(e), now: () => new Date("2026-11-05T10:00:00Z"), bigQueryOptions: fast });
  assert.deepEqual(result, { ok: true, rows: 2 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].outcome, "ok");
  assert.equal(logs[0].rows, 2);
  assert.equal(logs[0].feed_items, 2);
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
