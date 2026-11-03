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
 *   - a private-key block or a committed env/key file
 *
 * A line can opt out of the UUID/IPv4 rules ONLY with the marker
 * `public-safety: allow-synthetic` and a reason, for deliberately synthetic
 * test inputs. Opt-outs are listed in the output so reviewers see them.
 *
 * Usage: node scripts/check-public-safety.mjs [--staged]
 * Exit code 0 = clean, 1 = findings, 2 = internal error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const MARKER = "public-safety: allow-synthetic";
const MAX_BYTES = 2 * 1024 * 1024;

// Files that legitimately contain hashes/ids or are generated.
const SKIP_FILES = new Set(["package-lock.json"]);
const SKIP_PREFIXES = [];

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
];

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
  const out = execFileSync("git", args, { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function main() {
  const staged = process.argv.includes("--staged");
  const files = listFiles(staged);
  const findings = [];
  const optOuts = [];
  for (const file of files) {
    for (const f of FORBIDDEN_FILES) if (f.re.test(file)) findings.push(`${file}: ${f.why}`);
    const base = file.split("/").pop() ?? file;
    if (SKIP_FILES.has(base) || SKIP_PREFIXES.some((p) => file.startsWith(p))) continue;
    let st;
    try {
      st = statSync(file);
    } catch {
      continue; // deleted in working tree
    }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString("utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        for (const m of line.matchAll(rule.re)) {
          const hit = m[0];
          if (rule.filter && !rule.filter(hit)) continue;
          if (rule.allowMarker && line.includes(MARKER)) {
            optOuts.push(`${file}:${i + 1}: ${rule.id} (${hit})`);
            continue;
          }
          findings.push(`${file}:${i + 1}: ${rule.id}: ${rule.why}: ${hit}`);
        }
      }
    });
  }
  if (optOuts.length > 0) {
    console.log(`public-safety: ${optOuts.length} marked synthetic opt-out(s):`);
    for (const o of optOuts) console.log(`  ${o}`);
  }
  if (findings.length > 0) {
    console.error(`public-safety: ${findings.length} finding(s) in ${files.length} file(s):`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`public-safety: OK (${files.length} files scanned)`);
}

try {
  main();
} catch (err) {
  console.error(`public-safety: internal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
