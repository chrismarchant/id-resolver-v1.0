#!/usr/bin/env node
/**
 * Public-repository safety gate (CHR-69, owner decision D8).
 *
 * This repository is PUBLIC during development. GitHub secret scanning only
 * recognises provider-issued token formats; it cannot recognise this
 * project's own random bearer tokens or HMAC secrets, infrastructure
 * identifiers or real-looking traffic data. This gate complements gitleaks
 * (which runs separately in CI) with project-specific rules.
 *
 * Scans every file tracked by git (or staged for commit) and fails when it
 * finds:
 *   - a concrete Railway public hostname (<name>.up.railway.app); placeholders
 *     such as "<service>.up.railway.app" are allowed
 *   - a Railway private hostname other than the generic postgres.railway.internal
 *   - a UUID literal (Railway project/service/environment/deployment ids are UUIDs)
 *   - a public IPv4 literal outside private, reserved and RFC 5737 documentation ranges
 *   - an e-mail address outside RFC 2606 reserved/example domains
 *   - a public IPv6 literal (global unicast, first three bits 001, outside
 *     documentation 2001:db8::/32, 3fff::/20 and the 2001::/23 protocol block; link-local, ULA, loopback, "::" and mapped
 *     private IPv4 are never reported)
 *   - a private-key block or a committed env/key file
 *   - a text file larger than MAX_BYTES that is not on the reviewed list
 *     (it is never skipped silently)
 *
 * Encodings: UTF-8 (BOM stripped), UTF-16 LE/BE and UTF-32 with a BOM, and
 * BOM-less UTF-16 are decoded and scanned. A file with NUL bytes that is
 * valid UTF-8 is scanned as text (NUL treated as a line break). Anything else
 * is binary: it is NOT scanned and is listed in the output.
 *
 * A line can opt out of the UUID/IPv4/IPv6 rules ONLY with the marker
 * `public-safety: allow-synthetic` and a reason, for deliberately synthetic
 * test inputs. Opt-outs are listed in the output so reviewers see them.
 *
 * Modes:
 *   (default)   every file tracked by git (or untracked and not ignored)
 *   --staged    files staged for commit
 *   --history   every line ADDED by any commit reachable from any ref
 *               (`git log -p --all`), with the same rules. History is
 *               immutable, so already-reviewed historical synthetic hits are
 *               listed as exact `commit:path:rule:value` fingerprints in
 *               .public-safety-history-allow (see that file).
 *
 * Usage: node scripts/check-public-safety.mjs [--staged | --history]
 * Exit code 0 = clean, 1 = findings, 2 = internal error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const MARKER = "public-safety: allow-synthetic";
const MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_ALLOW_FILE = ".public-safety-history-allow";

// Generated lockfiles that are skipped entirely: EXACT repository-relative
// paths only (never matched by basename, never at any other depth).
// The history allow-list is skipped too: its entries necessarily quote the values they allow.
const SKIP_FILES = new Set(["package-lock.json", "packages/tanstack/verification/cf-lifecycle/package-lock.json", HISTORY_ALLOW_FILE]);
// Text files over MAX_BYTES that a reviewer has accepted (exact paths). Empty
// on purpose: any other large text file is a finding, not a silent skip.
const REVIEWED_LARGE_TEXT = new Set([]);

const FORBIDDEN_FILES = [
  { re: /(^|\/)\.env($|\.(?!example$)[^/]+$)/, why: "env file (only .env.example may be committed)" },
  { re: /\.(pem|key|p12|pfx)$/i, why: "key material file" },
];

const RULES = [
  {
    id: "railway-public-host",
    re: /\b[a-z0-9][a-z0-9-]*\.up\.railway\.app\b/gi,
    allowMarker: false,
    why: "concrete Railway public hostname (use a <placeholder>.up.railway.app)",
  },
  {
    id: "railway-private-host",
    re: /\b(?!postgres\.railway\.internal\b)[a-z0-9][a-z0-9-]*\.railway\.internal\b/gi,
    allowMarker: false,
    why: "concrete Railway private hostname",
  },
  {
    id: "uuid-literal",
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    allowMarker: true,
    why: "UUID literal (infrastructure ids are UUIDs; keep them in private Linear only)",
  },
  {
    id: "email",
    re: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
    allowMarker: false,
    filter: (m) => !/@(([a-z0-9-]+\.)*(example|invalid|test|localhost)|example\.(com|org|net))$/i.test(m) && !/@users\.noreply\.github\.com$/i.test(m),
    why: "e-mail address outside example domains",
  },
  {
    id: "private-key-block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    allowMarker: false,
    why: "private key block",
  },
  {
    id: "public-ipv4",
    re: /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g,
    allowMarker: true,
    filter: (m) => isPublicIpv4(m),
    why: "public IPv4 literal (use RFC 5737 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)",
  },
  {
    id: "public-ipv6",
    // Bounded candidate run of hex digits and colons (optionally ending in a dotted quad);
    // parseIpv6 then decides if it is really an address, so times (12:30:45) and
    // code such as Foo::bar are ignored.
    re: /(?<![0-9A-Za-z:._-])[0-9A-Fa-f:]{2,45}(?:\.\d{1,3}\.\d{1,3}\.\d{1,3})?(?![0-9A-Za-z_:])/g,
    allowMarker: true,
    filter: (m) => isPublicIpv6(m),
    why: "public IPv6 literal (use RFC 3849 2001:db8::/32)",
  },
];

/** Strict IPv6 text parser (RFC 4291, incl. "::" and an embedded dotted quad). Returns 8 hextets or null. */
function parseIpv6(text) {
  if (!text.includes(":") || /:::/.test(text)) return null;
  let t = text;
  let tail = [];
  const dq = /(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(t);
  if (dq) {
    const o = dq[1].split(".").map(Number);
    if (o.some((n) => n > 255 || dq[1].split(".").some((p) => p.length > 1 && p.startsWith("0")))) return null;
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    t = t.slice(0, t.length - dq[1].length);
    if (t.endsWith(":") && !t.endsWith("::")) t = t.slice(0, -1);
  }
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const parse = (h) => (h === "" ? [] : h.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const all = [...head, ...rest];
  if (all.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return null;
  const nums = (arr) => arr.map((g) => parseInt(g, 16));
  const have = all.length + tail.length;
  if (halves.length === 1) return have === 8 ? [...nums(head), ...tail] : null;
  if (have > 7) return null; // "::" must stand for at least one group
  return [...nums(head), ...Array(8 - have).fill(0), ...nums(rest), ...tail];
}

function isPublicIpv6(text) {
  const g = parseIpv6(text);
  if (g === null) return false;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) carry an IPv4 address: judge that.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicIpv4(v4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicIpv4(v4(g[6], g[7]));
  if (g[0] === 0x2002) return isPublicIpv4(v4(g[1], g[2])); // 6to4 embeds IPv4
  // Everything else is judged by being global unicast (first three bits 001): that excludes ::, ::1,
  // fe80::/10, fc00::/7 and multicast. Then subtract documentation space.
  if (g[0] < 0x2000 || g[0] > 0x3fff) return false;
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // RFC 3849
  if (g[0] === 0x3fff && g[1] <= 0x0fff) return false; // RFC 9637 3fff::/20
  return true;
}

function isPublicIpv4(text) {
  const parts = text.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  // Leading-zero forms (e.g. "010.0.0.1") are parser test inputs, not addresses.
  if (text.split(".").some((p) => p.length > 1 && p.startsWith("0"))) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-net, private, loopback, multicast/reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

function listFiles(staged) {
  const args = staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"] : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const out = execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

function decodeUtf32(buf, littleEndian) {
  const n = buf.length - (buf.length % 4);
  let out = "";
  for (let i = 0; i < n; i += 4) {
    const cp = littleEndian ? buf.readUInt32LE(i) : buf.readUInt32BE(i);
    out += cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "\ufffd";
  }
  return out;
}

function decodeUtf16(buf, littleEndian) {
  const even = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
  if (!littleEndian) even.swap16();
  return new TextDecoder("utf-16le").decode(even);
}

/**
 * Returns { text, encoding } for text content, or null for binary content.
 * Never throws and never silently treats an unknown encoding as clean text.
 */
export function decodeText(buf) {
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0 && buf[3] === 0) return { text: decodeUtf32(buf.subarray(4), true), encoding: "utf-32le" };
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff) return { text: decodeUtf32(buf.subarray(4), false), encoding: "utf-32be" };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: decodeUtf16(buf.subarray(2), true), encoding: "utf-16le" };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { text: decodeUtf16(buf.subarray(2), false), encoding: "utf-16be" };
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString("utf8").split("\0").join("\n"), encoding: "utf-8-bom" };
  if (!buf.includes(0)) return { text: buf.toString("utf8"), encoding: "utf-8" };
  // NUL bytes without a BOM: BOM-less UTF-16 (mostly ASCII text) has a NUL in every other byte.
  if (buf.length >= 4) {
    let odd = 0;
    let even = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0) (i % 2 ? odd++ : even++);
    const pairs = Math.floor(buf.length / 2);
    if (odd / pairs > 0.3 && even / pairs < 0.05) return { text: decodeUtf16(buf, true), encoding: "utf-16le-nobom" };
    if (even / pairs > 0.3 && odd / pairs < 0.05) return { text: decodeUtf16(buf, false), encoding: "utf-16be-nobom" };
  }
  try {
    // Valid UTF-8 containing NULs is still text: scan it, with NUL as a line break.
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf).split("\0").join("\n"), encoding: "utf-8-nul" };
  } catch {
    return null;
  }
}

