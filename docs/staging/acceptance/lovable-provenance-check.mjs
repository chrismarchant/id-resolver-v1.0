#!/usr/bin/env node
// lovable-provenance-check.mjs: who controls the visitor IP that the adapter selects on a Lovable-hosted TanStack
// Start site (CHR-119 section 3)? Lovable builds for Cloudflare Workers, and the adapter's trust policy
// {mode:"cloudflare"} reads CF-Connecting-IP. From the network it runs on, this script answers: does the resolver get
// the tester's real address whatever the client sends (provider-controlled), or can a client forge it?
// cf-site-check.mjs cannot answer that: its forged value is an RFC 5737 address, which the adapter silently refuses,
// so a forgery that got through would look exactly like an edge rejection.
//
// Set-up: the site's IDR_RESOLVER_URL points at the canary (canary-sink.mjs; IDR_RESOLVER_TOKEN = the canary token;
// CANARY_FORGED_IP = PROV_FORGED_IP, or PROV_FORGED_IP6 for an IPv6 run). The tester's real public address R is read
// from two or more independent IP-echo services at the start and at the end of the run, over the pinned family. Per
// case: reset the canary, tell it R, send ONE browser-like document navigation (serial, cache-busted), and read back
// what the entrance carried (booleans only: the canary never stores an address).
//   P1 baseline | P2 CF-Connecting-IP: F | P3a-d X-Forwarded-For / X-Real-IP / True-Client-IP / Forwarded = F
//   P4 two CF-Connecting-IP lines (F, F2) | P5 control CF-Connecting-IP: R | P6 = all of these with --family 6
//   P7 runtime evidence from the P1 response (cf-ray, server): supporting evidence only, never a provenance proof
// Verdicts (README, "lovable-provenance-check"): in a forged case an entrance with ip != R is a FAIL; in a clean case
// it is a HOLD; a header on the entrance subrequest carrying a visitor IP is a FAIL (G4-I8); an edge rejection
// (non-2xx Cloudflare error page) counts only when P1 passed on the same entry point in the same run. Overall PASS
// only when every case on every entry point is provider-controlled; the first FAIL stops the run.
//
// Environment (names only; nothing has a default that points anywhere):
//   PROV_SITE_URLS     comma list of the site's entry-point origins (https), e.g. the Lovable subdomain and a custom domain
//   PROV_PAGE_PATH     a path that answers 200 with HTML and is an eligible document for the adapter, e.g. /
//   PROV_CANARY_URL    origin of the canary sink
//   PROV_CANARY_TOKEN  the canary bearer token (secret: read -rs, never on the command line; never printed)
//   PROV_FORGED_IP, PROV_FORGED_IP2    (--family 4) forged public, non-personal IPv4 values F, F2
//   PROV_FORGED_IP6, PROV_FORGED_IP6B  (--family 6) forged public, non-personal IPv6 values F6, F6b
//   PROV_ECHO_URLS     comma list of 2-4 IP-echo URLs on distinct hosts, answering the caller's address as plain text,
//                      an ip=<address> line or JSON {"ip": ...}; at least one must not be served via Cloudflare
//   PROV_TESTER_IP     optional cross-check of the echoed address (never printed)
// Flags: --family 4|6 (required; every request, echo checks included, is pinned to it and the connected socket's
//   family is verified) --network-label <1-40 letters, digits, spaces, _ or -> (required) --confirm-target <every
//   entry-point host, comma-separated, any order> --dry-run --out <file> (mode 600) --local-probe (loopback http,
//   self-test only) --canary-any-family (reach the canary over either family: its view of the tester plays no part)
//   --delay-ms 2000 (between cases, 0-60000) --poll-timeout-s 20 (wait for an entrance, 1-120) --settle-ms 2000
//   (after the first entrance, to catch a second one, 0-10000)
// Safety: a refusal exits 2 with nothing sent. No IP address, token or host is printed or written: hosts appear as
//   <site1>, <canary>, <echo1>; every line and the --out file pass the redactor; R lives in memory only (it goes to
//   the canary's /_canary/expect and nowhere else); network errors are reported by code only.
// Exit: 0 PASS, 1 FAIL or HOLD, 2 refusal or configuration error.
//
//   export PROV_SITE_URLS=https://<project>.lovable.app,https://<custom-domain> PROV_PAGE_PATH=/ \
//          PROV_CANARY_URL=https://<canary-host> PROV_ECHO_URLS=https://<echo-host-a>/<path>,https://<echo-host-b>/<path> \
//          PROV_FORGED_IP=<public-v4-F> PROV_FORGED_IP2=<public-v4-F2>
//   read -rs PROV_CANARY_TOKEN && export PROV_CANARY_TOKEN
//   node lovable-provenance-check.mjs --family 4 --network-label home-fibre \
//        --confirm-target <project>.lovable.app,<custom-domain> --out <private dir>/prov-home-v4.json
import { closeSync, fchmodSync, openSync, writeSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { canonicalIp } from "./canary-sink.mjs";
import { Refusal, confirmTarget, letters, makeRedactor, parseArgs, parseTarget, requireEnv, sleep } from "./lib/common.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36 idr-provenance-check";
const ECHO_UA = "curl/8.5.0 idr-provenance-check";
const FLAGS = new Set(["_", "family", "network-label", "confirm-target", "dry-run", "out", "local-probe", "canary-any-family", "delay-ms", "poll-timeout-s", "settle-ms"]);
const POLL_MS = 300;

// Header NAMES expected on the entrance subrequest at the canary. Anything else is flagged INFO for human review; every
// name is printed either way (nothing is hidden), and every VALUE is compared by the canary for visitor IPs.
const ALLOWED = new Set([
  "authorization", "content-type", "accept", // exactly what the adapter sets (delivery.ts)
  "host", "content-length", "transfer-encoding", "connection", "accept-encoding", "user-agent", // HTTP framing, runtime fetch defaults
  "cdn-loop", // Cloudflare's loop marker on a Worker subrequest (with the cf-* prefix below)
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "x-real-ip", "x-request-start", "x-request-id", // the canary's own hosting proxy
]);
const ALLOWED_PREFIXES = ["cf-", "x-railway-"];
const allowedName = (n) => ALLOWED.has(n) || ALLOWED_PREFIXES.some((p) => n.startsWith(p));

// The adapter's address classes (packages/tanstack/src/ip.ts): only global unicast public addresses are selected;
// documentation ranges only with allowDocumentationRanges, which a production site does not set.
const NON_PUBLIC = new BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8], ["224.0.0.0", 3], ["100.64.0.0", 10], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["198.18.0.0", 15]]) NON_PUBLIC.addSubnet(a, p, "ipv4");
NON_PUBLIC.addSubnet("192.88.99.0", 24, "ipv4"); // public-safety: allow-synthetic (the deprecated 6to4 relay anycast prefix the adapter refuses; a range start, not a host)
NON_PUBLIC.addSubnet("2001::", 23, "ipv6");
NON_PUBLIC.addSubnet("2002::", 16, "ipv6");
const DOCS = new BlockList();
for (const a of ["192.0.2.0", "198.51.100.0", "203.0.113.0"]) DOCS.addSubnet(a, 24, "ipv4");
DOCS.addSubnet("2001:db8::", 32, "ipv6");
DOCS.addSubnet("3fff::", 20, "ipv6");
function classify(text) {
  const fam = isIP(text);
  const c = fam === 0 ? null : canonicalIp(text);
  if (c === null) return "malformed";
  const t = fam === 4 ? "ipv4" : "ipv6";
  // IPv6: only global unicast (first three bits 001) can be a public client; this also rejects mapped forms.
  if (fam === 6 && (parseInt(c.split(":")[0] || "0", 16) & 0xe000) !== 0x2000) return "non-public";
  if (NON_PUBLIC.check(c, t)) return "non-public";
  return DOCS.check(c, t) ? "documentation" : "public";
}
const same = (a, b) => canonicalIp(a) !== null && canonicalIp(a) === canonicalIp(b);

