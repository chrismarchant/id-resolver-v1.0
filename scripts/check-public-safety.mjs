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
 * Scans every file tracked by git (or staged for commit), its name, and every
 * ref name (as the pseudo-locations <path> and <ref>), and fails when it
 * finds:
 *   - a concrete Railway public hostname (<name>.up.railway.app); placeholders
 *     such as "<service>.up.railway.app" are allowed
 *   - a Railway private hostname other than the generic postgres.railway.internal
 *   - a UUID literal (Railway project/service/environment/deployment ids are UUIDs)
 *   - a public IPv4 literal outside private, reserved and RFC 5737 documentation ranges
 *   - an e-mail address outside RFC 2606 reserved/example domains (git noreply
 *     addresses such as noreply@anthropic.com and *@users.noreply.github.com,
 *     and GitHub's own service sign-off support@github.com, are allowed)
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
 *               (`git log -p --cc --all`; for a merge, what the merge itself
 *               introduced), every commit message and annotated tag message,
 *               and author/committer/tagger identities (every rule except
 *               `email`: an author e-mail is inherent to git), with the same
 *               rules, plus every path a commit adds (<path>) and every
 *               ref name (<ref>). History is immutable, so already-reviewed historical
 *               synthetic hits are listed as exact
 *               `commit:path:rule:sha256(value)` fingerprints in
 *               .public-safety-history-allow (see that file). Messages and
 *               identities use the pseudo-paths `<commit message>`,
 *               `<author>`, `<committer>`, `<tag message>` and `<tagger>`.
 *
 * The allow-list file is scanned like any other file, so it can hold no raw
 * hit value: entries store the SHA-256 of the value. Every entry needs a
 * justification comment directly above it (or above its block). Entries for
 * the rules in NEVER_ALLOW are refused as a hard error: a committed key or env
 * file, a real e-mail address or a concrete Railway host needs history
 * rewriting and credential rotation, not a waiver. The allow-list is validated
 * in every mode.
 *
 * Output never contains a matched value, nor a hash of one: the repository
 * and its CI logs are public, and a hash of a low-entropy value (an IPv4
 * address, an e-mail address) is effectively the value. A finding or opt-out
 * shows its location, the rule and `[redacted: <length> chars]` only.
 * Two flags are for LOCAL use only; the gate refuses both (exit 2) when the
 * CI or GITHUB_ACTIONS environment variable is set, and CI never passes them:
 *   --fingerprints  with --history, also print each allow-list entry
 *                   (`commit:path:rule:sha256`), for synthetic values only
 *   --show-values   print the raw matched values (and full internal errors)
 *
 * Usage: node scripts/check-public-safety.mjs [--staged | --history] [--fingerprints] [--show-values]
 * Exit code 0 = clean, 1 = findings, 2 = internal error (or a local-only flag in CI).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const MARKER = "public-safety: allow-synthetic";
const SHOW_VALUES = process.argv.includes("--show-values");
const SHOW_FINGERPRINTS = process.argv.includes("--fingerprints");
const MAX_BYTES = 2 * 1024 * 1024;
const HISTORY_ALLOW_FILE = ".public-safety-history-allow";

// Generated lockfiles that are skipped entirely: EXACT repository-relative
// paths only (never matched by basename, never at any other depth). The
// history allow-list is NOT skipped: its entries hold hashes, not values.
const SKIP_FILES = new Set(["package-lock.json", "packages/tanstack/verification/cf-lifecycle/package-lock.json"]);
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
    filter: (m) => !isAllowedEmail(m),
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
    // Not part of a longer dotted number run (a version such as 1.2.3.4.5), but a trailing or
    // leading dot that is not followed or preceded by a digit is fine: "192.0.2.7." ends a
    // sentence, "logs/192.0.2.7.txt" is a file name (shown with a documentation address).
    re: /(?<!\d|\d\.)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g,
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

// History hits of these rules can never be allow-listed: they need history
// rewriting and credential rotation, not a waiver.
const NEVER_ALLOW = new Set(["forbidden-file", "private-key-block", "email", "railway-public-host", "railway-private-host"]);
const KNOWN_RULES = new Set([...RULES.map((r) => r.id), "forbidden-file"]);
const REMEDIATION =
  "if the value is real, rewrite history to remove it and rotate or revoke it; only a SYNTHETIC value may be allow-listed (entry: run locally with --fingerprints)";
const FINGERPRINT_HINT =
  "public-safety: allow-list entries are not printed here (a hash of a low-entropy value reveals it). For SYNTHETIC values only, run " +
  "`node scripts/check-public-safety.mjs --history --fingerprints` locally (refused in CI) to print them; a real value needs history rewriting and rotation instead.";
const NO_WAIVER = "cannot be allow-listed: rewrite history to remove it, and rotate or revoke what it exposed (key, credential, host)";

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** How a matched value is printed: its length only, unless --show-values (local use only). No hash: it would reveal a low-entropy value. */
export function displayValue(value, showValues = SHOW_VALUES) {
  return showValues ? value : `[redacted: ${value.length} chars]`;
}

/**
 * A path or ref name as printed: every rule hit in it replaced by `[redacted: <n> chars]`
 * (unless --show-values), and control characters escaped, so a value carried by a name
 * never reaches the log.
 */
export function displayName(name, showValues = SHOW_VALUES) {
  let out = name;
  if (!showValues) {
    const spans = [];
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of name.matchAll(rule.re)) if (!rule.filter || rule.filter(m[0])) spans.push([m.index, m.index + m[0].length]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [a, b] of spans) {
      const last = merged[merged.length - 1];
      if (last && a < last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    out = "";
    let pos = 0;
    for (const [a, b] of merged) {
      out += `${name.slice(pos, a)}[redacted: ${b - a} chars]`;
      pos = b;
    }
    out += name.slice(pos);
  }
  return out.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** Pseudo-locations for hits in names. Real paths never start with "<". */
const PATH_NAME = "<path>";
const REF_NAME = "<ref>";

/** Every ref (branches, tags, remote-tracking refs, notes, stash) as { object, name }. Ref names cannot contain spaces. */
function listRefs() {
  const out = git(["for-each-ref", "--format=%(objectname) %(refname)"], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ object: line.slice(0, line.indexOf(" ")), name: line.slice(line.indexOf(" ") + 1) }));
}

/** An error whose message is ours and never contains scanned content. */
class GateError extends Error {}

/**
 * E-mail addresses that are never personal data: RFC 2606 / RFC 6761 reserved
 * names (any subdomain of example.com/.org/.net, and the .example, .invalid,
 * .test and .localhost TLDs), fixed git "noreply" identities, which appear
 * in commit trailers such as `Co-Authored-By: Claude <noreply@anthropic.com>`,
 * and GitHub's service address in Dependabot's `Signed-off-by: dependabot[bot]
 * <support@github.com>` trailer (exact match only).
 */
const ALLOWED_EMAILS = [
  /@(?:[a-z0-9-]+\.)*(?:example|invalid|test|localhost)$/i,
  /@(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i,
  /@users\.noreply\.github\.com$/i,
  /^noreply@(?:anthropic\.com|github\.com)$/i,
  /^support@github\.com$/i,
];

function isAllowedEmail(address) {
  return ALLOWED_EMAILS.some((re) => re.test(address));
}

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

/**
 * Runs git with its stderr captured, never echoed: a git diagnostic could quote
 * scanned content. A failure surfaces as an internal error (see the end of this file).
 */
function git(args, options = {}) {
  return execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], ...options });
}

