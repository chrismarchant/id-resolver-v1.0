#!/usr/bin/env node
// cf-site-check.mjs: acceptance checks for the disposable Cloudflare staging site
// (docs/staging/CLOUDFLARE_TEST_SITE.md). Run by the owner or MAIN after the owner has provisioned the site and
// the canary. Every target and credential comes from the environment; nothing has a default that points anywhere.
//
//   node cf-site-check.mjs --phase <phase> --confirm-target <site host> [options]
//   node cf-site-check.mjs --dry-run --phase all --confirm-target <site host>   (validates, sends nothing)
//
// Phases:
//   preflight  site served by Cloudflare over https; G4-I8 zone check of the resolver and canary hosts; CSP; trace
//   ttfb       added TTFB of a reported page vs an excluded control page; delivery; trust policy `cloudflare`
//              with the real CF-Connecting-IP and a forged one; G4-I8 header canary            (canary in mode ok)
//   faults     the same TTFB comparison with the canary answering 500, 503, 429, 401, hanging and resetting
//   down       TTFB comparison while the site's IDR_RESOLVER_URL points at an unresolvable host (owner switches it)
//   route      first-party collector route: Origin, Sec-Fetch-Site, type, size, schema, consent, GPC, replay, rate
//   bundle     the deployed client bundle holds no server code, token or resolver host; the collector is present
//   ceiling    waitUntil ceiling on the production edge, via the staging site's test-only probe route
//   cold       first request after a fresh deployment (the owner deploys right before) vs warm requests
//   browser    prints the real-browser checklist and summarises what the canary received from real browsers
//   all        preflight, ttfb, faults, route, bundle, ceiling
//
// Environment (names only; see the plan for what each one is):
//   ACCEPT_SITE_URL       https origin of the staging site                                   (required)
//   ACCEPT_SITE_ZONE      the site's Cloudflare zone, e.g. the apex domain                    (required)
//   ACCEPT_RESOLVER_URL   the value the site's IDR_RESOLVER_URL currently has                 (required)
//   ACCEPT_CANARY_URL     origin of the canary sink                                           (phases ttfb faults route ceiling cold)
//   ACCEPT_CANARY_TOKEN   the canary bearer token (= the site's IDR_RESOLVER_TOKEN while it points at the canary)
//   ACCEPT_PROBE_TOKEN    the staging site's ceiling-probe token                               (phase ceiling)
//   ACCEPT_COLLECTOR_ALLOW    comma list, the route's `allow`                                  (phase route)
//   ACCEPT_COLLECTOR_CONSENT  required | not_required (the route's `consent`)                  (phase route)
//   ACCEPT_CONSENT_COOKIE     optional: the test consent cookie that the site's hasConsent accepts, name=value
//   ACCEPT_RATE_EVENTS        the route's rateLimit.events on the staging site                 (phase route)
//   ACCEPT_TESTER_IP      optional: only if /cdn-cgi/trace is unavailable (never printed)
//   ACCEPT_BUNDLE_SCAN_TOKEN  optional: the site token, searched for in the client bundle (never printed)
//   ACCEPT_REPORTED_PREFIX / ACCEPT_CONTROL_PREFIX / ACCEPT_COLLECTOR_PATH   optional paths (/landing/, /control/, /idr/e)
//
// Options: --samples N (pairs, default 100) --out <file> --max-median-diff-ms 10 --max-p95-diff-ms 50
//          --ceiling-wait-s 75 --browser-wait-s 300 --local-probe (loopback http target: the repository's workerd
//          probe app, where no Cloudflare edge exists; edge-only checks are skipped)
// Exit: 0 no FAIL, 1 at least one FAIL, 2 refused (nothing sent).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Refusal,
  Results,
  confirmTarget,
  hostInZone,
  letters,
  makeRedactor,
  median,
  parseArgs,
  parseTarget,
  percentile,
  randomId,
  rawRequest,
  requireEnv,
  sleep,
} from "./lib/common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VOCABULARY = JSON.parse(readFileSync(join(HERE, "../../contracts/event-vocabulary.v1.json"), "utf8")).types;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36 idr-staging-acceptance";
const FORGED_IP = "203.0.113.9"; // RFC 5737; must equal the canary's CANARY_FORGED_IP
const LOCAL_TESTER_IP = "198.51.100.23"; // RFC 5737; local probe only (the probe allows documentation ranges)
const PHASES = ["preflight", "ttfb", "faults", "down", "route", "bundle", "ceiling", "cold", "browser"];
const ALL = ["preflight", "ttfb", "faults", "route", "bundle", "ceiling"];
// Strings that must never reach client assets (the hygiene test's list, plus hosts and the token added at run time).
const FORBIDDEN_IN_CLIENT = [
  "createIdrServerMiddleware",
  "createCollectorRoute",
  "idr-tanstack",
  "/v1/entrances",
  "/v1/events",
  "entrance.v1",
  "event.v1",
  "cf-connecting-ip",
  "x-forwarded-for",
  "sec-gpc",
  "resolverUrl",
  "allowInsecureHttp",
  "replayCacheSize",
  "maxClockSkewMs",
  "IDR_RESOLVER_TOKEN",
  "IDR_RESOLVER_URL",
  "IDR_WEBSITE_ID",
  "x-staging-probe-token",
];

