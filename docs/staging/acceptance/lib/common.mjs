// Shared helpers for the staging acceptance scripts (docs/staging/acceptance).
//
// Rules every script follows:
//   * No target has a default. Every URL, key and token comes from the environment at run time, and the
//     operator must repeat the target host on the command line (--confirm-target).
//   * Nothing secret is printed or written: tokens, keys, IP addresses, user ids and e-mail addresses never
//     reach the console or the result file. Hosts are printed as labels (<site>, <canary>, <project>), and every
//     IP literal left in a line (any spelling) becomes [ip].
//   * Zero dependencies beyond Node 22 built-ins.
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/** A refusal: the script stops before sending anything. */
export class Refusal extends Error {}

/** Reads the named variables; throws a Refusal that lists the missing NAMES (never values). */
export function requireEnv(env, names) {
  const missing = names.filter((n) => typeof env[n] !== "string" || env[n].trim() === "");
  if (missing.length > 0) throw new Refusal(`missing required environment variable(s): ${missing.join(", ")}`);
  return Object.fromEntries(names.map((n) => [n, env[n].trim()]));
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Parses a target URL. https only, unless allowLoopbackHttp and the host is a loopback name.
 * Refuses credentials, a query string, a fragment and anything that still looks like a placeholder.
 */
export function parseTarget(label, value, { allowLoopbackHttp = false } = {}) {
  if (/[<>]/.test(value)) throw new Refusal(`${label} still contains a <placeholder>`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Refusal(`${label} is not a valid URL`);
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:")) {
    throw new Refusal(`${label} must use https${allowLoopbackHttp ? " (http only for a loopback host)" : ""}`);
  }
  if (url.username || url.password || url.search || url.hash) throw new Refusal(`${label} must not contain credentials, a query string or a fragment`);
  return url;
}

/** The operator must name the target host again on the command line. */
export function confirmTarget(expectedHost, confirmed) {
  if (!confirmed) throw new Refusal("--confirm-target <host> is required (repeat the target host to confirm it)");
  if (confirmed.toLowerCase() !== expectedHost.toLowerCase()) throw new Refusal("--confirm-target does not match the target host");
}

/** true when host is the zone itself or any name below it. */
export function hostInZone(host, zone) {
  const h = host.toLowerCase().replace(/\.$/, "");
  const z = zone.toLowerCase().replace(/^\.+|\.$/g, "");
  return h === z || h.endsWith(`.${z}`);
}

/** True when a token (hex digits, dots, colons) is or contains an IP literal: as is, without a port or trailing dot. */
function isIpToken(tok) {
  const tries = [tok, tok.replace(/\.+$/, ""), tok.replace(/:\d{1,5}$/, ""), tok.replace(/(?<!:):$/, ""), ...[...tok.matchAll(/\d{1,3}(?:\.\d{1,3}){3}/g)].map((m) => m[0])];
  return tries.some((t) => isIP(t) !== 0);
}

/**
 * Replaces every IP literal with [ip], in any spelling: IPv4, IPv6 compressed or expanded, upper or lower case,
 * IPv4-embedded IPv6, with a port or in brackets. Output lines and result files never need an address.
 */
export function scrubIps(text) {
  return String(text).replace(/[0-9A-Fa-f:.]{2,}/g, (tok) => (isIpToken(tok) ? "[ip]" : tok));
}

/**
 * Replaces every occurrence of each secret (case-insensitively for IP-shaped ones) and each host (by label), then
 * every remaining IP literal.
 */
export function makeRedactor(secrets = [], hosts = {}) {
  const list = secrets.filter((s) => typeof s === "string" && s.length >= 4);
  const hostList = Object.entries(hosts).filter(([, h]) => typeof h === "string" && h.length > 0);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text) => {
    let out = String(text);
    for (const s of list) out = /^[0-9A-Fa-f:.]+$/.test(s) ? out.replace(new RegExp(escape(s), "gi"), "[redacted]") : out.split(s).join("[redacted]");
    for (const [label, h] of hostList) out = out.split(h).join(label);
    return scrubIps(out);
  };
}

/** Collects PASS / FAIL / INFO / SKIP lines. Every line goes through the redactor. */
export class Results {
  constructor(redact = (t) => t, write = (line) => console.log(line)) {
    this.items = [];
    this.redact = redact;
    this.write = write;
    this.section = "";
  }
  begin(section) {
    this.section = section;
    this.write(this.redact(`== ${section}`));
  }
  #add(kind, name, detail) {
    const item = { section: this.section, kind, check: this.redact(name), detail: this.redact(detail ?? "") };
    this.items.push(item);
    this.write(`${kind.padEnd(4)} [${item.section}] ${item.check}${item.detail ? ` (${item.detail})` : ""}`);
    return kind === "PASS" || kind === "INFO" || kind === "SKIP";
  }
  check(name, ok, detail) {
    return this.#add(ok ? "PASS" : "FAIL", name, detail);
  }
  info(name, detail) {
    return this.#add("INFO", name, detail);
  }
  skip(name, detail) {
    return this.#add("SKIP", name, detail);
  }
  get failed() {
    return this.items.filter((i) => i.kind === "FAIL").length;
  }
  summary() {
    const count = (k) => this.items.filter((i) => i.kind === k).length;
    return { pass: count("PASS"), fail: count("FAIL"), info: count("INFO"), skip: count("SKIP") };
  }
}

export function percentile(values, p) {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
export const median = (values) => percentile(values, 50);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One HTTP(S) request with exact headers (node:http, not fetch: undici rewrites Sec-Fetch-* headers).
 * Resolves { status, headers, body, ttfbMs, totalMs, startedAt, endedAt }. TTFB = time to response headers.
 * opts.abortAfterHeaders: destroy the socket as soon as headers arrive (a client that disconnects).
 * opts.chunks: an array of strings sent as a chunked body (no Content-Length).
 */
export function rawRequest(url, { method = "GET", headers = {}, body, chunks, timeoutMs = 30_000, abortAfterHeaders = false } = {}) {
  const u = url instanceof URL ? url : new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const t0 = performance.now();
    const h = { ...headers };
    if (typeof body === "string" && !Object.keys(h).some((k) => k.toLowerCase() === "content-length")) h["content-length"] = Buffer.byteLength(body);
    const req = mod.request(u, { method, headers: h, agent: false, timeout: timeoutMs }, (res) => {
      const ttfbMs = performance.now() - t0;
      if (abortAfterHeaders) {
        res.destroy();
        return resolve({ status: res.statusCode, headers: res.headers, body: "", ttfbMs, totalMs: ttfbMs, startedAt, endedAt: Date.now() });
      }
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString("utf8"), ttfbMs, totalMs: performance.now() - t0, startedAt, endedAt: Date.now() }),
      );
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (Array.isArray(chunks)) {
      for (const c of chunks) req.write(c);
      req.end();
    } else {
      req.end(body);
    }
  });
}

/** Command-line flags: --name value and --flag. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

/** Random lowercase letters: survives the page-key mapper (no digit run, no long mixed run). */
export function letters(n) {
  const a = "abcdefghijklmnopqrstuvwxyz";
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => a[b % 26]).join("");
}

/** A random event_id in the event.v1 alphabet (22 characters). */
export function randomId() {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return Array.from(crypto.getRandomValues(new Uint8Array(22)), (b) => a[b & 63]).join("");
}

/** Constant-time string comparison (both sides hashed to equal length first). */
export async function safeEqual(a, b) {
  const { createHash, timingSafeEqual } = await import("node:crypto");
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}
