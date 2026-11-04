#!/usr/bin/env node
// lovable-provenance-check.mjs: who controls the visitor IP that the adapter selects on a Lovable-hosted TanStack
// Start site (CHR-119 section 3)? Lovable builds for Cloudflare Workers, and the adapter's trust policy
// {mode:"cloudflare"} reads CF-Connecting-IP. From the network it runs on, this script answers: does the resolver get
// the tester's real address whatever the client sends (provider-controlled), or can a client forge it?
// cf-site-check.mjs cannot answer that: its forged value is an RFC 5737 address, which the adapter silently refuses,
// so a forgery that got through would look exactly like an edge rejection.
//
// Set-up: the site's IDR_RESOLVER_URL points at the canary (canary-sink.mjs; IDR_RESOLVER_TOKEN = the canary token;
// CANARY_FORGED_IP = PROV_FORGED_IP, checked before any case: a mismatch is refused). One run at a time per canary, and
// the canary must be a single replica (its state is in memory and shared by every client). The tester's real public
// address R is read from two or more independent IP-echo services at the start and at the end of the run, over the
// pinned family. Per case: read back any late record of the previous case, reset the canary, tell it R, check that it
// holds no record, send ONE browser-like document navigation (serial, cache-busted), and read back what the entrance
// for PROV_PAGE_PATH carried (booleans only: the canary never stores an address).
//   P1 baseline | P2 CF-Connecting-IP: F | P3a-d X-Forwarded-For / X-Real-IP / True-Client-IP / Forwarded = F
//   P4a, P4b two CF-Connecting-IP lines, (F, F2) and (F2, F) | P5 control CF-Connecting-IP: R
//   P6 = all of these with --family 6, forging the canary's F over IPv6 | P7 runtime evidence from the P1 response
// Verdicts (README, "lovable-provenance-check"): FAIL only when the canary identifies the forged value (its forged
// flag, or a subrequest header carrying it; in any window, since only this script sends F) or a subrequest header
// carries a visitor IP (G4-I8); any other address than R is a HOLD. An edge rejection counts for P2 and P4 only, and only as a 4xx with cf-ray and an allowed
// Cloudflare code (PROV_EDGE_REJECT_CODES, default 1000), after a passing P1 and followed by a fresh passing baseline.
// Overall PASS only when every case on every entry point is provider-controlled and G4-I8 coverage at the canary is
// complete; the first FAIL stops the run.
//
// Environment (names only; nothing has a default that points anywhere):
//   PROV_SITE_URLS     comma list of the site's entry-point origins (https), e.g. the Lovable subdomain and a custom domain
//   PROV_PAGE_PATH     / or lowercase words (a-z, - or _) per segment, a page rendered by the Worker that answers 200 HTML
//   PROV_CANARY_URL    origin of the canary sink
//   PROV_CANARY_TOKEN  the canary bearer token (secret: read -rs, never on the command line; never printed)
//   PROV_FORGED_IP, PROV_FORGED_IP2    forged public, non-personal IPv4 values F, F2 (both families; F = CANARY_FORGED_IP)
//   PROV_FORGED_IP6, PROV_FORGED_IP6B  optional, --family 6 only: IPv6 values, used only when CANARY_FORGED_IP = F6
//   PROV_ECHO_URLS     comma list of 2-4 IP-echo URLs on distinct hosts, answering the caller's address as plain text,
//                      an ip=<address> line or JSON {"ip": ...}; at least one must not be served via Cloudflare
//   PROV_EDGE_REJECT_CODES  optional, default 1000: Cloudflare error codes that may count as an edge rejection
//   PROV_TESTER_IP     optional cross-check of the echoed address (never printed)
// Flags: --family 4|6 (required; every request, echo checks included, is pinned to it and the connected socket's
//   family is verified) --network-label <1-40 letters, digits, spaces, _ or -> (required) --confirm-target <every
//   entry-point host, comma-separated, any order> --dry-run --out <new file> (created with mode 600; an existing path
//   or a symlink is refused) --local-probe (loopback http targets only, self-test) --canary-any-family (reach the canary
//   over either family: its view of the tester plays no part) --delay-ms 2000 (between cases, 0-60000)
//   --poll-timeout-s 20 (wait for an entrance, 1-120) --settle-ms 8000 (after the first entrance, 0-30000; see SETTLE)
//   --request-deadline-s 30 (whole-request deadline, 1-120)
// Safety: a refusal exits 2 with nothing sent. Three configuration errors found after the echo checks also exit 2 before
//   any request to the site: a forged value equal to R, a canary that refuses the token, a canary without F. No IP
//   address, token or host is printed or written (hosts appear as <site1>, <canary>, <echo1>; every line and the --out
//   file pass the redactor). R lives in memory only: it goes to the canary's /_canary/expect and, in the P5 control,
//   to the site as CF-Connecting-IP. Network errors are reported by code only. After the first canary contact the canary
//   is reset when the run ends (PASS, FAIL, HOLD, an error or a configuration error) and on SIGINT or SIGTERM (best
//   effort, about 5 s; verdict INTERRUPTED, exit 130). A delivery still in flight from the site can reach the canary
//   after that reset, and a crash or SIGKILL leaves the canary as it is until its next reset or restart.
// Exit: 0 PASS, 1 FAIL or HOLD, 2 refusal or configuration error, 130 interrupted.
//
//   export PROV_SITE_URLS=https://<project>.lovable.app,https://<custom-domain> PROV_PAGE_PATH=/ \
//          PROV_CANARY_URL=https://<canary-host> PROV_ECHO_URLS=https://<echo-host-a>/<path>,https://<echo-host-b>/<path> \
//          PROV_FORGED_IP=<public-v4-F> PROV_FORGED_IP2=<public-v4-F2>
//   read -rs PROV_CANARY_TOKEN && export PROV_CANARY_TOKEN
//   node lovable-provenance-check.mjs --family 4 --network-label home-fibre \
//        --confirm-target <project>.lovable.app,<custom-domain> --out <private dir>/prov-home-v4.json
import { closeSync, constants, fchmodSync, lstatSync, openSync, writeSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { canonicalIp } from "./canary-sink.mjs";
import { Refusal, confirmTarget, letters, makeRedactor, parseArgs, parseTarget, requireEnv, sleep } from "./lib/common.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36 idr-provenance-check";
const ECHO_UA = "curl/8.5.0 idr-provenance-check";
const FLAGS = new Set(["_", "family", "network-label", "confirm-target", "dry-run", "out", "local-probe", "canary-any-family", "delay-ms", "poll-timeout-s", "settle-ms", "request-deadline-s"]);
const POLL_MS = 300;
// SETTLE: delivery.ts sends at most two attempts per entrance (the second only under waitUntil, after a timeout, a
// network error, 429, 502, 503 or 504). The second starts timeoutMs after the first at worst (config.ts default 5000)
// plus the wait: retryDelayMs (default 250, at most 2000) or a Retry-After of at most 2000 ms (longer is a drop). So a
// retry reaches the canary at most 5000 + 2000 ms after the first attempt; 1000 ms margin gives 8000 ms. A site with
// timeoutMs 10000 needs --settle-ms 13000. Anything later is caught as a late entrance.
const SETTLE_DEFAULT_MS = 8000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
// G4-I8 observability: the forwarding headers the pre-flight sends to the canary with F. One the canary does not see
// carrying F is stripped or overwritten on the way (its hosting edge): a leak in it could not be seen there either.
const WATCHED = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "true-client-ip", "forwarded", "x-client-ip"];

