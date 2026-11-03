// Self-test of the staging acceptance scripts. Needs no credential and contacts nothing but 127.0.0.1.
//   node --test docs/staging/acceptance/self-test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