const args = parseArgs(process.argv.slice(2));
const LOCAL = args["local-probe"] === true;
const env = process.env;

function loadConfig() {
  const req = requireEnv(env, ["ACCEPT_SITE_URL", "ACCEPT_SITE_ZONE", "ACCEPT_RESOLVER_URL"]);
  const site = parseTarget("ACCEPT_SITE_URL", req.ACCEPT_SITE_URL, { allowLoopbackHttp: LOCAL });
  if (LOCAL && site.protocol !== "http:") throw new Refusal("--local-probe expects the loopback http probe app");
  confirmTarget(site.host, typeof args["confirm-target"] === "string" ? args["confirm-target"] : "");
  const resolver = parseTarget("ACCEPT_RESOLVER_URL", req.ACCEPT_RESOLVER_URL, { allowLoopbackHttp: LOCAL });
  const zone = req.ACCEPT_SITE_ZONE.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(zone) || (!zone.includes(".") && !LOCAL)) throw new Refusal("ACCEPT_SITE_ZONE must be a domain name");
  let canary = null;
  if (env.ACCEPT_CANARY_URL) {
    const url = parseTarget("ACCEPT_CANARY_URL", env.ACCEPT_CANARY_URL, { allowLoopbackHttp: LOCAL });
    const token = env.ACCEPT_CANARY_TOKEN ?? "";
    if (token.length < 32) throw new Refusal("ACCEPT_CANARY_TOKEN is required with ACCEPT_CANARY_URL (at least 32 characters)");
    canary = { url, token };
  }
  const path = (name, def) => {
    const v = env[name] ?? def;
    if (!/^\/[A-Za-z0-9/_.-]*$/.test(v)) throw new Refusal(`${name} must be a plain path`);
    return v;
  };
  return {
    site,
    zone,
    resolver,
    canary,
    probeToken: env.ACCEPT_PROBE_TOKEN ?? null,
    reported: path("ACCEPT_REPORTED_PREFIX", "/landing/"),
    control: path("ACCEPT_CONTROL_PREFIX", LOCAL ? "/m/none/" : "/control/"),
    collectorPath: path("ACCEPT_COLLECTOR_PATH", "/idr/e"),
    allow: (env.ACCEPT_COLLECTOR_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    consentMode: env.ACCEPT_COLLECTOR_CONSENT ?? null,
    consentCookie: env.ACCEPT_CONSENT_COOKIE ?? null,
    rateEvents: env.ACCEPT_RATE_EVENTS ? Number(env.ACCEPT_RATE_EVENTS) : null,
    testerIp: env.ACCEPT_TESTER_IP ?? (LOCAL ? LOCAL_TESTER_IP : null),
    scanToken: env.ACCEPT_BUNDLE_SCAN_TOKEN ?? null,
    samples: Number(args.samples ?? 100),
    maxMedianDiff: Number(args["max-median-diff-ms"] ?? 10),
    maxP95Diff: Number(args["max-p95-diff-ms"] ?? 50),
  };
}

function phasesFromArgs() {
  const p = typeof args.phase === "string" ? args.phase : "";
  if (p === "all") return ALL;
  const list = p.split(",").filter(Boolean);
  if (list.length === 0 || list.some((x) => !PHASES.includes(x))) throw new Refusal(`--phase must be one of ${[...PHASES, "all"].join(", ")}`);
  return list;
}

