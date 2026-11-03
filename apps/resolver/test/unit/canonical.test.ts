import { describe, expect, it } from "vitest";
import { canonicaliseIp } from "../../src/ip/canonical.js";

function canonical(input: string): string {
  const r = canonicaliseIp(input);
  if (!r.ok) throw new Error("expected valid");
  return r.canonical;
}

describe("canonicaliseIp", () => {
  it("maps equivalent IPv6 forms to one canonical string", () => {
    const forms = ["2001:DB8::1", "2001:db8:0:0:0:0:0:1", "2001:db8::0001", "2001:0db8:0000:0000:0000:0000:0000:0001"];
    const out = new Set(forms.map(canonical));
    expect([...out]).toEqual(["2001:db8::1"]);
  });

  it("maps IPv4-mapped IPv6 to the IPv4 literal", () => {
    expect(canonical("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(canonical("::FFFF:203.0.113.5")).toBe("203.0.113.5");
    const r = canonicaliseIp("::ffff:203.0.113.5");
    expect(r.ok && r.family).toBe(4);
  });

  it("treats documentation addresses as ineligible by default and eligible only when allowed", () => {
    for (const ip of ["192.0.2.1", "198.51.100.7", "203.0.113.5", "2001:db8::42"]) {
      const prod = canonicaliseIp(ip);
      expect(prod.ok && prod.eligible, ip).toBe(false);
      expect(prod.ok && !prod.eligible && prod.range).toBe("documentation");
      const test = canonicaliseIp(ip, { allowDocumentationRanges: true });
      expect(test.ok && test.eligible, ip).toBe(true);
    }
  });

  it.each([
    ["private 10/8", "10.0.0.1"],
    ["private 172.16/12", "172.16.5.4"],
    ["private 192.168/16", "192.168.1.1"],
    ["loopback v4", "127.0.0.1"],
    ["loopback v6", "::1"],
    ["link-local v4", "169.254.10.20"],
    ["link-local v6", "fe80::1"],
    ["multicast v4", "224.0.0.1"],
    ["multicast v6", "ff02::1"],
    ["unspecified v4", "0.0.0.0"],
    ["unspecified v6", "::"],
    ["CGNAT", "100.64.0.1"],
    ["ULA", "fc00::1"],
    ["ULA fd", "fd12:3456::1"],
    ["broadcast", "255.255.255.255"],
    ["mapped private", "::ffff:10.0.0.1"],
  ])("%s is ineligible", (_label, ip) => {
    const r = canonicaliseIp(ip);
    expect(r.ok).toBe(true);
    expect(r.ok && r.eligible).toBe(false);
  });

  it.each([
    "",
    "1.2.3",
    "1.2.3.4.5",
    "999.1.1.1",
    "1.2.3.4:80",
    "[::1]",
    "203.0.113.5 ",
    " 203.0.113.5",
    "fe80::1%eth0",
    "0x7f.0.0.1",
    "1",
    "a".repeat(65),
    "1".repeat(65),
    "203.0.113.5\n",
    "2001:db8:::1",
    "example.com",
    "203.0.113.5/24",
  ])("rejects invalid input %j", (input) => {
    expect(canonicaliseIp(input)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("strict dotted-quad IPv4 (no octal/short forms)", () => {
  it("rejects leading-zero octets that ipaddr.js would read as octal", () => {
    for (const input of ["010.0.0.1", "0127.0.0.1", "203.0.113.05", "::ffff:010.0.0.1", "::ffff:0203.0.113.5", "1.2.3", "1.2.3.4.5", "300.1.1.1"]) {
      expect(canonicaliseIp(input), input).toEqual({ ok: false, reason: "invalid" });
    }
  });
  it("still accepts zero octets and mapped forms", () => {
    expect(canonicaliseIp("203.0.113.0")).toMatchObject({ ok: true, canonical: "203.0.113.0" });
    expect(canonicaliseIp("::ffff:203.0.113.5")).toMatchObject({ ok: true, canonical: "203.0.113.5", family: 4 });
  });
});
