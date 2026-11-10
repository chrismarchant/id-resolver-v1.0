import { describe, expect, it } from "vitest";
import {
  canonicaliseDomain,
  canonicaliseOrganisationName,
  canonicaliseUsageType,
  isNetworkOperatorName,
  isNetworkOwner,
  organisationMatchesDomain,
  qualify,
  sameOrganisation,
  type QualificationPolicy,
} from "../../src/resolution/qualify.js";

const policy: QualificationPolicy = {
  qualified_usage_types: ["COM", "ORG", "GOV", "EDU", "MIL", "LIB"],
  excluded_usage_types: ["ISP", "MOB", "DCH", "CDN", "SES", "RSV"],
  denied_domains: ["Denied.Example", "www.blocked.example."],
};

describe("canonicaliseDomain", () => {
  it.each([
    ["example.com", "example.com"],
    ["  Example.COM  ", "example.com"],
    ["example.com.", "example.com"],
    ["www.example.com", "example.com"],
    ["WWW.Example.co.uk.", "example.co.uk"],
    ["sub.www.example.com", "sub.www.example.com"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["a-b.example", "a-b.example"],
  ])("%j -> %j", (input, expected) => {
    expect(canonicaliseDomain(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "localhost",
    "www.",
    "-bad.example",
    "bad-.example",
    "under_score.example",
    "exa mple.com",
    "example..com",
    ".example.com",
    "203.0.113.5",
    "example.com/path",
    "https://example.com",
    "user@example.com",
    "ex\u0000ample.com",
    `${"a".repeat(64)}.example`,
    `${"a".repeat(60)}.`.repeat(5) + "com",
    "bücher.example",
  ])("rejects %j", (input) => {
    expect(canonicaliseDomain(input)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(canonicaliseDomain(undefined)).toBeNull();
    expect(canonicaliseDomain(null)).toBeNull();
    expect(canonicaliseDomain(42)).toBeNull();
  });
});

describe("canonicaliseOrganisationName", () => {
  it("trims, collapses whitespace and strips control characters", () => {
    expect(canonicaliseOrganisationName("  Example \t\n Ltd  ")).toBe("Example Ltd");
    expect(canonicaliseOrganisationName("Example\u0000\u0007Ltd")).toBe("Example Ltd");
    expect(canonicaliseOrganisationName("Example‮Ltd")).toBe("Example Ltd");
  });
  it("caps at 200 characters", () => {
    expect(canonicaliseOrganisationName("x".repeat(500))).toHaveLength(200);
  });
  it("returns null when empty or not a string", () => {
    expect(canonicaliseOrganisationName("   ")).toBeNull();
    expect(canonicaliseOrganisationName("\u0000\u0001")).toBeNull();
    expect(canonicaliseOrganisationName(null)).toBeNull();
    expect(canonicaliseOrganisationName(7)).toBeNull();
  });
});

describe("canonicaliseUsageType", () => {
  it("uppercases and bounds the code", () => {
    expect(canonicaliseUsageType(" com ")).toBe("COM");
    expect(canonicaliseUsageType("ISP/MOB")).toBe("ISP/MOB");
    expect(canonicaliseUsageType("")).toBeNull();
    expect(canonicaliseUsageType("x".repeat(17))).toBeNull();
    expect(canonicaliseUsageType("C O M")).toBeNull();
    expect(canonicaliseUsageType(undefined)).toBeNull();
  });
});

describe("qualify", () => {
  it("qualifies an allowlisted usage type with category = usage type", () => {
    expect(qualify({ domain: "example.com", usageType: "com" }, policy)).toEqual({
      kind: "qualified",
      category: "COM",
      reason: "provider_resolved",
    });
    expect(qualify({ domain: "example.edu", usageType: "EDU" }, policy).kind).toBe("qualified");
  });

  it("excludes network-owner usage types", () => {
    for (const u of ["ISP", "mob", "DCH", "CDN", "SES", "RSV"]) {
      expect(qualify({ domain: "example-isp.net", usageType: u }, policy)).toEqual({
        kind: "excluded",
        reason: "provider_excluded_usage_type",
      });
    }
  });

  it("returns unknown for missing or unrecognised usage types", () => {
    for (const u of [null, "", "XYZ", "ISP/MOB", "COM/ISP"]) {
      expect(qualify({ domain: "example.com", usageType: u }, policy)).toEqual({
        kind: "unknown",
        reason: "provider_unknown_usage_type",
      });
    }
  });

  it("returns unknown for denied domains (case-insensitive, canonicalised)", () => {
    for (const d of ["denied.example", "DENIED.example", "blocked.example", "www.blocked.example"]) {
      expect(qualify({ domain: d, usageType: "COM" }, policy)).toEqual({ kind: "unknown", reason: "provider_denied_domain" });
    }
    expect(qualify({ domain: "notdenied.example", usageType: "COM" }, policy).kind).toBe("qualified");
  });

  it("never qualifies an invalid domain", () => {
    expect(qualify({ domain: "not a domain", usageType: "COM" }, policy).kind).toBe("unknown");
  });
});

describe("network-owner guard", () => {
  it("excludes a qualifying result whose organisation is a network operator and does not own the domain (the reported case)", () => {
    expect(
      qualify({ domain: "valley-review.example", usageType: "COM", organisationName: "Example Helios Networking Solutions Private Limited" }, policy),
    ).toEqual({ kind: "excluded", reason: "provider_network_owner" });
  });

  it("excludes when the provider names the organisation as the network's operator, whatever the name", () => {
    expect(qualify({ domain: "customer-shop.example", usageType: "COM", organisationName: "Example Online GmbH", organisationIsNetworkOperator: true }, policy)).toEqual({
      kind: "excluded",
      reason: "provider_network_owner",
    });
  });

  it.each([
    ["Juniper Networks", "juniper.example"],
    ["Palo Alto Networks Inc", "paloaltonetworks.example"],
    ["Extreme Networks", "extremenetworks.example"],
    ["Example Communications Ltd", "examplepr.co.uk"],
    ["British Telecommunications PLC", "bt.example"],
    ["International Business Machines", "ibm.example"],
    ["Tata Communications", "tatacommunications.example"],
  ])("keeps a network company that owns its domain: %s / %s", (organisationName, domain) => {
    expect(qualify({ domain, usageType: "COM", organisationName, organisationIsNetworkOperator: true }, policy)).toMatchObject({ kind: "qualified", category: "COM" });
  });

  it("keeps an ordinary company even when its name does not match the domain", () => {
    expect(qualify({ domain: "brand.example", usageType: "COM", organisationName: "Example Holdings Ltd" }, policy)).toMatchObject({ kind: "qualified" });
  });

  it("needs an organisation name, and never changes an excluded or unknown usage type", () => {
    expect(qualify({ domain: "valley-review.example", usageType: "COM", organisationName: null, organisationIsNetworkOperator: true }, policy)).toMatchObject({ kind: "qualified" });
    expect(qualify({ domain: "valley-review.example", usageType: "ISP", organisationName: "Example Broadband" }, policy)).toEqual({ kind: "excluded", reason: "provider_excluded_usage_type" });
    expect(qualify({ domain: "valley-review.example", usageType: "XYZ", organisationName: "Example Broadband" }, policy)).toEqual({ kind: "unknown", reason: "provider_unknown_usage_type" });
    expect(qualify({ domain: "denied.example", usageType: "COM", organisationName: "Example Broadband" }, policy)).toEqual({ kind: "unknown", reason: "provider_denied_domain" });
  });

  it("is switched off by network_owner_guard: false", () => {
    expect(
      qualify({ domain: "valley-review.example", usageType: "COM", organisationName: "Example Helios Networking Solutions Private Limited" }, { ...policy, network_owner_guard: false }),
    ).toMatchObject({ kind: "qualified" });
  });

  it("isNetworkOperatorName matches whole words and phrases only", () => {
    for (const n of ["Example Broadband", "Example Telecom SA", "Example Internet Services", "Example Data Centre Ltd", "Example Web Hosting", "EXAMPLE NETWORKS", "Example Telecomunicações"]) {
      expect(isNetworkOperatorName(n), n).toBe(true);
    }
    for (const n of ["Networkly Ltd", "Telecomix Media", "Example Holdings", "Hostess Brands"]) expect(isNetworkOperatorName(n), n).toBe(false);
  });

  it("organisationMatchesDomain: distinctive word, joined name, or initials; legal forms and descriptive words never match", () => {
    expect(organisationMatchesDomain("Example Helios Networking Solutions Private Limited", "valley-review.example")).toBe(false);
    expect(organisationMatchesDomain("Example Helios Networking Solutions Private Limited", "helios.example")).toBe(true);
    expect(organisationMatchesDomain("Networking Solutions Private Limited", "solutions.example")).toBe(true);
    expect(organisationMatchesDomain("Networking Solutions Private Limited", "limited.example")).toBe(false);
    expect(organisationMatchesDomain("Example Widgets", "shop.example-widgets.co.uk")).toBe(true);
    expect(organisationMatchesDomain("Acme Widgets", "aw.co.uk")).toBe(true);
  });

  it("sameOrganisation ignores case, punctuation and legal forms", () => {
    expect(sameOrganisation("Example Helios Networking Solutions Private Limited", "EXAMPLE HELIOS NETWORKING SOLUTIONS PVT. LTD.")).toBe(true);
    expect(sameOrganisation("Example Ltd", "Example Transit Networks")).toBe(false);
    expect(sameOrganisation("Ltd", "Limited")).toBe(false);
  });

  it("isNetworkOwner is false without a name", () => {
    expect(isNetworkOwner("valley-review.example", { organisationName: "   ", organisationIsNetworkOperator: true })).toBe(false);
  });
});