// ---------------------------------------------------------------------------------------------------------------
let cfg;
let phases;
try {
  phases = phasesFromArgs();
  cfg = loadConfig();
  const needsCanary = phases.some((p) => ["ttfb", "faults", "route", "ceiling", "cold"].includes(p));
  if (needsCanary && !cfg.canary) throw new Refusal("ACCEPT_CANARY_URL and ACCEPT_CANARY_TOKEN are required for the selected phase(s)");
  if (phases.includes("ceiling") && !LOCAL && !cfg.probeToken) throw new Refusal("ACCEPT_PROBE_TOKEN is required for phase ceiling");
  if (phases.includes("route")) {
    if (cfg.allow.length === 0) throw new Refusal("ACCEPT_COLLECTOR_ALLOW is required for phase route");
    if (cfg.consentMode !== "required" && cfg.consentMode !== "not_required") throw new Refusal("ACCEPT_COLLECTOR_CONSENT must be required or not_required");
    if (!Number.isInteger(cfg.rateEvents) || cfg.rateEvents < 1 || cfg.rateEvents > 1000) throw new Refusal("ACCEPT_RATE_EVENTS must be the staging route's rateLimit.events (1-1000)");
  }
  if (!Number.isInteger(cfg.samples) || cfg.samples < 5 || cfg.samples > 2000) throw new Refusal("--samples must be 5-2000");
} catch (e) {
  if (e instanceof Refusal) {
    console.error(`refused: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

// Secrets known so far; the tester IP learned from /cdn-cgi/trace is added when it is learned.
const SECRETS = [cfg.canary?.token, cfg.probeToken, cfg.scanToken, cfg.testerIp, env.ACCEPT_TESTER_IP];
const HOSTS = { "<site>": cfg.site.host, "<resolver>": cfg.resolver.host, "<canary>": cfg.canary?.url.host };
const redact = (text) => makeRedactor(SECRETS, HOSTS)(text);
const R = new Results(redact);
const metrics = {};

if (args["dry-run"] === true) {
  R.begin("dry-run");
  R.info("configuration valid; nothing was sent", `phases: ${phases.join(", ")}; local probe: ${LOCAL}`);
  R.info("targets", `site <site>, zone check against ACCEPT_SITE_ZONE, resolver <resolver>, canary ${cfg.canary ? "<canary>" : "not configured"}`);
  finish();
}

// ---------------------------------------------------------------------------------------------------------------
// helpers
function browserHeaders(extra = {}) {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en",
    "user-agent": UA,
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    ...(LOCAL ? { "cf-connecting-ip": cfg.testerIp } : {}),
    ...extra,
  };
}
const siteUrl = (path) => new URL(path, cfg.site);

const canary = {
  async call(method, path, body) {
    const r = await rawRequest(new URL(path, cfg.canary.url), {
      method,
      headers: { authorization: `Bearer ${cfg.canary.token}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 15_000,
    });
    if (r.status >= 300) throw new Error(`canary ${method} ${path} answered ${r.status}`);
    return r.body ? JSON.parse(r.body) : null;
  },
  reset: () => canary.call("POST", "/_canary/reset", {}),
  mode: (mode) => canary.call("POST", "/_canary/mode", { mode }),
  expect: (ip) => canary.call("POST", "/_canary/expect", { client_ip: ip }),
  results: () => canary.call("GET", "/_canary/results"),
};

async function testerIp() {
  if (LOCAL) return cfg.testerIp;
  try {
    const r = await rawRequest(siteUrl("/cdn-cgi/trace"), { headers: { "user-agent": UA }, timeoutMs: 10_000 });
    const m = /^ip=(.+)$/m.exec(r.body);
    if (r.status === 200 && m) {
      SECRETS.push(m[1].trim());
      return m[1].trim();
    }
  } catch {
    /* fall through */
  }
  return cfg.testerIp;
}

const stats = (xs) => ({ n: xs.length, median: round(median(xs)), p95: round(percentile(xs, 95)), max: round(Math.max(...xs)) });
const round = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** n interleaved pairs: a reported page and an excluded control page, in random order within each pair. */
async function ttfbPairs(label, tag, n) {
  for (let i = 0; i < 3; i++) {
    await rawRequest(siteUrl(`${cfg.control}warm-${tag}-${i}`), { headers: browserHeaders() });
    await rawRequest(siteUrl(`${cfg.reported}warm-${tag}-${i}`), { headers: browserHeaders() });
  }
  const pairs = [];
  for (let i = 1; i <= n; i++) {
    const rep = siteUrl(`${cfg.reported}${label}-${tag}-${i}`);
    const ctl = siteUrl(`${cfg.control}${label}-${tag}-${i}`);
    const first = Math.random() < 0.5;
    const a = await rawRequest(first ? rep : ctl, { headers: browserHeaders() });
    const b = await rawRequest(first ? ctl : rep, { headers: browserHeaders() });
    const [r, c] = first ? [a, b] : [b, a];
    pairs.push({ i, reported: r, control: c });
  }
  return pairs;
}

function ttfbVerdict(name, pairs) {
  const okStatus = pairs.every((p) => p.reported.status === 200 && p.control.status === 200);
  R.check(`${name}: every page answered 200`, okStatus, okStatus ? `${pairs.length} pairs` : `statuses ${[...new Set(pairs.flatMap((p) => [p.reported.status, p.control.status]))].join(",")}`);
  const diffs = pairs.map((p) => p.reported.ttfbMs - p.control.ttfbMs);
  const m = { reported: stats(pairs.map((p) => p.reported.ttfbMs)), control: stats(pairs.map((p) => p.control.ttfbMs)), pairedDiff: stats(diffs) };
  metrics[name] = { ...(metrics[name] ?? {}), ttfb: m };
  R.check(
    `${name}: added TTFB, median paired difference <= ${cfg.maxMedianDiff} ms and p95 <= ${cfg.maxP95Diff} ms`,
    m.pairedDiff.median <= cfg.maxMedianDiff && m.pairedDiff.p95 <= cfg.maxP95Diff,
    `reported median ${m.reported.median} ms p95 ${m.reported.p95}; control median ${m.control.median} p95 ${m.control.p95}; diff median ${m.pairedDiff.median} p95 ${m.pairedDiff.p95}`,
  );
}