// The paths the adapter never reports (eligibility.ts): API, internal, health, asset and the default collector path.
const INELIGIBLE_PATH = /^\/(?:api|_server|_serverfn|_build|_tsr|_nitro|_vercel|assets|\.well-known|cdn-cgi|health|healthz|healthcheck|ready|readyz|live|livez|ping|_health|idr\/e)(?:\/|$)|^\/(?:__|sitemap|favicon|robots\.txt)|\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|txt|xml|json|webmanifest|pdf|zip|gz|mp4|webm|mp3|wav|ogg|wasm)$/i;

// The cases. `forged`: any entrance whose ip != R is a FAIL. Clean cases (P1, P5): ip != R is a HOLD.
const CASES = [
  { id: "P1", forged: false, headers: () => ({}) },
  { id: "P2", forged: true, headers: (v) => ({ "cf-connecting-ip": v.F }) },
  { id: "P3a", forged: true, headers: (v) => ({ "x-forwarded-for": v.F }) },
  { id: "P3b", forged: true, headers: (v) => ({ "x-real-ip": v.F }) },
  { id: "P3c", forged: true, headers: (v) => ({ "true-client-ip": v.F }) },
  { id: "P3d", forged: true, headers: (v) => ({ forwarded: v.family === 6 ? `for="[${v.F}]"` : `for=${v.F}` }) },
  { id: "P4", forged: true, headers: (v) => ({ "cf-connecting-ip": [v.F, v.F2] }) }, // two separate raw header lines
  { id: "P5", forged: false, headers: (v) => ({ "cf-connecting-ip": v.R }) },
];