function listFiles(staged) {
  const args = staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"] : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const out = git(args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
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

/**
 * Applies every rule (except those in `skipRules`) to text. `report(rule, hit, lineNo, optedOut)`
 * is called per hit. Names (paths, refs) pass `honourMarker = false`: the opt-out marker is for content lines.
 */
function scanText(text, report, skipRules = null, honourMarker = true) {
  const lines = text.split(/\r\n|\n|\r|\u2028|\u2029/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (skipRules?.has(rule.id)) continue;
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        const hit = m[0];
        if (rule.filter && !rule.filter(hit)) continue;
        report(rule, hit, i + 1, honourMarker && rule.allowMarker && line.includes(MARKER));
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
    const shown = displayName(file);
    for (const f of FORBIDDEN_FILES) if (f.re.test(file)) findings.push(`${shown}: ${f.why}`);
    // The name itself is content too: a file named after an address or a host publishes it.
    scanText(file, (rule, hit) => findings.push(`${PATH_NAME} ${shown}: ${rule.id}: ${rule.why}: ${displayValue(hit)}`), null, false);
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
      skippedBinary.push(shown);
      continue;
    }
    if (st.size > MAX_BYTES && !REVIEWED_LARGE_TEXT.has(file)) {
      findings.push(`${shown}: large-text-file: ${st.size} bytes exceeds ${MAX_BYTES}; split it or add its exact path to REVIEWED_LARGE_TEXT after review`);
      continue;
    }
    scanText(dec.text, (rule, hit, line, optedOut) => {
      if (optedOut) optOuts.push(`${shown}:${line}: ${rule.id} ${displayValue(hit)}`);
      else findings.push(`${shown}:${line}: ${rule.id}: ${rule.why}: ${displayValue(hit)}`);
    });
  }
  // Ref names (branches, tags, remote-tracking refs) are public on the host too. In tree mode a
  // hit cannot be waived: rename or delete the ref.
  for (const ref of listRefs()) {
    scanText(ref.name, (rule, hit) => findings.push(`${REF_NAME} ${displayName(ref.name)}: ${rule.id}: ${rule.why}: ${displayValue(hit)}`), null, false);
  }
  return { count: files.length, findings, optOuts, skippedBinary };
}