// Edge rejections. 1000 is the only code seen when Cloudflare refused a client-supplied CF-Connecting-IP (earlier probe);
// every other code is INCONCLUSIVE unless the owner lists it. These never prove anything about the forged header and
// are refused even if listed: bans and firewall rules (1006-1010, 1012, 1020), rate limits (1015), Worker errors and
// quotas (1027, 1101, 1102), and any 5xx.
const NEVER_EDGE_CODES = new Set([1006, 1007, 1008, 1009, 1010, 1012, 1015, 1020, 1027, 1101, 1102]);
const CACHE_OK = new Set(["DYNAMIC", "BYPASS", "MISS"]); // a cf-cache-status that means the Worker ran

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

// Copied from packages/tanstack/src/eligibility.ts and collector-path.ts; self-test.mjs pins these lines to the source.
const DEFAULT_COLLECTOR_PATH = "/idr/e";
const ASSET_EXTENSION = /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|txt|xml|json|webmanifest|pdf|zip|gz|mp4|webm|mp3|wav|ogg|wasm)$/i;
const INTERNAL_PREFIXES = ["/_server", "/_build", "/_tsr", "/_nitro", "/_vercel", "/assets", "/.well-known", "/cdn-cgi"];
const INTERNAL_LEADING = /^\/(?:__|_serverfn|sitemap|favicon|robots\.txt)/i;
const API_PREFIXES = ["/api"];
const HEALTH_PREFIXES = ["/health", "/healthz", "/healthcheck", "/ready", "/readyz", "/live", "/livez", "/ping", "/_health"];
const SERVER_FN_PATH = /^\/_server(?:fn)?(?:\/|$)/i;
/** The path rules of isEligible (eligibility.ts) for a plain path, in its order; site include/exclude rules are unknown here. */
function adapterNeverReports(path) {
  const p = path.toLowerCase();
  const prefix = (list) => list.some((x) => p === x || p.startsWith(`${x}/`));
  return (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p) === DEFAULT_COLLECTOR_PATH || SERVER_FN_PATH.test(path) || prefix(API_PREFIXES) || prefix(HEALTH_PREFIXES) || prefix(INTERNAL_PREFIXES) || INTERNAL_LEADING.test(path) || ASSET_EXTENSION.test(path);
}
// Segments the adapter's default page_key mapper leaves unchanged (payload.ts: no digits, no token-like runs), so the
// entrance's page_key is the path itself and the canary records can be matched to it.
const PLAIN_PAGE = /^\/(?:[a-z]+(?:[-_][a-z]+)*(?:\/[a-z]+(?:[-_][a-z]+)*)*\/?)?$/;

// The cases. forged: a FAIL needs the canary to identify F. edge: an edge rejection may count (owner's matrix: P2, P4).
// refusal: a 2xx page without an entrance may count (the adapter refuses repeated values).
const fwd = (F) => (isIP(F) === 6 ? `for="[${F}]"` : `for=${F}`);
const CASES = [
  { id: "P1", forged: false, headers: () => ({}) },
  { id: "P2", forged: true, edge: true, headers: (v) => ({ "cf-connecting-ip": v.F }) },
  { id: "P3a", forged: true, headers: (v) => ({ "x-forwarded-for": v.F }) },
  { id: "P3b", forged: true, headers: (v) => ({ "x-real-ip": v.F }) },
  { id: "P3c", forged: true, headers: (v) => ({ "true-client-ip": v.F }) },
  { id: "P3d", forged: true, headers: (v) => ({ forwarded: fwd(v.F) }) },
  { id: "P4a", forged: true, edge: true, refusal: true, headers: (v) => ({ "cf-connecting-ip": [v.F, v.F2] }) }, // separate raw lines
  { id: "P4b", forged: true, edge: true, refusal: true, headers: (v) => ({ "cf-connecting-ip": [v.F2, v.F] }) },
  { id: "P5", forged: false, headers: (v) => ({ "cf-connecting-ip": v.R }) },
];
const REBASE = { id: "rebaseline", forged: false, headers: () => ({}) };

