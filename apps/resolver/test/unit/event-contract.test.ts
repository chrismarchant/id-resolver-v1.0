/**
 * event.v1 (Gate 4, CHR-64): the resolver's embedded vocabulary equals the
 * canonical docs/contracts/event-vocabulary.v1.json, and the strict request
 * schema accepts exactly the contract's fields and vocabulary pairs. The
 * schema has no field that could carry an IP, a user agent, a referrer, a
 * cookie, a session, a visitor or a company (owner decision D4).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBodySchema } from "../../src/api/schema.js";
import { EVENT_CONTRACT, EVENT_VOCABULARY, isVocabularyPair } from "../../src/contracts/event.js";

const CANONICAL = join(import.meta.dirname, "..", "..", "..", "..", "docs", "contracts", "event-vocabulary.v1.json");

const NOW_ISO = "2026-11-03T12:00:00.000Z";
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: EVENT_CONTRACT,
    website_id: "site-test",
    event_id: "evt_unit_0123456789AB",
    occurred_at: NOW_ISO,
    type: "page_view",
    name: "page_view",
    page_key: "/pricing",
    consent: "granted",
    ...over,
  };
}
const ok = (b: unknown) => EventBodySchema.safeParse(b).success;

describe("event-vocabulary.v1: one embedded copy, equal to the canonical contract file", () => {
  it("the resolver's vocabulary equals docs/contracts/event-vocabulary.v1.json exactly", () => {
    const canonical: unknown = JSON.parse(readFileSync(CANONICAL, "utf8"));
    expect(EVENT_VOCABULARY).toEqual(canonical);
    // Same order too, so a diff of the two is a diff of the vocabulary.
    expect(JSON.stringify(EVENT_VOCABULARY)).toBe(JSON.stringify(canonical));
  });

  it("isVocabularyPair accepts every listed pair and nothing else, including inherited keys", () => {
    const pairs = Object.entries(EVENT_VOCABULARY.types).flatMap(([t, names]) => names.map((n) => [t, n] as const));
    expect(pairs.length).toBe(14);
    for (const [t, n] of pairs) expect(isVocabularyPair(t, n), `${t}/${n}`).toBe(true);
    for (const [t, n] of [
      ["engagement", "page_view"], // a real name under the wrong type
      ["page_view", "scroll_50"],
      ["conversion_intent", "scroll_90"],
      ["click", "cta_click"],
      ["engagement", "scroll_75"],
      ["__proto__", "page_view"],
      ["constructor", "name"],
      ["toString", "length"],
      ["engagement", "length"],
      ["Page_View", "page_view"],
      ["", ""],
    ]) {
      expect(isVocabularyPair(t!, n!), `${t}/${n}`).toBe(false);
    }
  });
});

describe("event.v1 request schema", () => {
  it("has exactly the contract's fields: none can carry an IP, user agent, referrer, cookie, session, visitor, company or free text", () => {
    expect(Object.keys(EventBodySchema.shape).sort()).toEqual(["consent", "contract", "event_id", "name", "occurred_at", "page_key", "type", "website_id"]);
    for (const key of Object.keys(EventBodySchema.shape)) {
      expect(key).not.toMatch(/(^|_)ip(_|$)|addr|user_agent|agent|referr|cookie|session|visitor|company|fingerprint|text|value|url/);
    }
    expect(ok(body())).toBe(true);
  });

  it.each([
    "ip",
    "user_agent",
    "referrer",
    "referer",
    "company_id",
    "company",
    "session_id",
    "session",
    "visitor",
    "visitor_id",
    "cookie",
    "fingerprint",
    "text",
    "value",
    "url",
    "path",
    "v",
    "installation_id",
  ])("rejects the unknown field %s (strict)", (field) => {
    expect(ok(body({ [field]: field === "ip" ? "203.0.113.7" : "x" }))).toBe(false);
  });

  it("accepts every vocabulary pair and rejects out-of-vocabulary types, names and type-name pairs", () => {
    for (const [t, names] of Object.entries(EVENT_VOCABULARY.types)) for (const n of names) expect(ok(body({ type: t, name: n })), `${t}/${n}`).toBe(true);
    for (const over of [
      { type: "click" },
      { type: "engagement", name: "page_view" },
      { type: "conversion_intent", name: "scroll_50" },
      { name: "scroll_75", type: "engagement" },
      { type: "__proto__" },
      { type: "x".repeat(33) },
      { name: "y".repeat(33) },
      { type: 1 },
      { name: null },
    ]) {
      expect(ok(body(over)), JSON.stringify(over)).toBe(false);
    }
  });

  it("enforces the event_id grammar", () => {
    for (const id of ["a".repeat(16), "A".repeat(64), "abc_DEF-0123456789"]) expect(ok(body({ event_id: id })), id).toBe(true);
    for (const id of ["a".repeat(15), "a".repeat(65), "has space 0123456789", "evt.0123456789abcdef", "evt/0123456789abcdef", "", 12345678901234567]) {
      expect(ok(body({ event_id: id })), String(id)).toBe(false);
    }
  });

  it("enforces the entrance.v1 page_key rule: path only, no query or fragment, at most 256 characters", () => {
    expect(ok(body({ page_key: "/" }))).toBe(true);
    expect(ok(body({ page_key: `/${"p".repeat(255)}` }))).toBe(true);
    for (const pk of ["/pricing?plan=pro", "/pricing#faq", "/a?", "/a#", `/${"p".repeat(256)}`, "pricing", "", "/a b", "/a\tb", "/a\u0000"]) {
      expect(ok(body({ page_key: pk })), JSON.stringify(pk)).toBe(false);
    }
  });

  it("accepts only RFC 3339 UTC occurred_at values and consent granted | not_required", () => {
    for (const t of ["2026-11-03T12:00:00Z", "2026-11-03T12:00:00.123456789Z"]) expect(ok(body({ occurred_at: t })), t).toBe(true);
    for (const t of ["2026-11-03T12:00:00+01:00", "2026-11-03 12:00:00Z", "2026-02-30T12:00:00Z", "1730635200", ""]) expect(ok(body({ occurred_at: t })), t).toBe(false);
    expect(ok(body({ consent: "not_required" }))).toBe(true);
    for (const c of ["denied", "yes", "", true]) expect(ok(body({ consent: c })), String(c)).toBe(false);
    expect(ok(body({ contract: "event.v2" }))).toBe(false);
    expect(ok(body({ contract: "entrance.v1" }))).toBe(false);
    expect(ok(body({ website_id: "Site Test" }))).toBe(false);
  });
});