function entrancesFor(results, label, tag) {
  const prefix = `${cfg.reported}${label}-${tag}-`;
  return results.records.filter((r) => r.route === "entrances" && typeof r.pageKey === "string" && r.pageKey.startsWith(prefix));
}

function g4i8(name, records) {
  const leaking = [...new Set(records.flatMap((r) => r.headersWithClientIp))];
  const forged = [...new Set(records.flatMap((r) => r.headersWithForgedIp))];
  if (LOCAL) {
    R.info(`${name}: G4-I8 header canary (local workerd: not the production edge)`, leaking.length ? `headers with the tester IP: ${leaking.join(",")}` : "no header carried the tester IP");
  } else {
    R.check(`${name}: G4-I8, no request header at the resolver's hosting position carries the visitor's IP`, records.length > 0 && leaking.length === 0, leaking.length ? `headers carrying it: ${leaking.join(", ")}` : `${records.length} requests inspected`);
  }
  R.check(`${name}: no request header carries the forged IP`, forged.length === 0, forged.join(", ") || "none");
  const cf = records.filter((r) => r.headerPresence["cf-connecting-ip"]).length;
  const xri = records.filter((r) => r.headerPresence["x-real-ip"]).length;
  const cw = records.filter((r) => r.headerPresence["cf-worker"]).length;
  R.info(`${name}: header presence at the canary`, `cf-connecting-ip ${cf}/${records.length}, x-real-ip ${xri}/${records.length}, cf-worker ${cw}/${records.length}`);
}

// ---------------------------------------------------------------------------------------------------------------
// phases
async function preflight() {
  R.begin("preflight");
  const outside = (u) => !hostInZone(u.hostname, cfg.zone);
  R.check("G4-I8: the resolver host is outside the site's zone", outside(cfg.resolver), "ACCEPT_RESOLVER_URL vs ACCEPT_SITE_ZONE");
  if (cfg.canary) R.check("G4-I8: the canary host is outside the site's zone", outside(cfg.canary.url));
  if (cfg.canary && !LOCAL) {
    const sameHost = cfg.canary.url.host === cfg.resolver.host;
    R.info("the site currently points at", sameHost ? "the canary" : "a host other than the canary (the real resolver, or resolver.invalid)");
  }
  const r = await rawRequest(siteUrl("/"), { headers: browserHeaders() });
  R.check("the site answers 200 for a browser navigation", r.status === 200, `HTTP ${r.status}`);
  if (!LOCAL) {
    R.check("served through Cloudflare (cf-ray present)", typeof r.headers["cf-ray"] === "string");
    const ip = await testerIp();
    R.check("the tester's IP as Cloudflare sees it is known (from /cdn-cgi/trace or ACCEPT_TESTER_IP)", Boolean(ip), ip ? "known (not printed)" : "unknown: set ACCEPT_TESTER_IP");
  }
  const csp = r.headers["content-security-policy"];
  R.info("Content-Security-Policy on the page", typeof csp === "string" ? `${csp.length} chars; connect-src 'self': ${/connect-src[^;]*'self'/.test(csp)}; unsafe-eval: ${csp.includes("unsafe-eval")}` : "none sent");
  // Directive names only: the values can name hosts, and result files must not.
  metrics.cspDirectives = typeof csp === "string" ? csp.split(";").map((d) => d.trim().split(/\s+/)[0]).filter(Boolean) : null;
  R.info("Set-Cookie on the page", r.headers["set-cookie"] ? "present (from the site, not the adapter)" : "none");
}

