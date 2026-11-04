// Self-test of the staging acceptance scripts. Needs no credential and contacts nothing but 127.0.0.1.
//   node --test docs/staging/acceptance/self-test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { containsIp, createCanary, headersContaining, headersContainingAny, ipLiterals, loadConfig, scrubIps as canaryScrub } from "./canary-sink.mjs";
import { Refusal, confirmTarget, hostInZone, makeRedactor, parseTarget, percentile, rawRequest, scrubIps } from "./lib/common.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = "0123456789abcdef0123456789abcdef"; // the repository's allowlisted synthetic pattern
const IP = "198.51.100.7"; // RFC 5737
const FORGED = "203.0.113.9"; // RFC 5737

test("parseTarget refuses http, placeholders, credentials, queries and fragments", () => {
  assert.throws(() => parseTarget("X", "http://staging.example.com"), Refusal);
  assert.throws(() => parseTarget("X", "https://<site-host>"), Refusal);
  assert.throws(() => parseTarget("X", "https://user:pw@staging.example.com"), Refusal);
  assert.throws(() => parseTarget("X", "https://staging.example.com/?a=1"), Refusal);
  assert.throws(() => parseTarget("X", "https://staging.example.com/#x"), Refusal);
  assert.throws(() => parseTarget("X", "not a url"), Refusal);
  assert.throws(() => parseTarget("X", "http://staging.example.com", { allowLoopbackHttp: true }), Refusal);
  assert.equal(parseTarget("X", "http://127.0.0.1:8799", { allowLoopbackHttp: true }).port, "8799");
  assert.equal(parseTarget("X", "https://staging.example.com").host, "staging.example.com");
});

test("confirmTarget and hostInZone", () => {
  assert.throws(() => confirmTarget("staging.example.com", ""), Refusal);
  assert.throws(() => confirmTarget("staging.example.com", "other.example.com"), Refusal);
  confirmTarget("staging.example.com", "STAGING.example.com");
  assert.equal(hostInZone("example.com", "example.com"), true);
  assert.equal(hostInZone("api.resolver.example.com", "example.com"), true);
  assert.equal(hostInZone("notexample.com", "example.com"), false);
  assert.equal(hostInZone("resolver.example.net", "example.com"), false);
  assert.equal(hostInZone("example.com.", "example.com"), true);
});

