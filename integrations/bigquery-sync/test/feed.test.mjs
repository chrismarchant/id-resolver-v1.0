import assert from "node:assert/strict";
import { test } from "node:test";

import { readConfig } from "../src/config.mjs";
import { FeedError, readFeed } from "../src/feed.mjs";
import { ENV, TOKEN, json, observation, page, recordingFetch } from "./helpers.mjs";

const cfg = readConfig(ENV);

test("reads every page from the start and sends the bearer token", async () => {
  const fetch = recordingFetch((call, n) =>
    n === 1
      ? json(200, page([observation(1, 7)], { hasMore: true, next: "c1" }))
      : json(200, page([observation(2, 8)], { next: "c2" })),
  );
  const items = await readFeed(cfg, { fetch });
  assert.deepEqual(items.map((i) => i.observation_id), ["1", "2"]);
  assert.equal(fetch.calls.length, 2);
  const first = new URL(fetch.calls[0].url);
  assert.equal(first.pathname, "/v1/reporting/observations");
  assert.equal(first.searchParams.get("after"), null);
  assert.equal(first.searchParams.get("limit"), "500");
  assert.equal(new URL(fetch.calls[1].url).searchParams.get("after"), "c1");
  assert.equal(fetch.calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(fetch.calls[0].init.redirect, "error");
});

test("restarts once from the beginning after a 410", async () => {
  const fetch = recordingFetch((call, n) => {
    if (n === 1) return json(200, page([observation(1, 7)], { hasMore: true, next: "c1" }));
    if (n === 2) return json(410, { version: "1", error: "cursor_expired" });
    return json(200, page([observation(3, 7)], { next: "c3" }));
  });
  const items = await readFeed(cfg, { fetch });
  assert.deepEqual(items.map((i) => i.observation_id), ["3"]);
  assert.equal(new URL(fetch.calls[2].url).searchParams.get("after"), null);
});

test("fails after a second 410", async () => {
  const fetch = recordingFetch(() => json(410, { version: "1", error: "cursor_expired" }));
  await assert.rejects(readFeed(cfg, { fetch }), (e) => e instanceof FeedError && e.status === 410);
  assert.equal(fetch.calls.length, 2);
});

test("fails on 401 without exposing the token", async () => {
  const fetch = recordingFetch(() => json(401, { error: "unauthorized" }));
  await assert.rejects(readFeed(cfg, { fetch }), (e) => e.status === 401 && !e.message.includes(TOKEN));
});

test("refuses a page for another website", async () => {
  const fetch = recordingFetch(() => json(200, page([], { websiteId: "someone-else" })));
  await assert.rejects(readFeed(cfg, { fetch }), /different website/);
});

test("refuses malformed items", async () => {
  for (const bad of [
    observation(1, 7, { observed_at: "not a date" }),
    observation(1, 7, { company_id: "7" }),
    observation(1, 7, { method: "guess" }),
    observation(1, 7, { acquisition: "carrier-pigeon" }),
    { type: "something_else" },
  ]) {
    const fetch = recordingFetch(() => json(200, page([bad])));
    await assert.rejects(readFeed(cfg, { fetch }), FeedError);
  }
});

test("fails when the feed does not advance or has too many pages", async () => {
  const stuck = recordingFetch(() => json(200, page([], { hasMore: true, next: "same" })));
  await assert.rejects(readFeed(cfg, { fetch: stuck }), /did not advance/);

  let n = 0;
  const endless = recordingFetch(() => json(200, page([], { hasMore: true, next: `c${(n += 1)}` })));
  await assert.rejects(readFeed({ ...cfg, maxPages: 3 }, { fetch: endless }), /more than 3 pages/);
});

test("reports network failures without details", async () => {
  const fetch = async () => {
    throw new TypeError(`fetch failed for ${TOKEN}`);
  };
  await assert.rejects(readFeed(cfg, { fetch }), (e) => e instanceof FeedError && !e.message.includes(TOKEN));
});
