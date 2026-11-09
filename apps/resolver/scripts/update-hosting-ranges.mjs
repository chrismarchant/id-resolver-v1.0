#!/usr/bin/env node
/**
 * Regenerates apps/resolver/data/hosting-ranges.json: the network ranges that
 * cloud providers and search crawlers publish for their own servers. The
 * resolver reads that file at start-up (HOSTING_RANGES_MODE) and never fetches
 * anything at run time.
 *
 * Run from the repository root (Node 22, no dependencies):
 *   node apps/resolver/scripts/update-hosting-ranges.mjs
 *
 * Each source is the provider's own published list. A failed download, an
 * unparsable list or a provider that would shrink to under half its previous
 * IPv4 coverage stops the run and leaves the file unchanged (pass
 * --accept-shrink after checking the provider's announcement).
 *
 * When every provider's prefixes are the same as in the current file, the file
 * is left as it is (new dates or checksums alone are not a change).
 *
 * The output is canonical: per provider, ranges are merged and re-split into
 * the fewest prefixes, IPv4 /8 to /28 and IPv6 /16 to /64. Smaller pieces are
 * dropped (a /29 or a single address is never listed; see
 * scripts/check-public-safety.mjs PUBLISHED_RANGE_FILES) and larger ones are
 * split. One prefix per line keeps refresh diffs reviewable.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FORMAT = "hosting-ranges.v1";
export const GENERATOR = "apps/resolver/scripts/update-hosting-ranges.mjs";
export const OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), "../data/hosting-ranges.json");

/** Prefix-length bounds, shared with the resolver loader and the public-safety gate. */
export const V4_MIN_LEN = 8;
export const V4_MAX_LEN = 28;
export const V6_MIN_LEN = 16;
export const V6_MAX_LEN = 64;

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

// ---- addresses -------------------------------------------------------------

/** Strict dotted quad (no leading zeros) to a number, or null. */
export function parseV4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p.startsWith("0")) || Number(p) > 255) return null;
    value = value * 256 + Number(p);
  }
  return value;
}