const args = parseArgs(process.argv.slice(2));
const LOCAL = args["local-probe"] === true;
const env = process.env;

function checkForged(name, value, family) {
  if (isIP(value) !== family) throw new Refusal(`${name} must be a plain IPv${family} address`);
  const kind = classify(value);
  if (kind === "documentation" && !LOCAL) {
    throw new Refusal(
      `${name} is in a documentation range (RFC 5737 / RFC 3849). The adapter refuses those addresses, so a forged value that got through would be dropped exactly like an edge rejection and the test could not tell them apart: use a public, non-personal address (for example a public DNS anycast address)`,
    );
  }
  if (kind === "non-public") throw new Refusal(`${name} is private, reserved or otherwise not public: the adapter refuses it, so a forgery could not be seen`);
  return value;
}

/** Every entry-point host must be named again in --confirm-target (comma-separated, any order, nothing else). */
function confirmTargets(hosts, given) {
  const list = typeof given === "string" ? given.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (list.length === 0) return confirmTarget(hosts[0], "");
  if (list.length !== hosts.length) throw new Refusal(`--confirm-target must name every entry-point host (${hosts.length}), comma-separated, and nothing else`);
  const want = hosts.map((h) => h.toLowerCase()).sort();
  const got = list.map((h) => h.toLowerCase()).sort();
  want.forEach((h, i) => confirmTarget(h, got[i]));
}

function loadConfig() {
  const unknown = Object.keys(args).filter((k) => !FLAGS.has(k));
  if (unknown.length > 0 || args._.length > 0) throw new Refusal("unknown or positional argument(s); see the header of this script for the flags");
  for (const f of ["dry-run", "local-probe", "canary-any-family"]) if (args[f] !== undefined && args[f] !== true) throw new Refusal(`--${f} takes no value`);
  if (args.family !== "4" && args.family !== "6") throw new Refusal("--family 4 or --family 6 is required");
  const family = Number(args.family);
  const forgedNames = family === 4 ? ["PROV_FORGED_IP", "PROV_FORGED_IP2"] : ["PROV_FORGED_IP6", "PROV_FORGED_IP6B"];
  const req = requireEnv(env, ["PROV_SITE_URLS", "PROV_PAGE_PATH", "PROV_CANARY_URL", "PROV_CANARY_TOKEN", "PROV_ECHO_URLS", ...forgedNames]);
  const label = typeof args["network-label"] === "string" ? args["network-label"].trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(label)) throw new Refusal("--network-label is required: 1-40 letters, digits, spaces, _ or - (never an address)");
  const opt = { allowLoopbackHttp: LOCAL };
  const list = (name) => req[name].split(",").map((s) => s.trim()).filter(Boolean);
  const sites = list("PROV_SITE_URLS").map((v, i) => parseTarget(`PROV_SITE_URLS entry ${i + 1}`, v, opt));
  if (sites.length < 1 || sites.length > 4) throw new Refusal("PROV_SITE_URLS must hold 1-4 entry points");
  const canary = parseTarget("PROV_CANARY_URL", req.PROV_CANARY_URL, opt);
  for (const [n, u] of [...sites.map((u, i) => [`PROV_SITE_URLS entry ${i + 1}`, u]), ["PROV_CANARY_URL", canary]]) if (u.pathname !== "/") throw new Refusal(`${n} must be an origin (no path)`);
  const echo = list("PROV_ECHO_URLS").map((v, i) => parseTarget(`PROV_ECHO_URLS entry ${i + 1}`, v, opt));
  if (echo.length < 2 || echo.length > 4) throw new Refusal("PROV_ECHO_URLS must hold 2-4 IP-echo URLs");
  const hosts = [...sites, canary, ...echo].map((u) => u.host.toLowerCase());
  if (new Set(hosts).size !== hosts.length) throw new Refusal("the entry points, the canary and the echo URLs must all be on distinct hosts");
  confirmTargets(sites.map((u) => u.host), args["confirm-target"]);
  if (!/^[\x21-\x7e]{32,}$/.test(req.PROV_CANARY_TOKEN)) throw new Refusal("PROV_CANARY_TOKEN must be at least 32 printable characters");
  const pagePath = req.PROV_PAGE_PATH;
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(pagePath) || pagePath.includes("//")) throw new Refusal("PROV_PAGE_PATH must be a plain path starting with / (no query, no placeholder)");
  if (INELIGIBLE_PATH.test(pagePath)) throw new Refusal("PROV_PAGE_PATH is a path the adapter never reports (API, internal, health, asset or collector path)");
  const [F, F2] = forgedNames.map((n) => checkForged(n, req[n], family));
  if (same(F, F2)) throw new Refusal(`${forgedNames.join(" and ")} must differ`);
  let testerIp = null;
  if (typeof env.PROV_TESTER_IP === "string" && env.PROV_TESTER_IP.trim() !== "") {
    testerIp = env.PROV_TESTER_IP.trim();
    if (isIP(testerIp) !== family) throw new Refusal(`PROV_TESTER_IP must be a plain IPv${family} address`);
    if (same(F, testerIp) || same(F2, testerIp)) throw new Refusal("a forged value equals PROV_TESTER_IP: F and F2 must not be the tester's own address");
  }
  const num = (name, def, min, max) => {
    const v = args[name] === undefined ? def : Number(args[name]);
    if (!Number.isInteger(v) || v < min || v > max) throw new Refusal(`--${name} must be an integer from ${min} to ${max}`);
    return v;
  };
  if (args.out !== undefined && (typeof args.out !== "string" || args.out.trim() === "")) throw new Refusal("--out needs a file name");
  return {
    family, label, sites, canary, echo, pagePath, F, F2, testerIp,
    token: req.PROV_CANARY_TOKEN,
    canaryAnyFamily: args["canary-any-family"] === true,
    delayMs: num("delay-ms", 2000, 0, 60_000),
    pollMs: num("poll-timeout-s", 20, 1, 120) * 1000,
    settleMs: num("settle-ms", 2000, 0, 10_000),
    out: typeof args.out === "string" ? args.out : null,
  };
}

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  const values = ["PROV_CANARY_TOKEN", "PROV_TESTER_IP", "PROV_FORGED_IP", "PROV_FORGED_IP2", "PROV_FORGED_IP6", "PROV_FORGED_IP6B"].map((n) => env[n]);
  console.error(makeRedactor(values)(`refused: ${e.message}`));
  process.exit(2);
}

