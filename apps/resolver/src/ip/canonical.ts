/**
 * IP canonicalisation and eligibility using a vetted parser (ipaddr.js).
 *
 * - Rejects anything that is not a syntactically valid IPv4/IPv6 literal.
 * - Normalises IPv6 to the RFC 5952 compact lowercase form.
 * - Maps IPv4-mapped IPv6 (::ffff:a.b.c.d) to the IPv4 literal so equivalent
 *   representations share one fingerprint.
 * - Classifies private/loopback/link-local/multicast/reserved/unspecified as
 *   ineligible so they are never sent to the paid provider.
 */
import ipaddr from "ipaddr.js";
import { isIPv4 } from "node:net";
import { MAX_IP_LENGTH } from "../contracts/api.js";

export type CanonicalIp =
  | { ok: true; canonical: string; family: 4 | 6; eligible: true }
  | { ok: true; canonical: string; family: 4 | 6; eligible: false; range: string }
  | { ok: false; reason: "invalid" };

const INELIGIBLE_RANGES = new Set([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "private",
  "uniqueLocal",
  "reserved",
  "carrierGradeNat",
  "benchmarking",
  "amt",
  "as112",
  "as112v6",
  "deprecated",
  "discard",
  "orchid2",
  "droneRemoteIdProtocolEntityTags",
  "ipv4Mapped", // only reachable if mapping failed; treat conservatively
  "rfc6145",
  "rfc6052",
  "6to4",
  "teredo",
]);

// RFC 5737/3849 documentation ranges are "reserved" in ipaddr.js. They are
// INELIGIBLE by default so a production deployment never sends them to the
// paid provider; tests opt in with `allowDocumentationRanges` so the pipeline
// can be exercised with addresses that never belong to a real network.
const DOCUMENTATION_V4 = [
  ipaddr.parseCIDR("192.0.2.0/24"),
  ipaddr.parseCIDR("198.51.100.0/24"),
  ipaddr.parseCIDR("203.0.113.0/24"),
];
const DOCUMENTATION_V6 = [ipaddr.parseCIDR("2001:db8::/32")];

export interface CanonicaliseOptions {
  allowDocumentationRanges?: boolean;
}

export function canonicaliseIp(input: string, options: CanonicaliseOptions = {}): CanonicalIp {
  const allowDocs = options.allowDocumentationRanges === true;
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_IP_LENGTH) {
    return { ok: false, reason: "invalid" };
  }
  // Reject whitespace, zone ids, ports, brackets and anything non-literal up front.
  if (!/^[0-9a-fA-F:.]+$/.test(input)) return { ok: false, reason: "invalid" };
  if (!ipaddr.isValid(input)) return { ok: false, reason: "invalid" };
  // ipaddr.js accepts octal/hex/short IPv4 forms ("010.0.0.1" → 8.0.0.1). Require a
  // strict dotted quad for plain IPv4 and for IPv4 embedded in IPv6 (::ffff:a.b.c.d).
  if (input.includes(".")) {
    const quad = input.slice(input.lastIndexOf(":") + 1);
    if (!isIPv4(quad)) return { ok: false, reason: "invalid" };
  }

  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(input); // converts IPv4-mapped IPv6 to IPv4
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (addr.kind() === "ipv4") {
    const v4 = addr as ipaddr.IPv4;
    // ipaddr.js accepts non-dotted-quad forms (e.g. "1" or "0x7f.1"); require 4 octets.
    if (input.includes(":") === false && input.split(".").length !== 4) return { ok: false, reason: "invalid" };
    const canonical = v4.toString();
    if (DOCUMENTATION_V4.some((cidr) => v4.match(cidr))) {
      return allowDocs ? { ok: true, canonical, family: 4, eligible: true } : { ok: true, canonical, family: 4, eligible: false, range: "documentation" };
    }
    const range = v4.range();
    if (range !== "unicast" && INELIGIBLE_RANGES.has(range)) return { ok: true, canonical, family: 4, eligible: false, range };
    if (range !== "unicast") return { ok: true, canonical, family: 4, eligible: false, range };
    return { ok: true, canonical, family: 4, eligible: true };
  }

  const v6 = addr as ipaddr.IPv6;
  const canonical = v6.toRFC5952String();
  if (DOCUMENTATION_V6.some((cidr) => v6.match(cidr))) {
    return allowDocs ? { ok: true, canonical, family: 6, eligible: true } : { ok: true, canonical, family: 6, eligible: false, range: "documentation" };
  }
  const range = v6.range();
  if (range !== "unicast") return { ok: true, canonical, family: 6, eligible: false, range };
  return { ok: true, canonical, family: 6, eligible: true };
}