async function ttfb() {
  R.begin("ttfb (canary mode ok)");
  const ip = await testerIp();
  await canary.reset();
  await canary.mode("ok");
  if (ip) await canary.expect(ip);
  const tag = letters(4);
  const pairs = await ttfbPairs("ttfb", tag, cfg.samples);
  // A forged CF-Connecting-IP from the client: Cloudflare must overwrite it.
  if (!LOCAL) await rawRequest(siteUrl(`${cfg.reported}forged-${tag}-1`), { headers: browserHeaders({ "cf-connecting-ip": FORGED_IP, "x-forwarded-for": FORGED_IP, "x-real-ip": FORGED_IP, "true-client-ip": FORGED_IP }) });
  await sleep(4000);
  const res = await canary.results();
  ttfbVerdict("ttfb", pairs);
  const got = entrancesFor(res, "ttfb", tag);
  const ids = new Set(got.map((r) => r.id));
  R.check("every reported page delivered exactly one entrance (>= 99%)", ids.size >= Math.ceil(0.99 * pairs.length) && got.every((r) => r.attempt === 1), `${ids.size} of ${pairs.length}, ${got.length} requests`);
  const controls = res.records.filter((r) => r.pageKey?.startsWith(`${cfg.control}`)).length;
  R.check("no excluded control page was reported", controls === 0, `${controls}`);
  const keys = [...new Set(got.map((r) => r.keys.join(",")))];
  R.check("entrance body keys are exactly the entrance.v1 keys", keys.length === 1 && keys[0] === "acquisition,contract,eligibility,entrance_id,ip,occurred_at,page_key,website_id", keys.join(" | "));
  const endByI = new Map(pairs.map((p) => [p.i, p.reported.endedAt]));
  const lat = got.map((r) => r.at - (endByI.get(Number(r.pageKey.split("-").pop())) ?? r.at)).filter(Number.isFinite);
  metrics.ttfb = { ...(metrics.ttfb ?? {}), deliveryAfterResponseMs: stats(lat) };
  R.info("delivery arrival after the response completed (tester clock vs canary clock, approximate)", `median ${round(median(lat))} ms, p95 ${round(percentile(lat, 95))} ms`);
  if (ip) {
    const match = got.filter((r) => r.ip.matchesExpected).length;
    R.check("trust policy cloudflare: the entrance carried the tester's real IP", got.length > 0 && match === got.length, `${match} of ${got.length}`);
  } else {
    R.skip("trust policy cloudflare: tester IP unknown");
  }
  if (!LOCAL) {
    const forged = res.records.filter((r) => r.pageKey === `${cfg.reported}forged-${tag}-1`);
    R.check("a client-forged CF-Connecting-IP is overwritten by Cloudflare (the real IP is sent)", forged.length === 1 && !forged[0].ip.matchesForged && (ip ? forged[0].ip.matchesExpected : true), forged.length ? `matchesForged ${forged[0].ip.matchesForged}` : "no entrance for the forged request");
  }
  g4i8("ttfb", got);
}

const FAULTS = [
  { mode: "500", attempts: 1, settle: 4000 },
  { mode: "503", attempts: 2, settle: 5000 },
  { mode: "429", attempts: 2, settle: 5000 },
  { mode: "401", attempts: 1, settle: 4000 },
  { mode: "hang", attempts: 2, settle: 14000 },
  { mode: "reset", attempts: 2, settle: 5000 },
];
async function faults() {
  const n = Math.min(cfg.samples, 30);
  for (const f of FAULTS) {
    R.begin(`faults (canary mode ${f.mode})`);
    await canary.reset();
    const ip = await testerIp();
    if (ip) await canary.expect(ip);
    await canary.mode(f.mode);
    const tag = letters(4);
    const label = `fault${f.mode === "hang" ? "h" : f.mode === "reset" ? "r" : ""}`;
    const pairs = await ttfbPairs(label, tag, n);
    await sleep(f.settle);
    const res = await canary.results();
    ttfbVerdict(`faults ${f.mode}`, pairs);
    const got = entrancesFor(res, label, tag);
    const byId = new Map();
    for (const r of got) byId.set(r.id, Math.max(byId.get(r.id) ?? 0, r.attempt));
    const attempts = [...byId.values()];
    R.check(`resolver ${f.mode}: ${f.attempts} attempt(s) per entrance, then dropped`, byId.size >= Math.ceil(0.95 * n) && attempts.every((a) => a === f.attempts), `${byId.size} entrances; attempts ${[...new Set(attempts)].join(",")}`);
    if (f.mode === "hang") {
      const gaps = [];
      for (const id of byId.keys()) {
        const t = got.filter((r) => r.id === id).map((r) => r.at).sort((a, b) => a - b);
        if (t.length === 2) gaps.push(t[1] - t[0]);
      }
      R.info("hang: time between the two attempts (timeoutMs 5000 + retryDelayMs 250 expected)", `median ${round(median(gaps))} ms`);
    }
  }
  await canary.mode("ok");
}

async function down() {
  R.begin("down (site points at an unresolvable resolver host)");
  if (!cfg.resolver.hostname.endsWith(".invalid")) R.info("ACCEPT_RESOLVER_URL is not a .invalid host", "set the site's IDR_RESOLVER_URL to https://resolver.invalid for this phase");
  const tag = letters(4);
  const pairs = await ttfbPairs("down", tag, Math.min(cfg.samples, 30));
  ttfbVerdict("down", pairs);
  if (cfg.canary) {
    await sleep(3000);
    const res = await canary.results();
    R.check("nothing reached the canary", entrancesFor(res, "down", tag).length === 0);
  }
}