const args = parseArgs(process.argv.slice(2));
const LOCAL = args["local-probe"] === true;
const env = process.env;

function checkIpInput(name, value, family) {
  if (/[%[\]\s]/.test(value)) throw new Refusal(`${name} must be a plain address: no zone id (%), brackets or spaces`);
  if (isIP(value) !== family || classify(value) === "malformed") throw new Refusal(`${name} must be a plain IPv${family} address`);
  return value;
}
function checkForged(name, value, family) {
  checkIpInput(name, value, family);
  const kind = classify(value);
  if (kind === "documentation" && !LOCAL) {
    throw new Refusal(
      `${name} is in a documentation range (RFC 5737, RFC 3849, RFC 9637). The adapter refuses those addresses, so a forged value that got through would be dropped exactly like an edge rejection and the test could not tell them apart: use a public, non-personal address (for example a public DNS anycast address)`,
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

function edgeCodes() {
  const list = (env.PROV_EDGE_REJECT_CODES ?? "1000").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0 || list.some((s) => !/^\d{3,5}$/.test(s))) throw new Refusal("PROV_EDGE_REJECT_CODES must be a comma list of Cloudflare error codes");
  const bad = list.map(Number).filter((c) => NEVER_EDGE_CODES.has(c) || c < 1000 || c > 1999);
  if (bad.length > 0) {
    throw new Refusal(
      `PROV_EDGE_REJECT_CODES lists ${bad.join(", ")}: bans and firewall rules (1006-1010, 1012, 1020), rate limits (1015), Worker errors and quotas (1027, 1101, 1102) and any 5xx never show that the forged header was refused, and only 1xxx codes may be listed`,
    );
  }
  return new Set(list.map(Number));
}

function loadConfig() {
  const unknown = Object.keys(args).filter((k) => !FLAGS.has(k));
  if (unknown.length > 0 || args._.length > 0) throw new Refusal("unknown or positional argument(s); see the header of this script for the flags");
  for (const f of ["dry-run", "local-probe", "canary-any-family"]) if (args[f] !== undefined && args[f] !== true) throw new Refusal(`--${f} takes no value`);
  if (args.family !== "4" && args.family !== "6") throw new Refusal("--family 4 or --family 6 is required");
  const family = Number(args.family);
  const req = requireEnv(env, ["PROV_SITE_URLS", "PROV_PAGE_PATH", "PROV_CANARY_URL", "PROV_CANARY_TOKEN", "PROV_ECHO_URLS", "PROV_FORGED_IP", "PROV_FORGED_IP2"]);
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
  if (LOCAL && [...sites, canary, ...echo].some((u) => u.protocol !== "http:" || !LOOPBACK.has(u.hostname))) throw new Refusal("--local-probe accepts loopback http targets only (sites, canary and echo URLs)");
  const hosts = [...sites, canary, ...echo].map((u) => u.host.toLowerCase());
  if (new Set(hosts).size !== hosts.length) throw new Refusal("the entry points, the canary and the echo URLs must all be on distinct hosts");
  confirmTargets(sites.map((u) => u.host), args["confirm-target"]);
  if (!/^[\x21-\x7e]{32,}$/.test(req.PROV_CANARY_TOKEN)) throw new Refusal("PROV_CANARY_TOKEN must be at least 32 printable characters");
  const pagePath = req.PROV_PAGE_PATH;
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(pagePath) || pagePath.includes("//")) throw new Refusal("PROV_PAGE_PATH must be a plain path starting with / (no query, no placeholder)");
  if (adapterNeverReports(pagePath)) throw new Refusal("PROV_PAGE_PATH is a path the adapter never reports (API, internal, health, asset or collector path)");
  if (!PLAIN_PAGE.test(pagePath)) throw new Refusal("PROV_PAGE_PATH must be / or lowercase words (a-z joined by - or _) per segment, so the entrance's page_key equals the path");
  const F = checkForged("PROV_FORGED_IP", req.PROV_FORGED_IP, 4);
  const F2 = checkForged("PROV_FORGED_IP2", req.PROV_FORGED_IP2, 4);
  if (same(F, F2)) throw new Refusal("PROV_FORGED_IP and PROV_FORGED_IP2 must differ");
  let F6 = null;
  let F6b = null;
  if (family === 6 && (env.PROV_FORGED_IP6 || env.PROV_FORGED_IP6B)) {
    const v6 = requireEnv(env, ["PROV_FORGED_IP6", "PROV_FORGED_IP6B"]);
    F6 = checkForged("PROV_FORGED_IP6", v6.PROV_FORGED_IP6, 6);
    F6b = checkForged("PROV_FORGED_IP6B", v6.PROV_FORGED_IP6B, 6);
    if (same(F6, F6b)) throw new Refusal("PROV_FORGED_IP6 and PROV_FORGED_IP6B must differ");
  }
  let testerIp = null;
  if (typeof env.PROV_TESTER_IP === "string" && env.PROV_TESTER_IP.trim() !== "") {
    testerIp = checkIpInput("PROV_TESTER_IP", env.PROV_TESTER_IP.trim(), family);
    if ([F, F2, F6, F6b].some((f) => f && same(f, testerIp))) throw new Refusal("a forged value equals PROV_TESTER_IP: forged values must not be the tester's own address");
  }
  const num = (name, def, min, max) => {
    if (args[name] !== undefined && typeof args[name] !== "string") throw new Refusal(`--${name} needs a value`);
    const v = args[name] === undefined ? def : Number(args[name]);
    if (!Number.isInteger(v) || v < min || v > max) throw new Refusal(`--${name} must be an integer from ${min} to ${max}`);
    return v;
  };
  if (args.out !== undefined && (typeof args.out !== "string" || args.out.trim() === "")) throw new Refusal("--out needs a file name");
  if (typeof args.out === "string") {
    let exists = true;
    try {
      lstatSync(args.out);
    } catch (e) {
      exists = e?.code !== "ENOENT";
    }
    if (exists) throw new Refusal("--out must name a new file: an existing path or a symlink is refused (earlier evidence is never overwritten)");
  }
  return {
    family, label, sites, canary, echo, pagePath, F, F2, F6, F6b, testerIp,
    pageKey: pagePath.length > 1 && pagePath.endsWith("/") ? pagePath.slice(0, -1) : pagePath,
    token: req.PROV_CANARY_TOKEN,
    edgeCodes: edgeCodes(),
    canaryAnyFamily: args["canary-any-family"] === true,
    delayMs: num("delay-ms", 2000, 0, 60_000),
    pollMs: num("poll-timeout-s", 20, 1, 120) * 1000,
    settleMs: num("settle-ms", SETTLE_DEFAULT_MS, 0, 30_000),
    deadlineMs: num("request-deadline-s", 30, 1, 120) * 1000,
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
const SECRETS = [cfg.token, cfg.F, cfg.F2, cfg.F6, cfg.F6b, cfg.testerIp]; // R and every echo answer are added when learned
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
const prefix = (site) => `${site} net=${cfg.label} IPv${FAMILY}`;

if (args["dry-run"] === true) {
  say("dry-run: configuration valid; nothing was sent");
  say(
    `plan: network=${cfg.label} family=IPv${FAMILY} local-probe=${LOCAL}; entry points ${siteLabels.join(", ")}; per entry point, serially: ${CASES.map((c) => ID(c.id)).join(", ")}, then ${ID("P7")} (runtime evidence) and the header-name summary; forged value: the canary's (F${FAMILY === 6 ? ", or F6 when the canary holds F6" : ""}); edge-rejection codes ${[...cfg.edgeCodes].join(",")}; echo ${cfg.echo.map((_, i) => `<echo${i + 1}>`).join(", ")} at start and end; canary <canary>${cfg.canaryAnyFamily ? " (either family)" : ""}; poll timeout ${cfg.pollMs / 1000} s, settle ${cfg.settleMs} ms, delay ${cfg.delayMs} ms, request deadline ${cfg.deadlineMs / 1000} s`,
  );
  process.exit(0);
}

// The --out file is created (mode 600, O_EXCL, O_NOFOLLOW) before anything is sent: a bad path is a refusal.
let outFd = null;
if (cfg.out) {
  try {
    outFd = openSync(cfg.out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(outFd, 0o600);
  } catch (e) {
    console.error(`refused: cannot create the --out file (${codeOf(e)}): it must be a new path, not an existing file or a symlink; nothing was sent`);
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
 * and discarded like a browser would (no early disconnect), up to a hard cap. The whole request, slow bodies included,
 * ends at the run's deadline (EDEADLINE).
 */
function pinnedRequest(url, { method = "GET", headers = {}, body, maxBody = 65_536, anyFamily = false } = {}) {
  const mod = url.protocol === "https:" ? https : http;
  const h = { ...headers };
  if (typeof body === "string") h["content-length"] = Buffer.byteLength(body);
  const pin = anyFamily ? {} : { family: FAMILY, autoSelectFamily: false };
  const hardCap = Math.max(maxBody, 16 << 20);
  return new Promise((resolve, reject) => {
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      req.destroy(codeError("EDEADLINE"));
    }, cfg.deadlineMs);
    const ok = (v) => (clearTimeout(timer), resolve(v));
    const fail = (e) => (clearTimeout(timer), reject(late ? codeError("EDEADLINE") : e));
    const req = mod.request(url, { method, headers: h, agent: false, timeout: Math.min(20_000, cfg.deadlineMs), ...pin }, (res) => {
      if (!anyFamily && res.socket?.remoteFamily !== `IPv${FAMILY}`) {
        res.destroy();
        return fail(codeError("EFAMILY"));
      }
      const parts = [];
      let kept = 0;
      let total = 0;
      const done = () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString("utf8") });
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
      res.on("error", fail);
      res.on("close", () => (res.complete ? done() : fail(codeError("ECONNRESET"))));
    });
    req.on("timeout", () => req.destroy(codeError("ETIMEDOUT")));
    req.on("error", fail);
    req.end(body);
  });
}

let canaryContacted = false;
let canaryInFlight = 0;
let interrupted = false; // set by SIGINT/SIGTERM: from then on only the signal handler's final reset reaches the canary
const canary = {
  async call(method, path, body, extra = {}, { final = false } = {}) {
    if (interrupted && !final) throw codeError("INTERRUPTED");
    canaryContacted = true;
    canaryInFlight++;
    let r;
    try {
      r = await pinnedRequest(new URL(path, cfg.canary), {
        method,
        headers: { ...extra, authorization: `Bearer ${cfg.token}`, "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        maxBody: 16 << 20,
        anyFamily: cfg.canaryAnyFamily,
      });
    } finally {
      canaryInFlight--;
    }
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
    if (!r || r.contract !== "idr-staging-canary.v1" || !Array.isArray(r.records) || typeof r.counts !== "object") throw codeError("CANARY_SHAPE");
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
      const r = await pinnedRequest(url, { headers: { accept: "text/plain, application/json;q=0.9, */*;q=0.5", "user-agent": ECHO_UA }, maxBody: 4096 });
      const ip = r.status === 200 ? echoAddress(r.body) : null;
      if (ip) SECRETS.push(ip);
      const ok = ip !== null && isIP(ip) === FAMILY && canonicalIp(ip) !== null;
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

/** The numeric Cloudflare error code in a non-2xx body (plain `error code: N`, cf-error-code, or the title), or null. */
function cfErrorCode(resp) {
  if (!resp || (resp.status >= 200 && resp.status < 300)) return null;
  const m = /error code:\s*(\d{3,5})\b/i.exec(resp.body) ?? /cf-error-code[^>]*>\s*(\d{3,5})\s*</i.exec(resp.body) ?? /<title>[^<]*\berror\s+(\d{4,5})\b/i.exec(resp.body);
  return m ? Number(m[1]) : null;
}
const cacheStatus = (resp) => (resp && /^[A-Za-z]{1,16}$/.test(String(resp.headers["cf-cache-status"] ?? "")) ? resp.headers["cf-cache-status"].toUpperCase() : resp?.headers["cf-cache-status"] !== undefined ? "OTHER" : null);

/** Whether a non-2xx answer qualifies as an edge rejection: 4xx (not 429), cf-ray, and an allowed Cloudflare code. */
function edgeRejection(resp) {
  const code = cfErrorCode(resp);
  const s = resp.status;
  if (s < 400 || s > 499) return { ok: false, why: `HTTP ${s} is not a 4xx` };
  if (s === 429) return { ok: false, why: "HTTP 429 (rate limited) never counts" };
  if (typeof resp.headers["cf-ray"] !== "string") return { ok: false, why: "no cf-ray header" };
  if (code === null) return { ok: false, why: "no Cloudflare error code" };
  if (!cfg.edgeCodes.has(code)) return { ok: false, why: `Cloudflare error ${code} is not in PROV_EDGE_REJECT_CODES` };
  return { ok: true, why: `HTTP ${s}, Cloudflare error ${code}` };
}

function runtimeEvidence(resp) {
  const ray = resp?.headers["cf-ray"];
  return {
    cfRayPresent: typeof ray === "string",
    serverCloudflare: /^cloudflare$/i.test(String(resp?.headers.server ?? "")),
    cfRay: typeof ray === "string" ? (/^[0-9a-f]{16}-[A-Z]{3}$/.test(ray) ? ray : "unexpected-format") : null,
  };
}

let fx = null; // the forged values of this run: the canary's value F (or F6) and its partner, set by the pre-flight
const uniq = (xs) => [...new Set(xs)].sort().join(", ");

/**
 * F at the canary, in any window but the pre-flight (whose synthetic entrance the reset after it clears): only this
 * script sends F, and only to the site, so F reaching the canary means the site accepted a forged value.
 */
function forgedSeen(recs) {
  if (recs.some((r) => r.ip?.matchesForged === true)) return `the canary identified ${fx.name} as the entrance ip: a client-forged value was selected`;
  const carried = uniq(recs.flatMap((r) => r.headersWithForgedIp ?? []));
  return carried ? `header(s) ${carried} on the subrequest carry ${fx.name}: a client-supplied value reached the resolver` : null;
}

/**
 * The verdict for one case: [verdict, reason, basis]. PENDING means a PASS that still needs a fresh baseline right
 * after it (an edge rejection, or P4 without an entrance). Only records for PROV_PAGE_PATH count for the case.
 */
function evaluate(c, ctx, p1Passed) {
  const { resp, errCode, res } = ctx;
  const recs = res.records;
  const id = c === REBASE ? "the re-baseline" : ID(c.id);
  const leak = uniq(recs.flatMap((r) => r.headersWithClientIp ?? []));
  if (leak) return ["FAIL", `G4-I8: header(s) ${leak} on the subrequest carry a visitor IP`];
  const hit = forgedSeen(recs); // clean cases, re-baselines and the zero-record check included
  if (hit) return ["FAIL", hit];
  if (ctx.notSent) return ["INCONCLUSIVE", `foreign traffic: ${recs.length} record(s) at the canary right after the reset${res.expectationSet === true ? "" : ", and no expectation"}; the request was not sent`];
  const ours = recs.filter((r) => r.route === "entrances" && r.pageKey === cfg.pageKey);
  const n = new Set(ours.map((r) => r.id)).size;
  const ok2xx = resp !== null && resp.status >= 200 && resp.status < 300;
  const notes = [];
  if (ours.some((r) => r.ip?.present === true && r.ip.matchesExpected !== true)) notes.push(c.forged ? `unexpected address in ${id}: neither R nor ${fx.name} (the canary cannot name it)` : `entrance ip != R in ${id}: wrong provenance, investigate`);
  if (ours.some((r) => r.ip?.present !== true)) notes.push("an entrance without an ip field");
  if (n > 1) notes.push(`${n} entrances for one request`);
  if (recs.some((r) => r.compared !== true)) notes.push("record(s) the canary could not compare");
  if (ours.some((r) => r.bodyContainsClientIp === true)) notes.push("a visitor IP elsewhere in the entrance body");
  if (res.expectationSet !== true) notes.push("the canary lost the expected IP (reset by another client?)");
  if (n > 0 && !ok2xx) notes.push(`an entrance although the site answered ${resp ? `HTTP ${resp.status}` : errCode}`);
  const foreign = recs.length - ours.length;
  if (foreign > 0) return ["INCONCLUSIVE", [`foreign traffic: ${foreign} record(s) for another page or route during the case`, ...notes].join("; ")];
  if (notes.length > 0) return ["HOLD", notes.join("; ")];
  const retries = ours.length - n;
  if (n === 1) return ["PASS", `ip == R${retries > 0 ? ` (${retries} retry of the same entrance_id)` : ""}`, "entrance"];
  const diag = [res.counts.authFailed > 0 ? `canary refused ${res.counts.authFailed} unauthenticated request(s): check the site's resolver token` : "", res.counts.other > 0 ? `${res.counts.other} request(s) to unknown canary paths` : ""].filter(Boolean);
  const why = (s) => [s, ...diag].join("; ");
  if (resp === null) return ["INCONCLUSIVE", why(`no answer from the site (${errCode})`)];
  if (ok2xx) {
    const cache = cacheStatus(resp);
    const ran = cache === null || CACHE_OK.has(cache);
    if (!ran) return ["INCONCLUSIVE", why(`2xx page, no entrance, cf-cache-status ${cache}: possibly served without the Worker`)];
    if (!c.refusal) return ["INCONCLUSIVE", why(`2xx page but no entrance within ${cfg.pollMs / 1000} s`)];
    if (!p1Passed) return ["INCONCLUSIVE", why("2xx page, no entrance, and P1 did not pass on this entry point")];
    return ["PENDING", "2xx page, no entrance: the repeated values were refused (adapter level)", "adapter_refusal"];
  }
  const edge = edgeRejection(resp);
  const code = cfErrorCode(resp);
  const seen = `HTTP ${resp.status}${code !== null ? `, Cloudflare error ${code}` : ""}`;
  if (c === REBASE) return ["INCONCLUSIVE", why(`${seen}: the clean re-baseline was refused as well`)];
  if (!c.edge) return ["INCONCLUSIVE", why(`${seen}: an edge rejection does not count for ${id} (owner's matrix: P2 and P4 only)`)];
  if (!edge.ok) return ["INCONCLUSIVE", why(`${seen}: not a qualifying edge rejection (${edge.why})`)];
  if (!p1Passed) return ["INCONCLUSIVE", why(`edge rejection (${edge.why}), and P1 did not pass on this entry point`)];
  return ["PENDING", `edge rejection (${edge.why})`, "edge_rejection"];
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

const report = { cases: [], runtime: {}, headerNames: {}, echo: {}, g4i8Coverage: null, notes: [], problems: [], warnings: [], stop: false };
let R = null;
let configError = false;
let last = null; // the last scored probe: { entry, c, count }, for the late-entrance check
const RANK = { PASS: 1, PENDING: 1, INCONCLUSIVE: 2, HOLD: 3, FAIL: 4 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);
const problem = (text) => {
  report.problems.push(text);
  say(`problem: ${text}`);
};
const summarize = (records) =>
  records.map((x) => ({
    route: x.route, pageKeyMatches: x.pageKey === cfg.pageKey, attempt: x.attempt, ipPresent: x.ip?.present, matchesExpected: x.ip?.matchesExpected, matchesForged: x.ip?.matchesForged,
    compared: x.compared, headerNames: x.headerNames, headersWithClientIp: x.headersWithClientIp, headersWithForgedIp: x.headersWithForgedIp,
  }));

/**
 * Records that reached the canary for the last scored probe after it was scored. A late record that identifies F or
 * carries a visitor IP is a FAIL, whatever the case; any other late record (or a canary reset by someone else) makes
 * the case a HOLD.
 */
async function lateCheck() {
  if (!last) return;
  const { entry, count } = last;
  last = null;
  const res = await canary.results();
  const extra = res.records.slice(count);
  let v = null;
  let why = "";
  if (res.records.length < count || res.expectationSet !== true) [v, why] = ["HOLD", "the canary was reset by another client after the case was scored (one run at a time per canary)"];
  else if (extra.length > 0) {
    const leak = uniq(extra.flatMap((r) => r.headersWithClientIp ?? []));
    const hit = forgedSeen(extra); // after any case, clean ones and re-baselines included
    if (leak) [v, why] = ["FAIL", `late record: G4-I8, header(s) ${leak} carry a visitor IP`];
    else if (hit) [v, why] = ["FAIL", `late record: ${hit}`];
    else [v, why] = ["HOLD", `late entrance: ${extra.length} record(s) arrived after the case was scored`];
  }
  if (!v) return;
  entry.late = { verdict: v, reason: why, records: summarize(extra) };
  if (entry.verdict !== "PENDING") entry.verdict = worst(entry.verdict, v);
  if (v === "FAIL") report.stop = true;
  say(`${prefix(entry.site)} ${entry.id} late => ${v}: ${why}`);
}

/** One probe: late check, reset, expectation, zero-record check, one navigation, then the canary's records. */
async function probe(site, c) {
  await lateCheck();
  if (report.stop) return null;
  await canary.reset();
  await canary.mode();
  await canary.expect(R);
  const pre = await canary.results();
  if (pre.records.length > 0 || pre.expectationSet !== true) return { notSent: true, resp: null, errCode: "NOT_SENT", res: pre };
  const url = new URL(cfg.pagePath, site);
  url.searchParams.set("idrprov", letters(12)); // cache-busting nonce (the adapter keeps the path only)
  let resp = null;
  let errCode = null;
  try {
    resp = await pinnedRequest(url, { headers: browserHeaders(c.headers({ F: fx.F, F2: fx.F2, R })) });
  } catch (e) {
    errCode = codeOf(e);
  }
  return { resp, errCode, res: await collect() };
}

const httpText = (ctx) => (ctx.resp ? ctx.resp.status : ctx.notSent ? "not-sent" : `error:${ctx.errCode}`);
const entrancesOf = (ctx) => new Set(ctx.res.records.filter((r) => r.route === "entrances" && r.pageKey === cfg.pageKey).map((r) => r.id)).size;

async function runCase(label, site, c, p1Passed) {
  const ctx = await probe(site, c);
  if (!ctx) return null;
  // Read after probe(): its late check may just have turned P1 into a HOLD, which retracts the P1 gate.
  const [v, reason, basis] = evaluate(c, ctx, p1Passed());
  const entry = { site: label, id: ID(c.id), forged: c.forged === true, http: httpText(ctx), cfError: cfErrorCode(ctx.resp), cfCacheStatus: cacheStatus(ctx.resp), entrances: entrancesOf(ctx), verdict: v, reason, basis: null, records: summarize(ctx.res.records) };
  report.cases.push(entry);
  last = { entry, c, count: ctx.res.records.length };
  let verdict = v;
  let text = reason;
  if (v === "PENDING") {
    // The rejection (or the missing entrance) counts only if the pipeline still delivers a clean baseline right after.
    const rb = await probe(site, REBASE);
    const [rv, rr] = rb ? evaluate(REBASE, rb, true) : ["INCONCLUSIVE", "not run"];
    entry.rebaseline = rb ? { http: httpText(rb), entrances: entrancesOf(rb), verdict: rv, reason: rr, records: summarize(rb.res.records) } : null;
    if (rb) last = { entry, c: REBASE, count: rb.res.records.length };
    if (rv === "PASS") [verdict, text, entry.basis] = ["PASS", `${reason}; the re-baseline right after it passed (ip == R)`, basis];
    else if (rv === "FAIL") [verdict, text] = ["FAIL", `re-baseline after ${reason}: ${rr}`];
    else [verdict, text] = ["INCONCLUSIVE", `${reason}, but the re-baseline right after it did not pass (${rv}: ${rr})`];
  }
  entry.verdict = entry.late ? worst(verdict, entry.late.verdict) : verdict;
  entry.reason = text;
  if (entry.verdict === "FAIL") report.stop = true;
  const tag = entry.basis === "edge_rejection" ? " (by edge rejection)" : entry.basis === "adapter_refusal" ? " (by adapter refusal)" : "";
  const cache = entry.cfCacheStatus ? ` [cf-cache-status ${entry.cfCacheStatus}]` : "";
  say(`${prefix(label)} ${entry.id} http=${entry.http} cf-error=${entry.cfError ?? "-"} entrances=${entry.entrances} => ${entry.verdict}${tag}: ${text}${entry.late ? `; ${entry.late.reason}` : ""}${cache}`);
  if (c.id === "P1") {
    const ev = runtimeEvidence(ctx.resp);
    report.runtime[label] = ev;
    say(`${prefix(label)} ${ID("P7")} runtime => INFO: cf-ray present=${ev.cfRayPresent} value=${ev.cfRay ?? "-"}; server cloudflare=${ev.serverCloudflare} (supporting evidence only, not a provenance proof)`);
  }
  return entry;
}

/** Runs every case on one entry point, until a FAIL. */
async function runSite(label, site) {
  let p1 = null;
  const start = report.cases.length;
  for (const c of CASES) {
    if (report.stop) break;
    const entry = await runCase(label, site, c, () => p1?.verdict === "PASS");
    if (c.id === "P1") p1 = entry;
    if (report.stop) break;
    if (cfg.delayMs > 0) await sleep(cfg.delayMs);
  }
  const mine = report.cases.slice(start).flatMap((e) => [...e.records, ...(e.rebaseline?.records ?? [])]).filter((r) => r.route === "entrances" && r.pageKeyMatches);
  const seen = [...new Set(mine.flatMap((r) => r.headerNames ?? []))].sort();
  const outside = seen.filter((n) => !allowedName(n));
  report.headerNames[label] = { seen, outsideAllowlist: outside, entranceRecords: mine.length };
  say(`${prefix(label)} headers => INFO: ${mine.length === 0 ? "no entrance reached the canary: no header evidence" : `names on the entrance subrequest(s) at the canary: ${seen.join(", ")}; outside the allowlist (review): ${outside.join(", ") || "none"}`}`);
}

/** Posts one synthetic entrance carrying `F` (in the body and in every watched header) to learn what the canary sees. */
async function canaryProbe(F) {
  await canary.reset();
  await canary.mode();
  await canary.expect(R);
  const headers = Object.fromEntries(WATCHED.map((n) => [n, n === "forwarded" ? fwd(F) : F]));
  const occurredAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await canary.call("POST", "/v1/entrances", { contract: "entrance.v1", website_id: "idr-provenance-check", ip: F, entrance_id: `provcheck${letters(13)}`, occurred_at: occurredAt, page_key: "/idr-provenance-canary-check", acquisition: "direct", eligibility: "tsa-1" }, headers);
  const res = await canary.results();
  await canary.reset();
  const rec = res.records.find((r) => r.route === "entrances" && r.pageKey === "/idr-provenance-canary-check");
  if (!rec || rec.compared !== true || res.expectationSet !== true || rec.ip?.matchesExpected !== false) throw codeError("CANARY_SELF_CHECK");
  return { knows: rec.ip.matchesForged === true, observed: WATCHED.filter((n) => (rec.headersWithForgedIp ?? []).includes(n)) };
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
  if ([cfg.F, cfg.F2, cfg.F6, cfg.F6b].some((f) => f && same(f, R))) {
    configError = true;
    return problem("a forged value equals the tester's own address R: choose another; nothing was sent to the site or the canary");
  }
  let pre;
  try {
    await canary.reset(); // the token goes out first; R only after the answer has the canary's shape
    await canary.results();
    pre = await canaryProbe(cfg.F);
    if (pre.knows) {
      fx = { F: cfg.F, F2: cfg.F2, name: "F" };
      if (cfg.F6) report.notes.push("PROV_FORGED_IP6 is not the canary's CANARY_FORGED_IP: the F6 cases were skipped (an IPv6 forged literal needs CANARY_FORGED_IP = F6, a canary redeploy); this run forges F over IPv6");
    } else if (cfg.F6) {
      pre = await canaryProbe(cfg.F6);
      if (pre.knows) {
        fx = { F: cfg.F6, F2: cfg.F6b, name: "F6" };
        report.notes.push("the canary holds F6: this run forges F6 and F6b; the cases forging F over IPv6 were skipped (the canary cannot identify F)");
      }
    }
  } catch (e) {
    if (/^CANARY_HTTP_40[13]$/.test(codeOf(e))) configError = true;
    return problem(`canary self-check failed (${codeOf(e)}): stopped before contacting the site`);
  }
  if (!fx) {
    configError = true;
    return problem(`the canary's CANARY_FORGED_IP is not PROV_FORGED_IP${cfg.F6 ? " nor PROV_FORGED_IP6" : ""}: a forged value it cannot identify can only give HOLD; set CANARY_FORGED_IP (a canary redeploy) and rerun. Stopped before contacting the site`);
  }
  for (const n of report.notes) say(`note: ${n}`);
  const blind = WATCHED.filter((n) => !pre.observed.includes(n));
  report.g4i8Coverage = { observed: pre.observed, blind };
  say(`canary: token accepted, records compared, its CANARY_FORGED_IP is this run's ${fx.name}; G4-I8 observability: ${fx.name} seen at the canary in ${pre.observed.join(", ") || "none"}${blind.length ? `; blind spots: ${blind.join(", ")}` : "; no blind spot"}`);
  if (blind.length > 0) problem(`G4-I8 coverage incomplete: ${blind.join(", ")} (stripped or overwritten before the canary: a visitor IP in these headers could not be seen)`);
  try {
    for (const [i, site] of cfg.sites.entries()) {
      if (report.stop) break;
      await runSite(siteLabels[i], site);
    }
  } catch (e) {
    problem(`run stopped (${codeOf(e)}): the remaining cases were not run`);
  }
  const end = await echoCheck();
  report.echo.end = end.summary;
  const moved = end.problems.length === 0 && !same(end.ip, R);
  say(`echo end (IPv${FAMILY}): ${end.text}: ${end.problems.length ? end.problems.join("; ") : moved ? "the address changed during the run" : "agree, and equal to the start"}`);
  if (end.problems.length > 0 || moved) problem("egress check at end failed: the results cannot be tied to R (a FAIL above stays a FAIL; rerun)");
}

const planned = cfg.sites.length * CASES.length;
const count = (v) => report.cases.filter((c) => c.verdict === v).length;
const byBasis = (b) => report.cases.filter((c) => c.verdict === "PASS" && c.basis === b).length;
const tally = () => ({ pass: count("PASS"), pass_by_edge_rejection: byBasis("edge_rejection"), pass_by_adapter_refusal: byBasis("adapter_refusal"), fail: count("FAIL"), hold: count("HOLD"), inconclusive: count("INCONCLUSIVE") });
function writeOut(overall) {
  if (outFd === null) return;
  const fd = outFd;
  outFd = null;
  const { stop, ...rest } = report;
  void stop;
  const doc = { script: "lovable-provenance-check", version: 2, ranAt: new Date().toISOString(), localProbe: LOCAL, family: FAMILY, networkLabel: cfg.label, forgedValue: fx?.name ?? null, edgeRejectCodes: [...cfg.edgeCodes], entryPoints: siteLabels, overall, summary: tally(), ...rest, lines };
  try {
    writeSync(fd, `${redact(JSON.stringify(doc, null, 2))}\n`);
    closeSync(fd);
  } catch (e) {
    console.error(`could not write the --out file (${codeOf(e)})`);
  }
}

/**
 * SIGINT / SIGTERM: no new canary call is made; once the calls in flight settle (at most 2 s), the canary is reset
 * (best effort, at most 3 s) so it does not keep R; the --out file gets the verdict INTERRUPTED (never PASS); exit 130.
 * A second signal leaves at once.
 */
async function onSignal(sig) {
  if (interrupted) process.exit(130);
  interrupted = true;
  let reset = "the canary was not contacted";
  if (canaryContacted) {
    const t0 = Date.now();
    while (canaryInFlight > 0 && Date.now() - t0 < 2000) await sleep(50);
    try {
      await Promise.race([canary.call("POST", "/_canary/reset", {}, {}, { final: true }), sleep(3000).then(() => Promise.reject(codeError("ETIMEDOUT")))]);
      reset = "the canary was reset (a delivery still in flight from the site can reach it after this)";
    } catch (e) {
      reset = `the canary reset failed (${codeOf(e)}): it may hold R until its next reset or restart`;
    }
  }
  say(`interrupted (${sig}): ${report.cases.length} of ${planned} cases run; ${reset}`);
  say("overall: INTERRUPTED (no verdict)");
  writeOut("INTERRUPTED");
  process.exit(130);
}
process.on("SIGINT", () => void onSignal("SIGINT"));
process.on("SIGTERM", () => void onSignal("SIGTERM"));
const parkIfInterrupted = () => (interrupted ? new Promise(() => {}) : undefined); // the handler finishes and exits

try {
  await main();
} catch (e) {
  problem(`run stopped (${codeOf(e)})`);
}
await parkIfInterrupted();
if (canaryContacted) {
  // Every normal end after the first canary contact (signals: onSignal): read back late records, then leave nothing
  // (R included) behind.
  try {
    await lateCheck();
  } catch (e) {
    report.warnings.push(`late-entrance check at the end failed (${codeOf(e)})`);
  }
  try {
    await canary.reset();
  } catch (e) {
    report.warnings.push(`final canary reset failed (${codeOf(e)}): the canary may hold R until its next reset or restart`);
  }
  for (const w of report.warnings) say(`warning: ${w}`);
}
await parkIfInterrupted();

const overall = configError ? "CONFIG-ERROR" : count("FAIL") > 0 ? "FAIL" : count("PASS") !== planned || report.problems.length > 0 ? "HOLD" : "PASS";
const summary = tally();
say(
  `overall: ${overall} (${report.cases.length} of ${planned} cases run: ${summary.pass} PASS [${summary.pass_by_edge_rejection} by edge rejection, ${summary.pass_by_adapter_refusal} by adapter refusal], ${summary.fail} FAIL, ${summary.hold} HOLD, ${summary.inconclusive} INCONCLUSIVE; ${report.problems.length} run problem(s))${LOCAL ? " [local probe: stand-in servers, no claim about any platform]" : ""}`,
);
writeOut(overall);
process.exit(overall === "CONFIG-ERROR" ? 2 : overall === "PASS" ? 0 : 1);
