// Self-test of the staging acceptance scripts. Needs no credential and contacts nothing but 127.0.0.1.
//   node --test docs/staging/acceptance/self-test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
// answering with a cf-ray header in the /cdn-cgi/trace `ip=` format, one in plain text without it), stand-in sites
// that, for an eligible document navigation, post an entrance.v1 body to the canary after their response the way the
// adapter would, and optionally a stand-in for the canary's hosting edge. R, F and F2 are documentation addresses: the
// canary and the stand-ins accept them and --local-probe allows them. A real run REFUSES a documentation-range F: the
// adapter refuses those addresses, so a forged value that got through would be dropped exactly like an edge rejection.
const PROV_R = IP;
const PROV_F = FORGED;
const PROV_F2 = "192.0.2.10"; // RFC 5737
const PROV_PAGE = "/landing/prov";
const RAY = "7a1b2c3d4e5f6a7b-AMS";
const CASE_IDS = ["P1", "P2", "P3a", "P3b", "P3c", "P3d", "P4a", "P4b", "P5"];
const FWD_HEADERS = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "true-client-ip", "forwarded"];
const FAST = ["--poll-timeout-s", "1", "--settle-ms", "150", "--delay-ms", "0"];

/** Posts one entrance.v1 body to the canary, like the adapter's delivery (headers: authorization, content-type, accept). */
let provSeq = 0;
function postEntrance(host, port, ip, pageKey, extra = {}) {
  const body = JSON.stringify({ contract: "entrance.v1", website_id: "w", ip, entrance_id: `provsite${String(++provSeq).padStart(14, "0")}`, occurred_at: "2026-11-04T10:00:00Z", page_key: pageKey, acquisition: "direct", eligibility: "tsa-1" });
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json", "content-length": Buffer.byteLength(body), ...extra };
  return new Promise((resolve) => {
    const out = http.request({ host, port, path: "/v1/entrances", method: "POST", headers }, (r) => (r.resume(), r.on("end", resolve)));
    out.on("error", resolve);
    out.end(body);
  });
}

/**
 * Stand-in site. An eligible navigation gets 200 HTML (cf-ray, server: cloudflare), then an entrance is posted. Modes:
 *   honest R whatever the client sent | forged-cf the client's CF-Connecting-IP | forged-xff the first X-Forwarded-For
 *   dup-first / dup-last with two CF-Connecting-IP lines, the first / the last | header-forward R, but the client's
 *   CF-Connecting-IP is copied into x-forwarded-for on the subrequest | wrong-ip a new address every time | leaky R plus
 *   x-real-ip: R on the subrequest | silent never posts | dup-refuse, dup-refuse-stale no entrance for repeated
 *   CF-Connecting-IP lines (the adapter's refusal), -stale with cf-cache-status STALE | reject-cf 403 "error code:
 *   1000" when CF-Connecting-IP is present | reject-any the same for any forwarding header | reject-1020 code 1020 |
 *   ratelimit every request after the first gets 429 "error code: 1015" | reject-then-block reject-cf, and no entrance
 *   at all after the first rejection | wrong-reject reject-cf, else wrong-ip | cached-reject reject-cf, else a cache HIT
 *   without an entrance | noisy honest, plus an entrance for another page on the third eligible request | late honest,
 *   but the first entrance is posted 2.5 s late | trickle the first response trickles its body for 6 s.
 */