function vocabularyType(name) {
  for (const [type, names] of Object.entries(VOCABULARY)) if (names.includes(name)) return type;
  return null;
}
async function route() {
  R.begin("route (first-party collector route)");
  const ip = await testerIp();
  await canary.reset();
  await canary.mode("ok");
  if (ip) await canary.expect(ip);
  const tag = letters(4);
  const name = cfg.allow.includes("cta_click") ? "cta_click" : cfg.allow[0];
  const type = vocabularyType(name);
  const consent = cfg.consentMode === "required" ? "granted" : "not_required";
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const ev = (over = {}) => ({ v: 1, event_id: randomId(), occurred_at: now(), type, name, path: `/landing/route-${tag}`, consent, ...over });
  const base = {
    origin: cfg.site.origin,
    "sec-fetch-site": "same-origin",
    "content-type": "text/plain;charset=UTF-8",
    "user-agent": UA,
    ...(cfg.consentCookie ? { cookie: cfg.consentCookie } : {}),
  };
  const hostile = { "cf-connecting-ip": FORGED_IP, "x-forwarded-for": FORGED_IP, "x-real-ip": FORGED_IP, "true-client-ip": FORGED_IP, referer: `${cfg.site.origin}/secret-ref?x=1` };
  const url = siteUrl(cfg.collectorPath);
  const post = (body, headers = base, extra = {}) => rawRequest(url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body), ...extra });
  let accepted = 0;
  const expect = async (label, promise, status) => {
    const r = await promise;
    if (r.status === 204) accepted++;
    R.check(`${label}: ${status}`, r.status === status, `HTTP ${r.status}`);
    return r;
  };

  const first = ev();
  const ok = await expect("valid event with hostile headers", post(first, { ...base, ...hostile }), 204);
  R.check("204 is bare: no body, no Set-Cookie, Cache-Control no-store", ok.body === "" && !ok.headers["set-cookie"] && /no-store/.test(String(ok.headers["cache-control"] ?? "")));
  R.info("route TTFB for an accepted event", `${round(ok.ttfbMs)} ms`);
  const replay = await post(first);
  if (replay.status === 204) accepted++;
  R.check("replayed event_id: 409 (or 204 when another instance answered; see the plan)", replay.status === 409 || replay.status === 204, `HTTP ${replay.status}`);
  metrics.replay = replay.status;
  // With only `POST` registered (as the README documents), TanStack Start serves a GET itself (the local probe
  // answered 200 with an empty route page), so the route's own 405 is not reached. What matters: a GET is never
  // accepted as an event (nothing is forwarded; the forwarded count below would show it).
  const get = await rawRequest(url, { method: "GET", headers: base });
  R.check("GET is not accepted as an event (no 204)", get.status !== 204, `HTTP ${get.status}${get.status === 405 ? " from the route" : " from the framework, not the route (finding G5-D-F1)"}`);
  await expect("foreign Origin", post(ev(), { ...base, origin: "https://attacker.example.net", "sec-fetch-site": "cross-site" }), 403);
  const noOrigin = { ...base };
  delete noOrigin.origin;
  await expect("missing Origin", post(ev(), noOrigin), 403);
  await expect("Sec-Fetch-Site cross-site with the right Origin", post(ev(), { ...base, "sec-fetch-site": "cross-site" }), 403);
  await expect("content type application/xml", post(ev(), { ...base, "content-type": "application/xml" }), 415);
  const big = JSON.stringify({ ...ev(), pad: "x".repeat(3000) });
  await expect("Content-Length above 1 KiB", post(big), 413);
  await expect("streamed (chunked) body above 1 KiB", rawRequest(url, { method: "POST", headers: { ...base, "transfer-encoding": "chunked" }, chunks: [big.slice(0, 900), big.slice(900)] }), 413);
  await expect("malformed JSON", post("{not json"), 400);
  await expect("unknown field (ip)", post({ ...ev(), ip: FORGED_IP }), 400);
  await expect("path with a query string", post(ev({ path: "/pricing?email=x" })), 400);
  await expect("unknown event name", post(ev({ name: "not_a_name" })), 400);
  const notAllowed = Object.values(VOCABULARY).flat().find((n) => !cfg.allow.includes(n));
  if (notAllowed) await expect(`vocabulary name outside the allowlist (${notAllowed})`, post(ev({ name: notAllowed, type: vocabularyType(notAllowed) })), 403);
  else R.skip("name outside the allowlist", "the allowlist holds the whole vocabulary");
  await expect("Sec-GPC: 1", post(ev(), { ...base, "sec-gpc": "1" }), 403);
  if (cfg.consentMode === "required") {
    await expect("consent not_required under consent required", post(ev({ consent: "not_required" })), 403);
    if (cfg.consentCookie) {
      const noCookie = { ...base };
      delete noCookie.cookie;
      await expect("granted, but the server-side consent check (cookie) fails", post(ev(), noCookie), 403);
    } else R.skip("server-side consent check", "ACCEPT_CONSENT_COOKIE not set");
  }
  await expect("occurred_at 10 minutes in the past", post(ev({ occurred_at: new Date(Date.now() - 600_000).toISOString().replace(/\.\d{3}Z$/, "Z") })), 400);

  // Rate budget: per route instance (not per site, not per IP). Sent with concurrency 10.
  const burst = cfg.rateEvents + 20;
  const statuses = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      while (next < burst) {
        next++;
        const r = await post(ev());
        statuses.push(r.status);
      }
    }),
  );
  const n204 = statuses.filter((s) => s === 204).length;
  const n429 = statuses.filter((s) => s === 429).length;
  accepted += n204;
  metrics.rate = { sent: burst, accepted: n204, limited: n429, other: statuses.length - n204 - n429 };
  if (n429 > 0) R.check(`rate budget: 429 after the per-instance budget (${cfg.rateEvents})`, n204 <= cfg.rateEvents + 2, `${n204} accepted, ${n429} limited of ${burst}`);
  else R.info("rate budget: no 429 seen (requests spread over several instances; the budget is per instance)", `${n204} accepted of ${burst}`);

  await sleep(4000);
  const res = await canary.results();
  const events = res.records.filter((r) => r.route === "events");
  const distinct = new Set(events.map((r) => r.id)).size;
  const expected = accepted - (replay.status === 204 ? 1 : 0); // a replay answered 204 by another instance reuses its event_id
  R.check("forwarded to the resolver: exactly one event_id per accepted event, nothing for a refused one", distinct === expected, `${distinct} distinct event_ids forwarded, ${expected} accepted`);
  const keys = [...new Set(events.map((r) => r.keys.join(",")))];
  R.check("forwarded body keys are exactly the event.v1 keys", keys.length === 1 && keys[0] === "consent,contract,event_id,name,occurred_at,page_key,type,website_id", keys.join(" | "));
  R.check("forwarded bodies carry no ip field", events.every((r) => !r.ip.present));
  R.check("page_key is the mapped path", events.every((r) => r.pageKey === `/landing/route-${tag}`));
  g4i8("route", events);
}