/** IPv6 text (lower or upper case, "::", no zone, no embedded IPv4) to a BigInt, or null. */
export function parseV6(text) {
  if (!/^[0-9a-fA-F:]+$/.test(text) || text.includes(":::")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (h) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if ([...head, ...tail].some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const have = head.length + tail.length;
  if (halves.length === 1 ? have !== 8 : have > 7) return null;
  const all = [...head, ...Array(8 - have).fill("0"), ...tail];
  return all.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

export function formatV4(value) {
  return [24, 16, 8, 0].map((s) => Math.floor(value / 2 ** s) % 256).join(".");
}

/** RFC 5952 text: lowercase, no leading zeros, the longest run of two or more zero groups (leftmost on a tie) as "::". */
export function formatV6(value) {
  const g = [];
  for (let i = 7; i >= 0; i--) g.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (arr) => arr.map((x) => x.toString(16)).join(":");
  if (best === -1) return hex(g);
  return `${hex(g.slice(0, best))}::${hex(g.slice(best + bestLen))}`;
}

/**
 * Parses "address/len" of one family into [start, end] (inclusive), or null.
 * Host bits are ignored (masked): providers occasionally publish them set.
 */
export function parseCidr(text, family) {
  const m = /^([^/\s]+)\/(\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  const len = Number(m[2]);
  if (family === 4) {
    const v = parseV4(m[1]);
    if (v === null || len > 32) return null;
    const size = 2 ** (32 - len);
    const start = v - (v % size);
    return [start, start + size - 1];
  }
  const v = parseV6(m[1]);
  if (v === null || len > 128) return null;
  const size = 1n << BigInt(128 - len);
  const start = v - (v % size);
  return [start, start + size - 1n];
}

/** Sorts and merges overlapping or adjacent [start, end] ranges. */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    const one = typeof s === "bigint" ? 1n : 1;
    if (last && s <= last[1] + one) {
      if (e > last[1]) last[1] = e;
    } else out.push([s, e]);
  }
  return out;
}

/**
 * Splits merged ranges into the fewest aligned prefixes no larger than /minLen,
 * dropping pieces smaller than /maxLen. Returns "address/len" strings in order.
 */
export function rangesToCidrs(ranges, family) {
  const bits = family === 4 ? 32 : 128;
  const [minLen, maxLen] = family === 4 ? [V4_MIN_LEN, V4_MAX_LEN] : [V6_MIN_LEN, V6_MAX_LEN];
  const out = [];
  for (const [start, end] of ranges) {
    let cur = BigInt(start);
    const last = BigInt(end);
    while (cur <= last) {
      // Largest aligned block at `cur` that fits, bounded by /minLen.
      let len = minLen;
      for (; len <= bits; len++) {
        const size = 1n << BigInt(bits - len);
        if (cur % size === 0n && cur + size - 1n <= last) break;
      }
      const size = 1n << BigInt(bits - len);
      if (len <= maxLen) out.push(`${family === 4 ? formatV4(Number(cur)) : formatV6(cur)}/${len}`);
      cur += size;
    }
  }
  return out;
}

/** Canonical prefixes of one family from raw "address/len" strings (invalid entries are an error). */
export function canonicalPrefixes(raw, family, provider) {
  const ranges = raw.map((text) => {
    const r = parseCidr(text, family);
    if (r === null) throw new Error(`${provider}: unparsable IPv${family} prefix in the source list`);
    return r;
  });
  return rangesToCidrs(mergeRanges(ranges), family);
}

/** Number of IPv4 addresses covered by canonical "address/len" strings. */
export function v4Coverage(prefixes) {
  return prefixes.reduce((n, p) => n + 2 ** (32 - Number(p.split("/")[1])), 0);
}

// ---- sources -----------------------------------------------------------------

const familyOf = (p) => (p.includes(":") ? 6 : 4);
const split = (list) => ({ v4: list.filter((p) => familyOf(p) === 4), v6: list.filter((p) => familyOf(p) === 6) });

/** The Google-style format (Google Cloud, Googlebot, Bingbot): { creationTime, prefixes: [{ ipv4Prefix | ipv6Prefix }] }. */
export function parseGoogleStyle(json) {
  if (!Array.isArray(json?.prefixes)) throw new Error("no prefixes array");
  const list = json.prefixes.map((p) => p.ipv4Prefix ?? p.ipv6Prefix).filter((p) => typeof p === "string");
  return { ...split(list), version: String(json.creationTime ?? json.syncToken ?? "") };
}

/** AWS ip-ranges.json, EC2 only: the ranges customer servers (and so automated clients) use. */
export function parseAws(json) {
  if (!Array.isArray(json?.prefixes) || !Array.isArray(json?.ipv6_prefixes)) throw new Error("unexpected AWS format");
  const v4 = json.prefixes.filter((p) => p.service === "EC2").map((p) => p.ip_prefix);
  const v6 = json.ipv6_prefixes.filter((p) => p.service === "EC2").map((p) => p.ipv6_prefix);
  return { v4, v6, version: String(json.createDate ?? "") };
}

/** Azure Service Tags (public cloud), tag AzureCloud: every public Azure range. */
export function parseAzure(json, fileName) {
  const tag = Array.isArray(json?.values) ? json.values.find((v) => v?.name === "AzureCloud") : undefined;
  const list = tag?.properties?.addressPrefixes;
  if (!Array.isArray(list)) throw new Error("no AzureCloud tag");
  return { ...split(list), version: `${fileName} change ${json.changeNumber ?? "?"}` };
}

export function parseOracle(json) {
  if (!Array.isArray(json?.regions)) throw new Error("unexpected Oracle format");
  const list = json.regions.flatMap((r) => (Array.isArray(r?.cidrs) ? r.cidrs.map((c) => c?.cidr) : [])).filter((c) => typeof c === "string");
  return { ...split(list), version: String(json.last_updated_timestamp ?? "") };
}

/** DigitalOcean's RFC 8805 geofeed: CSV, prefix first. */
export function parseGeofeed(text) {
  const list = text
    .split(/\r?\n/)
    .map((line) => line.split(",")[0]?.trim() ?? "")
    .filter((p) => p !== "" && !p.startsWith("#"));
  return { ...split(list), version: "" };
}

/** The Azure download page links the current weekly file; its name carries the date. */
export function findAzureFileUrl(html) {
  const m = /https:\/\/download\.microsoft\.com\/download\/[A-Za-z0-9/_.-]+\/(ServiceTags_Public_\d{8}\.json)/.exec(html);
  return m ? { url: m[0], fileName: m[1] } : null;
}

export const SOURCES = [
  { provider: "aws", url: "https://ip-ranges.amazonaws.com/ip-ranges.json", parse: (body) => parseAws(JSON.parse(body)) },
  { provider: "gcp", url: "https://www.gstatic.com/ipranges/cloud.json", parse: (body) => parseGoogleStyle(JSON.parse(body)) },
  { provider: "azure", url: "https://www.microsoft.com/en-us/download/details.aspx?id=56519", azure: true },
  { provider: "oracle", url: "https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json", parse: (body) => parseOracle(JSON.parse(body)) },
  { provider: "digitalocean", url: "https://www.digitalocean.com/geo/google.csv", parse: (body) => parseGeofeed(body) },
  { provider: "googlebot", url: "https://developers.google.com/static/search/apis/ipranges/googlebot.json", parse: (body) => parseGoogleStyle(JSON.parse(body)) },
  { provider: "bingbot", url: "https://www.bing.com/toolbox/bingbot.json", parse: (body) => parseGoogleStyle(JSON.parse(body)) },
];

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BODY_BYTES) throw new Error("response too large");
  return buf;
}

