import { describe, expect, it } from "vitest";
import { decodeUriOrNull, isCollectorPath, routerPathname } from "../src/collector-path.js";

/** Deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

describe("collector path canonicalisation building blocks (G5R2-L1)", () => {
  it("decodeUriOrNull equals decodeURI on 200,000 random escape strings (null exactly where decodeURI throws)", () => {
    // Escapes chosen to hit every branch: ASCII, reserved, controls, lead bytes of 2, 3 and 4 byte sequences,
    // continuation bytes, invalid lead bytes, surrogates, overlongs, a stray "%" and broken hex.
    const parts = ["%41", "%65", "%2F", "%2f", "%3B", "%23", "%25", "%20", "%00", "%7F", "%C3", "%A9", "%C0", "%AE", "%E0", "%A4", "%E2", "%84", "%AA", "%ED", "%A0", "%80", "%F0", "%9F", "%98", "%F4", "%90", "%F8", "%FF", "%BF", "%", "%2", "%G1", "a", "/", "é", "%e9"];
    const rnd = prng(31337);
    let threw = 0;
    for (let i = 0; i < 200_000; i++) {
      let s = "";
      for (let k = 1 + rnd(8); k > 0; k--) s += parts[rnd(parts.length)];
      let expected: string | null;
      try {
        expected = decodeURI(s);
      } catch {
        expected = null;
        threw++;
      }
      if (decodeUriOrNull(s) !== expected) expect.fail(`decodeUriOrNull(${JSON.stringify(s)}) = ${JSON.stringify(decodeUriOrNull(s))}, decodeURI: ${JSON.stringify(expected)}`);
    }
    expect(threw).toBeGreaterThan(10_000);
  });

  it("routerPathname: what TanStack Router matches routes against (examples)", () => {
    expect(routerPathname("/idr/e%20")).toBe("/idr/e");
    expect(routerPathname("/idr/e%20%20/")).toBe("/idr/e%20%20"); // the slash protects the spaces from the trim
    expect(routerPathname("/IDR/%45%20")).toBe("/IDR/E");
    expect(routerPathname("/x/%2%65%2%65/idr/e")).toBe("/idr/e");
    expect(routerPathname("/idr/e%09")).toBe("/idr/e%09");
    expect(routerPathname("/idr/e%20x")).toBe("/idr/e%20x");
    expect(routerPathname("/idr%2Fe")).toBe("/idr%2Fe");
    expect(routerPathname("/idr/%2565")).toBe("/idr/%2565");
  });

  it("isCollectorPath stays fast on hostile escapes (no exception per escape)", () => {
    const hostile = ["/" + "%C0x".repeat(4_000), "/" + "%25%".repeat(4_000), "/" + "%E0%A4/".repeat(2_300), "/" + "%x".repeat(8_000), "/" + "%2%65".repeat(3_000) + "/idr/e"];
    // Best of five runs (the first warms up): wall-clock time in a parallel test run is noisy, a quadratic or
    // exception-per-escape cost is not. decodeURI would throw once per escape on these; the port stays linear.
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      for (const p of hostile) isCollectorPath(p, "/idr/e");
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(40);
  });
});
