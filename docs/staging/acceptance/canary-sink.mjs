#!/usr/bin/env node
// canary-sink.mjs: a stand-in resolver and header canary for the Cloudflare staging test
// (docs/staging/CLOUDFLARE_TEST_SITE.md, sections 4 and 5).
//
// The owner runs it OUTSIDE the staging site's Cloudflare zone, in the same hosting position as the real resolver
// (for example a second, temporary service in the isolated Railway development project). The staging site's
// IDR_RESOLVER_URL then points at it. It answers like the resolver, in a mode the acceptance script selects
// (ok, 500, 503, 429, 401, hang, slow:<ms>, reset), and it records, per request:
//   * which route, mode and attempt (an entrance_id / event_id seen before counts as a retry);
//   * the body's key list, contract, page_key and event name;
//   * whether the body's `ip` equals the tester's IP or the forged IP (booleans only: the IP is never stored);
//   * which request HEADERS were present, and the NAMES of headers whose value contains a visitor's IP
//     (G4-I8: a platform-added CF-Connecting-IP / X-Real-IP / X-Forwarded-For carrying the visitor's IP). The
//     comparison uses the tester's IP when the script sets one, each entrance body's own `ip`, and the visitor IPs
//     of earlier entrances (for event subrequests); a request with nothing to compare against is marked as such.
//     Every header is inspected, every copy of a repeated header included (raw headers), and the IP is recognised in
//     any spelling: upper or lower case, compressed or expanded IPv6, with a port or brackets, and IPv4 embedded in
//     IPv6 (::ffff:a.b.c.d, its hex form ::ffff:xxxx:xxxx, ::a.b.c.d, 64:ff9b::a.b.c.d).
// No header value, IP address or token is stored, logged or returned. The comparison happens in memory; strings
// kept from request bodies (page_key, event name, ids, key names) have any IP literal replaced by [ip].
//
// Environment (all required unless marked optional; there are no defaults that point anywhere):
//   CANARY_TOKEN         at least 32 characters. Bearer expected on /v1/* (set the staging site's
//                        IDR_RESOLVER_TOKEN to the same value while it points here) and on /_canary/* and /ceiling/*.
//   CANARY_BIND          listen address: 0.0.0.0 (or ::) on a host, 127.0.0.1 locally.
//   PORT                 listen port (Railway sets it).
//   CANARY_DEFAULT_MODE  optional, default ok.
//   CANARY_FORGED_IP     optional, default 203.0.113.9 (RFC 5737): the value the acceptance script forges.
//
// Endpoints:
//   POST [/m/<mode>]/v1/entrances | /v1/events     stand-in resolver (mode from the path prefix, else the current mode)
//   POST /_canary/expect  {"client_ip": "..."}      the tester's IP as Cloudflare sees it (memory only, never echoed)
//   POST /_canary/mode    {"mode": "..."}           switch the current mode
//   POST /_canary/reset                             forget records, the expectation and the mode
//   GET  /_canary/results                           JSON summary (no IP, no header value, no token)
//   POST /ceiling/<probe_id>/<offset_s>             waitUntil ceiling probe arrivals
//   GET  /healthz                                   200, no authentication
//
// Run:  CANARY_TOKEN=... CANARY_BIND=127.0.0.1 PORT=4599 node canary-sink.mjs
//       node canary-sink.mjs --self-check     (validates the environment and exits; prints no value)
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

const MODES = /^(ok|500|503|429|401|hang|reset|slow:(\d{1,5}))$/;
const HEADER_WATCH = [
  "cf-connecting-ip",
  "x-real-ip",
  "x-forwarded-for",
  "true-client-ip",
  "forwarded",
  "x-client-ip",
  "x-cluster-client-ip",
  "cf-connecting-ipv6",
  "cf-pseudo-ipv4",
  "cf-ipcountry",
  "cf-ray",
  "cf-worker",
  "cf-visitor",
  "cf-ew-via",
  "cdn-loop",
  "via",
  "x-forwarded-proto",
  "x-forwarded-host",
  "user-agent",
  "cookie",
  "referer",
];
const MAX_BODY = 4096;
const MAX_RECORDS = 20_000;
const HANG_MAX_MS = 60_000;

export function loadConfig(env) {
  const problems = [];
  const token = env.CANARY_TOKEN ?? "";
  if (!/^[\x21-\x7e]{32,}$/.test(token)) problems.push("CANARY_TOKEN must be at least 32 printable characters");
  const bind = env.CANARY_BIND ?? "";
  if (bind === "") problems.push("CANARY_BIND is required (0.0.0.0 on a host, 127.0.0.1 locally)");
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push("PORT is required (1-65535)");
  const defaultMode = env.CANARY_DEFAULT_MODE ?? "ok";
  if (!MODES.test(defaultMode)) problems.push("CANARY_DEFAULT_MODE is not a known mode");
  const forgedIp = env.CANARY_FORGED_IP ?? "203.0.113.9";
  return { problems, token, bind, port, defaultMode, forgedIp };
}