function provSite(host, canaryPort, mode, R) {
  const state = { requests: 0, eligible: 0, nonces: new Set(), noCache: 0, dupOrders: [], rejected: 0 };
  let n = 0;
  const server = http.createServer((req, res) => {
    state.requests++;
    const url = new URL(req.url, "http://site.invalid");
    const h = req.headers;
    const cf = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "cf-connecting-ip") cf.push(req.rawHeaders[i + 1]);
    if (cf.length >= 2) state.dupOrders.push(cf.join(","));
    if (url.searchParams.has("idrprov")) state.nonces.add(url.searchParams.get("idrprov"));
    if (h["cache-control"] === "no-cache") state.noCache++;
    const cfPage = (status, code) => res.writeHead(status, { "content-type": "text/plain", "cf-ray": RAY, server: "cloudflare" }).end(`error code: ${code}`);
    if (mode === "ratelimit" && state.requests > 1) return cfPage(429, 1015);
    if (["reject-cf", "reject-then-block", "wrong-reject", "cached-reject"].includes(mode) && cf.length > 0) return (state.rejected++, cfPage(403, 1000));
    if (mode === "reject-any" && FWD_HEADERS.some((x) => h[x] !== undefined)) return cfPage(403, 1000);
    if (mode === "reject-1020" && cf.length > 0) return cfPage(403, 1020);
    const eligible = req.method === "GET" && url.pathname === PROV_PAGE && /text\/html/.test(h.accept ?? "") && h["sec-fetch-dest"] === "document" && h["sec-fetch-mode"] === "navigate" && Boolean(h["user-agent"]) && !h.upgrade;
    const extraOut = mode === "cached-reject" ? { "cf-cache-status": "HIT" } : mode === "dup-refuse-stale" && cf.length >= 2 ? { "cf-cache-status": "STALE" } : {};
    res.writeHead(200, { "content-type": "text/html", "cf-ray": RAY, server: "cloudflare", ...extraOut });
    if (mode === "trickle" && state.requests === 1) {
      let k = 0;
      const t = setInterval(() => (++k > 20 ? (clearInterval(t), res.end()) : res.write(".")), 300);
      res.on("close", () => clearInterval(t));
    } else res.end("<!doctype html><html><body>page</body></html>");
    if (!eligible) return;
    if (mode === "silent" || mode === "cached-reject" || (mode.startsWith("dup-refuse") && cf.length >= 2) || (mode === "reject-then-block" && state.rejected > 0)) return;
    state.eligible++;
    n++;
    let ip = R;
    const extra = {};
    if (mode === "forged-cf" && cf.length > 0) ip = h["cf-connecting-ip"];
    if (mode === "forged-xff" && h["x-forwarded-for"]) ip = h["x-forwarded-for"].split(",")[0].trim();
    if (mode === "dup-first" && cf.length >= 2) ip = cf[0];
    if (mode === "dup-last" && cf.length >= 2) ip = cf[cf.length - 1];
    if (mode === "header-forward" && cf.length > 0) extra["x-forwarded-for"] = cf[0];
    if (mode === "wrong-ip" || mode === "wrong-reject") ip = `198.51.100.${100 + n}`; // a different address every time
    if (mode === "leaky") extra["x-real-ip"] = R;
    const send = () => void postEntrance(host, canaryPort, ip, url.pathname, extra);
    if (mode === "late" && n === 1) setTimeout(send, 2500);
    else send();
    if (mode === "noisy" && n === 3) void postEntrance(host, canaryPort, R, "/elsewhere");
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

/**
 * Stand-in for the canary's hosting edge, between the script and the canary: drops the named request headers (as an
 * edge that strips or overwrites them would), and can post a foreign entrance into the canary right after the n-th
 * /_canary/expect, before that answer reaches the script.
 */
function canaryEdge(host, canaryPort, { strip = [], injectAfterExpect = 0 } = {}) {
  let expects = 0;
  return http.createServer((req, res) => {
    const raw = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) if (!strip.includes(req.rawHeaders[i].toLowerCase())) raw.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    const inject = req.url === "/_canary/expect" && ++expects === injectAfterExpect;
    const out = http.request({ host, port: canaryPort, method: req.method, path: req.url, headers: raw }, (r) => {
      const parts = [];
      r.on("data", (c) => parts.push(c));
      r.on("end", async () => {
        if (inject) await postEntrance(host, canaryPort, PROV_R, "/elsewhere");
        res.writeHead(r.statusCode, r.headers).end(Buffer.concat(parts));
      });
    });
    out.on("error", () => res.destroy());
    req.pipe(out);
  });
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

/** One run of the script against the stand-ins (one stand-in site per mode); returns its output plus what each stand-in saw. */
async function runProv({ mode = "honest", family = 4, echo = [[PROV_R], [PROV_R]], echoRay = [true, false], env = {}, argv = (a) => a, canaryForged = PROV_F, edge = null } = {}) {
  const host = family === 6 ? "::1" : "127.0.0.1";
  const urlHost = family === 6 ? "[::1]" : "127.0.0.1";
  const R = echo[0][0];
  const { server: canary, state: canaryState } = createCanary(loadConfig({ CANARY_TOKEN: TOKEN, CANARY_BIND: host, PORT: "1", CANARY_FORGED_IP: canaryForged }));
  let canaryHits = 0;
  canary.on("request", () => canaryHits++);
  const canaryPort = await listenOn(canary, host);
  const edgeServer = edge ? canaryEdge(host, canaryPort, edge) : null;
  const edgePort = edgeServer ? await listenOn(edgeServer, host) : null;
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
      PROV_CANARY_URL: `http://${urlHost}:${edgePort ?? canaryPort}`,
      PROV_CANARY_TOKEN: TOKEN,
      PROV_ECHO_URLS: `http://${urlHost}:${p1}/cdn-cgi/trace,http://${urlHost}:${p2}/ip`,
      PROV_FORGED_IP: PROV_F,
      PROV_FORGED_IP2: PROV_F2,
      ...env,
    };
    const base = ["--local-probe", "--family", String(family), "--network-label", "selftest", "--confirm-target", sitePorts.map((p) => `${urlHost}:${p}`).reverse().join(","), "--out", outFile, ...FAST];
    const r = await spawnScript("lovable-provenance-check.mjs", argv(base), fullEnv);
    let file = "";
    let fileMode = null;
    try {
      file = readFileSync(outFile, "utf8");
      fileMode = statSync(outFile).mode & 0o777;
    } catch {
      /* no file (refusal) */
    }
    const left = { expectation: canaryState.expectedIp !== null, records: canaryState.records.length };
    return { ...r, file, fileMode, site: sites[0].state, sites: sites.map((s) => s.state), echoHits: [e1.state.requests, e2.state.requests], canaryHits, left };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const s of [...sites.map((x) => x.server), canary, e1.server, e2.server, ...(edgeServer ? [edgeServer] : [])]) await closeServer(s);
  }
}