test("redactor and percentile", () => {
  const r = makeRedactor([TOKEN, IP], { "<site>": "staging.example.com" });
  assert.equal(r(`a ${TOKEN} b ${IP} c staging.example.com`), "a [redacted] b [redacted] c <site>");
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

test("canary refuses to start without explicit configuration", () => {
  assert.ok(loadConfig({}).problems.length >= 3);
  assert.ok(loadConfig({ CANARY_TOKEN: "short", CANARY_BIND: "127.0.0.1", PORT: "1" }).problems.length === 1);
  assert.equal(loadConfig({ CANARY_TOKEN: TOKEN, CANARY_BIND: "127.0.0.1", PORT: "4599" }).problems.length, 0);
  const r = spawnSync(process.execPath, [join(HERE, "canary-sink.mjs")], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to start/);
});

test("headersContaining returns names, never values", () => {
  assert.deepEqual(headersContaining({ "x-real-ip": IP, "cf-connecting-ip": `${IP}`, via: "1.1 edge" }, IP), ["cf-connecting-ip", "x-real-ip"]);
  assert.deepEqual(headersContaining({ "x-real-ip": IP }, null), []);
});

// The tester's IP in every spelling a platform or proxy might use (G4-I8 / T5).
const IP_SPELLINGS = [IP, `${IP}:443`, `[${IP}]`, `::ffff:${IP}`, "::FFFF:C633:6407", "::ffff:c633:6407", "64:ff9b::c633:6407", `::${IP}`];
const IP6 = "2001:db8::7"; // RFC 3849
const IP6_SPELLINGS = [IP6, "2001:DB8::7", "2001:0db8:0000:0000:0000:0000:0000:0007", "2001:db8:0:0:0:0:0:7", `[${IP6}]:443`, "2001:DB8:0::0:7"];

test("the canary recognises the tester's IP in any spelling, in raw headers (every repeated copy), and returns names only", () => {
  for (const v of IP_SPELLINGS) assert.equal(containsIp(`for="${v}";proto=https`, IP), true, v);
  for (const v of IP6_SPELLINGS) assert.equal(containsIp(`a, ${v}`, IP6), true, v);
  for (const v of ["203.0.113.9", "198.51.100.8", "2001:db8::8", "1.1 edge", "cf-ray-abc", "2026-11-03T10:00:00Z"]) assert.equal(containsIp(v, IP), false, v);
  // Node keeps only the first User-Agent / Referer in req.headers; the raw headers keep every copy.
  const raw = ["User-Agent", "site-worker/1.0", "user-agent", `x ${IP}`, "Referer", "https://www.example.com/", "X-Visitor", "::FFFF:C633:6407", "Via", "1.1 edge", "Bad Name", IP];
  assert.deepEqual(headersContaining(raw, IP), ["<nonstandard-name>", "user-agent", "x-visitor"]);
  assert.deepEqual(headersContaining(raw, null), []);
});

test("scrubIps (redactor and canary) removes every IP spelling and keeps ordinary text", () => {
  const text = [...IP_SPELLINGS, ...IP6_SPELLINGS, "connect ECONNREFUSED 203.0.113.5:443", "fe80::1%eth0"].join(" | ");
  for (const scrub of [scrubIps, canaryScrub]) {
    const out = scrub(text);
    assert.deepEqual(ipLiterals(out), [], out);
    assert.ok(!/198\.51|c633|2001:|db8|203\.0/i.test(out), out);
  }
  for (const keep of ["median 12.3 ms p95 4.5", "2026-11-03T22:13:00.123Z", "cf-connecting-ip 0/40", "Wrangler 4.157.0", "/landing/ttfb-abcd-12"]) {
    assert.equal(scrubIps(keep), keep);
    assert.equal(canaryScrub(keep), keep);
  }
  const r = makeRedactor([TOKEN, IP6], {});
  assert.equal(r(`a ${IP6.toUpperCase()} b 2001:0db8:0000:0000:0000:0000:0000:0007 c ${TOKEN}`), "a [redacted] b [ip] c [redacted]");
});

test("canary: authentication, modes, IP booleans, header canary, ceiling, and no IP in its results", async () => {
  const cfg = loadConfig({ CANARY_TOKEN: TOKEN, CANARY_BIND: "127.0.0.1", PORT: "1" });
  const { server } = createCanary(cfg);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const post = (path, body, headers = auth, extra = {}) => rawRequest(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), ...extra });
  try {
    assert.equal((await rawRequest(`${base}/healthz`)).status, 200);
    assert.equal((await post("/v1/entrances", {}, { "content-type": "application/json" })).status, 401);
    assert.equal((await post("/v1/entrances", {}, { ...auth, authorization: `Bearer ${TOKEN.slice(1)}x` })).status, 401);
    assert.equal((await rawRequest(`${base}/elsewhere`)).status, 404);
    assert.equal((await post("/_canary/expect", { client_ip: IP })).status, 204);
    const entrance = { contract: "entrance.v1", website_id: "w", ip: IP, entrance_id: "abcdefghijklmnop1", occurred_at: "2026-11-03T10:00:00Z", page_key: "/landing/x", acquisition: "direct", eligibility: "tsa-1" };
    const ok = await post("/v1/entrances", entrance, { ...auth, "x-real-ip": IP, "cf-connecting-ip": FORGED });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).status, "ineligible");
    assert.equal((await post("/v1/entrances", entrance)).status, 200);
    assert.equal((await post("/m/500/v1/entrances", { ...entrance, entrance_id: "abcdefghijklmnop2", ip: FORGED })).status, 500);
    assert.equal((await post("/v1/events", { contract: "event.v1", event_id: "eeeeeeeeeeeeeeee1", name: "cta_click" })).status, 200);
    assert.equal((await post("/v1/events", { pad: "x".repeat(5000) })).status, 413);
    assert.equal((await post("/_canary/mode", { mode: "nope" })).status, 400);
    assert.equal((await post("/_canary/mode", { mode: "hang" })).status, 204);
    await assert.rejects(post("/v1/entrances", { ...entrance, entrance_id: "abcdefghijklmnop3" }, auth, { timeoutMs: 300 }));
    assert.equal((await post("/_canary/mode", { mode: "503" })).status, 204);
    assert.equal((await post("/v1/entrances", { ...entrance, entrance_id: "abcdefghijklmnop4" })).status, 503);
    assert.equal((await post("/ceiling/probe/25", {})).status, 204);
    // Body strings that carry an IP are kept with [ip] in its place.
    assert.equal((await post("/m/ok/v1/events", { contract: "event.v1", event_id: `eeeeeeeeeeeeeeee2`, name: `x ${IP}`, page_key: `/landing/${IP}/::ffff:c633:6407`, [IP]: 1 })).status, 200);
    const res = await rawRequest(`${base}/_canary/results`, { headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(ipLiterals(res.body), [], "the results contain no IP literal in any spelling");
    assert.ok(!/c633/i.test(res.body));
    assert.ok(!res.body.includes(IP), "the results never contain the tester's IP");
    assert.ok(!res.body.includes(FORGED), "the results never contain the forged IP");
    assert.ok(!res.body.includes(TOKEN), "the results never contain the token");
    const j = JSON.parse(res.body);
    const [first, second, third] = j.records;
    assert.deepEqual([first.attempt, second.attempt, first.ip.matchesExpected, first.ip.matchesForged], [1, 2, true, false]);
    assert.deepEqual(first.headersWithClientIp, ["x-real-ip"]);
    assert.deepEqual(first.headersWithForgedIp, ["cf-connecting-ip"]);
    assert.equal(first.headerPresence["cf-connecting-ip"], true);
    assert.deepEqual([third.mode, third.ip.matchesForged, third.ip.matchesExpected], ["500", true, false]);
    assert.equal(j.counts.authFailed, 2);
    assert.deepEqual(j.ceiling.map((c) => [c.probeId, c.offsetS]), [["probe", 25]]);
    const scrubbed = j.records.find((r) => r.id === "eeeeeeeeeeeeeeee2");
    assert.deepEqual([scrubbed.pageKey, scrubbed.name, scrubbed.keys.includes("[ip]"), scrubbed.bodyContainsClientIp], ["/landing/[ip]/[ip]", "x [ip]", true, true]);
    assert.equal(first.bodyContainsClientIp, false, "the entrance's own ip field does not count");
    assert.ok(first.headerNames.includes("x-real-ip") && first.headerNames.includes("cf-connecting-ip"));
    assert.equal((await post("/_canary/reset", {})).status, 204);
    const after = JSON.parse((await rawRequest(`${base}/_canary/results`, { headers: auth })).body);
    assert.deepEqual([after.records.length, after.expectationSet, after.mode], [0, false, "ok"]);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

function run(script, env, argv = []) {
  return spawnSync(process.execPath, [join(HERE, script), ...argv], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 60_000 });
}
const SITE = {
  ACCEPT_SITE_URL: "https://staging.example.com",
  ACCEPT_SITE_ZONE: "example.com",
  ACCEPT_RESOLVER_URL: "https://resolver.example.net",
  ACCEPT_CANARY_URL: "https://canary.example.org",
  ACCEPT_CANARY_TOKEN: TOKEN,
  ACCEPT_PROBE_TOKEN: `${TOKEN}probe`,
  ACCEPT_COLLECTOR_ALLOW: "page_view,cta_click",
  ACCEPT_COLLECTOR_CONSENT: "required",
  ACCEPT_RATE_EVENTS: "60",
};

test("cf-site-check refuses to run without explicit targets, and never echoes a value", () => {
  const none = run("cf-site-check.mjs", {}, ["--phase", "preflight"]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /ACCEPT_SITE_URL, ACCEPT_SITE_ZONE, ACCEPT_RESOLVER_URL/);
  assert.equal(run("cf-site-check.mjs", SITE, ["--phase", "preflight"]).status, 2, "no --confirm-target");
  assert.equal(run("cf-site-check.mjs", SITE, ["--phase", "preflight", "--confirm-target", "other.example.com"]).status, 2);
  assert.equal(run("cf-site-check.mjs", { ...SITE, ACCEPT_SITE_URL: "http://staging.example.com" }, ["--phase", "preflight", "--confirm-target", "staging.example.com"]).status, 2);
  assert.equal(run("cf-site-check.mjs", { ...SITE, ACCEPT_SITE_URL: "https://<site-host>" }, ["--phase", "preflight", "--confirm-target", "<site-host>"]).status, 2);
  assert.equal(run("cf-site-check.mjs", { ...SITE, ACCEPT_CANARY_URL: "" }, ["--phase", "ttfb", "--confirm-target", "staging.example.com"]).status, 2);
  assert.equal(run("cf-site-check.mjs", { ...SITE, ACCEPT_PROBE_TOKEN: "" }, ["--phase", "ceiling", "--confirm-target", "staging.example.com"]).status, 2);
  assert.equal(run("cf-site-check.mjs", SITE, ["--phase", "nope", "--confirm-target", "staging.example.com"]).status, 2);
  const dry = run("cf-site-check.mjs", SITE, ["--dry-run", "--phase", "all", "--confirm-target", "staging.example.com"]);
  assert.equal(dry.status, 0, dry.stderr);
  for (const v of [TOKEN, "staging.example.com", "resolver.example.net", "canary.example.org"]) assert.ok(!dry.stdout.includes(v), `dry-run output must not contain ${v}`);
  assert.match(dry.stdout, /<site>/);
});

test("cf-site-check preflight FAILS when the resolver is inside the site's zone (G4-I8 gate)", async () => {
  const server = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<html></html>"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const env = { ACCEPT_SITE_URL: `http://127.0.0.1:${port}`, ACCEPT_SITE_ZONE: "127.0.0.1", ACCEPT_RESOLVER_URL: "http://127.0.0.1:9" };
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [join(HERE, "cf-site-check.mjs"), "--local-probe", "--phase", "preflight", "--confirm-target", `127.0.0.1:${port}`], { env: { PATH: process.env.PATH, ...env } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", (status) => resolve({ status, out }));
    });
    assert.equal(r.status, 1);
    assert.match(r.out, /FAIL .*G4-I8: the resolver host is outside the site's zone/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("supabase-hosted-check refuses to run without explicit targets, and never echoes a value", () => {
  const SB = {
    SBH_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SBH_PUBLISHABLE_KEY: `pub-${TOKEN}`,
    SBH_SERVICE_ROLE_KEY: `svc-${TOKEN}`,
    SBH_SYNC_SECRET: `sync-${TOKEN}`,
    SBH_INSTALLATION_ID: "idr-staging",
  };
  const none = run("supabase-hosted-check.mjs", {});
  assert.equal(none.status, 2);
  assert.match(none.stderr, /SBH_URL/);
  assert.equal(run("supabase-hosted-check.mjs", SB).status, 2, "no --confirm-target");
  assert.equal(run("supabase-hosted-check.mjs", SB, ["--confirm-target", "zzzzzzzzzzzzzzzzzzzz"]).status, 2);
  assert.equal(run("supabase-hosted-check.mjs", { ...SB, SBH_URL: "https://project.example.com" }, ["--confirm-target", "project"]).status, 2);
  assert.equal(run("supabase-hosted-check.mjs", { ...SB, SBH_URL: "http://abcdefghijklmnopqrst.supabase.co" }, ["--confirm-target", "abcdefghijklmnopqrst"]).status, 2);
  assert.equal(run("supabase-hosted-check.mjs", { ...SB, SBH_RESOLVER_URL: "https://resolver.example.net" }, ["--confirm-target", "abcdefghijklmnopqrst"]).status, 2, "oracle needs both values");
  assert.equal(run("supabase-hosted-check.mjs", SB, ["--confirm-target", "abcdefghijklmnopqrst", "--checks", "nope"]).status, 2);
  const dry = run("supabase-hosted-check.mjs", SB, ["--dry-run", "--confirm-target", "abcdefghijklmnopqrst"]);
  assert.equal(dry.status, 0, dry.stderr);
  for (const v of [TOKEN, "abcdefghijklmnopqrst", "idr-staging"]) assert.ok(!dry.stdout.includes(v), `dry-run output must not contain ${v}`);
});

// End to end: cf-site-check (phase ttfb, --local-probe) against a stand-in site whose outbound requests leak the
// tester's IP in many headers and spellings. The run must FAIL G4-I8 with the header NAMES, and nothing it prints or
// writes may contain the IP in any form.
function standInSite(canaryPort, leak) {
  let n = 0;
  return http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html><body>page</body></html>");
    const path = new URL(req.url, "http://site.invalid").pathname;
    if (!path.startsWith("/landing/")) return; // the control prefix of --local-probe is /m/none/
    const ip = req.headers["cf-connecting-ip"]; // --local-probe sends the tester IP here, like the probe app reads it
    const body = JSON.stringify({ contract: "entrance.v1", website_id: "w", ip, entrance_id: `entrance${String(++n).padStart(12, "0")}`, occurred_at: "2026-11-03T10:00:00Z", page_key: path, acquisition: "direct", eligibility: "tsa-1" });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json", "content-length": Buffer.byteLength(body), ...leak };
    const out = http.request({ host: "127.0.0.1", port: canaryPort, path: "/v1/entrances", method: "POST", headers }, (r) => r.resume());
    out.on("error", () => {});
    out.end(body);
  });
}

