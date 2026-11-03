/**
 * Gate 5: the pure parts of the smoke test's events phase and feed reading
 * (src/ops/smoke-events.ts, smoke-events-db.ts, smoke-feed.ts,
 * smoke-http.ts): the reporting-feed.v1 shape check, the byte-for-byte answer
 * comparison behind "absent = like an unknown route", and the high-water-mark
 * window verdict that never fails on concurrent resolver traffic. The full
 * phase runs against the real service in
 * test/adversarial/smoke-ownership-events.test.ts.
 */
import { describe, expect, it } from "vitest";
import { checkEventsAbsent, EV } from "../../src/ops/smoke-events.js";
import { windowVerdict, type ResolutionSnapshot } from "../../src/ops/smoke-events-db.js";
import { feedPageShapeProblems, readFeed } from "../../src/ops/smoke-feed.js";
import { answerDifferences, type HttpAnswer } from "../../src/ops/smoke-http.js";
import { SmokeReport } from "../../src/ops/smoke-report.js";

const observation = {
  type: "observation",
  observation_id: "1",
  company_id: 1,
  domain: "example.com",
  organisation_name: null,
  observed_at: "2026-11-03T12:00:00.000Z",
  method: "cache",
  page_key: "/smoke/abc",
  acquisition: "direct",
  entrance_contract: "entrance.v1",
};
const tombstone = { type: "company_erased", tombstone_id: "3", company_id: 7, erased_at: "2026-11-03T12:05:00.000Z" };
const page = (items: unknown[], over: Record<string, unknown> = {}) => ({
  version: "1",
  contract: "reporting-feed.v1",
  scope: { installation_id: "inst-test", website_id: "site-test" },
  items,
  next_cursor: "c1",
  has_more: false,
  ...over,
});

describe("reporting-feed.v1 page shape", () => {
  it("accepts exactly the contract shape", () => {
    expect(feedPageShapeProblems(page([observation, tombstone]))).toEqual([]);
    expect(feedPageShapeProblems(page([]))).toEqual([]);
  });

  it("names every deviation by a fixed code, never a value", () => {
    expect(feedPageShapeProblems(undefined)).toEqual(["page_not_json_object"]);
    expect(feedPageShapeProblems(page([{ ...observation, ip: "203.0.113.10" }]))).toEqual(["observation_keys"]);
    const { page_key: _drop, ...missing } = observation;
    expect(feedPageShapeProblems(page([missing]))).toEqual(["observation_keys"]);
    expect(feedPageShapeProblems(page([{ ...tombstone, domain: "x" }]))).toEqual(["tombstone_keys"]);
    expect(feedPageShapeProblems(page([{ type: "browser_event", page_key: "/x" }]))).toEqual(["item_type"]);
    expect(feedPageShapeProblems(page([observation], { events: [] }))).toEqual(["page_keys"]);
    expect(feedPageShapeProblems(page([], { version: "2", contract: "x" })).sort()).toEqual(["contract", "version"]);
    expect(feedPageShapeProblems(page([], { scope: { installation_id: "a" } }))).toEqual(["scope_keys"]);
    for (const p of feedPageShapeProblems(page([{ ...observation, ip: "203.0.113.10" }]))) expect(p).not.toContain("203");
  });

  it("readFeed pages through every page, keeps the shape problems and can search the raw text", async () => {
    const pages = [JSON.stringify(page([observation], { has_more: true, next_cursor: "p2" })), JSON.stringify(page([tombstone, { ...observation, extra: 1 }]))];
    const queries: string[] = [];
    const feed = await readFeed(async (q) => {
      queries.push(q);
      return { status: 200, text: pages[queries.length - 1]!, headers: new Headers() };
    });
    expect(queries).toEqual(["?limit=500", "?after=p2&limit=500"]);
    expect(feed).toMatchObject({ ok: true, status: 200, pages: 2, shapeProblems: ["observation_keys"] });
    expect(feed.items).toHaveLength(3);
    expect(feed.includes("/smoke/abc")).toBe(true);
    expect(feed.includes("/smoke/abc/ev")).toBe(false);
  });

  it("readFeed stops at a non-200 page and reports it", async () => {
    const feed = await readFeed(async () => ({ status: 401, text: "{}", headers: new Headers() }));
    expect(feed).toMatchObject({ ok: false, status: 401, pages: 0, items: [], shapeProblems: [] });
  });
});

const answer = (status: number, text: string, headers: Record<string, string> = {}): HttpAnswer => ({
  status,
  text,
  headers: new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }),
});