function digest(s) {
  return createHash("sha256").update(String(s)).digest();
}
function bearerOk(req, token) {
  const h = req.headers["authorization"];
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return false;
  const given = h.slice(7);
  return timingSafeEqual(digest(given), digest(token)) && given.length === token.length;
}

/** Canonical text of one IP address (IPv4 dotted decimal; IPv6 compressed lower case, embedded IPv4 as hex), or null. */
export function canonicalIp(text) {
  const t = String(text ?? "").trim();
  const kind = isIP(t);
  if (kind === 4) return t;
  if (kind !== 6) return null;
  try {
    return new URL(`http://[${t}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** The canonical spellings that identify one address: itself, and for IPv4 the IPv6 forms that embed it. */
export function ipForms(address) {
  const c = canonicalIp(address);
  if (c === null) return [];
  if (isIP(c) !== 4) return [c];
  const o = c.split(".").map(Number);
  const hex = `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  return [c, `::ffff:${hex}`, `::${hex}`, `64:ff9b::${hex}`];
}

/**
 * Every IP literal in a text, canonicalised: tokens of hex digits, dots and colons, also with a trailing port or
 * dot removed, and every dotted quad inside a token. Linear in the text length.
 */
export function ipLiterals(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(/[0-9A-Fa-f:.]{2,}/g)) {
    const tok = m[0];
    const tries = [tok, tok.replace(/\.+$/, ""), tok.replace(/:\d{1,5}$/, ""), tok.replace(/(?<!:):$/, "")];
    for (const q of tok.matchAll(/\d{1,3}(?:\.\d{1,3}){3}/g)) tries.push(q[0]);
    for (const t of tries) {
      const c = canonicalIp(t);
      if (c !== null) out.add(c);
    }
  }
  return [...out];
}

/** Replaces every IP literal (any spelling) in a kept string with [ip]. */
export function scrubIps(text) {
  return String(text).replace(/[0-9A-Fa-f:.]{2,}/g, (tok) => (ipLiterals(tok).length > 0 ? "[ip]" : tok));
}

/** Header names as kept: lower case, and a name outside the token alphabet is not kept verbatim. */
const safeName = (name) => {
  const n = String(name).toLowerCase();
  return /^[a-z0-9-]{1,64}$/.test(n) ? n : "<nonstandard-name>";
};

/** [name, value] pairs: from raw headers ([n, v, n, v, ...], every repeated copy) or from a header object. */
function headerPairs(headers) {
  if (Array.isArray(headers)) {
    const pairs = [];
    for (let i = 0; i + 1 < headers.length; i += 2) pairs.push([headers[i], headers[i + 1]]);
    return pairs;
  }
  return Object.entries(headers ?? {}).flatMap(([n, v]) => (Array.isArray(v) ? v.map((x) => [n, x]) : [[n, v]]));
}

/** True when the text contains the address in any spelling (case-insensitive substring, or a canonical IP match). */
export function containsIp(text, address) {
  if (!address) return false;
  const v = String(text ?? "");
  if (v.toLowerCase().includes(String(address).toLowerCase())) return true;
  const forms = ipForms(address);
  return forms.length > 0 && ipLiterals(v).some((ip) => forms.includes(ip));
}

/** A matcher for several addresses at once: true when a text contains any of them, in any spelling. */
function anyIpMatcher(addresses) {
  const list = [...new Set((addresses ?? []).filter((a) => typeof a === "string" && a !== ""))];
  if (list.length === 0) return null;
  const forms = new Set(list.flatMap((a) => ipForms(a)));
  const lowers = list.map((a) => a.toLowerCase());
  return (text) => {
    const v = String(text ?? "");
    const lv = v.toLowerCase();
    return lowers.some((l) => lv.includes(l)) || (forms.size > 0 && ipLiterals(v).some((ip) => forms.has(ip)));
  };
}

/** True when the text contains any of the addresses in any spelling. */
export function containsAnyIp(text, addresses) {
  const m = anyIpMatcher(addresses);
  return m !== null && m(text);
}

/**
 * Header NAMES whose value contains any of the addresses in any spelling (conservative: a false positive fails safe).
 * Accepts raw headers (preferred: Node drops repeated copies of some headers from req.headers) or a header object.
 * With no address there is nothing to compare against: [] (callers must not read that as "no leak").
 */
export function headersContainingAny(headers, addresses) {
  const m = anyIpMatcher(addresses);
  if (m === null) return [];
  const names = new Set();
  for (const [name, value] of headerPairs(headers)) if (m(value)) names.add(safeName(name));
  return [...names].sort();
}

export function headersContaining(headers, address) {
  return headersContainingAny(headers, [address]);
}

/** The names of every header present (sanitised), for the "all headers checked" summary. */
function headerNames(rawHeaders) {
  return [...new Set(headerPairs(rawHeaders).map(([n]) => safeName(n)))].sort();
}

/** Visitor IPs learned from entrance bodies, kept in memory for comparison only (never returned or logged). */
const MAX_VISITOR_IPS = 1000;

export function createCanary(cfg) {
  const state = { mode: cfg.defaultMode, expectedIp: null, visitorIps: new Map(), records: [], ceiling: [], seen: new Map(), authFailed: 0, other: 0, startedAt: Date.now() };
  const rememberVisitorIp = (ip) => {
    const c = canonicalIp(ip);
    if (c === null) return;
    state.visitorIps.delete(c);
    state.visitorIps.set(c, ip);
    while (state.visitorIps.size > MAX_VISITOR_IPS) state.visitorIps.delete(state.visitorIps.keys().next().value);
  };
  const reset = () => {
    state.mode = cfg.defaultMode;
    state.expectedIp = null;
    state.visitorIps = new Map();
    state.records = [];
    state.ceiling = [];
    state.seen = new Map();
    state.authFailed = 0;
    state.other = 0;
  };

  const send = (res, status, body, extra = {}) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
    res.end(payload);
  };

  function readBody(req) {
    return new Promise((resolve) => {
      const parts = [];
      let n = 0;
      let tooLarge = false;
      req.on("data", (c) => {
        n += c.length;
        if (n > MAX_BODY) tooLarge = true;
        else parts.push(c);
      });
      req.on("end", () => resolve({ tooLarge, text: Buffer.concat(parts).toString("utf8") }));
      req.on("error", () => resolve({ tooLarge: false, text: "" }));
    });
  }

  function summary() {
    const presence = {};
    const withClientIp = {};
    const names = {};
    for (const r of state.records) {
      for (const [k, v] of Object.entries(r.headerPresence)) if (v) presence[k] = (presence[k] ?? 0) + 1;
      for (const k of r.headersWithClientIp) withClientIp[k] = (withClientIp[k] ?? 0) + 1;
      for (const k of r.headerNames) names[k] = (names[k] ?? 0) + 1;
    }
    return {
      contract: "idr-staging-canary.v1",
      mode: state.mode,
      expectationSet: state.expectedIp !== null,
      visitorIpsKnown: state.visitorIps.size,
      uptimeS: Math.round((Date.now() - state.startedAt) / 1000),
      counts: {
        entrances: state.records.filter((r) => r.route === "entrances").length,
        events: state.records.filter((r) => r.route === "events").length,
        authFailed: state.authFailed,
        other: state.other,
        ceiling: state.ceiling.length,
      },
      headerPresence: presence,
      headerNamesSeen: names,
      headersWithClientIp: withClientIp,
      records: state.records,
      ceiling: state.ceiling,
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://canary.invalid");
    const path = url.pathname;
    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });

    const v1 = /^(?:\/m\/(ok|500|503|429|401|hang|reset|slow:\d{1,5}))?\/v1\/(entrances|events)$/.exec(path);
    const ceiling = /^\/ceiling\/([a-z]{1,16})\/(\d{1,3})$/.exec(path);
    const control = path.startsWith("/_canary/");
    if (!v1 && !ceiling && !control) {
      state.other++;
      return send(res, 404, undefined);
    }
    if (!bearerOk(req, cfg.token)) {
      state.authFailed++;
      return send(res, 401, { version: "1", error: "unauthorized" });
    }
    if (req.method === "GET" && path === "/_canary/results") return send(res, 200, summary());
    if (req.method !== "POST") return send(res, 405, undefined, { allow: "POST" });

    const { tooLarge, text } = await readBody(req);
    if (tooLarge) return send(res, 413, { version: "1", error: "payload_too_large" });
    let body = null;
    try {
      body = text === "" ? {} : JSON.parse(text);
    } catch {
      return send(res, 400, { version: "1", error: "invalid_request" });
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { version: "1", error: "invalid_request" });

    if (path === "/_canary/reset") {
      reset();
      return send(res, 204, undefined);
    }
    if (path === "/_canary/expect") {
      const ip = typeof body.client_ip === "string" ? body.client_ip.trim() : "";
      if (ip.length < 3 || ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip) || canonicalIp(ip) === null) return send(res, 400, { error: "client_ip" });
      state.expectedIp = ip;
      return send(res, 204, undefined);
    }
    if (path === "/_canary/mode") {
      if (typeof body.mode !== "string" || !MODES.test(body.mode)) return send(res, 400, { error: "mode" });
      state.mode = body.mode;
      return send(res, 204, undefined);
    }
    if (ceiling) {
      if (state.ceiling.length < 2000) state.ceiling.push({ probeId: ceiling[1], offsetS: Number(ceiling[2]), at: Date.now() });
      return send(res, 204, undefined);
    }
    if (!v1) return send(res, 404, undefined);

    // Stand-in resolver.
    const route = v1[2];
    const mode = v1[1] ?? state.mode;
    const id = route === "entrances" ? body.entrance_id : body.event_id;
    const key = `${route}:${typeof id === "string" ? id : ""}`;
    const attempt = (state.seen.get(key) ?? 0) + 1;
    state.seen.set(key, attempt);
    const ipField = typeof body.ip === "string" ? body.ip : null;
    // G4-I8 comparison basis, in memory only: the expected tester IP (when the script set one), this entrance's own
    // `ip` (so every entrance is compared, whoever the client), and visitor IPs from earlier entrance bodies (so an
    // event subrequest from the same visitor is compared too).
    if (route === "entrances" && ipField !== null) rememberVisitorIp(ipField);
    const basis = [state.expectedIp, ...state.visitorIps.values()];
    const compared = basis.some((a) => typeof a === "string" && a !== "");
    const sameIp = (a, b) => a !== null && b !== null && canonicalIp(a) !== null && canonicalIp(a) === canonicalIp(b);
    const presence = {};
    for (const h of HEADER_WATCH) presence[h] = req.headers[h] !== undefined;
    // Everything kept below is a boolean, a count, a header NAME, or a body string with IP literals replaced.
    const kept = (v, max) => (typeof v === "string" ? scrubIps(v.slice(0, max)) : null);
    const record = {
      seq: state.records.length + 1,
      route,
      mode,
      at: Date.now(),
      attempt,
      keys: Object.keys(body).map((k) => scrubIps(k.slice(0, 64))).sort(),
      contract: kept(body.contract, 32),
      pageKey: kept(body.page_key, 256),
      name: route === "events" ? kept(body.name, 64) : null,
      id: kept(id, 64),
      bearer: true,
      ip: {
        present: ipField !== null,
        matchesExpected: sameIp(ipField, state.expectedIp),
        matchesForged: sameIp(ipField, cfg.forgedIp),
      },
      // Whether this request was compared with at least one known visitor IP. A record that was not compared is no
      // evidence of anything: cf-site-check never counts it as a PASS.
      compared,
      // A visitor IP anywhere in the body other than the entrance's `ip` field (an event body has no `ip`).
      bodyContainsClientIp: containsAnyIp(JSON.stringify({ ...body, ip: undefined }), basis),
      headerPresence: presence,
      headerNames: headerNames(req.rawHeaders),
      headersWithClientIp: headersContainingAny(req.rawHeaders, basis),
      headersWithForgedIp: headersContaining(req.rawHeaders, cfg.forgedIp),
    };
    if (state.records.length < MAX_RECORDS) state.records.push(record);

    if (mode === "hang") {
      const t = setTimeout(() => res.destroy(), HANG_MAX_MS);
      res.on("close", () => clearTimeout(t));
      return undefined;
    }
    if (mode === "reset") return res.destroy();
    if (mode === "500") return send(res, 500, { version: "1", error: "internal" });
    if (mode === "503") return send(res, 503, { version: "1", error: "overloaded" });
    if (mode === "429") return send(res, 429, { version: "1", error: "rate_limited" }, { "retry-after": "1" });
    if (mode === "401") return send(res, 401, { version: "1", error: "unauthorized" });
    const answer =
      route === "entrances" ? { version: "1", status: "ineligible", source: "none", recorded: false } : { version: "1", recorded: attempt === 1 };
    const slow = /^slow:(\d+)$/.exec(mode);
    if (slow) {
      await new Promise((r) => setTimeout(r, Math.min(Number(slow[1]), 30_000)));
      if (res.destroyed) return undefined;
    }
    return send(res, 200, answer);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, undefined);
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return { server, state, reset };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cfg = loadConfig(process.env);
  if (cfg.problems.length > 0) {
    console.error(`canary: refusing to start: ${cfg.problems.join("; ")}`);
    process.exit(2);
  }
  if (process.argv.includes("--self-check")) {
    console.log("canary: configuration valid (values not printed)");
    process.exit(0);
  }
  const { server } = createCanary(cfg);
  server.listen(cfg.port, cfg.bind, () => console.log(`canary: listening (mode ${cfg.defaultMode}); records are kept in memory only`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
