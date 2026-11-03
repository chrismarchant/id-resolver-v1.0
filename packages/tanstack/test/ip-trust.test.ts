import { describe, expect, it } from "vitest";
import { parsePublicIp, selectClientIp, type TrustPolicy } from "../src/index.js";
import { formatIPv6, parseIPv6 } from "../src/ip.js";
import { validateTrustPolicy } from "../src/trust.js";
import { req } from "./helpers.js";

const docs = { allowDocumentationRanges: true };

describe("parsePublicIp", () => {
  const accepted: Array<[string, string]> = [
    ["198.51.100.7", "198.51.100.7"],
    ["203.0.113.250", "203.0.113.250"],
    ["192.0.2.1", "192.0.2.1"],
    ["2001:db8::1", "2001:db8::1"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["2001:db8::", "2001:db8::"],
  ];
  it.each(accepted)("accepts documentation address %s as %s when allowed", (input, canonical) => {
    expect(parsePublicIp(input, docs)).toEqual({ ok: true, ip: canonical, family: input.includes(":") ? 6 : 4 });
  });

  it("rejects documentation ranges by default (production)", () => {
    for (const ip of ["192.0.2.1", "198.51.100.7", "203.0.113.9", "2001:db8::1", "3fff::1"]) {
      expect(parsePublicIp(ip)).toEqual({ ok: false, reason: "non_public" });
    }
  });

  it("accepts a real global unicast address of each family when documentation ranges are off", () => {
    expect(parsePublicIp("11.22.33.44")).toEqual({ ok: true, ip: "11.22.33.44", family: 4 }); // public-safety: allow-synthetic parser input, never contacted
    expect(parsePublicIp("2a0d:1234:5678::1")).toEqual({ ok: true, ip: "2a0d:1234:5678::1", family: 6 });
  });

  const nonPublic = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
    "169.254.1.1", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.168.1.1", "192.88.99.1", "198.18.0.1", "198.19.255.255", // public-safety: allow-synthetic parser inputs, never contacted
    "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "64:ff9b::808:808", "100::1",
    "2002:c000:204::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:2::1", "2001:10::1", "5f00::1",
  ];
  it.each(nonPublic)("rejects non-public %s", (ip) => {
    const r = parsePublicIp(ip, docs);
    expect(r.ok).toBe(false);
  });

  const mapped = ["::ffff:198.51.100.7", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:c633:6407", "::198.51.100.7", "0:0:0:0:0:ffff:198.51.100.7", "64:ff9b::198.51.100.7"];
  it.each(mapped)("rejects IPv4-mapped / embedded forms %s", (ip) => {
    expect(parsePublicIp(ip, docs).ok).toBe(false);
  });

  const malformed = [
    "", " ", "1", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.04", "0x7f.0.0.1", "017700000001", "2130706433", "1.2.3.4/32", "1.2.3.4:80", "[2001:db8::1]", "[2001:db8::1]:443", // public-safety: allow-synthetic parser inputs, never contacted
    "2001:db8::1%eth0", "2001:db8:::1", "2001:db8::1::2", "2001:db8:1", "12345::1", "2001:db8::g", "1.2.3.4 ", " 1.2.3.4", "1.2.3.4\n", "1.2.3.4,5.6.7.8", "localhost", "example.com", "198.51.100.7;", "-1.2.3.4", "1.2.3.-4", // public-safety: allow-synthetic parser inputs, never contacted
    ":1:2:3:4:5:6:7", "1:2:3:4:5:6:7:", "1:2:3:4:5:6:7:8:9", "::1.2.3", "::1.2.3.4.5", "1::2::3", "a".repeat(46), // public-safety: allow-synthetic parser inputs, never contacted
  ];
  it.each(malformed)("rejects malformed %j", (ip) => {
    expect(parsePublicIp(ip, docs)).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("IPv6 text helpers", () => {
  it("round-trips and compresses per RFC 5952", () => {
    expect(formatIPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])).toBe("2001:db8::1");
    expect(formatIPv6([0x2001, 0xdb8, 0, 1, 0, 0, 0, 1])).toBe("2001:db8:0:1::1");
    expect(formatIPv6([1, 0, 2, 0, 3, 0, 4, 0])).toBe("1:0:2:0:3:0:4:0");
    expect(parseIPv6("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

const hdr = (h: Record<string, string>) => req("/x", h, { base: false });

describe("selectClientIp: trust policies", () => {
  const cf: TrustPolicy = { mode: "cloudflare" };
  const xff1: TrustPolicy = { mode: "xff", trustedHops: 1 };
  const xff2: TrustPolicy = { mode: "xff", trustedHops: 2 };
  const custom: TrustPolicy = { mode: "header", name: "X-Real-Client" };

  type Row = { name: string; policy: TrustPolicy; headers: Record<string, string>; expect: { ok: true; ip: string } | { ok: false; reason: string } };
  const rows: Row[] = [
    { name: "cloudflare: valid", policy: cf, headers: { "cf-connecting-ip": "198.51.100.7" }, expect: { ok: true, ip: "198.51.100.7" } },
    { name: "cloudflare: ipv6 canonicalised", policy: cf, headers: { "CF-Connecting-IP": "2001:DB8:0:0:0:0:0:5" }, expect: { ok: true, ip: "2001:db8::5" } },
    { name: "cloudflare: ignores XFF entirely", policy: cf, headers: { "x-forwarded-for": "203.0.113.9" }, expect: { ok: false, reason: "header_missing" } },
    { name: "cloudflare: ignores True-Client-IP", policy: cf, headers: { "true-client-ip": "203.0.113.9" }, expect: { ok: false, reason: "header_missing" } },
    { name: "cloudflare: missing", policy: cf, headers: {}, expect: { ok: false, reason: "header_missing" } },
    { name: "cloudflare: list in header", policy: cf, headers: { "cf-connecting-ip": "198.51.100.7, 203.0.113.9" }, expect: { ok: false, reason: "header_multiple" } },
    { name: "cloudflare: private", policy: cf, headers: { "cf-connecting-ip": "10.1.2.3" }, expect: { ok: false, reason: "ip_non_public" } },
    { name: "cloudflare: loopback v6", policy: cf, headers: { "cf-connecting-ip": "::1" }, expect: { ok: false, reason: "ip_non_public" } },
    { name: "cloudflare: link-local", policy: cf, headers: { "cf-connecting-ip": "169.254.169.254" }, expect: { ok: false, reason: "ip_non_public" } },
    { name: "cloudflare: mapped trick", policy: cf, headers: { "cf-connecting-ip": "::ffff:10.0.0.1" }, expect: { ok: false, reason: "ip_non_public" } },
    { name: "cloudflare: garbage", policy: cf, headers: { "cf-connecting-ip": "unknown" }, expect: { ok: false, reason: "ip_malformed" } },
    { name: "cloudflare: port appended", policy: cf, headers: { "cf-connecting-ip": "198.51.100.7:4433" }, expect: { ok: false, reason: "ip_malformed" } },
    { name: "cloudflare: embedded whitespace", policy: cf, headers: { "cf-connecting-ip": "198.51.100.7 x" }, expect: { ok: false, reason: "header_malformed" } },
    { name: "cloudflare: empty", policy: cf, headers: { "cf-connecting-ip": "" }, expect: { ok: false, reason: "header_malformed" } },

    { name: "xff1: single entry", policy: xff1, headers: { "x-forwarded-for": "198.51.100.7" }, expect: { ok: true, ip: "198.51.100.7" } },
    { name: "xff1: takes the rightmost, ignoring spoofed left entries", policy: xff1, headers: { "x-forwarded-for": "203.0.113.66, 198.51.100.7" }, expect: { ok: true, ip: "198.51.100.7" } },
    { name: "xff1: spoofed leftmost private is never consulted", policy: xff1, headers: { "x-forwarded-for": "10.0.0.1, 198.51.100.7" }, expect: { ok: true, ip: "198.51.100.7" } },
    { name: "xff1: rightmost private rejected, no walking left", policy: xff1, headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.9" }, expect: { ok: false, reason: "ip_non_public" } },
    { name: "xff2: second from right", policy: xff2, headers: { "x-forwarded-for": "203.0.113.66, 198.51.100.7, 192.168.0.4" }, expect: { ok: true, ip: "198.51.100.7" } },
    { name: "xff2: too few hops", policy: xff2, headers: { "x-forwarded-for": "198.51.100.7" }, expect: { ok: false, reason: "xff_too_few_hops" } },
    { name: "xff2: repeated headers are joined like a chain", policy: xff2, headers: { "x-forwarded-for": "198.51.100.7" }, expect: { ok: false, reason: "xff_too_few_hops" } },
    { name: "xff1: missing", policy: xff1, headers: {}, expect: { ok: false, reason: "header_missing" } },
    { name: "xff1: empty entry", policy: xff1, headers: { "x-forwarded-for": "198.51.100.7," }, expect: { ok: false, reason: "header_malformed" } },
    { name: "xff1: port in entry", policy: xff1, headers: { "x-forwarded-for": "198.51.100.7:80" }, expect: { ok: false, reason: "ip_malformed" } },
    { name: "xff1: obfuscated token", policy: xff1, headers: { "x-forwarded-for": "_hidden" }, expect: { ok: false, reason: "ip_malformed" } },
    { name: "xff1: too many entries", policy: xff1, headers: { "x-forwarded-for": Array(25).fill("198.51.100.7").join(", ") }, expect: { ok: false, reason: "xff_too_long" } },
    { name: "xff1: oversize header", policy: xff1, headers: { "x-forwarded-for": "1".repeat(600) }, expect: { ok: false, reason: "xff_too_long" } },
    { name: "xff1: ignores cf-connecting-ip", policy: xff1, headers: { "cf-connecting-ip": "198.51.100.7" }, expect: { ok: false, reason: "header_missing" } },
    { name: "xff1: ignores Forwarded header", policy: xff1, headers: { forwarded: "for=198.51.100.7" }, expect: { ok: false, reason: "header_missing" } },
    { name: "xff1: mapped loopback", policy: xff1, headers: { "x-forwarded-for": "::ffff:127.0.0.1" }, expect: { ok: false, reason: "ip_non_public" } },

    { name: "header: valid (case-insensitive name)", policy: custom, headers: { "x-real-client": "198.51.100.7" }, expect: { ok: true, ip: "198.51.100.7" } },
    { name: "header: ignores XFF", policy: custom, headers: { "x-forwarded-for": "198.51.100.7" }, expect: { ok: false, reason: "header_missing" } },
    { name: "header: multiple values", policy: custom, headers: { "x-real-client": "198.51.100.7, 198.51.100.8" }, expect: { ok: false, reason: "header_multiple" } },
    { name: "header: reserved", policy: custom, headers: { "x-real-client": "192.168.1.1" }, expect: { ok: false, reason: "ip_non_public" } },

    { name: "none: disabled even with headers", policy: { mode: "none" }, headers: { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "198.51.100.7" }, expect: { ok: false, reason: "policy_none" } },
  ];

  it.each(rows)("$name", (row) => {
    const r = selectClientIp(hdr(row.headers), row.policy, docs);
    if (row.expect.ok) expect(r).toMatchObject({ ok: true, ip: row.expect.ip });
    else expect(r).toEqual({ ok: false, reason: row.expect.reason });
  });

  it("repeated X-Forwarded-For header lines count as one chain, right to left", () => {
    const h = new Headers();
    h.append("x-forwarded-for", "203.0.113.66");
    h.append("x-forwarded-for", "198.51.100.7");
    const r = new Request("https://www.example.com/", { headers: h });
    expect(selectClientIp(r, xff1, docs)).toMatchObject({ ok: true, ip: "198.51.100.7" });
    expect(selectClientIp(r, xff2, docs)).toMatchObject({ ok: true, ip: "203.0.113.66" });
  });

  it("repeated CF-Connecting-IP lines are rejected as multiple", () => {
    const h = new Headers();
    h.append("cf-connecting-ip", "198.51.100.7");
    h.append("cf-connecting-ip", "198.51.100.8");
    expect(selectClientIp(new Request("https://www.example.com/", { headers: h }), cf, docs)).toEqual({ ok: false, reason: "header_multiple" });
  });

  it("documentation ranges are rejected unless explicitly allowed (production default)", () => {
    expect(selectClientIp(hdr({ "cf-connecting-ip": "198.51.100.7" }), cf)).toEqual({ ok: false, reason: "ip_non_public" });
  });

  it("rejection results never contain the offending value", () => {
    const r = selectClientIp(hdr({ "cf-connecting-ip": "10.20.30.40" }), cf, docs);
    expect(JSON.stringify(r)).not.toContain("10.20.30.40");
  });
});

describe("validateTrustPolicy", () => {
  it.each([
    [undefined], [null], [{}], [{ mode: "auto" }], [{ mode: "xff" }], [{ mode: "xff", trustedHops: 0 }], [{ mode: "xff", trustedHops: 1.5 }], [{ mode: "xff", trustedHops: 11 }],
    [{ mode: "xff", trustedHops: "1" }], [{ mode: "header" }], [{ mode: "header", name: "" }], [{ mode: "header", name: "bad name" }], [{ mode: "header", name: "Host" }], [{ mode: "header", name: "Cookie" }],
  ])("rejects %j", (p) => {
    expect(() => validateTrustPolicy(p as unknown as TrustPolicy)).toThrow(/idr-tanstack/);
  });
  it.each([[{ mode: "cloudflare" }], [{ mode: "none" }], [{ mode: "xff", trustedHops: 1 }], [{ mode: "xff", trustedHops: 3 }], [{ mode: "header", name: "X-Real-IP" }]])("accepts %j", (p) => {
    expect(() => validateTrustPolicy(p as TrustPolicy)).not.toThrow();
  });
});