/** Nothing the script prints or writes holds an IP literal (any spelling), a test address, a loopback host or the token. */
function assertNoProvLeak(r) {
  for (const [where, text] of [["stdout", r.stdout], ["stderr", r.stderr], ["--out file", r.file]]) {
    assert.deepEqual(ipLiterals(text), [], `${where} holds no IP literal`);
    for (const s of ["198.51.100", "203.0.113", "192.0.2.", "2001:db8", "127.0.0.1", TOKEN]) assert.ok(!text.toLowerCase().includes(s), `${where} must not contain ${s}`);
  }
}
/** L4: after every run that reached the canary, the canary holds no expectation (R) and no record. */
const assertCanaryLeftClean = (r, name = "") => assert.deepEqual(r.left, { expectation: false, records: 0 }, `${name}: the canary was reset at the end`);
const caseRe = (id, http, cfError, entrances, verdict, reason, site = "<site1>") => new RegExp(`^${site} net=selftest IPv4 ${id} http=${http} cf-error=${cfError} entrances=${entrances} => ${verdict}: ${reason}`, "m");
const overallRe = (text) => new RegExp(`^overall: ${text}`, "m");

test("lovable-provenance-check: refusals exit 2 and send nothing", async () => {
  let hits = 0;
  const servers = Array.from({ length: 4 }, () => http.createServer((q, s) => (hits++, s.end("x"))));
  const ports = [];
  for (const s of servers) ports.push(await listenOn(s, "127.0.0.1"));
  const dir = mkdtempSync(join(tmpdir(), "idr-prov-refuse-"));
  const existing = join(dir, "existing.json");
  writeFileSync(existing, "earlier evidence");
  symlinkSync(existing, join(dir, "link.json"));
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
  const ok6 = ok.map((a) => (a === "4" ? "6" : a));
  const HTTPS = { ...L, PROV_SITE_URLS: "https://staging.example.com,https://www.example.com", PROV_CANARY_URL: "https://canary.example.org", PROV_ECHO_URLS: "https://echo-a.example.net/ip,https://echo-b.example.org/ip" };
  const httpsArgs = ["--family", "4", "--network-label", "home", "--confirm-target", "www.example.com,staging.example.com"];
  const refusals = [
    ["no variables", {}, ["--family", "4", "--network-label", "x", "--confirm-target", site], /missing required environment variable\(s\): PROV_SITE_URLS, PROV_PAGE_PATH, PROV_CANARY_URL, PROV_CANARY_TOKEN, PROV_ECHO_URLS, PROV_FORGED_IP, PROV_FORGED_IP2/],
    ["no --family", L, ok.filter((a, i) => i !== 1 && i !== 2), /--family 4 or --family 6/],
    ["PROV_FORGED_IP6 without PROV_FORGED_IP6B", { ...L, PROV_FORGED_IP6: "2001:db8::9" }, ok6, /missing required environment variable\(s\): PROV_FORGED_IP6B/],
    ["http without --local-probe", L, ok.slice(1), /must use https/],
    ["L2: --local-probe with https targets", HTTPS, ["--local-probe", ...httpsArgs], /--local-probe accepts loopback http targets only/],
    ["no --confirm-target", L, ok.slice(0, -2), /--confirm-target <host> is required/],
    ["mismatched --confirm-target", L, [...ok.slice(0, -1), "127.0.0.1:1"], /does not match/],
    ["only one of two entry points confirmed", HTTPS, [...httpsArgs.slice(0, -1), "staging.example.com"], /must name every entry-point host \(2\)/],
    ["a wrong host among two confirmed", HTTPS, [...httpsArgs.slice(0, -1), "staging.example.com,other.example.com"], /does not match/],
    ["documentation-range F outside --local-probe", HTTPS, httpsArgs, /PROV_FORGED_IP is in a documentation range \(RFC 5737, RFC 3849, RFC 9637\)\. The adapter refuses those addresses/],
    ["a private F", { ...HTTPS, PROV_FORGED_IP: "10.1.2.3" }, httpsArgs, /PROV_FORGED_IP is private, reserved or otherwise not public/],
    ["L5: an F6 with a zone id", { ...L, PROV_FORGED_IP6: "2001:db8::9%1", PROV_FORGED_IP6B: "2001:db8::a" }, ok6, /PROV_FORGED_IP6 must be a plain address: no zone id/],
    ["L5: an F with a zone id", { ...L, PROV_FORGED_IP: `${PROV_F}%eth0` }, ok, /PROV_FORGED_IP must be a plain address: no zone id/],
    ["L5: a bracketed PROV_TESTER_IP", { ...L, PROV_TESTER_IP: `[${PROV_R}]` }, ok, /PROV_TESTER_IP must be a plain address: no zone id \(%\), brackets/],
    ["F equal to PROV_TESTER_IP", { ...L, PROV_TESTER_IP: PROV_F }, ok, /a forged value equals PROV_TESTER_IP/],
    ["F equal to F2", { ...L, PROV_FORGED_IP2: PROV_F }, ok, /must differ/],
    ["H1: a rate-limit code as an edge rejection", { ...L, PROV_EDGE_REJECT_CODES: "1000,1015" }, ok, /PROV_EDGE_REJECT_CODES lists 1015: .*never show that the forged header was refused/],
    ["H1: a firewall code as an edge rejection", { ...L, PROV_EDGE_REJECT_CODES: "1020" }, ok, /PROV_EDGE_REJECT_CODES lists 1020/],
    ["H1: a 5xx as an edge rejection", { ...L, PROV_EDGE_REJECT_CODES: "1000,502" }, ok, /PROV_EDGE_REJECT_CODES lists 502/],
    ["an address as network label", L, ok.map((a) => (a === "selftest" ? PROV_R : a)), /--network-label is required/],
    ["an unknown flag", L, [...ok, "--confirm-targt", site], /unknown or positional argument/],
    ["L6: a numeric flag without a value", L, [...ok, "--poll-timeout-s", "--settle-ms", "0"], /--poll-timeout-s needs a value/],
    ["an ineligible page path", { ...L, PROV_PAGE_PATH: "/api/page" }, ok, /never reports/],
    ["L6: /_serverFn (the adapter's INTERNAL_LEADING rule)", { ...L, PROV_PAGE_PATH: "/_serverFn" }, ok, /never reports/],
    ["L6: the collector path", { ...L, PROV_PAGE_PATH: "/idr/e/" }, ok, /never reports/],
    ["M2: a page path the page_key mapper would change", { ...L, PROV_PAGE_PATH: "/blog/2026" }, ok, /lowercase words .*page_key equals the path/],
    ["a placeholder", { ...L, PROV_CANARY_URL: "https://<canary-host>" }, ok, /still contains a <placeholder>/],
    ["a short canary token", { ...L, PROV_CANARY_TOKEN: "short" }, ok, /at least 32 printable characters/],
    ["an echo URL on the site's host", { ...L, PROV_ECHO_URLS: `http://${site}/ip,http://127.0.0.1:${ports[3]}/ip` }, ok, /distinct hosts/],
    ["L3: --out naming an existing file", L, [...ok, "--out", existing], /--out must name a new file/],
    ["L3: --out naming a symlink", L, [...ok, "--out", join(dir, "link.json")], /--out must name a new file/],
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
    assert.equal(readFileSync(existing, "utf8"), "earlier evidence", "L3: the existing file and the symlink's target are untouched");
    const dry = await spawnScript("lovable-provenance-check.mjs", ["--dry-run", ...ok], L);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /^dry-run: configuration valid; nothing was sent$/m);
    assert.match(dry.stdout, /entry points <site1>; per entry point, serially: P1, P2, P3a, P3b, P3c, P3d, P4a, P4b, P5, then P7/);
    assert.match(dry.stdout, /edge-rejection codes 1000;.*settle 8000 ms/);
    assertNoProvLeak({ ...dry, file: "" });
    const collectorChild = await spawnScript("lovable-provenance-check.mjs", ["--dry-run", ...ok], { ...L, PROV_PAGE_PATH: "/idr/e/x" });
    assert.equal(collectorChild.status, 0, "L6: /idr/e/x is eligible for the adapter, so it is accepted");
    assert.equal(hits, 0, "no refusal and no dry run contacted any server");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const s of servers) await closeServer(s);
  }
});