async function runLeakCase(testerIp, leak) {
  const cfg = loadConfig({ CANARY_TOKEN: TOKEN, CANARY_BIND: "127.0.0.1", PORT: "1" });
  const { server: canary } = createCanary(cfg);
  await new Promise((r) => canary.listen(0, "127.0.0.1", r));
  const canaryPort = canary.address().port;
  const site = standInSite(canaryPort, leak);
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const sitePort = site.address().port;
  const dir = mkdtempSync(join(tmpdir(), "idr-selftest-"));
  const outFile = join(dir, "out.json");
  try {
    const env = {
      ACCEPT_SITE_URL: `http://127.0.0.1:${sitePort}`,
      ACCEPT_SITE_ZONE: "probe.invalid",
      ACCEPT_RESOLVER_URL: `http://127.0.0.1:${canaryPort}`,
      ACCEPT_CANARY_URL: `http://127.0.0.1:${canaryPort}`,
      ACCEPT_CANARY_TOKEN: TOKEN,
      ACCEPT_TESTER_IP: testerIp,
    };
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [join(HERE, "cf-site-check.mjs"), "--local-probe", "--phase", "ttfb", "--samples", "5", "--confirm-target", `127.0.0.1:${sitePort}`, "--out", outFile], { env: { PATH: process.env.PATH, ...env } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    return { ...r, file: readFileSync(outFile, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    site.closeAllConnections();
    canary.closeAllConnections();
    await new Promise((r) => site.close(r));
    await new Promise((r) => canary.close(r));
  }
}

const G4I8_FAIL = /FAIL \[ttfb \(canary mode ok\)\] ttfb: G4-I8, no request header at the resolver's hosting position carries the visitor's IP \(local workerd\) \(headers carrying it: ([a-z0-9<>, -]+)\)/;

test("cf-site-check: an IPv4 tester IP leaked in many headers and spellings is a G4-I8 FAIL naming the headers, and no output holds the IP", async () => {
  const leak = {
    "cf-connecting-ip": IP,
    "x-real-ip": IP,
    "x-forwarded-for": `192.0.2.1, ${IP}`,
    forwarded: `for="${IP}:443";proto=https`,
    "true-client-ip": `::ffff:${IP}`,
    "x-visitor": "::FFFF:C633:6407",
    "user-agent": ["site-worker/1.0", `worker ${IP}`], // the second copy is dropped from Node's req.headers
    "cf-ray": "0123456789abcdef-AMS",
  };
  const r = await runLeakCase(IP, leak);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const m = G4I8_FAIL.exec(r.stdout);
  assert.ok(m, r.stdout);
  assert.equal(m[1], "cf-connecting-ip, forwarded, true-client-ip, user-agent, x-forwarded-for, x-real-ip, x-visitor");
  assert.match(r.stdout, /PASS .*trust policy cloudflare: the entrance carried the tester's real IP/);
  assert.match(r.stdout, /every header name that arrived \(all were inspected\) \(.*x-visitor/);
  const doc = JSON.parse(r.file);
  assert.ok(doc.items.some((i) => i.kind === "FAIL" && /headers carrying it: cf-connecting-ip/.test(i.detail)));
  for (const [where, text] of [["stdout", r.stdout], ["stderr", r.stderr], ["--out file", r.file]]) {
    assert.deepEqual(ipLiterals(text), [], `${where} holds no IP literal`);
    for (const form of [IP, "198.51.100", "c633", "6407", "51.100.7"]) assert.ok(!text.toLowerCase().includes(form.toLowerCase()), `${where} must not contain ${form}`);
  }
});

test("cf-site-check: an IPv6 tester IP leaked in other spellings is a G4-I8 FAIL, and no output holds the IP", async () => {
  const leak = {
    "cf-connecting-ip": "2001:DB8::7",
    "x-real-ip": "2001:0db8:0000:0000:0000:0000:0000:0007",
    forwarded: `for="[${IP6}]:443"`,
    "x-forwarded-for": "192.0.2.1, 2001:db8:0:0::7",
    referer: ["https://www.example.com/", `https://www.example.com/?via=${IP6}`],
  };
  const r = await runLeakCase(IP6, leak);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const m = G4I8_FAIL.exec(r.stdout);
  assert.ok(m, r.stdout);
  assert.equal(m[1], "cf-connecting-ip, forwarded, referer, x-forwarded-for, x-real-ip");
  for (const [where, text] of [["stdout", r.stdout], ["stderr", r.stderr], ["--out file", r.file]]) {
    assert.deepEqual(ipLiterals(text), [], `${where} holds no IP literal`);
    assert.ok(!/2001:|db8/i.test(text), `${where} must not contain any spelling of the IPv6 address`);
  }
});

test("cf-site-check: a stand-in site that leaks nothing gives INFO (local: no edge claim) and exit 0", async () => {
  const r = await runLeakCase(IP, { "cf-ray": "0123456789abcdef-AMS" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /INFO \[ttfb \(canary mode ok\)\] ttfb: G4-I8 header canary \(local workerd: not the production edge, no claim\) \(no header carried the tester IP/);
  assert.deepEqual(ipLiterals(r.stdout + r.file), []);
});

// G5R2-L5: the header check must never PASS without a comparison basis, and must catch a header carrying the
// entrance body's own IP even when no expected tester IP was set (the browser phase never sets one).
const BODY_IP = "192.0.2.77"; // RFC 5737; deliberately not the script's local tester IP
function entranceBody(n, ip, pageKey) {
  return { contract: "entrance.v1", website_id: "w", ip, entrance_id: `entranceL5${String(n).padStart(8, "0")}`, occurred_at: "2026-11-03T10:00:00Z", page_key: pageKey, acquisition: "direct", eligibility: "tsa-1" };
}
function eventBody(n, pageKey) {
  return { contract: "event.v1", website_id: "w", event_id: `eventL5${String(n).padStart(11, "0")}`, occurred_at: "2026-11-03T10:00:00Z", type: "conversion_intent", name: "cta_click", page_key: pageKey, consent: "granted" };
}

test("canary: with no expectation, a request is marked uncompared; an entrance's own ip and earlier visitor IPs are compared", async () => {
  assert.deepEqual(headersContainingAny({ "x-real-ip": IP }, []), []);
  assert.deepEqual(headersContainingAny({ "x-real-ip": IP, via: "1.1 edge" }, [null, IP6, IP]), ["x-real-ip"]);
  const { server } = createCanary(loadConfig({ CANARY_TOKEN: TOKEN, CANARY_BIND: "127.0.0.1", PORT: "1" }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const post = (path, body, extra = {}) => rawRequest(`${base}${path}`, { method: "POST", headers: { ...auth, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/v1/events", eventBody(1, "/landing/a"), { "x-real-ip": BODY_IP })).status, 200);
    assert.equal((await post("/v1/entrances", entranceBody(1, BODY_IP, "/landing/a"), { "cf-connecting-ip": BODY_IP })).status, 200);
    assert.equal((await post("/v1/events", eventBody(2, "/landing/a"), { "x-real-ip": `::ffff:${BODY_IP}` })).status, 200);
    assert.equal((await post("/v1/events", eventBody(3, "/landing/a"))).status, 200);
    const res = await rawRequest(`${base}/_canary/results`, { headers: auth });
    assert.deepEqual(ipLiterals(res.body), [], "the results hold no IP");
    const j = JSON.parse(res.body);
    assert.deepEqual([j.expectationSet, j.visitorIpsKnown], [false, 1]);
    const [ev1, ent, ev2, ev3] = j.records;
    assert.deepEqual([ev1.compared, ev1.headersWithClientIp], [false, []], "before any entrance: nothing to compare against");
    assert.deepEqual([ent.compared, ent.headersWithClientIp], [true, ["cf-connecting-ip"]], "the entrance's own ip");
    assert.deepEqual([ev2.compared, ev2.headersWithClientIp], [true, ["x-real-ip"]], "an earlier visitor's ip, in another spelling");
    assert.deepEqual([ev3.compared, ev3.headersWithClientIp], [true, []]);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

/** Runs cf-site-check --local-probe --phase browser against an in-process canary pre-seeded by `seed`. */
async function runBrowserPhase(seed) {
  const { server: canary } = createCanary(loadConfig({ CANARY_TOKEN: TOKEN, CANARY_BIND: "127.0.0.1", PORT: "1" }));
  await new Promise((r) => canary.listen(0, "127.0.0.1", r));
  const canaryPort = canary.address().port;
  const site = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<html></html>"));
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const sitePort = site.address().port;
  const dir = mkdtempSync(join(tmpdir(), "idr-selftest-"));
  const outFile = join(dir, "out.json");
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const post = (path, body, extra = {}) => rawRequest(`http://127.0.0.1:${canaryPort}${path}`, { method: "POST", headers: { ...auth, ...extra }, body: JSON.stringify(body) });
  try {
    await seed(post);
    const env = { ACCEPT_SITE_URL: `http://127.0.0.1:${sitePort}`, ACCEPT_SITE_ZONE: "probe.invalid", ACCEPT_RESOLVER_URL: `http://127.0.0.1:${canaryPort}`, ACCEPT_CANARY_URL: `http://127.0.0.1:${canaryPort}`, ACCEPT_CANARY_TOKEN: TOKEN };
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [join(HERE, "cf-site-check.mjs"), "--local-probe", "--phase", "browser", "--browser-wait-s", "1", "--confirm-target", `127.0.0.1:${sitePort}`, "--out", outFile], { env: { PATH: process.env.PATH, ...env } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    return { ...r, file: readFileSync(outFile, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    site.closeAllConnections();
    canary.closeAllConnections();
    await new Promise((r) => site.close(r));
    await new Promise((r) => canary.close(r));
  }
}

test("cf-site-check browser phase: requests with nothing to compare against can never PASS G4-I8", async () => {
  const r = await runBrowserPhase(async (post) => {
    // Events only (no entrance, no expectation): a leaking header could not even be recognised here.
    assert.equal((await post("/v1/events", eventBody(10, "/landing/browser-a"), { "x-real-ip": BODY_IP })).status, 200);
    assert.equal((await post("/v1/events", eventBody(11, "/landing/browser-a"))).status, 200);
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL \[browser \(manual, real browsers\)\] browser: G4-I8, no request header at the resolver's hosting position carries the visitor's IP \(local workerd\) \(2 of 2 requests could not be compared/);
  assert.ok(!/PASS .*G4-I8/.test(r.stdout) && !/INFO .*no header carried/.test(r.stdout), r.stdout);
  assert.deepEqual(ipLiterals(r.stdout + r.stderr + r.file), []);
});

test("cf-site-check browser phase: a header carrying the entrance body's own IP is a FAIL without any expected IP", async () => {
  const r = await runBrowserPhase(async (post) => {
    assert.equal((await post("/v1/entrances", entranceBody(20, BODY_IP, "/landing/browser-b"), { "cf-connecting-ip": BODY_IP, "x-real-ip": BODY_IP })).status, 200);
    assert.equal((await post("/v1/events", eventBody(20, "/landing/browser-b"), { "x-forwarded-for": `198.51.100.1, ${BODY_IP}` })).status, 200);
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL \[browser \(manual, real browsers\)\] browser: G4-I8, .*\(headers carrying it: cf-connecting-ip, x-forwarded-for, x-real-ip\)/);
  assert.match(r.stdout, /expected tester IP set: false; visitor IPs known from entrance bodies: 1/);
  for (const [where, text] of [["stdout", r.stdout], ["stderr", r.stderr], ["--out file", r.file]]) {
    assert.deepEqual(ipLiterals(text), [], `${where} holds no IP literal`);
    assert.ok(!text.includes("192.0.2"), `${where} must not contain the visitor IP`);
  }
});

test("cf-site-check browser phase: compared and clean is INFO locally (no claim), exit 0", async () => {
  const r = await runBrowserPhase(async (post) => {
    assert.equal((await post("/v1/entrances", entranceBody(30, BODY_IP, "/landing/browser-c"))).status, 200);
    assert.equal((await post("/v1/events", eventBody(30, "/landing/browser-c"))).status, 200);
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /INFO \[browser \(manual, real browsers\)\] browser: G4-I8 header canary \(local workerd: not the production edge, no claim\) \(no header carried the tester IP \(2 requests, each compared\)\)/);
});

// ---------------------------------------------------------------------------------------------------------------
// lovable-provenance-check.mjs (CHR-119): end to end against an in-process canary, two stand-in IP-echo servers (one
// answering with a cf-ray header in the /cdn-cgi/trace `ip=` format, one in plain text without it) and a stand-in site
// that, for an eligible document navigation, posts an entrance.v1 body to the canary after its response, the way the
// adapter would. R, F and F2 are documentation addresses: the canary and the stand-ins accept them and --local-probe
// allows them. A real run REFUSES a documentation-range F: the adapter refuses those addresses, so a forged value that
// got through would be dropped exactly like an edge rejection.
const PROV_R = IP;
const PROV_F = FORGED;
const PROV_F2 = "192.0.2.10"; // RFC 5737
const PROV_PAGE = "/landing/prov";
const RAY = "7a1b2c3d4e5f6a7b-AMS";
const CASE_IDS = ["P1", "P2", "P3a", "P3b", "P3c", "P3d", "P4", "P5"];

/** Stand-in site. Modes: honest, forged-cf, forged-dup, forged-xff, wrong-ip, edge-reject, wrong-reject, cached-reject, leaky, silent. */
function provSite(host, canaryPort, mode, R) {
  const state = { requests: 0, eligible: 0, nonces: new Set(), noCache: 0, dupLines: 0 };
  let n = 0;
  const server = http.createServer((req, res) => {
    state.requests++;
    const url = new URL(req.url, "http://site.invalid");
    const h = req.headers;
    const cf = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "cf-connecting-ip") cf.push(req.rawHeaders[i + 1]);
    if (cf.length >= 2) state.dupLines++;
    if (url.searchParams.has("idrprov")) state.nonces.add(url.searchParams.get("idrprov"));
    if (h["cache-control"] === "no-cache") state.noCache++;
    if (/-reject$/.test(mode) && cf.length > 0) {
      return res.writeHead(403, { "content-type": "text/plain", "cf-ray": RAY, server: "cloudflare" }).end("error code: 1000");
    }
    res.writeHead(200, { "content-type": "text/html", "cf-ray": RAY, server: "cloudflare", ...(mode === "cached-reject" ? { "cf-cache-status": "HIT" } : {}) }).end("<!doctype html><html><body>page</body></html>");
    const eligible = req.method === "GET" && url.pathname === PROV_PAGE && /text\/html/.test(h.accept ?? "") && h["sec-fetch-dest"] === "document" && h["sec-fetch-mode"] === "navigate" && Boolean(h["user-agent"]) && !h.upgrade;
    if (!eligible || mode === "silent" || mode === "cached-reject") return;
    state.eligible++;
    n++;
    let ip = R;
    if (mode === "forged-cf" && cf.length > 0) ip = h["cf-connecting-ip"];
    if (mode === "forged-dup" && cf.length >= 2) ip = cf[1];
    if (mode === "forged-xff" && h["x-forwarded-for"]) ip = h["x-forwarded-for"].split(",")[0].trim();
    if (mode === "wrong-ip" || mode === "wrong-reject") ip = `198.51.100.${100 + n}`; // a different address every time
    const body = JSON.stringify({ contract: "entrance.v1", website_id: "w", ip, entrance_id: `provsite${String(n).padStart(14, "0")}`, occurred_at: "2026-11-04T10:00:00Z", page_key: url.pathname, acquisition: "direct", eligibility: "tsa-1" });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json", "content-length": Buffer.byteLength(body), ...(mode === "leaky" ? { "x-real-ip": R } : {}) };
    const out = http.request({ host, port: canaryPort, path: "/v1/entrances", method: "POST", headers }, (r) => r.resume());
    out.on("error", () => {});
    out.end(body);
  });
  return { server, state };
}

/** Stand-in IP echo: answers[i] for the i-th request (the last one repeats). */
function echoServer(answers, viaCloudflare) {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    const a = answers[Math.min(state.requests, answers.length - 1)];
    state.requests++;
    if (viaCloudflare) res.writeHead(200, { "content-type": "text/plain", "cf-ray": RAY }).end(`fl=1\nh=echo.invalid\nip=${a}\nts=1\n`);
    else res.writeHead(200, { "content-type": "text/plain" }).end(`${a}\n`);
  });
  return { server, state };
}

const listenOn = (server, host) => new Promise((r) => server.listen(0, host, () => r(server.address().port)));
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
};
function spawnScript(script, argv, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, script), ...argv], { env: { PATH: process.env.PATH, ...env } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** One run of the script against the stand-ins (one stand-in site per mode); returns its output plus what each stand-in received. */
async function runProv({ mode = "honest", family = 4, echo = [[PROV_R], [PROV_R]], echoRay = [true, false], env = {}, argv = (a) => a, forged } = {}) {
  const host = family === 6 ? "::1" : "127.0.0.1";
  const urlHost = family === 6 ? "[::1]" : "127.0.0.1";
  const R = echo[0][0];
  const [F, F2] = forged ?? (family === 6 ? ["2001:db8::9", "2001:db8::a"] : [PROV_F, PROV_F2]);
  const { server: canary } = createCanary(loadConfig({ CANARY_TOKEN: TOKEN, CANARY_BIND: host, PORT: "1", CANARY_FORGED_IP: F }));
  let canaryHits = 0;
  canary.on("request", () => canaryHits++);
  const canaryPort = await listenOn(canary, host);
  const sites = [mode].flat().map((m) => provSite(host, canaryPort, m, R));
  const sitePorts = [];
  for (const s of sites) sitePorts.push(await listenOn(s.server, host));
  const e1 = echoServer(echo[0], echoRay[0]);
  const e2 = echoServer(echo[1], echoRay[1]);
  const [p1, p2] = [await listenOn(e1.server, host), await listenOn(e2.server, host)];
  const dir = mkdtempSync(join(tmpdir(), "idr-prov-"));
  const outFile = join(dir, "prov.json");
  try {
    const fullEnv = {
      PROV_SITE_URLS: sitePorts.map((p) => `http://${urlHost}:${p}`).join(","),
      PROV_PAGE_PATH: PROV_PAGE,
      PROV_CANARY_URL: `http://${urlHost}:${canaryPort}`,
      PROV_CANARY_TOKEN: TOKEN,
      PROV_ECHO_URLS: `http://${urlHost}:${p1}/cdn-cgi/trace,http://${urlHost}:${p2}/ip`,
      ...(family === 6 ? { PROV_FORGED_IP6: F, PROV_FORGED_IP6B: F2 } : { PROV_FORGED_IP: F, PROV_FORGED_IP2: F2 }),
      ...env,
    };
    const base = ["--local-probe", "--family", String(family), "--network-label", "selftest", "--confirm-target", sitePorts.map((p) => `${urlHost}:${p}`).reverse().join(","), "--out", outFile, "--poll-timeout-s", "1", "--settle-ms", "150", "--delay-ms", "0"];
    const r = await spawnScript("lovable-provenance-check.mjs", argv(base), fullEnv);
    let file = "";
    let fileMode = null;
    try {
      file = readFileSync(outFile, "utf8");
      fileMode = statSync(outFile).mode & 0o777;
    } catch {
      /* no file (refusal) */
    }
    return { ...r, file, fileMode, site: sites[0].state, sites: sites.map((s) => s.state), echoHits: [e1.state.requests, e2.state.requests], canaryHits };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const s of [...sites.map((x) => x.server), canary, e1.server, e2.server]) await closeServer(s);
  }
}

/** Nothing the script prints or writes holds an IP literal (any spelling), a test address, a loopback host or the token. */
function assertNoProvLeak(r) {
  for (const [where, text] of [["stdout", r.stdout], ["stderr", r.stderr], ["--out file", r.file]]) {
    assert.deepEqual(ipLiterals(text), [], `${where} holds no IP literal`);
    for (const s of ["198.51.100", "203.0.113", "192.0.2.", "2001:db8", "127.0.0.1", TOKEN]) assert.ok(!text.toLowerCase().includes(s), `${where} must not contain ${s}`);
  }
}
const caseRe = (id, http, cfError, entrances, verdict, reason, site = "<site1>") => new RegExp(`^${site} net=selftest IPv4 ${id} http=${http} cf-error=${cfError} entrances=${entrances} => ${verdict}: ${reason}$`, "m");

test("lovable-provenance-check: refusals exit 2 and send nothing", async () => {
  let hits = 0;
  const servers = Array.from({ length: 4 }, () => http.createServer((q, s) => (hits++, s.end("x"))));
  const ports = [];
  for (const s of servers) ports.push(await listenOn(s, "127.0.0.1"));
  const L = {
    PROV_SITE_URLS: `http://127.0.0.1:${ports[0]}`,
    PROV_PAGE_PATH: PROV_PAGE,
    PROV_CANARY_URL: `http://127.0.0.1:${ports[1]}`,
    PROV_CANARY_TOKEN: TOKEN,
    PROV_ECHO_URLS: `http://127.0.0.1:${ports[2]}/ip,http://127.0.0.1:${ports[3]}/ip`,
    PROV_FORGED_IP: PROV_F,
    PROV_FORGED_IP2: PROV_F2,
  };
  const site = `127.0.0.1:${ports[0]}`;
  const ok = ["--local-probe", "--family", "4", "--network-label", "selftest", "--confirm-target", site];
  const HTTPS = { ...L, PROV_SITE_URLS: "https://staging.example.com,https://www.example.com", PROV_CANARY_URL: "https://canary.example.org", PROV_ECHO_URLS: "https://echo-a.example.net/ip,https://echo-b.example.org/ip" };
  const httpsArgs = ["--family", "4", "--network-label", "home", "--confirm-target", "www.example.com,staging.example.com"];
  const refusals = [
    ["no variables", {}, ["--family", "4", "--network-label", "x", "--confirm-target", site], /missing required environment variable\(s\): PROV_SITE_URLS, PROV_PAGE_PATH, PROV_CANARY_URL, PROV_CANARY_TOKEN, PROV_ECHO_URLS, PROV_FORGED_IP, PROV_FORGED_IP2/],
    ["no --family", L, ok.filter((a, i) => i !== 1 && i !== 2), /--family 4 or --family 6/],
    ["IPv6 run without the IPv6 forged values", L, ok.map((a) => (a === "4" ? "6" : a)), /PROV_FORGED_IP6, PROV_FORGED_IP6B/],
    ["http without --local-probe", L, ok.slice(1), /must use https/],
    ["no --confirm-target", L, ok.slice(0, -2), /--confirm-target <host> is required/],
    ["mismatched --confirm-target", L, [...ok.slice(0, -1), "127.0.0.1:1"], /does not match/],
    ["only one of two entry points confirmed", HTTPS, [...httpsArgs.slice(0, -1), "staging.example.com"], /must name every entry-point host \(2\)/],
    ["a wrong host among two confirmed", HTTPS, [...httpsArgs.slice(0, -1), "staging.example.com,other.example.com"], /does not match/],
    ["documentation-range F outside --local-probe", HTTPS, httpsArgs, /PROV_FORGED_IP is in a documentation range .*The adapter refuses those addresses/],
    ["a private F", { ...HTTPS, PROV_FORGED_IP: "10.1.2.3" }, httpsArgs, /PROV_FORGED_IP is private, reserved or otherwise not public/],
    ["F equal to PROV_TESTER_IP", { ...L, PROV_TESTER_IP: PROV_F }, ok, /a forged value equals PROV_TESTER_IP/],
    ["F equal to F2", { ...L, PROV_FORGED_IP2: PROV_F }, ok, /must differ/],
    ["an address as network label", L, ok.map((a) => (a === "selftest" ? PROV_R : a)), /--network-label is required/],
    ["an unknown flag", L, [...ok, "--confirm-targt", site], /unknown or positional argument/],
    ["an ineligible page path", { ...L, PROV_PAGE_PATH: "/api/page" }, ok, /never reports/],
    ["a placeholder", { ...L, PROV_CANARY_URL: "https://<canary-host>" }, ok, /still contains a <placeholder>/],
    ["a short canary token", { ...L, PROV_CANARY_TOKEN: "short" }, ok, /at least 32 printable characters/],
    ["an echo URL on the site's host", { ...L, PROV_ECHO_URLS: `http://${site}/ip,http://127.0.0.1:${ports[3]}/ip` }, ok, /distinct hosts/],
  ];
  try {
    for (const [name, env, argv, re] of refusals) {
      const r = await spawnScript("lovable-provenance-check.mjs", argv, env);
      assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /^refused: /, name);
      assert.match(r.stderr, re, name);
      assert.equal(r.stdout, "", name);
      assert.deepEqual(ipLiterals(r.stderr), [], `${name}: no IP in the refusal`);
      assert.ok(!r.stderr.includes(TOKEN), name);
    }
    const dry = await spawnScript("lovable-provenance-check.mjs", ["--dry-run", ...ok], L);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /^dry-run: configuration valid; nothing was sent$/m);
    assert.match(dry.stdout, /entry points <site1>; per entry point, serially: P1, P2, P3a, P3b, P3c, P3d, P4, P5, then P7/);
    assertNoProvLeak({ ...dry, file: "" });
    assert.equal(hits, 0, "no refusal and no dry run contacted any server");
  } finally {
    for (const s of servers) await closeServer(s);
  }
});

test("lovable-provenance-check: an honest site (the edge sets R) is a PASS on every case; duplicates go out as two raw lines", async () => {
  const r = await runProv({ mode: "honest" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of CASE_IDS) assert.match(r.stdout, caseRe(id, 200, "-", 1, "PASS", "ip == R"), id);
  assert.match(r.stdout, /^echo start \(IPv4\): <echo1> via_cloudflare=true, <echo2> via_cloudflare=false: agree$/m);
  assert.match(r.stdout, /^canary: token accepted, records compared; its CANARY_FORGED_IP is this run's F: the forged flag corroborates$/m);
  assert.match(r.stdout, /^<site1> net=selftest IPv4 P7 runtime => INFO: cf-ray present=true value=7a1b2c3d4e5f6a7b-AMS; server cloudflare=true/m);
  assert.match(r.stdout, /^<site1> net=selftest IPv4 headers => INFO: names on the entrance subrequest\(s\) at the canary: accept, authorization, connection, content-length, content-type, host; outside the allowlist \(review\): none$/m);
  assert.match(r.stdout, /^echo end \(IPv4\): .*: agree, and equal to the start$/m);
  assert.match(r.stdout, /^overall: PASS \(8 of 8 cases run: 8 PASS, 0 FAIL, 0 HOLD, 0 INCONCLUSIVE; 0 run problem\(s\)\) \[local probe: stand-in servers, no claim about any platform\]$/m);
  assert.deepEqual([r.site.requests, r.site.eligible, r.site.nonces.size, r.site.noCache, r.site.dupLines], [8, 8, 8, 8, 1], "serial, eligible, cache-busted, no-cache, P4 as two raw header lines");
  assert.deepEqual(r.echoHits, [2, 2], "every echo URL at start and at end");
  assert.equal(r.fileMode, 0o600);
  const doc = JSON.parse(r.file);
  assert.deepEqual([doc.overall, doc.cases.length, doc.canaryForgedIsF, doc.echo.start.map((e) => e.viaCloudflare)], ["PASS", 8, true, [true, false]]);
  assert.deepEqual(doc.headerNames["<site1>"].outsideAllowlist, []);
  assertNoProvLeak(r);
});

test("lovable-provenance-check: a site that selects a forged value FAILS on that case and stops", async () => {
  const table = [
    ["forged-cf", "P2", 2, "canary forged flag true: F was selected"],
    ["forged-xff", "P3a", 3, "canary forged flag true: F was selected"],
    ["forged-dup", "P4", 7, "canary forged flag false: not F and not R \\(F2 or another value\\), counted as forged"],
  ];
  for (const [mode, id, ran, note] of table) {
    const r = await runProv({ mode });
    assert.equal(r.status, 1, `${mode}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, caseRe(id, 200, "-", 1, "FAIL", `entrance ip != R \\(${note}\\)`), mode);
    assert.match(r.stdout, new RegExp(`^overall: FAIL \\(${ran} of 8 cases run: ${ran - 1} PASS, 1 FAIL`, "m"), mode);
    assert.equal(r.site.requests, ran, `${mode}: the run stops at the FAIL`);
    assert.deepEqual(r.echoHits, [2, 2], `${mode}: the end egress check still runs`);
    assertNoProvLeak(r);
  }
});

test("lovable-provenance-check: a wrong clean-request IP is a HOLD on P1, never a PASS", async () => {
  const r = await runProv({ mode: "wrong-ip" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, caseRe("P1", 200, "-", 1, "HOLD", "entrance ip != R: wrong provenance, investigate"));
  // Conservative by design: in a forged case any ip != R is a FAIL (the canary knows one forged value only).
  assert.match(r.stdout, caseRe("P2", 200, "-", 1, "FAIL", "entrance ip != R \\(canary forged flag false: .*\\)"));
  assert.match(r.stdout, /^overall: FAIL /m);
  assertNoProvLeak(r);
});

test("lovable-provenance-check: an edge rejection counts only with a passing P1 on the same entry point", async () => {
  const ok = await runProv({ mode: "edge-reject" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  for (const id of ["P2", "P4", "P5"]) assert.match(ok.stdout, caseRe(id, 403, 1000, 0, "PASS", "edge rejection \\(HTTP 403, Cloudflare error 1000\\); P1 passed on this entry point"), id);
  for (const id of ["P1", "P3a", "P3b", "P3c", "P3d"]) assert.match(ok.stdout, caseRe(id, 200, "-", 1, "PASS", "ip == R"), id);
  assert.match(ok.stdout, /^overall: PASS \(8 of 8 cases run: 8 PASS/m);
  assertNoProvLeak(ok);

  const bad = await runProv({ mode: "wrong-reject" });
  assert.notEqual(bad.status, 0, bad.stdout + bad.stderr);
  assert.match(bad.stdout, caseRe("P1", 200, "-", 1, "HOLD", "entrance ip != R: wrong provenance, investigate"));
  assert.match(bad.stdout, caseRe("P2", 403, 1000, 0, "INCONCLUSIVE", "edge rejection \\(HTTP 403, Cloudflare error 1000\\) and P1 did not pass on this entry point"));
  assert.ok(!/^overall: PASS/m.test(bad.stdout), bad.stdout);
  assertNoProvLeak(bad);
});

test("lovable-provenance-check: a subrequest header carrying the visitor IP is a G4-I8 FAIL", async () => {
  const r = await runProv({ mode: "leaky" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, caseRe("P1", 200, "-", 1, "FAIL", "G4-I8: header\\(s\\) x-real-ip on the subrequest carry a visitor IP"));
  assert.match(r.stdout, /^overall: FAIL \(1 of 8 cases run/m);
  assertNoProvLeak(r);
});

test("lovable-provenance-check: no entrance at all is INCONCLUSIVE, overall HOLD", async () => {
  const r = await runProv({ mode: "silent" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, caseRe("P1", 200, "-", 0, "INCONCLUSIVE", "2xx page but no entrance within 1 s"));
  assert.match(r.stdout, caseRe("P4", 200, "-", 0, "INCONCLUSIVE", "2xx page, no entrance, and P1 did not pass on this entry point"));
  assert.match(r.stdout, /^overall: HOLD \(8 of 8 cases run: 0 PASS, 0 FAIL, 0 HOLD, 8 INCONCLUSIVE/m);
  assertNoProvLeak(r);
});

test("lovable-provenance-check: echo disagreement, a Cloudflare-only ground truth, or a moved egress is never a PASS", async () => {
  const other = "198.51.100.8";
  const start = await runProv({ echo: [[PROV_R], [other]] });
  assert.equal(start.status, 1, start.stdout + start.stderr);
  assert.match(start.stdout, /^echo start \(IPv4\): <echo1> via_cloudflare=true, <echo2> via_cloudflare=false: the echo answers disagree$/m);
  assert.match(start.stdout, /^overall: HOLD \(0 of 8 cases run/m);
  assert.deepEqual([start.site.requests, start.canaryHits], [0, 0], "stopped before contacting the site or the canary");
  assertNoProvLeak(start);

  const cfOnly = await runProv({ echoRay: [true, true] });
  assert.equal(cfOnly.status, 1);
  assert.match(cfOnly.stdout, /no echo answer came from outside Cloudflare/);
  assert.deepEqual([cfOnly.site.requests, cfOnly.canaryHits], [0, 0]);

  const moved = await runProv({ echo: [[PROV_R, other], [PROV_R, other]] });
  assert.equal(moved.status, 1, moved.stdout + moved.stderr);
  assert.match(moved.stdout, /^echo end \(IPv4\): .*: the address changed during the run$/m);
  assert.match(moved.stdout, /^overall: HOLD \(8 of 8 cases run: 8 PASS, 0 FAIL, 0 HOLD, 0 INCONCLUSIVE; 1 run problem\(s\)\)/m);
  assertNoProvLeak(moved);

  const tester = await runProv({ env: { PROV_TESTER_IP: other } });
  assert.equal(tester.status, 1);
  assert.match(tester.stdout, /PROV_TESTER_IP differs from the echoed address/);
  assert.deepEqual([tester.site.requests, tester.canaryHits], [0, 0]);
  assertNoProvLeak(tester);
});

test("lovable-provenance-check: F equal to the echoed R, or a family the servers cannot answer, stops before the site", async () => {
  const same = await runProv({ forged: [PROV_R, PROV_F2] });
  assert.equal(same.status, 2, same.stdout + same.stderr);
  assert.match(same.stdout, /a forged value equals the tester's own address R/);
  assert.match(same.stdout, /^overall: CONFIG-ERROR/m);
  assert.deepEqual([same.site.requests, same.canaryHits], [0, 0], "nothing sent to the site or the canary");
  assertNoProvLeak(same);

  // --family 6 against IPv4-only stand-ins: every request is pinned and the socket family is checked (EFAMILY).
  const fam = await runProv({ env: { PROV_FORGED_IP6: "2001:db8::9", PROV_FORGED_IP6B: "2001:db8::a" }, argv: (a) => a.map((x) => (x === "4" ? "6" : x)) });
  assert.equal(fam.status, 1, fam.stdout + fam.stderr);
  assert.match(fam.stdout, /^echo start \(IPv6\): <echo1> via_cloudflare=unknown, <echo2> via_cloudflare=unknown: <echo1>: EFAMILY; <echo2>: EFAMILY/m);
  assert.deepEqual([fam.site.requests, fam.canaryHits], [0, 0]);
  assertNoProvLeak(fam);
});

test("lovable-provenance-check: two entry points; P1 gates edge rejections per entry point; a cache HIT is not evidence", async () => {
  const r = await runProv({ mode: ["honest", "cached-reject"] });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  for (const id of CASE_IDS) assert.match(r.stdout, caseRe(id, 200, "-", 1, "PASS", "ip == R"), `<site1> ${id}`);
  const s2 = (id, http, cfError, reason) => assert.match(r.stdout, caseRe(id, http, cfError, 0, "INCONCLUSIVE", reason, "<site2>"), `<site2> ${id}`);
  s2("P1", 200, "-", "served from cache \\(cf-cache-status HIT\\), no entrance \\[cf-cache-status HIT\\]");
  s2("P3a", 200, "-", "served from cache \\(cf-cache-status HIT\\), no entrance \\[cf-cache-status HIT\\]");
  for (const id of ["P2", "P4", "P5"]) s2(id, 403, 1000, "edge rejection \\(HTTP 403, Cloudflare error 1000\\) and P1 did not pass on this entry point");
  assert.match(r.stdout, /^<site2> net=selftest IPv4 headers => INFO: no entrance reached the canary: no header evidence$/m);
  assert.match(r.stdout, /^overall: HOLD \(16 of 16 cases run: 8 PASS, 0 FAIL, 0 HOLD, 8 INCONCLUSIVE/m);
  assert.deepEqual(r.sites.map((s) => s.requests), [8, 8]);
  assertNoProvLeak(r);
});

test("lovable-provenance-check: a canary that refuses the token is a configuration error before the site is contacted", async () => {
  const r = await runProv({ env: { PROV_CANARY_TOKEN: `${TOKEN}0123456789abcdef` } }); // a different (longer) synthetic token
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /canary self-check failed \(CANARY_HTTP_401\): stopped before contacting the site/);
  assert.equal(r.site.requests, 0);
  assertNoProvLeak(r); // also covers the wrong token, which starts with TOKEN
});

test("lovable-provenance-check: IPv6 (P6) honest run over ::1 is a PASS", async (t) => {
  const probe = http.createServer();
  const v6 = await new Promise((r) => probe.once("error", () => r(false)).listen(0, "::1", () => probe.close(() => r(true))));
  if (!v6) return t.skip("no IPv6 loopback in this environment");
  const r = await runProv({ family: 6, echo: [["2001:db8::7"], ["2001:DB8:0:0::7"]] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of CASE_IDS) assert.match(r.stdout, new RegExp(`^<site1> net=selftest IPv6 P6-${id} http=200 cf-error=- entrances=1 => PASS: ip == R$`, "m"), id);
  assert.match(r.stdout, /^overall: PASS /m);
  assert.ok(!/::1|\[::/.test(r.stdout + r.file));
  assertNoProvLeak(r);
});