const FAMILY = cfg.family;
const SECRETS = [cfg.token, cfg.F, cfg.F2, cfg.testerIp]; // R and every echo answer are added when learned
const HOSTS = Object.fromEntries([...cfg.sites.map((u, i) => [`<site${i + 1}>`, u.host]), ["<canary>", cfg.canary.host], ...cfg.echo.map((u, i) => [`<echo${i + 1}>`, u.host])]);
const redact = (text) => makeRedactor(SECRETS, HOSTS)(text);
const lines = [];
const say = (line) => {
  const l = redact(line);
  lines.push(l);
  console.log(l);
};
const ID = (base) => (FAMILY === 6 ? `P6-${base}` : base);
const siteLabels = cfg.sites.map((_, i) => `<site${i + 1}>`);
const fNames = FAMILY === 4 ? "F" : "F6";

if (args["dry-run"] === true) {
  say("dry-run: configuration valid; nothing was sent");
  say(
    `plan: network=${cfg.label} family=IPv${FAMILY} local-probe=${LOCAL}; entry points ${siteLabels.join(", ")}; per entry point, serially: ${CASES.map((c) => ID(c.id)).join(", ")}, then ${ID("P7")} (runtime evidence) and the header-name summary; echo ${cfg.echo.map((_, i) => `<echo${i + 1}>`).join(", ")} at start and end; canary <canary>${cfg.canaryAnyFamily ? " (either family)" : ""}; poll timeout ${cfg.pollMs / 1000} s, settle ${cfg.settleMs} ms, delay ${cfg.delayMs} ms`,
  );
  process.exit(0);
}