test("lovable-provenance-check: the page-path lists are the adapter's own (eligibility.ts, collector-path.ts)", () => {
  const src = (p) => readFileSync(join(HERE, "../../../packages/tanstack/src", p), "utf8");
  const script = readFileSync(join(HERE, "lovable-provenance-check.mjs"), "utf8");
  const adapter = src("eligibility.ts") + src("collector-path.ts");
  const def = (text, name) => {
    const m = new RegExp(`^(?:export )?const ${name} = (.+);$`, "m").exec(text);
    assert.ok(m, `${name} defined`);
    return m[1];
  };
  for (const name of ["ASSET_EXTENSION", "INTERNAL_PREFIXES", "INTERNAL_LEADING", "API_PREFIXES", "HEALTH_PREFIXES", "DEFAULT_COLLECTOR_PATH"]) assert.equal(def(script, name), def(adapter, name), `${name} drifted from the adapter`);
  const serverFn = def(script, "SERVER_FN_PATH");
  assert.ok(src("eligibility.ts").includes(`if (${serverFn}.test(path)) return no("server_fn");`), "SERVER_FN_PATH drifted from the adapter");
});

test("lovable-provenance-check: an honest site (the edge sets R) is a PASS on every case; P4 goes out as two raw lines in both orders", async () => {
  const r = await runProv({ mode: "honest" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of CASE_IDS) assert.match(r.stdout, caseRe(id, 200, "-", 1, "PASS", "ip == R$"), id);
  assert.match(r.stdout, /^echo start \(IPv4\): <echo1> via_cloudflare=true, <echo2> via_cloudflare=false: agree$/m);
  assert.match(r.stdout, /^canary: token accepted, records compared, its CANARY_FORGED_IP is this run's F; G4-I8 observability: F seen at the canary in cf-connecting-ip, x-forwarded-for, x-real-ip, true-client-ip, forwarded, x-client-ip; no blind spot$/m);
  assert.match(r.stdout, /^<site1> net=selftest IPv4 P7 runtime => INFO: cf-ray present=true value=7a1b2c3d4e5f6a7b-AMS; server cloudflare=true/m);
  assert.match(r.stdout, /^<site1> net=selftest IPv4 headers => INFO: names on the entrance subrequest\(s\) at the canary: accept, authorization, connection, content-length, content-type, host; outside the allowlist \(review\): none$/m);
  assert.match(r.stdout, /^echo end \(IPv4\): .*: agree, and equal to the start$/m);
  assert.match(r.stdout, overallRe("PASS \\(9 of 9 cases run: 9 PASS \\[0 by edge rejection, 0 by adapter refusal\\], 0 FAIL, 0 HOLD, 0 INCONCLUSIVE; 0 run problem\\(s\\)\\) \\[local probe: stand-in servers, no claim about any platform\\]$"));
  assert.deepEqual([r.site.requests, r.site.eligible, r.site.nonces.size, r.site.noCache], [9, 9, 9, 9], "serial, eligible, cache-busted, no-cache");
  assert.deepEqual(r.site.dupOrders, [`${PROV_F},${PROV_F2}`, `${PROV_F2},${PROV_F}`], "P4a and P4b: two raw header lines, in both orders");
  assert.deepEqual(r.echoHits, [2, 2], "every echo URL at start and at end");
  assert.equal(r.fileMode, 0o600);
  const doc = JSON.parse(r.file);
  assert.deepEqual([doc.overall, doc.cases.length, doc.forgedValue, doc.echo.start.map((e) => e.viaCloudflare)], ["PASS", 9, "F", [true, false]]);
  assert.deepEqual(doc.summary, { pass: 9, pass_by_edge_rejection: 0, pass_by_adapter_refusal: 0, fail: 0, hold: 0, inconclusive: 0 });
  assert.deepEqual(doc.g4i8Coverage.blind, []);
  assertCanaryLeftClean(r, "honest");
  assertNoProvLeak(r);
});

test("lovable-provenance-check (M1): FAIL only when the canary identifies F; P4 is sent in both orders", async () => {
  const table = [
    ["forged-cf", "P2", 2, "the canary identified F as the entrance ip: a client-forged value was selected"],
    ["forged-xff", "P3a", 3, "the canary identified F as the entrance ip"],
    ["dup-first", "P4a", 7, "the canary identified F as the entrance ip"],
    ["dup-last", "P4b", 8, "the canary identified F as the entrance ip"],
    ["header-forward", "P2", 2, "header\\(s\\) x-forwarded-for on the subrequest carry F: a client-supplied value reached the resolver"],
  ];
  const runs = await Promise.all(table.map(([mode]) => runProv({ mode })));
  table.forEach(([mode, id, ran, reason], i) => {
    const r = runs[i];
    assert.equal(r.status, 1, `${mode}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, caseRe(id, 200, "-", 1, "FAIL", reason), mode);
    assert.match(r.stdout, overallRe(`FAIL \\(${ran} of 9 cases run`), mode);
    assert.equal(r.site.requests, ran, `${mode}: the run stops at the FAIL`);
    assert.deepEqual(r.echoHits, [2, 2], `${mode}: the end egress check still runs`);
    assertCanaryLeftClean(r, mode);
    assertNoProvLeak(r);
  });
  // dup-last selects the second line: F2 in P4a (not identifiable: HOLD), F in P4b (identified: FAIL).
  assert.match(runs[3].stdout, caseRe("P4a", 200, "-", 1, "HOLD", "unexpected address in P4a: neither R nor F \\(the canary cannot name it\\)"));
});

test("lovable-provenance-check (M1): an address that is neither R nor F is a HOLD naming the case, never a FAIL", async () => {
  const r = await runProv({ mode: "wrong-ip" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, caseRe("P1", 200, "-", 1, "HOLD", "entrance ip != R in P1: wrong provenance, investigate"));
  assert.match(r.stdout, caseRe("P2", 200, "-", 1, "HOLD", "unexpected address in P2: neither R nor F"));
  assert.match(r.stdout, caseRe("P4b", 200, "-", 1, "HOLD", "unexpected address in P4b"));
  assert.match(r.stdout, overallRe("HOLD \\(9 of 9 cases run: 0 PASS .*0 FAIL, 9 HOLD"));
  assertCanaryLeftClean(r, "wrong-ip");
  assertNoProvLeak(r);
});

test("lovable-provenance-check (H1): an edge rejection counts for P2 and P4 only, as an allowed 4xx with cf-ray, bracketed by passing baselines", async () => {
  const [ok, any, c1020, rate, block, wrong] = await Promise.all(["reject-cf", "reject-any", "reject-1020", "ratelimit", "reject-then-block", "wrong-reject"].map((mode) => runProv({ mode })));
  const edgePass = "edge rejection \\(HTTP 403, Cloudflare error 1000\\); the re-baseline right after it passed \\(ip == R\\)";
  for (const id of ["P2", "P4a", "P4b"]) assert.match(ok.stdout, caseRe(id, 403, 1000, 0, "PASS \\(by edge rejection\\)", edgePass), id);
  assert.match(ok.stdout, caseRe("P5", 403, 1000, 0, "INCONCLUSIVE", "HTTP 403, Cloudflare error 1000: an edge rejection does not count for P5 \\(owner's matrix: P2 and P4 only\\)"));
  assert.match(ok.stdout, overallRe("HOLD \\(9 of 9 cases run: 8 PASS \\[3 by edge rejection, 0 by adapter refusal\\], 0 FAIL, 0 HOLD, 1 INCONCLUSIVE"));
  assert.equal(ok.site.requests, 12, "three re-baselines");
  assert.deepEqual(JSON.parse(ok.file).summary.pass_by_edge_rejection, 3);
  assert.match(any.stdout, caseRe("P3a", 403, 1000, 0, "INCONCLUSIVE", "HTTP 403, Cloudflare error 1000: an edge rejection does not count for P3a"));
  assert.match(c1020.stdout, caseRe("P2", 403, 1020, 0, "INCONCLUSIVE", "HTTP 403, Cloudflare error 1020: not a qualifying edge rejection \\(Cloudflare error 1020 is not in PROV_EDGE_REJECT_CODES\\)"));
  // The reviewer's probe: P1 passes, then every request is rate limited. Never a PASS.
  assert.match(rate.stdout, caseRe("P2", 429, 1015, 0, "INCONCLUSIVE", "HTTP 429, Cloudflare error 1015: not a qualifying edge rejection \\(HTTP 429 \\(rate limited\\) never counts\\)"));
  assert.match(block.stdout, caseRe("P2", 403, 1000, 0, "INCONCLUSIVE", "edge rejection \\(HTTP 403, Cloudflare error 1000\\), but the re-baseline right after it did not pass \\(INCONCLUSIVE: 2xx page but no entrance"));
  assert.match(wrong.stdout, caseRe("P2", 403, 1000, 0, "INCONCLUSIVE", "edge rejection \\(HTTP 403, Cloudflare error 1000\\), and P1 did not pass on this entry point"));
  for (const r of [ok, any, c1020, rate, block, wrong]) {
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(!/^overall: PASS/m.test(r.stdout), r.stdout);
    assertCanaryLeftClean(r);
    assertNoProvLeak(r);
  }
});

test("lovable-provenance-check (L1): P4 without an entrance counts only when the Worker ran (no cache-served status) and a re-baseline passes", async () => {
  const [refuse, stale] = await Promise.all(["dup-refuse", "dup-refuse-stale"].map((mode) => runProv({ mode })));
  for (const id of ["P4a", "P4b"]) assert.match(refuse.stdout, caseRe(id, 200, "-", 0, "PASS \\(by adapter refusal\\)", "2xx page, no entrance: the repeated values were refused \\(adapter level\\); the re-baseline right after it passed"), id);
  assert.equal(refuse.status, 0, refuse.stdout + refuse.stderr);
  assert.match(refuse.stdout, overallRe("PASS \\(9 of 9 cases run: 9 PASS \\[0 by edge rejection, 2 by adapter refusal\\]"));
  assert.match(stale.stdout, caseRe("P4a", 200, "-", 0, "INCONCLUSIVE", "2xx page, no entrance, cf-cache-status STALE: possibly served without the Worker"));
  assert.equal(stale.status, 1);
  for (const r of [refuse, stale]) assertNoProvLeak(r);
});

test("lovable-provenance-check: a subrequest header carrying the visitor IP is a G4-I8 FAIL; no entrance at all is never a PASS", async () => {
  const [leaky, silent] = await Promise.all(["leaky", "silent"].map((mode) => runProv({ mode })));
  assert.equal(leaky.status, 1, leaky.stdout + leaky.stderr);
  assert.match(leaky.stdout, caseRe("P1", 200, "-", 1, "FAIL", "G4-I8: header\\(s\\) x-real-ip on the subrequest carry a visitor IP"));
  assert.match(leaky.stdout, overallRe("FAIL \\(1 of 9 cases run"));
  assert.equal(silent.status, 1, silent.stdout + silent.stderr);
  assert.match(silent.stdout, caseRe("P1", 200, "-", 0, "INCONCLUSIVE", "2xx page but no entrance within 1 s"));
  assert.match(silent.stdout, caseRe("P4a", 200, "-", 0, "INCONCLUSIVE", "2xx page, no entrance, and P1 did not pass on this entry point"));
  assert.match(silent.stdout, overallRe("HOLD \\(9 of 9 cases run: 0 PASS .*9 INCONCLUSIVE"));
  for (const r of [leaky, silent]) {
    assertCanaryLeftClean(r);
    assertNoProvLeak(r);
  }
});

test("lovable-provenance-check (M2): foreign traffic before or during a case is INCONCLUSIVE; a late entrance is a HOLD", async () => {
  // P1's entrance in mode late arrives 2.5 s after the request: after P1 was scored (poll timeout 1 s), before P2's
  // reset (3 s later).
  const [before, during, late] = await Promise.all([runProv({ edge: { injectAfterExpect: 3 } }), runProv({ mode: "noisy" }), runProv({ mode: "late", argv: (a) => [...a, "--delay-ms", "3000"] })]);
  // expect #1 is the pre-flight, #2 is P1, #3 is P2: a record lands right after P2's reset, so P2 is not sent.
  assert.match(before.stdout, caseRe("P2", "not-sent", "-", 0, "INCONCLUSIVE", "foreign traffic: 1 record\\(s\\) at the canary right after the reset; the request was not sent"));
  assert.equal(before.site.requests, 8);
  assert.match(during.stdout, caseRe("P3a", 200, "-", 1, "INCONCLUSIVE", "foreign traffic: 1 record\\(s\\) for another page or route during the case"));
  for (const r of [before, during]) {
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, overallRe("HOLD "));
    assertCanaryLeftClean(r);
    assertNoProvLeak(r);
  }
  assert.equal(late.status, 1, late.stdout + late.stderr);
  assert.match(late.stdout, /^<site1> net=selftest IPv4 P1 late => HOLD: late entrance: 1 record\(s\) arrived after the case was scored$/m);
  assert.match(late.stdout, overallRe("HOLD \\(9 of 9 cases run: 8 PASS .*1 HOLD"));
  assert.equal(JSON.parse(late.file).cases[0].verdict, "HOLD");
  assertNoProvLeak(late);
});

test("lovable-provenance-check (M3): a watched header the canary's edge strips is a G4-I8 blind spot and the run is a HOLD", async () => {
  const r = await runProv({ edge: { strip: ["x-real-ip"] } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /G4-I8 observability: F seen at the canary in cf-connecting-ip, x-forwarded-for, true-client-ip, forwarded, x-client-ip; blind spots: x-real-ip$/m);
  assert.match(r.stdout, /^problem: G4-I8 coverage incomplete: x-real-ip \(stripped or overwritten before the canary/m);
  assert.match(r.stdout, overallRe("HOLD \\(9 of 9 cases run: 9 PASS .*1 run problem\\(s\\)\\)"));
  assert.deepEqual(JSON.parse(r.file).g4i8Coverage.blind, ["x-real-ip"]);
  assertCanaryLeftClean(r);
  assertNoProvLeak(r);
});

test("lovable-provenance-check: echo disagreement, a Cloudflare-only ground truth, or a moved egress is never a PASS", async () => {
  const other = "198.51.100.8";
  const [start, cfOnly, moved, tester] = await Promise.all([
    runProv({ echo: [[PROV_R], [other]] }),
    runProv({ echoRay: [true, true] }),
    runProv({ echo: [[PROV_R, other], [PROV_R, other]] }),
    runProv({ env: { PROV_TESTER_IP: other } }),
  ]);
  assert.match(start.stdout, /^echo start \(IPv4\): <echo1> via_cloudflare=true, <echo2> via_cloudflare=false: the echo answers disagree$/m);
  assert.match(start.stdout, overallRe("HOLD \\(0 of 9 cases run"));
  assert.match(cfOnly.stdout, /no echo answer came from outside Cloudflare/);
  assert.match(tester.stdout, /PROV_TESTER_IP differs from the echoed address/);
  for (const r of [start, cfOnly, tester]) assert.deepEqual([r.site.requests, r.canaryHits], [0, 0], "stopped before contacting the site or the canary");
  assert.match(moved.stdout, /^echo end \(IPv4\): .*: the address changed during the run$/m);
  assert.match(moved.stdout, overallRe("HOLD \\(9 of 9 cases run: 9 PASS .*1 run problem\\(s\\)\\)"));
  for (const r of [start, cfOnly, moved, tester]) {
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assertNoProvLeak(r);
  }
});

test("lovable-provenance-check: configuration errors after the echo checks (F == R, a refused token, a canary without F) exit 2 before the site", async () => {
  const [same, token, other, fam] = await Promise.all([
    runProv({ env: { PROV_FORGED_IP: PROV_R } }),
    runProv({ env: { PROV_CANARY_TOKEN: `${TOKEN}0123456789abcdef` } }), // a different (longer) synthetic token
    runProv({ canaryForged: "192.0.2.99" }), // the canary's CANARY_FORGED_IP is not this run's F
    // --family 6 against IPv4-only stand-ins: every request is pinned and the socket family is checked (EFAMILY).
    runProv({ argv: (a) => a.map((x) => (x === "4" ? "6" : x)) }),
  ]);
  assert.match(same.stdout, /a forged value equals the tester's own address R/);
  assert.deepEqual([same.site.requests, same.canaryHits], [0, 0], "nothing sent to the site or the canary");
  assert.match(token.stdout, /canary self-check failed \(CANARY_HTTP_401\): stopped before contacting the site/);
  assert.match(other.stdout, /the canary's CANARY_FORGED_IP is not PROV_FORGED_IP: .*Stopped before contacting the site/);
  assertCanaryLeftClean(other, "a canary without F");
  for (const r of [same, token, other]) {
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, overallRe("CONFIG-ERROR"));
    assert.equal(r.site.requests, 0);
    assertNoProvLeak(r); // also covers the wrong token, which starts with TOKEN
  }
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
  s2("P1", 200, "-", "2xx page, no entrance, cf-cache-status HIT: possibly served without the Worker");
  s2("P3a", 200, "-", "2xx page, no entrance, cf-cache-status HIT");
  for (const id of ["P2", "P4a", "P4b"]) s2(id, 403, 1000, "edge rejection \\(HTTP 403, Cloudflare error 1000\\), and P1 did not pass on this entry point");
  s2("P5", 403, 1000, "HTTP 403, Cloudflare error 1000: an edge rejection does not count for P5");
  assert.match(r.stdout, /^<site2> net=selftest IPv4 headers => INFO: no entrance reached the canary: no header evidence$/m);
  assert.match(r.stdout, overallRe("HOLD \\(18 of 18 cases run: 9 PASS .*9 INCONCLUSIVE"));
  assert.deepEqual(r.sites.map((s) => s.requests), [9, 9]);
  assertNoProvLeak(r);
});

test("lovable-provenance-check (L6): a response that trickles past the request deadline ends with EDEADLINE", async () => {
  const t0 = Date.now();
  const r = await runProv({ mode: "trickle", argv: (a) => [...a, "--request-deadline-s", "1"] });
  assert.match(r.stdout, caseRe("P1", "error:EDEADLINE", "-", 1, "HOLD", "an entrance although the site answered EDEADLINE"));
  assert.match(r.stdout, caseRe("P2", 200, "-", 1, "PASS", "ip == R"));
  assert.ok(Date.now() - t0 < 30_000, "the run did not wait for the trickling body");
  assertNoProvLeak(r);
});

test("lovable-provenance-check: IPv6 (P6) honest run over ::1 forges the canary's F over IPv6 and is a PASS", async (t) => {
  const probe = http.createServer();
  const v6 = await new Promise((r) => probe.once("error", () => r(false)).listen(0, "::1", () => probe.close(() => r(true))));
  if (!v6) return t.skip("no IPv6 loopback in this environment");
  const r = await runProv({ family: 6, echo: [["2001:db8::7"], ["2001:DB8:0:0::7"]], env: { PROV_FORGED_IP6: "2001:db8::9", PROV_FORGED_IP6B: "2001:db8::a" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of CASE_IDS) assert.match(r.stdout, new RegExp(`^<site1> net=selftest IPv6 P6-${id} http=200 cf-error=- entrances=1 => PASS: ip == R`, "m"), id);
  assert.match(r.stdout, /^note: PROV_FORGED_IP6 is not the canary's CANARY_FORGED_IP: the F6 cases were skipped/m);
  assert.match(r.stdout, overallRe("PASS "));
  assert.ok(!/::1|\[::/.test(r.stdout + r.file));
  assertCanaryLeftClean(r);
  assertNoProvLeak(r);
});
