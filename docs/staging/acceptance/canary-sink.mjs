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
//   * which request HEADERS were present, and the NAMES of headers whose value contains the tester's IP
//     (G4-I8: a platform-added CF-Connecting-IP / X-Real-IP / X-Forwarded-For carrying the visitor's IP).
// No header value, IP address or token is stored, logged or returned.
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

/** Header NAMES whose value contains the needle (conservative substring match: a false positive fails safe). */
export function headersContaining(headers, needle) {
  if (!needle) return [];
  const names = [];
  for (const [name, value] of Object.entries(headers)) {
    const v = Array.isArray(value) ? value.join(",") : String(value ?? "");
    if (v.includes(needle)) names.push(name);
  }
  return names.sort();
}

export function createCanary(cfg) {
  const state = { mode: cfg.defaultMode, expectedIp: null, records: [], ceiling: [], seen: new Map(), authFailed: 0, other: 0, startedAt: Date.now() };
  const reset = () => {
    state.mode = cfg.defaultMode;
    state.expectedIp = null;
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
    for (const r of state.records) {
      for (const [k, v] of Object.entries(r.headerPresence)) if (v) presence[k] = (presence[k] ?? 0) + 1;
      for (const k of r.headersWithClientIp) withClientIp[k] = (withClientIp[k] ?? 0) + 1;
    }
    return {
      contract: "idr-staging-canary.v1",
      mode: state.mode,
      expectationSet: state.expectedIp !== null,
      uptimeS: Math.round((Date.now() - state.startedAt) / 1000),
      counts: {
        entrances: state.records.filter((r) => r.route === "entrances").length,
        events: state.records.filter((r) => r.route === "events").length,
        authFailed: state.authFailed,
        other: state.other,
        ceiling: state.ceiling.length,
      },
      headerPresence: presence,
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
      if (ip.length < 3 || ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip)) return send(res, 400, { error: "client_ip" });
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
    const presence = {};
    for (const h of HEADER_WATCH) presence[h] = req.headers[h] !== undefined;
    const record = {
      seq: state.records.length + 1,
      route,
      mode,
      at: Date.now(),
      attempt,
      keys: Object.keys(body).sort(),
      contract: typeof body.contract === "string" ? body.contract : null,
      pageKey: typeof body.page_key === "string" ? body.page_key.slice(0, 256) : null,
      name: route === "events" && typeof body.name === "string" ? body.name.slice(0, 64) : null,
      id: typeof id === "string" ? id.slice(0, 64) : null,
      bearer: true,
      ip: {
        present: ipField !== null,
        matchesExpected: ipField !== null && state.expectedIp !== null && ipField === state.expectedIp,
        matchesForged: ipField !== null && ipField === cfg.forgedIp,
      },
      headerPresence: presence,
      headersWithClientIp: headersContaining(req.headers, state.expectedIp),
      headersWithForgedIp: headersContaining(req.headers, cfg.forgedIp),
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
