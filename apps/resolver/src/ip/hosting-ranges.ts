/**
 * Published cloud and crawler ranges (HOSTING_RANGES_MODE).
 *
 * The network ranges that cloud providers and search crawlers publish for
 * their own servers, read once at start-up from data/hosting-ranges.json
 * (written by scripts/update-hosting-ranges.mjs, reviewed in a pull request).
 * Nothing is fetched at run time. A visitor address is matched in memory only:
 * callers log the provider name, never the address.
 *
 * The file is validated strictly: a known format, known providers only, and
 * canonical, sorted, non-overlapping prefixes within IPv4 /8-/28 and IPv6
 * /16-/64. Any deviation refuses the whole file, so a damaged list fails the
 * start instead of matching more (or less) than reviewed.
 */
import { readFileSync } from "node:fs";
import ipaddr from "ipaddr.js";

export const HOSTING_RANGES_FORMAT = "hosting-ranges.v1";
export const HOSTING_RANGE_PROVIDERS = ["aws", "gcp", "azure", "oracle", "digitalocean", "googlebot", "bingbot"] as const;
export type HostingRangeProvider = (typeof HOSTING_RANGE_PROVIDERS)[number];

/** off: not loaded. shadow: matched and logged, the lookup goes ahead. enforce: a match is excluded without a lookup. */
export const HOSTING_RANGES_MODES = ["off", "shadow", "enforce"] as const;
export type HostingRangesMode = (typeof HOSTING_RANGES_MODES)[number];

export const V4_MIN_LEN = 8;
export const V4_MAX_LEN = 28;
export const V6_MIN_LEN = 16;
export const V6_MAX_LEN = 64;

export const DEFAULT_HOSTING_RANGES_PATH = new URL("../../data/hosting-ranges.json", import.meta.url);

export class HostingRangesError extends Error {
  constructor(message: string) {
    super(`hosting ranges: ${message}`);
    this.name = "HostingRangesError";
  }
}

export interface HostingRangeMatcher {
  /** The provider whose published range contains this canonical address (canonicaliseIp output), or null. */
  lookup(canonicalIp: string): HostingRangeProvider | null;
  /** UTC date the file was generated (YYYY-MM-DD). */
  readonly generatedAt: string;
  readonly prefixCount: number;
}

interface FamilyTable<T extends number | bigint> {
  starts: T[];
  ends: T[];
}

interface ProviderTable {
  provider: HostingRangeProvider;
  v4: FamilyTable<number>;
  /** IPv6 prefixes are /64 or larger, so the first 64 bits decide a match. */
  v6: FamilyTable<bigint>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseV4Prefix(text: string, where: string): [number, number] {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text);
  if (!m || !ipaddr.IPv4.isValidFourPartDecimal(m[1]!)) throw new HostingRangesError(`${where}: not an IPv4 prefix`);
  const addr = ipaddr.IPv4.parse(m[1]!);
  const len = Number(m[2]);
  if (addr.toString() !== m[1] || String(len) !== m[2]) throw new HostingRangesError(`${where}: not in canonical form`);
  if (len < V4_MIN_LEN || len > V4_MAX_LEN) throw new HostingRangesError(`${where}: IPv4 prefix length outside /${V4_MIN_LEN}-/${V4_MAX_LEN}`);
  const value = addr.toByteArray().reduce((acc, b) => acc * 256 + b, 0);
  const size = 2 ** (32 - len);
  if (value % size !== 0) throw new HostingRangesError(`${where}: host bits set`);
  return [value, value + size - 1];
}

function parseV6Prefix(text: string, where: string): [bigint, bigint] {
  const m = /^([0-9a-f:]+)\/(\d{1,3})$/.exec(text);
  if (!m || !ipaddr.IPv6.isValid(m[1]!)) throw new HostingRangesError(`${where}: not an IPv6 prefix`);
  const addr = ipaddr.IPv6.parse(m[1]!);
  const len = Number(m[2]);
  if (addr.toRFC5952String() !== m[1] || String(len) !== m[2]) throw new HostingRangesError(`${where}: not in canonical form`);
  if (len < V6_MIN_LEN || len > V6_MAX_LEN) throw new HostingRangesError(`${where}: IPv6 prefix length outside /${V6_MIN_LEN}-/${V6_MAX_LEN}`);
  const bytes = addr.toByteArray();
  if (bytes.slice(8).some((b) => b !== 0)) throw new HostingRangesError(`${where}: host bits set`);
  const high = bytes.slice(0, 8).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  const size = 1n << BigInt(64 - len);
  if (high % size !== 0n) throw new HostingRangesError(`${where}: host bits set`);
  return [high, high + size - 1n];
}