// The --out file is opened (mode 600) before anything is sent, so a bad path is a refusal, not a lost result.
let outFd = null;
if (cfg.out) {
  try {
    outFd = openSync(cfg.out, "w", 0o600);
    fchmodSync(outFd, 0o600);
  } catch (e) {
    console.error(`refused: cannot open the --out file (${codeOf(e)}); nothing was sent`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------------------------------------------
function codeOf(e) {
  return typeof e?.code === "string" && /^[A-Z0-9_]{2,64}$/.test(e.code) ? e.code : "ERROR";
}
const codeError = (code) => Object.assign(new Error(code), { code });

/**
 * One HTTP(S) request pinned to the run's IP family (lookup `family`, no happy-eyeballs), with exact headers (an array
 * value is sent as separate header lines). The connected socket's family is checked: an IP literal of the other family
 * would otherwise connect silently. Resolves { status, headers, body } with the body cut at maxBody; the rest is read
 * and discarded like a browser would (no early disconnect), up to a hard cap.
 */
function pinnedRequest(url, { method = "GET", headers = {}, body, timeoutMs = 20_000, maxBody = 65_536, anyFamily = false } = {}) {
  const mod = url.protocol === "https:" ? https : http;
  const h = { ...headers };
  if (typeof body === "string") h["content-length"] = Buffer.byteLength(body);
  const pin = anyFamily ? {} : { family: FAMILY, autoSelectFamily: false };
  const hardCap = Math.max(maxBody, 16 << 20);
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, headers: h, agent: false, timeout: timeoutMs, ...pin }, (res) => {
      if (!anyFamily && res.socket?.remoteFamily !== `IPv${FAMILY}`) {
        res.destroy();
        return reject(codeError("EFAMILY"));
      }
      const parts = [];
      let kept = 0;
      let total = 0;
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString("utf8") });
      res.on("data", (c) => {
        total += c.length;
        if (kept < maxBody) {
          parts.push(c);
          kept += c.length;
        }
        if (total > hardCap) {
          done();
          res.destroy();
        }
      });
      res.on("end", done);
      res.on("error", reject);
      res.on("close", () => (res.complete ? done() : reject(codeError("ECONNRESET"))));
    });
    req.on("timeout", () => req.destroy(codeError("ETIMEDOUT")));
    req.on("error", reject);
    req.end(body);
  });
}

const canary = {
  async call(method, path, body) {
    const r = await pinnedRequest(new URL(path, cfg.canary), {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      maxBody: 16 << 20,
      anyFamily: cfg.canaryAnyFamily,
    });
    if (r.status >= 300) throw codeError(`CANARY_HTTP_${r.status}`);
    if (!r.body) return null;
    try {
      return JSON.parse(r.body);
    } catch {
      throw codeError("CANARY_NOT_JSON");
    }
  },
  reset: () => canary.call("POST", "/_canary/reset", {}),
  mode: () => canary.call("POST", "/_canary/mode", { mode: "ok" }),
  expect: (ip) => canary.call("POST", "/_canary/expect", { client_ip: ip }),
  async results() {
    const r = await canary.call("GET", "/_canary/results");
    if (!r || !Array.isArray(r.records) || typeof r.counts !== "object") throw codeError("CANARY_SHAPE");
    return r;
  },
};

/** The caller's address from an echo answer: plain text, an `ip=` line (cdn-cgi/trace style) or JSON {"ip": ...}. */
function echoAddress(body) {
  const t = body.trim();
  if (isIP(t)) return t;
  const m = /^ip=(\S+)$/m.exec(body);
  if (m && isIP(m[1])) return m[1];
  try {
    const j = JSON.parse(t);
    if (typeof j?.ip === "string" && isIP(j.ip.trim())) return j.ip.trim();
  } catch {
    /* not JSON */
  }
  return null;
}

/** Asks every echo URL (serially, pinned). The answers are kept in memory only; output names <echoN> and via_cloudflare. */
async function echoCheck() {
  const answers = [];
  for (const [i, url] of cfg.echo.entries()) {
    const label = `<echo${i + 1}>`;
    try {
      const r = await pinnedRequest(url, { headers: { accept: "text/plain, application/json;q=0.9, */*;q=0.5", "user-agent": ECHO_UA }, maxBody: 4096, timeoutMs: 10_000 });
      const ip = r.status === 200 ? echoAddress(r.body) : null;
      if (ip) SECRETS.push(ip);
      const ok = ip !== null && isIP(ip) === FAMILY;
      const why = r.status !== 200 ? `HTTP ${r.status}` : ip === null ? "no address in the answer" : ok ? null : "an address of the other family";
      answers.push({ label, viaCloudflare: typeof r.headers["cf-ray"] === "string", ip: ok ? canonicalIp(ip) : null, why });
    } catch (e) {
      answers.push({ label, viaCloudflare: null, ip: null, why: codeOf(e) });
    }
  }
  const problems = answers.filter((a) => a.ip === null).map((a) => `${a.label}: ${a.why}`);
  const ips = new Set(answers.filter((a) => a.ip !== null).map((a) => a.ip));
  if (ips.size > 1) problems.push("the echo answers disagree");
  if (!answers.some((a) => a.viaCloudflare === false)) problems.push("no echo answer came from outside Cloudflare (all had cf-ray, or failed)");
  const summary = answers.map(({ label, viaCloudflare }) => ({ label, viaCloudflare }));
  const text = summary.map((a) => `${a.label} via_cloudflare=${a.viaCloudflare ?? "unknown"}`).join(", ");
  return { ip: problems.length === 0 ? [...ips][0] : null, problems, summary, text };
}

function browserHeaders(extra) {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent": UA,
    ...extra,
  };
}