describe("answer comparison (absent = byte-identical to an unknown route)", () => {
  const notFound = JSON.stringify({ version: "1", error: "not_found" });
  it("identical apart from the clock and rate-limit counters", () => {
    expect(answerDifferences(answer(404, notFound, { date: "a", "x-ratelimit-remaining": "9" }), answer(404, notFound, { date: "b", "x-ratelimit-remaining": "8" }))).toEqual([]);
  });

  it("names the differing part: status, body, a header value, or a header present on one side only", () => {
    expect(answerDifferences(answer(404, notFound), answer(400, notFound))).toEqual(["status"]);
    expect(answerDifferences(answer(404, notFound), answer(404, "{}"))).toEqual(["body"]);
    expect(answerDifferences(answer(404, notFound, { allow: "POST" }), answer(404, notFound))).toEqual(["header:allow"]);
    expect(answerDifferences(answer(404, notFound, { "content-length": "35" }), answer(404, notFound, { "content-length": "36" }))).toEqual(["header:content-length"]);
    // A volatile header present on one side only still counts: the header set must match.
    expect(answerDifferences(answer(404, notFound, { "retry-after": "1" }), answer(404, notFound))).toEqual(["header:retry-after"]);
  });

  it("checkEventsAbsent: 404 identical passes; a 200, a different answer, or 400 when 404 is required fails; any identical 4xx passes for a rollback target", async () => {
    const run = async (events: HttpAnswer, unknown: HttpAnswer, expectStatus: 404 | undefined) => {
      const lines: string[] = [];
      const report = new SmokeReport((l) => lines.push(l));
      await checkEventsAbsent({
        report,
        post: async (path, headers) => (headers["authorization"] === undefined ? answer(401, JSON.stringify({ version: "1", error: "unauthorized" })) : path === "/v1/events" ? events : unknown),
        websiteAuth: { authorization: "Bearer x" },
        json: {},
        websiteId: "site-test",
        run: "abc",
        expectStatus,
      });
      return report.results;
    };
    const invalid = JSON.stringify({ version: "1", error: "invalid_request" });
    let r = await run(answer(404, notFound), answer(404, notFound), 404);
    expect(r.map((x) => [x.check, x.outcome, x.detail])).toEqual([
      [EV.disabled, "pass", "status 404, identical to an unknown route"],
      [EV.disabledNoCredential, "pass", "status 401, identical to an unknown route"],
    ]);
    r = await run(answer(200, JSON.stringify({ version: "1", recorded: true })), answer(404, notFound), 404);
    expect(r[0]).toMatchObject({ outcome: "fail", detail: "status 200 vs 404, differs: status,body" });
    r = await run(answer(400, invalid), answer(400, invalid), 404);
    expect(r[0]).toMatchObject({ outcome: "fail", detail: "status 400, identical to an unknown route" });
    r = await run(answer(400, invalid), answer(400, invalid), undefined);
    expect(r[0]).toMatchObject({ outcome: "pass", detail: "status 400, identical to an unknown route" });
    r = await run(answer(200, "{}"), answer(200, "{}"), undefined);
    expect(r[0]).toMatchObject({ outcome: "fail" });
  });
});

const snap = (over: Partial<ResolutionSnapshot> = {}): ResolutionSnapshot => ({
  companiesMaxId: 10n,
  observationsMaxId: 100n,
  cacheRows: 5n,
  cacheLatestCheckedMs: 1_000,
  resolverRequests: 50n,
  pendingCacheRows: 0n,
  ...over,
});

describe("high-water-mark window verdict", () => {
  it("quiet when nothing grew, whatever else moved (maintenance deletes only lower the marks)", () => {
    expect(windowVerdict(snap(), snap())).toEqual({ kind: "quiet" });
    expect(windowVerdict(snap(), snap({ cacheRows: 2n, observationsMaxId: 90n, resolverRequests: 60n }))).toEqual({ kind: "quiet" });
  });

  it("fails (written without resolver traffic) when a row appeared and no resolver job ran", () => {
    expect(windowVerdict(snap(), snap({ companiesMaxId: 11n }))).toEqual({ kind: "written_without_resolver_traffic", grew: ["companies"] });
    expect(windowVerdict(snap(), snap({ observationsMaxId: 101n, cacheLatestCheckedMs: 2_000 }))).toEqual({
      kind: "written_without_resolver_traffic",
      grew: ["company_observations", "ip_resolution_cache"],
    });
    expect(windowVerdict(snap(), snap({ cacheRows: 6n }))).toMatchObject({ kind: "written_without_resolver_traffic" });
  });

  it("never fails on concurrent resolver traffic: inconclusive instead", () => {
    expect(windowVerdict(snap(), snap({ companiesMaxId: 11n, resolverRequests: 51n }))).toEqual({ kind: "inconclusive_concurrent_traffic", grew: ["companies"] });
    expect(windowVerdict(snap({ pendingCacheRows: 1n }), snap({ cacheRows: 6n }))).toMatchObject({ kind: "inconclusive_concurrent_traffic" });
    expect(windowVerdict(snap(), snap({ cacheRows: 6n, pendingCacheRows: 1n }))).toMatchObject({ kind: "inconclusive_concurrent_traffic" });
  });
});