// `<full commit sha>:<path>:<rule>:<sha256 hex of the value>`; the path may contain ":".
const ALLOW_ENTRY = /^([0-9a-f]{40}|[0-9a-f]{64}):(.+):([a-z0-9-]+):([0-9a-f]{64})$/;

/**
 * Parses the history allow-list. Returns `{ entries, errors }`: `entries` maps
 * each accepted fingerprint to `{ line, used }`; `errors` lists every refused
 * line (malformed, unknown or never-allowed rule, no justification).
 */
export function parseHistoryAllow(text) {
  const entries = new Map();
  const errors = [];
  let commentHasText = false; // the comment block directly above has a justification
  let blockJustified = false; // the current block of consecutive entries is justified
  let prev = "blank";
  text.split(/\r\n|\n|\r/).forEach((raw, i) => {
    const line = raw.trim();
    const where = `${HISTORY_ALLOW_FILE}:${i + 1}`;
    if (line === "") {
      prev = "blank";
      return;
    }
    if (line.startsWith("#")) {
      const hasText = /[A-Za-z]/.test(line.replace(/^#+/, ""));
      commentHasText = prev === "comment" ? commentHasText || hasText : hasText;
      prev = "comment";
      return;
    }
    if (prev === "comment") blockJustified = commentHasText;
    else if (prev === "blank") blockJustified = false;
    prev = "entry";
    const m = ALLOW_ENTRY.exec(line);
    if (!m) {
      errors.push(`${where}: malformed entry (expected <full commit sha>:<path>:<rule>:<sha256 hex of the value>; raw values are not accepted)`);
      return;
    }
    const [, commit, path, rule, hash] = m;
    if (!KNOWN_RULES.has(rule)) errors.push(`${where}: unknown rule "${rule}"`);
    else if (NEVER_ALLOW.has(rule)) errors.push(`${where}: rule ${rule} ${NO_WAIVER}`);
    else if (!blockJustified) errors.push(`${where}: no justification: put a non-empty "# ..." comment directly above this entry or its block`);
    else entries.set(`${commit}:${path}:${rule}:${hash}`, { line: i + 1, used: false });
  });
  return { entries, errors };
}

function loadHistoryAllow() {
  let text;
  try {
    text = readFileSync(HISTORY_ALLOW_FILE, "utf8");
  } catch {
    return { entries: new Map(), errors: [] };
  }
  return parseHistoryAllow(text);
}

function isAllowed(allow, commit, path, rule, value) {
  const entry = allow.get(`${commit}:${path}:${rule}:${sha256Hex(value)}`);
  if (!entry) return false;
  entry.used = true;
  return true;
}

/**
 * Undoes git's C-style quoting of a path. git quotes a path that contains `"`,
 * `\`, a tab, a newline or another control character (also with
 * core.quotePath=false): `"we\"ird/.env"`, `"tab\tdir/server.key"`, octal
 * `\303\251` for bytes. An unquoted input is returned unchanged.
 */
export function unquoteGitPath(text) {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const chars = [...text.slice(1, -1)];
  const bytes = [];
  const ESC = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\\") {
      bytes.push(...Buffer.from(chars[i], "utf8"));
      continue;
    }
    const next = chars[++i] ?? "";
    if (next in ESC) bytes.push(ESC[next]);
    else if (/^[0-3]$/.test(next) && /^[0-7]{2}$/.test((chars[i + 1] ?? "") + (chars[i + 2] ?? ""))) {
      bytes.push(parseInt(next + chars[i + 1] + chars[i + 2], 8));
      i += 2;
    } else bytes.push(...Buffer.from(`\\${next}`, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Every path each commit adds or changes, read NUL-safely (`--raw -z` never
 * quotes a path), with the blob id of the commit's (or merge's) result.
 * Returns Map(commit -> Array<{ path, blob, added }>); `added` means new
 * relative to every parent. Deleted paths are left out.
 */
function collectHistoryPaths() {
  const out = git(["log", "--all", "--cc", "--raw", "-z", "--no-renames", "--no-abbrev", "--no-color", "--format=commit %H"], { maxBuffer: 1024 * 1024 * 1024 });
  const byCommit = new Map();
  let entries = null;
  let meta = null;
  for (const token of out.toString("utf8").split("\0")) {
    if (meta !== null) {
      // The token after a raw meta field is the path, verbatim (it may even start with a newline).
      const n = /^:+/.exec(meta)[0].length;
      const fields = meta.slice(n).split(" ");
      const blob = fields[2 * n + 1];
      const status = fields[2 * n + 2] ?? "";
      if (entries && blob && !/^0+$/.test(blob)) entries.push({ path: token, blob, added: /^A+$/.test(status) });
      meta = null;
      continue;
    }
    const t = token.replace(/^\n+/, "");
    if (/^commit [0-9a-f]{40}$/.test(t)) {
      entries = [];
      byCommit.set(t.slice(7), entries);
    } else if (t.startsWith(":")) meta = t;
  }
  return byCommit;
}

/**
 * Parses one `git log -p --raw --cc` stream. A file's header runs from its
 * `diff --git`/`diff --cc` line to its first `@@` line; only there are
 * `+++ `, `Binary files` and similar lines headers. In the hunk body every
 * line carries one prefix column per parent, so an added line whose content
 * starts with `++ ` (shown as `+++ ...`) is scanned as content. For a merge,
 * `--cc` shows only what the merge itself introduced: a line is scanned when
 * it is added relative to EVERY parent (lines taken from one parent were
 * scanned in the commit that added them there). Quoted paths in headers are
 * un-quoted; blob ids come from the NUL-safe path pass.
 */
function scanPatchLog(log, ctx, historyPaths) {
  let commit = "";
  let state = "none"; // "none" (commit header / raw lines) | "header" | "body"
  let parents = 1;
  let path = null;
  let skipPath = false;
  let resultBlob = new Map(); // path -> blob id of the commit's (or merge's) result
  const setPath = (p) => {
    path = p;
    skipPath = p !== null && SKIP_FILES.has(p);
  };
  const scanBlob = (p) => {
    const blob = resultBlob.get(p);
    if (!blob || SKIP_FILES.has(p)) return;
    // git shows no lines for NUL-containing blobs (e.g. UTF-16): decode the blob and scan it whole.
    const content = git(["cat-file", "blob", blob], { maxBuffer: 1024 * 1024 * 1024 });
    const dec = decodeText(content);
    if (dec === null) ctx.skippedBinary.push(`${commit.slice(0, 12)}:${displayName(p)}`);
    else ctx.scan(commit, p, dec.text);
  };

  for (const lineBuf of splitBuffer(log, 0x0a)) {
    const line = lineBuf.toString("utf8");
    // Neither a commit line nor a diff line can be hunk content: content lines start with a prefix column.
    if (line.startsWith("commit ") && /^commit [0-9a-f]{40}$/.test(line)) {
      commit = line.slice(7);
      ctx.commits++;
      state = "none";
      setPath(null);
      resultBlob = new Map((historyPaths.get(commit) ?? []).map((e) => [e.path, e.blob]));
      continue;
    }
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      state = "header";
      setPath(line.startsWith("diff --git ") ? null : unquoteGitPath(line.slice(line.indexOf(" ", 5) + 1)));
      continue;
    }
    if (state === "none") continue; // the commit's header lines; paths come from the NUL-safe pass
    if (state === "header") {
      if (line.startsWith("@@")) {
        state = "body";
        parents = Math.max(1, /^@+/.exec(line)[0].length - 1);
      } else if (line.startsWith("+++ ")) {
        const p = unquoteGitPath(line.slice(4));
        setPath(p === "/dev/null" ? null : p.replace(/^b\//, ""));
      } else if (line === "Binary files differ") {
        if (path !== null) scanBlob(path); // combined diff: the path is from "diff --cc"
      } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        // "Binary files <a> and <b> differ", each side a/P, b/P (maybe quoted) or /dev/null.
        // With --no-renames both sides name the same path, so the b side is the second half.
        const inner = line.slice("Binary files ".length, -" differ".length);
        let b = null;
        if (inner.startsWith("/dev/null and ")) b = inner.slice("/dev/null and ".length);
        else if (!inner.endsWith(" and /dev/null")) b = inner.slice((inner.length - " and ".length) / 2 + " and ".length);
        const p = b === null ? null : unquoteGitPath(b);
        if (p !== null && p.startsWith("b/")) scanBlob(p.slice(2));
      }
      continue;
    }
    // Hunk body.
    if (line.startsWith("@@")) {
      parents = Math.max(1, /^@+/.exec(line)[0].length - 1);
      continue;
    }
    if (path === null || skipPath) continue;
    const prefix = line.slice(0, parents);
    if (prefix.length === parents && /^\+*$/.test(prefix)) ctx.scan(commit, path, line.slice(parents));
  }
}

/** Pseudo-paths for content that is not a file. Real paths never start with "<". */
const MESSAGE_PATH = "<commit message>";
const AUTHOR_PATH = "<author>";
const COMMITTER_PATH = "<committer>";
const TAG_MESSAGE_PATH = "<tag message>";
const TAGGER_PATH = "<tagger>";
// Identities are scanned with every rule except "email": an author e-mail is inherent to git
// (documented limitation, docs/PUBLIC_REPO_SECURITY.md).
const IDENTITY_SKIP = new Set(["email"]);

/** Commit messages (every rule) and author/committer identities (every rule but e-mail). */
function scanCommitMetadata(ctx) {
  const out = git(["log", "--all", "-z", "--no-color", "--format=%H%n%an <%ae>%n%cn <%ce>%n%B"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  for (const record of out.split("\0")) {
    const m = /^([0-9a-f]{40})\n([^\n]*)\n([^\n]*)\n([\s\S]*)$/.exec(record.replace(/^\n/, ""));
    if (!m) continue;
    const [, commit, author, committer, message] = m;
    ctx.scan(commit, MESSAGE_PATH, message);
    ctx.scan(commit, AUTHOR_PATH, author, IDENTITY_SKIP);
    ctx.scan(commit, COMMITTER_PATH, committer, IDENTITY_SKIP);
  }
}

/** Annotated tag messages (every rule) and tagger identities (every rule but e-mail), following tags of tags. */
function scanTags(ctx) {
  const refs = git(["for-each-ref", "refs/tags", "--format=%(objectname) %(objecttype)"], { encoding: "utf8" });
  const done = new Set();
  for (const ref of refs.split("\n").filter(Boolean)) {
    let [sha, type] = ref.split(" ");
    while (type === "tag" && !done.has(sha)) {
      done.add(sha);
      ctx.tags++;
      const body = git(["cat-file", "tag", sha], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
      const split = body.indexOf("\n\n");
      const headers = split === -1 ? body : body.slice(0, split);
      const message = split === -1 ? "" : body.slice(split + 2);
      const h = (name) => new RegExp(`^${name} (.*)$`, "m").exec(headers)?.[1];
      ctx.scan(sha, TAG_MESSAGE_PATH, message);
      const name = h("tag");
      if (name !== undefined) ctx.scan(sha, REF_NAME, name, null, false, `tag ${displayName(name)}`);
      const tagger = h("tagger");
      if (tagger !== undefined) ctx.scan(sha, TAGGER_PATH, tagger.replace(/ \d+ [+-]\d{4}$/, ""), IDENTITY_SKIP);
      [sha, type] = [h("object"), h("type")];
    }
  }
}

function checkHistory(allow) {
  if (git(["rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim() === "true") {
    throw new GateError("history mode needs full history (this is a shallow clone; use fetch-depth: 0)");
  }
  const findings = [];
  const optOuts = [];
  const seen = new Set();
  const ctx = {
    commits: 0,
    tags: 0,
    waivable: 0,
    skippedBinary: [],
    emit(commit, path, rule, hit, optedOut, note = "") {
      const fp = `${commit}:${path}:${rule.id}:${sha256Hex(hit)}`;
      if (seen.has(fp)) return;
      seen.add(fp);
      if (isAllowed(allow, commit, path, rule.id, hit)) return;
      const where = `${commit.slice(0, 12)}:${displayName(path)}${note ? ` ${note}` : ""}`;
      // A forbidden file's "value" is its path, which the location already shows.
      const what = rule.id === "forbidden-file" ? `${rule.id}: ${rule.why}` : `${rule.id}: ${rule.why}: ${displayValue(hit)}`;
      if (optedOut) optOuts.push(`${where}: ${rule.id} ${displayValue(hit)}`);
      else if (NEVER_ALLOW.has(rule.id)) findings.push(`${where}: ${what}\n      ${NO_WAIVER}`);
      else {
        ctx.waivable++;
        findings.push(`${where}: ${what}\n      ${REMEDIATION}${SHOW_FINGERPRINTS ? `\n      allow-list fingerprint: ${fp}` : ""}`);
      }
    },
    scan(commit, path, text, skipRules = null, honourMarker = true, note = "") {
      scanText(text, (rule, hit, _n, optedOut) => ctx.emit(commit, path, rule, hit, optedOut, note), skipRules, honourMarker);
    },
  };
  // Every path each commit adds or changes, read NUL-safely: an empty or binary .env or key file
  // (no "+++" line) and a path git would C-quote (`we"ird/.env`, a tab) are both checked.
  const historyPaths = collectHistoryPaths();
  for (const [commit, entries] of historyPaths) {
    for (const e of entries) {
      for (const f of FORBIDDEN_FILES) if (f.re.test(e.path)) ctx.emit(commit, e.path, { id: "forbidden-file", why: f.why }, e.path, false);
      // File names are content too: every path a commit adds is scanned, as <path> (allow-listed per commit and value).
      if (e.added) ctx.scan(commit, PATH_NAME, e.path, null, false, displayName(e.path));
    }
  }
  // Ref names, as <ref>, keyed by the object the ref points to.
  for (const ref of listRefs()) ctx.scan(ref.object, REF_NAME, ref.name, null, false, displayName(ref.name));
  // --cc: merge commits show what the merge itself introduced (git log -p shows nothing for merges by default).
  const log = git(
    ["-c", "core.quotePath=false", "log", "--all", "-p", "--cc", "--no-abbrev", "--no-color", "--no-ext-diff", "--no-renames", "-U0", "--format=commit %H"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 },
  );
  scanPatchLog(log, ctx, historyPaths);
  scanCommitMetadata(ctx);
  scanTags(ctx);
  // Unused entries are named by their line in the allow-list (whose hashes are public there anyway), not reprinted.
  const unused = [...allow].filter(([, e]) => !e.used).map(([k, e]) => `line ${e.line}: ${displayName(k.slice(0, k.lastIndexOf(":")))}`);
  return { count: ctx.commits, tags: ctx.tags, waivable: ctx.waivable, findings, optOuts, skippedBinary: ctx.skippedBinary, unused };
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
  const localOnly = [SHOW_VALUES && "--show-values", SHOW_FINGERPRINTS && "--fingerprints"].filter(Boolean);
  if (localOnly.length > 0 && ["CI", "GITHUB_ACTIONS"].some((k) => (process.env[k] ?? "") !== "" && process.env[k] !== "false")) {
    const one = localOnly.length === 1;
    throw new GateError(`${localOnly.join(" and ")} ${one ? "prints" : "print"} raw values or their hashes and ${one ? "is" : "are"} for local use only; refusing in CI (CI or GITHUB_ACTIONS is set)`);
  }
  const history = process.argv.includes("--history");
  const allow = loadHistoryAllow();
  const r = history ? checkHistory(allow.entries) : checkTree(process.argv.includes("--staged"));
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
  if (allow.errors.length > 0) {
    console.error(`public-safety: ${allow.errors.length} refused entr(y/ies) in ${HISTORY_ALLOW_FILE} (hard error, the gate fails whatever else it finds):`);
    for (const e of allow.errors) console.error(`  ${e}`);
  }
  if (r.findings.length > 0) {
    console.error(`public-safety${history ? " (history)" : ""}: ${r.findings.length} finding(s) in ${r.count} ${unit}${history ? ` and ${r.tags} annotated tag(s)` : ""}:`);
    for (const f of r.findings) console.error(`  ${f}`);
    if (r.waivable > 0 && !SHOW_FINGERPRINTS) console.error(FINGERPRINT_HINT);
  }
  if (allow.errors.length > 0 || r.findings.length > 0) process.exit(1);
  console.log(`public-safety${history ? " (history)" : ""}: OK (${r.count} ${unit}${history ? ` and ${r.tags} annotated tag(s)` : ""} scanned)`);
}

try {
  main();
} catch (err) {
  // Only our own messages are printed by default: another error's message (e.g. a failed
  // git command with its stderr) could quote scanned content.
  const detail =
    err instanceof GateError || SHOW_VALUES
      ? err instanceof Error
        ? err.message
        : String(err)
      : `${err instanceof Error ? err.name : "error"}${err && typeof err === "object" && "status" in err ? ` (exit status ${err.status})` : ""}; rerun locally with --show-values for the message`;
  console.error(`public-safety: internal error: ${detail}`);
  process.exit(2);
}