/** Applies every rule to text. `report(rule, hit, lineNo, optedOut)` is called per hit. */
function scanText(text, report) {
  const lines = text.split(/\r\n|\n|\r|\u2028|\u2029/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        const hit = m[0];
        if (rule.filter && !rule.filter(hit)) continue;
        report(rule, hit, i + 1, rule.allowMarker && line.includes(MARKER));
      }
    }
  });
}

function checkTree(staged) {
  const files = listFiles(staged);
  const findings = [];
  const optOuts = [];
  const skippedBinary = [];
  for (const file of files) {
    for (const f of FORBIDDEN_FILES) if (f.re.test(file)) findings.push(`${file}: ${f.why}`);
    if (SKIP_FILES.has(file)) continue;
    let st;
    try {
      st = statSync(file);
    } catch {
      continue; // deleted in working tree
    }
    if (!st.isFile()) continue;
    const buf = readFileSync(file);
    const dec = decodeText(buf);
    if (dec === null) {
      skippedBinary.push(file);
      continue;
    }
    if (st.size > MAX_BYTES && !REVIEWED_LARGE_TEXT.has(file)) {
      findings.push(`${file}: large-text-file: ${st.size} bytes exceeds ${MAX_BYTES}; split it or add its exact path to REVIEWED_LARGE_TEXT after review`);
      continue;
    }
    scanText(dec.text, (rule, hit, line, optedOut) => {
      if (optedOut) optOuts.push(`${file}:${line}: ${rule.id} (${hit})`);
      else findings.push(`${file}:${line}: ${rule.id}: ${rule.why}: ${hit}`);
    });
  }
  return { count: files.length, findings, optOuts, skippedBinary };
}