/** A Cloudflare error page: non-2xx, cf-ray present, and a numeric error code in the body. Only the number is kept. */
function cfErrorCode(resp) {
  if (!resp || (resp.status >= 200 && resp.status < 300) || typeof resp.headers["cf-ray"] !== "string") return null;
  const m = /error code:\s*(\d{3,5})\b/i.exec(resp.body) ?? /cf-error-code[^>]*>\s*(\d{3,5})\s*</i.exec(resp.body) ?? /<title>[^<]*\berror\s+(\d{4,5})\b/i.exec(resp.body);
  return m ? Number(m[1]) : null;
}

function runtimeEvidence(resp) {
  const ray = resp?.headers["cf-ray"];
  return {
    cfRayPresent: typeof ray === "string",
    serverCloudflare: /^cloudflare$/i.test(String(resp?.headers.server ?? "")),
    cfRay: typeof ray === "string" ? (/^[0-9a-f]{16}-[A-Z]{3}$/.test(ray) ? ray : "unexpected-format") : null,
  };
}

let canaryKnowsF = null;
function forgedNote(rs) {
  if (rs.some((r) => r.ip?.matchesForged === true)) return `canary forged flag true: ${fNames} was selected`;
  if (canaryKnowsF) return `canary forged flag false: not ${fNames} and not R (${fNames}2 or another value), counted as forged`;
  return `canary forged flag not informative (its CANARY_FORGED_IP is not this run's ${fNames}); counted as forged`;
}

/** The verdict for one case from the site's answer and the canary's records (shape: canary-sink.mjs summary()). */
function evaluate(c, p1Passed, resp, errCode, res) {
  const recs = res.records;
  const ent = recs.filter((r) => r.route === "entrances");
  const ids = new Set(ent.map((r) => r.id));
  const n = ids.size;
  const uniq = (xs) => [...new Set(xs)].sort().join(", ");
  const leak = uniq(recs.flatMap((r) => r.headersWithClientIp ?? []));
  if (leak) return ["FAIL", `G4-I8: header(s) ${leak} on the subrequest carry a visitor IP`];
  const notR = ent.filter((r) => r.ip?.present === true && r.ip.matchesExpected !== true);
  if (c.forged && notR.length > 0) return ["FAIL", `entrance ip != R (${forgedNote(notR)})`];
  const ok2xx = resp !== null && resp.status >= 200 && resp.status < 300;
  const hold = [];
  if (notR.length > 0) hold.push("entrance ip != R: wrong provenance, investigate");
  if (ent.some((r) => r.ip?.present !== true)) hold.push("an entrance without an ip field");
  if (n > 1) hold.push(`${n} entrances for one request`);
  if (recs.length > ent.length) hold.push(`${recs.length - ent.length} non-entrance record(s) at the canary`);
  const fwd = uniq(recs.flatMap((r) => r.headersWithForgedIp ?? []));
  if (fwd) hold.push(`header(s) ${fwd} on the subrequest carry the canary's forged value`);
  if (recs.some((r) => r.compared !== true)) hold.push("record(s) the canary could not compare");
  if (ent.some((r) => r.bodyContainsClientIp === true)) hold.push("a visitor IP elsewhere in the entrance body");
  if (res.expectationSet !== true) hold.push("the canary lost the expected IP (reset by another client?)");
  if (n > 0 && !ok2xx) hold.push(`an entrance although the site answered ${resp ? `HTTP ${resp.status}` : errCode}`);
  if (hold.length > 0) return ["HOLD", hold.join("; ")];
  const retries = ent.length - n;
  if (n === 1) return ["PASS", `ip == R${retries > 0 ? ` (${retries} retry of the same entrance_id)` : ""}`];
  const diag = [res.counts.authFailed > 0 ? `canary refused ${res.counts.authFailed} unauthenticated request(s): check the site's resolver token` : "", res.counts.other > 0 ? `${res.counts.other} request(s) to unknown canary paths` : ""].filter(Boolean).join("; ");
  const why = (s) => (diag ? `${s}; ${diag}` : s);
  if (resp === null) return ["INCONCLUSIVE", why(`no answer from the site (${errCode})`)];
  if (ok2xx) {
    if (/^hit$/i.test(String(resp.headers["cf-cache-status"] ?? ""))) return ["INCONCLUSIVE", why("served from cache (cf-cache-status HIT), no entrance")];
    if (c.id === "P4") return p1Passed ? ["PASS", "2xx page, no entrance: repeated values refused (P1 passed on this entry point)"] : ["INCONCLUSIVE", why("2xx page, no entrance, and P1 did not pass on this entry point")];
    return ["INCONCLUSIVE", why(`2xx page but no entrance within ${cfg.pollMs / 1000} s`)];
  }
  const code = cfErrorCode(resp);
  if (code !== null) {
    if (c.id !== "P1" && p1Passed) return ["PASS", `edge rejection (HTTP ${resp.status}, Cloudflare error ${code}); P1 passed on this entry point`];
    return ["INCONCLUSIVE", why(`edge rejection (HTTP ${resp.status}, Cloudflare error ${code}) ${c.id === "P1" ? "of the baseline" : "and P1 did not pass on this entry point"}`)];
  }
  return ["INCONCLUSIVE", why(`HTTP ${resp.status} without a Cloudflare error code, no entrance`)];
}

