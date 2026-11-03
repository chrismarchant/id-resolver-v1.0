// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_VOCABULARY } from "../src/index.js";

const canonicalPath = resolve(import.meta.dirname, "../../../docs/contracts/event-vocabulary.v1.json");
const srcDir = resolve(import.meta.dirname, "../src");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("event-vocabulary.v1 (embedded copy)", () => {
  it("equals the canonical docs/contracts/event-vocabulary.v1.json exactly (values and key order)", () => {
    const canonical = JSON.parse(readFileSync(canonicalPath, "utf8")) as unknown;
    expect(EVENT_VOCABULARY).toStrictEqual(canonical);
    expect(JSON.stringify(EVENT_VOCABULARY)).toBe(JSON.stringify(canonical));
  });

  it("names are unique across types (each name maps to exactly one type)", () => {
    const names = Object.values(EVENT_VOCABULARY.types).flat();
    expect(new Set(names).size).toBe(names.length);
  });

  it("is embedded in one place in this package (src/vocabulary.ts)", () => {
    // Type keys and names that no behaviour code needs: only a copy of the list would contain them.
    const holders = readdirSync(srcDir).filter((f) => /conversion_intent|demo_request_start|video_complete|contact_view/.test(strip(readFileSync(join(srcDir, f), "utf8"))));
    expect(holders).toEqual(["vocabulary.ts"]);
  });

  it("every event name quoted in the collector's behaviour code is a vocabulary name", () => {
    const names = new Set<string>(Object.values(EVENT_VOCABULARY.types).flat());
    const code = strip(readFileSync(join(srcDir, "index.ts"), "utf8"));
    const quoted = [...code.matchAll(/"((?:page|scroll|engaged|video|file|outbound|cta|pricing|contact|demo|form)_[a-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(quoted.length).toBeGreaterThan(5);
    for (const q of quoted) expect(names.has(q), q).toBe(true);
  });
});
