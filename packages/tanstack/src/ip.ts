/**
 * Strict IP literal parsing and public-address classification using Web APIs
 * only. Anything that is not a plain, public, globally routable unicast
 * address is rejected; the caller then sends nothing.
 */

export interface ParseIpOptions {
  /** RFC 5737 / RFC 3849 documentation ranges count as public. Tests and local development only. */
  allowDocumentationRanges?: boolean;
}

export type ParsedIp = { ok: true; ip: string; family: 4 | 6 } | { ok: false; reason: "malformed" | "non_public" };

const V4_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;

export function parseIPv4(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!V4_OCTET.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/** Returns eight 16-bit groups, or null when the text is not a strict IPv6 literal. */
export function parseIPv6(text: string): number[] | null {
  if (text.length < 2 || text.length > 45 || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  let str = text;
  let tail: number[] = [];
  if (text.includes(".")) {
    const i = text.lastIndexOf(":");
    if (i < 0) return null;
    const v4 = parseIPv4(text.slice(i + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    str = text.slice(0, i + 1);
    if (!str.endsWith("::")) str = str.slice(0, -1);
  }
  const want = 8 - tail.length;
  if (str.includes(":::")) return null;
  const first = str.indexOf("::");
  const hex = /^[0-9a-fA-F]{1,4}$/;
  let head: string[];
  if (first >= 0) {
    if (first !== str.lastIndexOf("::")) return null;
    const left = str.slice(0, first);
    const right = str.slice(first + 2);
    const l = left === "" ? [] : left.split(":");
    const r = right === "" ? [] : right.split(":");
    if (![...l, ...r].every((g) => hex.test(g))) return null;
    if (l.length + r.length > want - 1) return null;
    head = [...l, ...Array<string>(want - l.length - r.length).fill("0"), ...r];
  } else {
    head = str === "" ? [] : str.split(":");
    if (head.length !== want || !head.every((g) => hex.test(g))) return null;
  }
  return [...head.map((g) => parseInt(g, 16)), ...tail];
}

/** RFC 5952 text form: lower case, longest zero run (>= 2 groups) compressed. */
export function formatIPv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

function isPublicV4(o: readonly number[], docs: boolean): boolean {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
  if (a >= 224) return false; // multicast, reserved, broadcast
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 88 && c === 99) return false; // deprecated 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  const documentation = (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  if (documentation) return docs;
  return true;
}

function isPublicV6(g: readonly number[], docs: boolean): boolean {
  const g0 = g[0] ?? 0;
  const g1 = g[1] ?? 0;
  // Only global unicast (first three bits 001) can be a public client. This rejects ::, ::1,
  // IPv4-mapped/compatible (::/8), NAT64 (64:ff9b::), ULA fc00::/7, link-local
  // fe80::/10, multicast ff00::/8 and everything else outside global unicast.
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 < 0x0200) return false; // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID...)
  if (g0 === 0x2002) return false; // 6to4 (embeds IPv4 chosen by the sender)
  const documentation = (g0 === 0x2001 && g1 === 0x0db8) || (g0 === 0x3fff && g1 < 0x1000);
  if (documentation) return docs;
  return true;
}

/** Parses one IP literal (no port, brackets, zone id, whitespace, or mapped forms). */
export function parsePublicIp(text: string, options: ParseIpOptions = {}): ParsedIp {
  const docs = options.allowDocumentationRanges === true;
  if (typeof text !== "string" || text.length === 0 || text.length > 45) return { ok: false, reason: "malformed" };
  if (!text.includes(":")) {
    const v4 = parseIPv4(text);
    if (!v4) return { ok: false, reason: "malformed" };
    return isPublicV4(v4, docs) ? { ok: true, ip: v4.join("."), family: 4 } : { ok: false, reason: "non_public" };
  }
  const g = parseIPv6(text);
  if (!g) return { ok: false, reason: "malformed" };
  return isPublicV6(g, docs) ? { ok: true, ip: formatIPv6(g), family: 6 } : { ok: false, reason: "non_public" };
}