function loadHistoryAllow() {
  const allow = new Map(); // fingerprint -> used?
  let text;
  try {
    text = readFileSync(HISTORY_ALLOW_FILE, "utf8");
  } catch {
    return allow;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    allow.set(line, false);
  }
  return allow;
}

function isAllowed(allow, commit, path, rule, value) {
  for (const key of allow.keys()) {
    const parts = key.split(":");
    if (parts.length < 4) continue;
    const [c, p, r] = parts;
    const v = parts.slice(3).join(":");
    if (c.length >= 12 && commit.startsWith(c) && p === path && r === rule && v === value) {
      allow.set(key, true);
      return true;
    }
  }
  return false;
}

function checkHistory() {
  if (execFileSync("git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim() === "true") {
    throw new Error("history mode needs full history (this is a shallow clone; use fetch-depth: 0)");
  }
  const log = execFileSync(
    "git",
    ["-c", "core.quotePath=false", "log", "--all", "-p", "--raw", "--no-abbrev", "--no-color", "--no-ext-diff", "--no-renames", "-U0", "--format=commit %H"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 },
  );
  const allow = loadHistoryAllow();
  const findings = [];
  const optOuts = [];
  const skippedBinary = [];
  const seen = new Set();
  let commits = 0;
  let commit = "";
  let path = null;
  let skipPath = false;
  let combined = false;
  const rawNew = new Map(); // path -> blob id added in this commit
  const emit = (rule, hit, where, optedOut) => {
    const fp = `${commit}:${path}:${rule.id}:${hit}`;
    if (seen.has(fp)) return;
    seen.add(fp);
    if (isAllowed(allow, commit, path, rule.id, hit)) return;
    if (optedOut) optOuts.push(`${commit.slice(0, 12)}:${path}: ${rule.id} (${hit})`);
    else findings.push(`${commit.slice(0, 12)}:${path}${where}: ${rule.id}: ${rule.why}: ${hit}\n      allow-list fingerprint: ${fp}`);
  };
  const addLine = (line) => scanText(line, (rule, hit, _n, optedOut) => emit(rule, hit, "", optedOut));

  for (const lineBuf of splitBuffer(log, 0x0a)) {
    const line = lineBuf.toString("utf8");
    if (line.startsWith("commit ") && /^commit [0-9a-f]{40}$/.test(line)) {
      commit = line.slice(7);
      commits++;
      path = null;
      rawNew.clear();
      continue;
    }
    if (line.startsWith(":") && !line.startsWith("::")) {
      const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [AM]\t(.+)$/.exec(line);
      if (m && !/^0+$/.test(m[1])) rawNew.set(m[2], m[1]);
      continue;
    }
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ")) {
      combined = line.startsWith("diff --cc ");
      path = combined ? line.slice("diff --cc ".length) : null;
      skipPath = path !== null && SKIP_FILES.has(path);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      path = p === "/dev/null" ? null : p.replace(/^b\//, "");
      skipPath = path !== null && SKIP_FILES.has(path);
      if (path !== null) for (const f of FORBIDDEN_FILES) if (f.re.test(path)) emit({ id: "forbidden-file", why: f.why }, path, "", false);
      continue;
    }
    if (line.startsWith("Binary files ")) {
      // git shows no lines for NUL-containing blobs (e.g. UTF-16): decode the added blob and scan it whole.
      const m = /^Binary files (?:a\/(.+)|\/dev\/null) and (?:b\/(.+)|\/dev\/null) differ$/.exec(line);
      const p = m?.[2];
      const blob = p ? rawNew.get(p) : undefined;
      if (p && blob && !SKIP_FILES.has(p)) {
        path = p;
        const content = execFileSync("git", ["cat-file", "blob", blob], { maxBuffer: 1024 * 1024 * 1024 });
        const dec = decodeText(content);
        if (dec === null) skippedBinary.push(`${commit.slice(0, 12)}:${p}`);
        else addLine(dec.text);
      }
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("@@") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("old mode") || line.startsWith("new mode")) continue;
    if (path === null || skipPath) continue;
    if (combined ? line.startsWith("++") : line.startsWith("+")) addLine(line.slice(combined ? 2 : 1));
  }
  const unused = [...allow].filter(([, used]) => !used).map(([k]) => k);
  return { count: commits, findings, optOuts, skippedBinary, unused };
}

function splitBuffer(buf, sep) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === sep) {
      out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

function main() {
  const history = process.argv.includes("--history");
  const r = history ? checkHistory() : checkTree(process.argv.includes("--staged"));
  const unit = history ? "commit(s)" : "file(s)";
  if (r.optOuts.length > 0) {
    console.log(`public-safety: ${r.optOuts.length} marked synthetic opt-out(s):`);
    for (const o of r.optOuts) console.log(`  ${o}`);
  }
  if (r.skippedBinary.length > 0) {
    console.log(`public-safety: ${r.skippedBinary.length} binary file(s) NOT scanned (not valid text in any supported encoding):`);
    for (const b of r.skippedBinary) console.log(`  ${b}`);
  }
  if (r.unused && r.unused.length > 0) {
    console.log(`public-safety: warning: ${r.unused.length} unused entr(y/ies) in ${HISTORY_ALLOW_FILE} (history rewritten or fixed?):`);
    for (const u of r.unused) console.log(`  ${u}`);
  }
  if (r.findings.length > 0) {
    console.error(`public-safety${history ? " (history)" : ""}: ${r.findings.length} finding(s) in ${r.count} ${unit}:`);
    for (const f of r.findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`public-safety${history ? " (history)" : ""}: OK (${r.count} ${unit} scanned)`);
}

try {
  main();
} catch (err) {
  console.error(`public-safety: internal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
