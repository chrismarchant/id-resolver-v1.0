/**
 * reporting-feed.v1 wire allowlist and feed-SQL isolation (docs/GUARDRAILS.md
 * G6), the detector side: the clean feed SQL passes, and a planted reference
 * or an extra or missing wire key is reported. The real HTTP responses are
 * checked against the same allowlist in
 * test/integration/feed-wire-allowlist.test.ts.
 */
import { describe, expect, it } from "vitest";
import { FEED_SQL } from "../../src/db/reporting-repo.js";
import { feedSqlViolations, feedWireViolations, FEED_OBSERVATION_KEYS, FEED_TOMBSTONE_KEYS } from "../helpers/feed-wire.js";

const OBS = {
  type: "observation",
  observation_id: "1",
  company_id: 7,
  domain: "example.com",
  organisation_name: "Example Ltd",
  observed_at: "2026-11-03T12:00:00.000Z",
  method: "cache",
  page_key: "/pricing",
  acquisition: "search",
  entrance_contract: "entrance.v1",
};
const TOMB = { type: "company_erased", tombstone_id: "1", company_id: 7, erased_at: "2026-11-03T12:05:00.000Z" };
const page = (over: Record<string, unknown> = {}) => ({
  version: "1",
  contract: "reporting-feed.v1",
  scope: { installation_id: "inst-test", website_id: "site-test" },
  items: [OBS, TOMB],
  next_cursor: "c",
  has_more: false,
  ...over,
});

describe("feed SQL isolation", () => {
  it("the feed query references no IP cache table, fingerprint, observation reference, browser event or eligibility", () => {
    expect(feedSqlViolations(FEED_SQL)).toEqual([]);
    // Sanity: it is the real feed query.
    expect(FEED_SQL).toMatch(/FROM company_observations o/);
    expect(FEED_SQL).toMatch(/FROM feed_tombstones t/);
  });

  it.each([
    ["a join to the IP cache", (s: string) => s.replace("JOIN companies c ON c.id = o.company_id", "JOIN companies c ON c.id = o.company_id JOIN ip_resolution_cache ic ON ic.company_id = c.id")],
    ["a fingerprint column", (s: string) => s.replace("o.entrance_contract,", "o.entrance_contract, ic.ip_fingerprint,")],
    ["the observation reference", (s: string) => s.replace("o.entrance_contract,", "o.entrance_contract, o.observation_ref,")],
    ["the deduplication table", (s: string) => s.replace("FROM company_observations o", "FROM company_observation_refs o")],
    ["browser events", (s: string) => `${s} UNION ALL SELECT * FROM browser_events`],
  ])("detects %s planted into the feed query", (_name, plant) => {
    const planted = plant(FEED_SQL);
    expect(planted).not.toBe(FEED_SQL);
    expect(feedSqlViolations(planted).length).toBeGreaterThan(0);
  });
});

describe("feed wire allowlist detector", () => {
  it("a page with exactly the contract keys is clean (and so is an empty page and a 410 body)", () => {
    expect(feedWireViolations(page())).toEqual([]);
    expect(feedWireViolations(page({ items: [] }))).toEqual([]);
    expect(feedWireViolations({ version: "1", error: "cursor_expired" })).toEqual([]);
    expect(Object.keys(OBS).sort()).toEqual([...FEED_OBSERVATION_KEYS]);
    expect(Object.keys(TOMB).sort()).toEqual([...FEED_TOMBSTONE_KEYS]);
  });

  it.each([
    ["an IP on an observation", page({ items: [{ ...OBS, ip: "192.0.2.1" }] }), "items[0] observation: unexpected key ip"],
    ["a fingerprint on an observation", page({ items: [{ ...OBS, ip_fingerprint: "00" }] }), "items[0] observation: unexpected key ip_fingerprint"],
    ["an observation reference", page({ items: [{ ...OBS, observation_ref: "r" }] }), "items[0] observation: unexpected key observation_ref"],
    ["eligibility", page({ items: [{ ...OBS, eligibility: "tsa-1" }] }), "items[0] observation: unexpected key eligibility"],
    ["a domain on a tombstone", page({ items: [OBS, { ...TOMB, domain: "example.com" }] }), "items[1] company_erased: unexpected key domain"],
    ["an extra envelope key", page({ txid: "1" }), "envelope: unexpected key txid"],
    ["an extra scope key", page({ scope: { installation_id: "i", website_id: "w", token: "t" } }), "scope: unexpected key token"],
    ["a missing observation key", page({ items: [(({ page_key: _p, ...rest }) => rest)(OBS)] }), "items[0] observation: missing key page_key"],
    ["an unknown item type", page({ items: [{ type: "visitor", id: "1" }] }), "items[0]: unknown item type"],
    ["an extra key on a 410 body", { version: "1", error: "cursor_expired", items: [] }, "expired: unexpected key items"],
  ])("detects %s", (_name, body, violation) => {
    expect(feedWireViolations(body)).toContain(violation);
  });
});