// ---- output ------------------------------------------------------------------

/** Builds the file object from per-provider raw lists. */
export function buildFile(results, generatedAt) {
  const providers = {};
  for (const r of results) {
    providers[r.provider] = {
      source: r.source,
      source_version: r.version,
      source_sha256: r.sha256,
      v4: canonicalPrefixes(r.v4, 4, r.provider),
      v6: canonicalPrefixes(r.v6, 6, r.provider),
    };
  }
  return { format: FORMAT, generated_at: generatedAt, generator: GENERATOR, providers };
}

/** Stable JSON with one prefix per line (the public-safety gate exempts exactly these lines). */
export function serialise(file) {
  const lines = ["{", `  "format": ${JSON.stringify(file.format)},`, `  "generated_at": ${JSON.stringify(file.generated_at)},`, `  "generator": ${JSON.stringify(file.generator)},`, `  "providers": {`];
  const names = Object.keys(file.providers);
  names.forEach((name, i) => {
    const p = file.providers[name];
    const list = (key, values, trailing) => {
      if (values.length === 0) return [`      ${JSON.stringify(key)}: []${trailing}`];
      return [`      ${JSON.stringify(key)}: [`, ...values.map((v, j) => `        ${JSON.stringify(v)}${j < values.length - 1 ? "," : ""}`), `      ]${trailing}`];
    };
    lines.push(
      `    ${JSON.stringify(name)}: {`,
      `      "source": ${JSON.stringify(p.source)},`,
      `      "source_version": ${JSON.stringify(p.source_version)},`,
      `      "source_sha256": ${JSON.stringify(p.source_sha256)},`,
      ...list("v4", p.v4, ","),
      ...list("v6", p.v6, ""),
      `    }${i < names.length - 1 ? "," : ""}`,
    );
  });
  lines.push("  }", "}", "");
  return lines.join("\n");
}

/** True when both files list exactly the same providers and prefixes (dates and checksums aside). */
export function sameRanges(previous, next) {
  if (!previous?.providers) return false;
  const pick = (file) => Object.fromEntries(Object.entries(file.providers).map(([k, v]) => [k, { v4: v.v4 ?? [], v6: v.v6 ?? [] }]));
  return JSON.stringify(pick(previous)) === JSON.stringify(pick(next));
}

/** Providers whose IPv4 coverage would fall under half of the previous file's. */
export function shrunkProviders(previous, next) {
  const out = [];
  for (const [name, p] of Object.entries(next.providers)) {
    const before = previous?.providers?.[name];
    if (!before) continue;
    const old = v4Coverage(before.v4 ?? []);
    if (old > 0 && v4Coverage(p.v4) < old / 2) out.push(name);
  }
  return out;
}

async function main() {
  const acceptShrink = process.argv.includes("--accept-shrink");
  const results = [];
  for (const s of SOURCES) {
    try {
      let body;
      let parsed;
      if (s.azure) {
        const page = (await download(s.url)).toString("utf8");
        const link = findAzureFileUrl(page);
        if (!link) throw new Error("no ServiceTags_Public file linked from the download page");
        body = await download(link.url);
        parsed = parseAzure(JSON.parse(body.toString("utf8")), link.fileName);
      } else {
        body = await download(s.url);
        parsed = s.parse(body.toString("utf8"));
      }
      if (parsed.v4.length === 0) throw new Error("no IPv4 prefixes");
      results.push({ provider: s.provider, source: s.url, version: parsed.version, sha256: createHash("sha256").update(body).digest("hex"), v4: parsed.v4, v6: parsed.v6 });
      console.log(`${s.provider}: ${parsed.v4.length} IPv4 and ${parsed.v6.length} IPv6 source prefixes`);
    } catch (err) {
      console.error(`${s.provider}: ${err instanceof Error ? err.message : String(err)} (file unchanged)`);
      process.exit(1);
    }
  }
  const file = buildFile(results, new Date().toISOString().slice(0, 10));
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(OUTPUT, "utf8"));
  } catch {
    previous = null;
  }
  const shrunk = shrunkProviders(previous, file);
  if (shrunk.length > 0 && !acceptShrink) {
    console.error(`IPv4 coverage fell by more than half for: ${shrunk.join(", ")}. Check the providers' announcements, then re-run with --accept-shrink (file unchanged).`);
    process.exit(1);
  }
  if (sameRanges(previous, file)) {
    console.log("unchanged: every provider lists the same prefixes (file left as it is)");
    return;
  }
  writeFileSync(OUTPUT, serialise(file));
  for (const [name, p] of Object.entries(file.providers)) console.log(`${name}: ${p.v4.length} IPv4 and ${p.v6.length} IPv6 prefixes written`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