/** Waits for an entrance (or the poll timeout), then settles to catch a second one or a retry. */
async function collect() {
  const deadline = Date.now() + cfg.pollMs;
  const has = (r) => r.records.some((x) => x.route === "entrances");
  let res = await canary.results();
  while (!has(res) && Date.now() < deadline) {
    await sleep(POLL_MS);
    res = await canary.results();
  }
  if (has(res) && cfg.settleMs > 0) {
    await sleep(cfg.settleMs);
    res = await canary.results();
  }
  return res;
}

const report = { cases: [], runtime: {}, headerNames: {}, echo: {}, problems: [] };
let R = null;
let configError = false;
const problem = (text) => {
  report.problems.push(text);
  say(`problem: ${text}`);
};
const caseLine = (site, id, http, cfError, entrances, verdict, reason) =>
  `${site} net=${cfg.label} IPv${FAMILY} ${id} http=${http} cf-error=${cfError ?? "-"} entrances=${entrances} => ${verdict}: ${reason}`;

async function runCase(site, c, p1Passed) {
  await canary.reset();
  await canary.mode();
  await canary.expect(R);
  const url = new URL(cfg.pagePath, site);
  url.searchParams.set("idrprov", letters(12)); // cache-busting nonce (the adapter keeps the path only)
  let resp = null;
  let errCode = null;
  try {
    resp = await pinnedRequest(url, { headers: browserHeaders(c.headers({ F: cfg.F, F2: cfg.F2, R, family: FAMILY })) });
  } catch (e) {
    errCode = codeOf(e);
  }
  const res = await collect();
  const [verdict, reason] = evaluate(c, p1Passed, resp, errCode, res);
  const ent = res.records.filter((r) => r.route === "entrances");
  return { resp, verdict, reason, entrances: new Set(ent.map((r) => r.id)).size, records: res.records, http: resp ? resp.status : `error:${errCode}`, cfError: cfErrorCode(resp), cache: resp && /^[A-Za-z]{1,16}$/.test(String(resp.headers["cf-cache-status"] ?? "")) ? resp.headers["cf-cache-status"].toUpperCase() : null };
}

/** Runs every case on one entry point; returns false when a FAIL stops the run. */
async function runSite(label, site) {
  let p1Passed = false;
  const names = new Set();
  let entranceRecords = 0;
  let go = true;
  for (const c of CASES) {
    const r = await runCase(site, c, p1Passed);
    for (const rec of r.records.filter((x) => x.route === "entrances")) {
      entranceRecords++;
      for (const n of rec.headerNames ?? []) names.add(n);
    }
    report.cases.push({
      site: label, id: ID(c.id), forged: c.forged, http: r.http, cfError: r.cfError, cfCacheStatus: r.cache, entrances: r.entrances, verdict: r.verdict, reason: r.reason,
      records: r.records.map((x) => ({
        route: x.route, attempt: x.attempt, ipPresent: x.ip?.present, matchesExpected: x.ip?.matchesExpected, matchesForged: x.ip?.matchesForged, compared: x.compared,
        headerNames: x.headerNames, headersWithClientIp: x.headersWithClientIp, headersWithForgedIp: x.headersWithForgedIp,
      })),
    });
    say(caseLine(label, ID(c.id), r.http, r.cfError, r.entrances, r.verdict, `${r.reason}${r.cache ? ` [cf-cache-status ${r.cache}]` : ""}`));
    if (c.id === "P1") {
      p1Passed = r.verdict === "PASS";
      const ev = runtimeEvidence(r.resp);
      report.runtime[label] = ev;
      say(`${label} net=${cfg.label} IPv${FAMILY} ${ID("P7")} runtime => INFO: cf-ray present=${ev.cfRayPresent} value=${ev.cfRay ?? "-"}; server cloudflare=${ev.serverCloudflare} (supporting evidence only, not a provenance proof)`);
    }
    if (r.verdict === "FAIL") {
      go = false;
      break;
    }
    if (cfg.delayMs > 0) await sleep(cfg.delayMs);
  }
  const seen = [...names].sort();
  const outside = seen.filter((n) => !allowedName(n));
  report.headerNames[label] = { seen, outsideAllowlist: outside, entranceRecords };
  say(
    `${label} net=${cfg.label} IPv${FAMILY} headers => INFO: ${entranceRecords === 0 ? "no entrance reached the canary: no header evidence" : `names on the entrance subrequest(s) at the canary: ${seen.join(", ")}; outside the allowlist (review): ${outside.join(", ") || "none"}`}`,
  );
  return go;
}