function table<T extends number | bigint>(list: unknown, where: string, parse: (text: string, where: string) => [T, T]): FamilyTable<T> {
  if (!Array.isArray(list)) throw new HostingRangesError(`${where}: not a list`);
  const starts: T[] = [];
  const ends: T[] = [];
  list.forEach((item, i) => {
    if (typeof item !== "string") throw new HostingRangesError(`${where}[${i}]: not a string`);
    const [s, e] = parse(item, `${where}[${i}]`);
    const prevEnd = ends[ends.length - 1];
    if (prevEnd !== undefined && s <= prevEnd) throw new HostingRangesError(`${where}[${i}]: not sorted or overlapping`);
    starts.push(s);
    ends.push(e);
  });
  return { starts, ends };
}

function contains<T extends number | bigint>(t: FamilyTable<T>, value: T): boolean {
  let lo = 0;
  let hi = t.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.starts[mid]! <= value) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi >= 0 && value <= t.ends[hi]!;
}

/** Validates parsed file content and builds the matcher. Throws HostingRangesError. */
export function buildHostingRangeMatcher(data: unknown): HostingRangeMatcher {
  if (!isRecord(data) || data["format"] !== HOSTING_RANGES_FORMAT) throw new HostingRangesError(`format is not ${HOSTING_RANGES_FORMAT}`);
  const generatedAt = data["generated_at"];
  if (typeof generatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(generatedAt) || Number.isNaN(Date.parse(`${generatedAt}T00:00:00Z`))) {
    throw new HostingRangesError("generated_at is not a date");
  }
  const providers = data["providers"];
  if (!isRecord(providers)) throw new HostingRangesError("no providers");
  const tables: ProviderTable[] = [];
  let prefixCount = 0;
  for (const [name, value] of Object.entries(providers)) {
    if (!(HOSTING_RANGE_PROVIDERS as readonly string[]).includes(name)) throw new HostingRangesError(`unknown provider ${JSON.stringify(name.slice(0, 40))}`);
    if (!isRecord(value)) throw new HostingRangesError(`${name}: not an object`);
    const v4 = table(value["v4"], `${name}.v4`, parseV4Prefix);
    const v6 = table(value["v6"], `${name}.v6`, parseV6Prefix);
    prefixCount += v4.starts.length + v6.starts.length;
    tables.push({ provider: name as HostingRangeProvider, v4, v6 });
  }
  if (prefixCount === 0) throw new HostingRangesError("no prefixes");
  // Fixed order, so an address published by two providers always gets the same name.
  tables.sort((a, b) => HOSTING_RANGE_PROVIDERS.indexOf(a.provider) - HOSTING_RANGE_PROVIDERS.indexOf(b.provider));

  return {
    generatedAt,
    prefixCount,
    lookup(canonicalIp: string): HostingRangeProvider | null {
      let bytes: number[];
      try {
        bytes = ipaddr.parse(canonicalIp).toByteArray();
      } catch {
        return null;
      }
      if (bytes.length === 4) {
        const v = bytes.reduce((acc, b) => acc * 256 + b, 0);
        for (const t of tables) if (contains(t.v4, v)) return t.provider;
        return null;
      }
      const high = bytes.slice(0, 8).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
      for (const t of tables) if (contains(t.v6, high)) return t.provider;
      return null;
    },
  };
}

/** Reads and validates the ranges file (data/hosting-ranges.json by default). Throws HostingRangesError. */
export function loadHostingRanges(path: URL | string = DEFAULT_HOSTING_RANGES_PATH): HostingRangeMatcher {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new HostingRangesError("file not readable");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HostingRangesError("file is not JSON");
  }
  return buildHostingRangeMatcher(data);
}

/** Whole days since the file was generated (for the start-up log). */
export function hostingRangesAgeDays(matcher: HostingRangeMatcher, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(`${matcher.generatedAt}T00:00:00Z`)) / 86_400_000));
}
