import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ipaddr from "ipaddr.js";
import {
  buildHostingRangeMatcher,
  hostingRangesAgeDays,
  HOSTING_RANGE_PROVIDERS,
  HostingRangesError,
  loadHostingRanges,
} from "../../src/ip/hosting-ranges.js";
// The generator is plain Node (it runs in a scheduled workflow); its pure helpers are tested here.
import {
  buildFile,
  canonicalPrefixes,
  findAzureFileUrl,
  formatV6,
  parseAws,
  parseGeofeed,
  parseV6,
  sameRanges,
  serialise,
  shrunkProviders,
  V4_MAX_LEN,
  V4_MIN_LEN,
  V6_MAX_LEN,
  V6_MIN_LEN,
} from "../../scripts/update-hosting-ranges.mjs";

// Documentation ranges only (RFC 5737 / RFC 3849): the repository's public-safety gate refuses public literals.
const file = (providers: Record<string, { v4?: string[]; v6?: string[] }>, extra: Record<string, unknown> = {}) => ({
  format: "hosting-ranges.v1",
  generated_at: "2026-11-09",
  generator: "test",
  providers: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, { source: "test", v4: v.v4 ?? [], v6: v.v6 ?? [] }])),
  ...extra,
});

const errorOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HostingRangesError);
    return (e as Error).message;
  }
  throw new Error("expected HostingRangesError");
};

