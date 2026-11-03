import { describe, expect, it } from "vitest";
import { computeFingerprint, decodeSecret } from "../../src/ip/fingerprint.js";

const SECRET = decodeSecret("a".repeat(64));

describe("computeFingerprint", () => {
  it("is deterministic and 32 bytes", () => {
    const a = computeFingerprint(SECRET, "inst", "site", "203.0.113.5");
    const b = computeFingerprint(SECRET, "inst", "site", "203.0.113.5");
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  it("differs across installation, website, ip and secret", () => {
    const base = computeFingerprint(SECRET, "inst", "site", "203.0.113.5");
    const variants = [
      computeFingerprint(SECRET, "inst-2", "site", "203.0.113.5"),
      computeFingerprint(SECRET, "inst", "site-2", "203.0.113.5"),
      computeFingerprint(SECRET, "inst", "site", "203.0.113.6"),
      computeFingerprint(decodeSecret("b".repeat(64)), "inst", "site", "203.0.113.5"),
    ];
    for (const v of variants) expect(v.equals(base)).toBe(false);
  });

  it("is not ambiguous under concatenation (length-prefixed)", () => {
    const x = computeFingerprint(SECRET, "ab", "c", "203.0.113.5");
    const y = computeFingerprint(SECRET, "a", "bc", "203.0.113.5");
    expect(x.equals(y)).toBe(false);
    const p = computeFingerprint(SECRET, "inst", "site2", "03.0.113.5");
    const q = computeFingerprint(SECRET, "inst", "site", "203.0.113.5");
    expect(p.equals(q)).toBe(false);
  });

  it("does not contain the IP in its output", () => {
    const fp = computeFingerprint(SECRET, "inst", "site", "203.0.113.5");
    expect(fp.toString("latin1")).not.toContain("203.0.113.5");
  });

  it("decodes hex and base64url secrets to raw bytes", () => {
    expect(decodeSecret("00".repeat(32)).length).toBe(32);
    expect(decodeSecret("A".repeat(43)).length).toBe(32);
  });
});