async function bundle() {
  R.begin("bundle (deployed client assets)");
  const pages = ["/", `${cfg.reported}bundle-${letters(4)}-1`];
  const seen = new Map();
  const queue = [];
  const enqueue = (raw, from) => {
    let u;
    try {
      u = new URL(raw, from);
    } catch {
      return;
    }
    if (u.origin !== cfg.site.origin) return;
    u.hash = "";
    if (!seen.has(u.href) && queue.length + seen.size < 400) {
      seen.set(u.href, null);
      queue.push(u);
    }
  };
  let html = "";
  for (const p of pages) {
    const r = await rawRequest(siteUrl(p), { headers: browserHeaders() });
    html += r.body;
    for (const m of r.body.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) enqueue(m[1], siteUrl(p));
    for (const m of r.body.matchAll(/<link[^>]*\shref="([^"]+)"[^>]*>/g)) if (/rel="(?:modulepreload|preload|stylesheet)"/.test(m[0])) enqueue(m[1], siteUrl(p));
    for (const m of r.body.matchAll(/["'`](\/[A-Za-z0-9_./-]+\.m?js)["'`]/g)) enqueue(m[1], siteUrl(p));
  }
  let bytes = 0;
  let text = html;
  while (queue.length > 0 && bytes < 20_000_000) {
    const u = queue.shift();
    const r = await rawRequest(u, { headers: { "user-agent": UA, accept: "*/*" } });
    if (r.status !== 200) continue;
    bytes += r.body.length;
    text += `\n${r.body}`;
    if (/\.m?js$/.test(u.pathname)) for (const m of r.body.matchAll(/["'`]((?:\.{1,2}\/|\/)[A-Za-z0-9_./-]+\.m?js)["'`]/g)) enqueue(m[1], u);
  }
  metrics.bundle = { files: seen.size, bytes };
  R.info("client assets scanned", `${seen.size} files, ${bytes} bytes, plus the HTML of ${pages.length} pages`);
  const needles = [...FORBIDDEN_IN_CLIENT.map((s) => [s, s]), [cfg.resolver.host, "<resolver host>"]];
  if (cfg.canary) needles.push([cfg.canary.url.host, "<canary host>"]);
  if (cfg.scanToken) needles.push([cfg.scanToken, "<the site's resolver token>"]);
  const found = needles.filter(([s]) => text.includes(s)).map(([, label]) => label);
  R.check("no server code, token, resolver host or contract name in client assets or HTML", found.length === 0, found.join(", ") || `${needles.length} markers checked`);
  if (!cfg.scanToken) R.skip("token search", "ACCEPT_BUNDLE_SCAN_TOKEN not set");
  if (env.ACCEPT_EXPECT_COLLECTOR !== "0") R.check("positive control: the collector (data-idr-event) is in the client bundle", text.includes("data-idr-event"));
}

async function ceiling() {
  R.begin("ceiling (waitUntil on the production edge)");
  if (LOCAL) {
    R.skip("the probe app has no ceiling route; local workerd is not the production edge");
    return;
  }
  await canary.reset();
  const runs = [];
  for (const variant of ["complete", "disconnect", "complete"]) {
    const probeId = letters(6);
    const r = await rawRequest(siteUrl("/staging-probe/ceiling"), {
      method: "POST",
      headers: { "x-staging-probe-token": cfg.probeToken, "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ probe_id: probeId }),
      abortAfterHeaders: variant === "disconnect",
    });
    R.check(`probe route accepted (${variant})`, r.status === 202, `HTTP ${r.status}`);
    runs.push({ probeId, variant, sentAt: r.endedAt });
  }
  await sleep(Number(args["ceiling-wait-s"] ?? 75) * 1000);
  const res = await canary.results();
  for (const run of runs) {
    const offsets = res.ceiling.filter((c) => c.probeId === run.probeId).map((c) => c.offsetS).sort((a, b) => a - b);
    const max = offsets.length ? offsets[offsets.length - 1] : null;
    metrics[`ceiling_${run.probeId}`] = { variant: run.variant, offsets };
    R.info(`observed waitUntil ceiling (${run.variant})`, `last ping received at +${max} s; received offsets ${offsets.join(",")}`);
    R.check(`(${run.variant}) every ping up to +25 s arrived (the adapter's worst case is 10.25 s, or 20.25 s at timeoutMs 10000)`, [1, 5, 10, 15, 20, 25].every((o) => offsets.includes(o)));
  }
}

async function cold() {
  R.begin("cold (first request after a fresh deployment)");
  R.info("precondition", "the owner deployed the staging Worker immediately before this phase (or it was idle for the documented time)");
  const ip = await testerIp();
  await canary.reset();
  await canary.mode("ok");
  if (ip) await canary.expect(ip);
  const tag = letters(4);
  const first = await rawRequest(siteUrl(`${cfg.reported}cold-${tag}-1`), { headers: browserHeaders() });
  const warm = [];
  for (let i = 2; i <= 11; i++) warm.push((await rawRequest(siteUrl(`${cfg.reported}cold-${tag}-${i}`), { headers: browserHeaders() })).ttfbMs);
  await sleep(4000);
  const res = await canary.results();
  metrics.cold = { firstTtfbMs: round(first.ttfbMs), warm: stats(warm) };
  R.info("TTFB first request vs warm", `first ${round(first.ttfbMs)} ms; warm median ${round(median(warm))} ms`);
  R.check("the first (cold) request answered 200", first.status === 200, `HTTP ${first.status}`);
  R.check("the cold request's entrance was delivered", entrancesFor(res, "cold", tag).some((r) => r.pageKey === `${cfg.reported}cold-${tag}-1`));
}

async function browser() {
  R.begin("browser (manual, real browsers)");
  const lines = [
    "Open <site>/landing/browser-<browser name> in each browser (Chrome, Firefox, Safari on macOS; iOS Safari and Android Chrome if available).",
    "In DevTools > Network: the document is 200; with consent granted, a POST to the collector path answers 204; no request goes to any other host for the collector.",
    "In DevTools > Console: no Content-Security-Policy violation and no exception from the collector.",
    "Consent: before consent, no POST to the collector path; after granting, a page_view; after withdrawing, nothing more.",
    "GPC: in a browser with Global Privacy Control on (navigator.globalPrivacyControl === true), no POST at all.",
    "SPA: navigate between two landing pages through in-app links; one page_view per path change.",
    "Click an element marked data-idr-event; submit a form marked data-idr-form with values typed in; check that no value is sent.",
  ];
  for (const l of lines) R.info("checklist", l);
  if (!cfg.canary) return;
  const wait = Number(args["browser-wait-s"] ?? 300);
  R.info(`polling the canary for ${wait} s`, "records with page_key /landing/browser-*");
  await sleep(wait * 1000);
  const res = await canary.results();
  const recs = res.records.filter((r) => r.pageKey?.startsWith("/landing/browser-"));
  const byKey = {};
  for (const r of recs) {
    const k = `${r.pageKey} ${r.route === "events" ? r.name : "entrance"}`;
    byKey[k] = (byKey[k] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(byKey)) R.info("received", `${k}: ${n}`);
  if (recs.length > 0) g4i8("browser", recs);
}

function finish() {
  const summary = R.summary();
  console.log(`summary: ${summary.pass} pass, ${summary.fail} fail, ${summary.info} info, ${summary.skip} skip`);
  if (typeof args.out === "string") {
    const doc = { script: "cf-site-check", version: 1, ranAt: new Date().toISOString(), localProbe: LOCAL, phases, summary, items: R.items, metrics: JSON.parse(redact(JSON.stringify(metrics))) };
    writeFileSync(args.out, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  }
  process.exit(summary.fail > 0 ? 1 : 0);
}

const RUN = { preflight, ttfb, faults, down, route, bundle, ceiling, cold, browser };
try {
  for (const p of phases) await RUN[p]();
} catch (e) {
  R.check("phase completed without an error", false, redact(e instanceof Error ? e.message : String(e)));
}
finish();