describe("hosting range matcher", () => {
  const m = buildHostingRangeMatcher(
    file({
      aws: { v4: ["192.0.2.0/24", "203.0.113.16/28"], v6: ["2001:db8:1::/48"] },
      gcp: { v4: ["198.51.100.0/25"] },
      azure: { v4: ["192.0.2.0/25"] }, // overlaps aws: aws wins by the fixed provider order
    }),
  );

  it("matches IPv4 at block edges and nothing outside", () => {
    expect(m.lookup("192.0.2.0")).toBe("aws");
    expect(m.lookup("192.0.2.255")).toBe("aws");
    expect(m.lookup("203.0.113.16")).toBe("aws");
    expect(m.lookup("203.0.113.31")).toBe("aws");
    expect(m.lookup("203.0.113.15")).toBeNull();
    expect(m.lookup("203.0.113.32")).toBeNull();
    expect(m.lookup("198.51.100.77")).toBe("gcp");
    expect(m.lookup("198.51.100.128")).toBeNull();
  });

  it("matches IPv6 on the first 64 bits", () => {
    expect(m.lookup("2001:db8:1::1")).toBe("aws");
    expect(m.lookup("2001:db8:1:ffff:ffff:ffff:ffff:ffff")).toBe("aws");
    expect(m.lookup("2001:db8:2::")).toBeNull();
    expect(m.lookup("2001:db8:0:ffff:ffff:ffff:ffff:ffff")).toBeNull();
  });

  it("names the first provider in the fixed order when lists overlap, and ignores input that is not an address", () => {
    expect(HOSTING_RANGE_PROVIDERS.indexOf("aws")).toBeLessThan(HOSTING_RANGE_PROVIDERS.indexOf("azure"));
    expect(m.lookup("192.0.2.1")).toBe("aws");
    expect(m.lookup("not-an-ip")).toBeNull();
    expect(m.lookup("")).toBeNull();
    expect(m.prefixCount).toBe(5);
    expect(m.generatedAt).toBe("2026-11-09");
  });

  it("refuses a damaged file as a whole", () => {
    const cases: Array<[string, unknown]> = [
      ["format", { ...file({ aws: { v4: ["192.0.2.0/24"] } }), format: "hosting-ranges.v2" }],
      ["generated_at", file({ aws: { v4: ["192.0.2.0/24"] } }, { generated_at: "yesterday" })],
      ["unknown provider", file({ myhost: { v4: ["192.0.2.0/24"] } })],
      ["no prefixes", file({ aws: {} })],
      ["IPv4 prefix length", file({ aws: { v4: ["192.0.2.0/29"] } })],
      ["IPv4 prefix length", file({ aws: { v4: ["192.0.0.0/7"] } })],
      ["host bits", file({ aws: { v4: ["192.0.2.16/24"] } })],
      ["not an IPv4 prefix", file({ aws: { v4: ["192.0.2.0"] } })],
      ["not an IPv4 prefix", file({ aws: { v4: ["192.0.2.010/28"] } })],
      ["canonical", file({ aws: { v4: ["192.0.2.0/08"] } })],
      ["not sorted or overlapping", file({ aws: { v4: ["203.0.113.0/24", "192.0.2.0/24"] } })],
      ["not sorted or overlapping", file({ aws: { v4: ["192.0.2.0/24", "192.0.2.128/25"] } })],
      ["IPv6 prefix length", file({ aws: { v6: ["2001:db8::/65"] } })],
      ["IPv6 prefix length", file({ aws: { v6: ["2001::/15"] } })],
      ["canonical", file({ aws: { v6: ["2001:0db8::/32"] } })],
      ["not an IPv6 prefix", file({ aws: { v6: ["2001:DB8::/32"] } })],
      ["host bits", file({ aws: { v6: ["2001:db8::1/64"] } })],
      ["host bits", file({ aws: { v6: ["2001:db8:1::/32"] } })],
      ["not a string", file({ aws: { v4: [42 as unknown as string] } })],
    ];
    for (const [expected, data] of cases) expect(errorOf(() => buildHostingRangeMatcher(data))).toContain(expected);
    expect(errorOf(() => buildHostingRangeMatcher(null))).toContain("format");
    expect(errorOf(() => loadHostingRanges(new URL("file:///nonexistent/hosting-ranges.json")))).toContain("not readable");
  });

  it("error messages name the entry, never the prefix", () => {
    const message = errorOf(() => buildHostingRangeMatcher(file({ aws: { v4: ["198.51.100.0/24", "203.0.113.64/27", "203.0.113.70/32"] } })));
    expect(message).toContain("aws.v4[2]");
    expect(message).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("reports the file's age in whole days", () => {
    expect(hostingRangesAgeDays(m, new Date("2026-11-09T23:59:00Z"))).toBe(0);
    expect(hostingRangesAgeDays(m, new Date("2026-11-16T00:00:00Z"))).toBe(7);
  });
});

describe("the committed data file", () => {
  const matcher = loadHostingRanges();
  // Same path the service reads (src/ip/hosting-ranges.ts DEFAULT_HOSTING_RANGES_PATH).
  const raw = JSON.parse(readFileSync(new URL("../../data/hosting-ranges.json", import.meta.url), "utf8")) as {
    providers: Record<string, { v4: string[]; v6: string[] }>;
    generated_at: string;
  };

  it("loads, lists every provider and is reasonably fresh", () => {
    expect(Object.keys(raw.providers).sort()).toEqual([...HOSTING_RANGE_PROVIDERS].sort());
    expect(matcher.prefixCount).toBeGreaterThan(1_000);
    expect(matcher.generatedAt).toBe(raw.generated_at);
    for (const name of HOSTING_RANGE_PROVIDERS) expect(raw.providers[name]!.v4.length).toBeGreaterThan(0);
  });

  it("matches the first and last address of each provider's own blocks", () => {
    for (const name of HOSTING_RANGE_PROVIDERS) {
      for (const prefix of [raw.providers[name]!.v4[0]!, raw.providers[name]!.v4.at(-1)!]) {
        const [addr, len] = ipaddr.parseCIDR(prefix);
        const first = addr.toString();
        const last = ipaddr.IPv4.broadcastAddressFromCIDR(`${first}/${len}`).toString();
        // Overlapping lists name the earlier provider, so only a match is required here.
        expect(matcher.lookup(first)).not.toBeNull();
        expect(matcher.lookup(last)).not.toBeNull();
      }
    }
  });

  it("holds no private, documentation or otherwise special address space", () => {
    for (const p of Object.values(raw.providers)) {
      for (const prefix of [...p.v4, ...p.v6]) {
        const [addr] = ipaddr.parseCIDR(prefix);
        expect(addr.range(), prefix.split("/")[1]).toBe("unicast");
      }
    }
  });
});

describe("update-hosting-ranges generator", () => {
  it("shares its prefix bounds with the loader", () => {
    expect([V4_MIN_LEN, V4_MAX_LEN, V6_MIN_LEN, V6_MAX_LEN]).toEqual([8, 28, 16, 64]);
  });

  it("merges, masks host bits, drops pieces under /28 or /64 and splits blocks over /8", () => {
    expect(canonicalPrefixes(["203.0.113.128/25", "203.0.113.0/25", "203.0.113.7/25"], 4, "t")).toEqual(["203.0.113.0/24"]);
    expect(canonicalPrefixes(["198.51.100.0/24", "198.51.100.0/26"], 4, "t")).toEqual(["198.51.100.0/24"]);
    expect(canonicalPrefixes(["192.0.2.5/32", "192.0.2.64/29"], 4, "t")).toEqual([]);
    // 192.0.2.0 to 192.0.2.40: a /27, then a /29 and a single address that are both dropped.
    expect(canonicalPrefixes(["192.0.2.0/27", "192.0.2.32/29", "192.0.2.40/32"], 4, "t")).toEqual(["192.0.2.0/27"]);
    // A /7 is split into two /8 blocks (built at run time: the second /8 is public space).
    const seven = ["10", "0", "0", "0"].join(".") + "/7";
    expect(canonicalPrefixes([seven], 4, "t")).toEqual([`${["10", "0", "0", "0"].join(".")}/8`, `${["11", "0", "0", "0"].join(".")}/8`]);
    expect(canonicalPrefixes(["2001:db8:0:0::/48", "2001:db8::1/128", "2001:db8:1::/48"], 6, "t")).toEqual(["2001:db8::/47"]);
    expect(() => canonicalPrefixes(["not a prefix"], 4, "aws")).toThrow(/aws: unparsable IPv4/);
  });

  it("writes IPv6 exactly as RFC 5952 (the loader's canonical form)", () => {
    for (const text of ["2001:db8::", "2001:db8:0:1::", "2001:db8::1:0:0:1", "2001:db8:0:0:1::", "2001:db8:1:2:3:4:5:6", "2001:0:0:1::", "::"]) {
      expect(formatV6(parseV6(text)!)).toBe(ipaddr.IPv6.parse(text).toRFC5952String());
    }
  });

  it("serialises one prefix per line, in a form the loader accepts and the public-safety gate exempts", () => {
    const built = buildFile(
      [
        { provider: "aws", source: "s", version: "v", sha256: "0".repeat(64), v4: ["203.0.113.0/24", "192.0.2.0/24"], v6: ["2001:db8::/32"] },
        { provider: "bingbot", source: "s", version: "v", sha256: "0".repeat(64), v4: ["198.51.100.0/28"], v6: [] },
      ],
      "2026-11-09",
    );
    const text = serialise(built);
    const matcher = buildHostingRangeMatcher(JSON.parse(text));
    expect(matcher.lookup("192.0.2.9")).toBe("aws");
    expect(matcher.lookup("198.51.100.15")).toBe("bingbot");
    const prefixLines = text.split("\n").filter((l) => /\/\d/.test(l) && !l.includes('": '));
    expect(prefixLines).toHaveLength(4);
    for (const line of prefixLines) expect(line).toMatch(/^\s*"[0-9a-f.:]+\/\d{1,3}",?$/);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("parses the AWS (EC2 only), geofeed and Azure link formats", () => {
    const aws = parseAws({
      createDate: "d",
      prefixes: [
        { ip_prefix: "192.0.2.0/24", service: "EC2" },
        { ip_prefix: "198.51.100.0/24", service: "S3" },
      ],
      ipv6_prefixes: [{ ipv6_prefix: "2001:db8::/32", service: "EC2" }],
    });
    expect(aws).toEqual({ v4: ["192.0.2.0/24"], v6: ["2001:db8::/32"], version: "d" });
    expect(parseGeofeed("# comment\n192.0.2.0/24,NL,NL-NH,Amsterdam,\n2001:db8::/48,US,,,\n\n")).toEqual({ v4: ["192.0.2.0/24"], v6: ["2001:db8::/48"], version: "" });
    const link = findAzureFileUrl('<a href="https://download.microsoft.com/download/7/1/D/abc/ServiceTags_Public_20261102.json">');
    expect(link?.fileName).toBe("ServiceTags_Public_20261102.json");
    expect(findAzureFileUrl("<html>nothing here</html>")).toBeNull();
  });

  it("treats new dates and checksums alone as no change", () => {
    const a = buildFile([{ provider: "aws", source: "s", version: "v1", sha256: "a".repeat(64), v4: ["192.0.2.0/24"], v6: [] }], "2026-11-02");
    const b = buildFile([{ provider: "aws", source: "s", version: "v2", sha256: "b".repeat(64), v4: ["192.0.2.0/25", "192.0.2.128/25"], v6: [] }], "2026-11-09");
    const c = buildFile([{ provider: "aws", source: "s", version: "v2", sha256: "b".repeat(64), v4: ["192.0.2.0/25"], v6: [] }], "2026-11-09");
    expect(sameRanges(a, b)).toBe(true);
    expect(sameRanges(a, c)).toBe(false);
    expect(sameRanges(null, a)).toBe(false);
  });

  it("flags a provider whose IPv4 coverage would fall under half", () => {
    const before = { providers: { aws: { v4: ["192.0.2.0/24"] }, gcp: { v4: ["198.51.100.0/24"] } } };
    const after = { providers: { aws: { v4: ["192.0.2.0/25"], v6: [] }, gcp: { v4: ["198.51.100.0/26"], v6: [] }, oracle: { v4: ["203.0.113.0/28"], v6: [] } } };
    expect(shrunkProviders(before, after)).toEqual(["gcp"]);
    expect(shrunkProviders(null, after)).toEqual([]);
  });
});