async function main() {
  const start = await echoCheck();
  report.echo.start = start.summary;
  say(`echo start (IPv${FAMILY}): ${start.text}: ${start.problems.length ? start.problems.join("; ") : "agree"}`);
  if (start.problems.length > 0) return problem("egress check at start failed: stopped before contacting the site or the canary");
  R = start.ip;
  SECRETS.push(R);
  if (cfg.testerIp && !same(cfg.testerIp, R)) return problem("PROV_TESTER_IP differs from the echoed address: stopped before contacting the site or the canary");
  const kind = classify(R);
  if (!(kind === "public" || (LOCAL && kind === "documentation"))) return problem("the echoed address is not a public address: stopped before contacting the site or the canary");
  if (same(cfg.F, R) || same(cfg.F2, R)) {
    configError = true;
    return problem("a forged value equals the tester's own address R: choose another; nothing was sent to the site or the canary");
  }
  try {
    // Canary self-check: token accepted, records compared, and whether its CANARY_FORGED_IP is this run's F.
    await canary.reset();
    await canary.mode();
    await canary.expect(R);
    const occurredAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await canary.call("POST", "/v1/entrances", { contract: "entrance.v1", website_id: "idr-provenance-check", ip: cfg.F, entrance_id: `provcheck${letters(13)}`, occurred_at: occurredAt, page_key: "/idr-provenance-canary-check", acquisition: "direct", eligibility: "tsa-1" });
    const res = await canary.results();
    await canary.reset();
    const rec = res.records.find((r) => r.route === "entrances");
    if (!rec || rec.compared !== true || res.expectationSet !== true || rec.ip?.matchesExpected !== false) throw codeError("CANARY_SELF_CHECK");
    canaryKnowsF = rec.ip.matchesForged === true;
  } catch (e) {
    if (/^CANARY_HTTP_40[13]$/.test(codeOf(e))) configError = true;
    return problem(`canary self-check failed (${codeOf(e)}): stopped before contacting the site`);
  }
  report.canaryForgedIsF = canaryKnowsF;
  say(`canary: token accepted, records compared; its CANARY_FORGED_IP ${canaryKnowsF ? `is this run's ${fNames}: the forged flag corroborates` : `is NOT this run's ${fNames}: the forged flag is not informative (forged cases still FAIL on any ip != R)`}`);
  try {
    for (const [i, site] of cfg.sites.entries()) if (!(await runSite(siteLabels[i], site))) break;
  } catch (e) {
    problem(`run stopped (${codeOf(e)}): the remaining cases were not run`);
  }
  const end = await echoCheck();
  report.echo.end = end.summary;
  const moved = end.problems.length === 0 && !same(end.ip, R);
  say(`echo end (IPv${FAMILY}): ${end.text}: ${end.problems.length ? end.problems.join("; ") : moved ? "the address changed during the run" : "agree, and equal to the start"}`);
  if (end.problems.length > 0 || moved) problem("egress check at end failed: the results cannot be tied to R (a FAIL above stays a FAIL; rerun)");
}

try {
  await main();
} catch (e) {
  problem(`run stopped (${codeOf(e)})`);
}

const count = (v) => report.cases.filter((c) => c.verdict === v).length;
const planned = cfg.sites.length * CASES.length;
const overall = configError ? "CONFIG-ERROR" : count("FAIL") > 0 ? "FAIL" : count("HOLD") + count("INCONCLUSIVE") > 0 || report.problems.length > 0 || report.cases.length !== planned ? "HOLD" : "PASS";
say(
  `overall: ${overall} (${report.cases.length} of ${planned} cases run: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("HOLD")} HOLD, ${count("INCONCLUSIVE")} INCONCLUSIVE; ${report.problems.length} run problem(s))${LOCAL ? " [local probe: stand-in servers, no claim about any platform]" : ""}`,
);
if (outFd !== null) {
  const doc = { script: "lovable-provenance-check", version: 1, ranAt: new Date().toISOString(), localProbe: LOCAL, family: FAMILY, networkLabel: cfg.label, entryPoints: siteLabels, overall, ...report, lines };
  try {
    writeSync(outFd, `${redact(JSON.stringify(doc, null, 2))}\n`);
    closeSync(outFd);
  } catch (e) {
    console.error(`could not write the --out file (${codeOf(e)})`);
  }
}
process.exit(overall === "CONFIG-ERROR" ? 2 : overall === "PASS" ? 0 : 1);
