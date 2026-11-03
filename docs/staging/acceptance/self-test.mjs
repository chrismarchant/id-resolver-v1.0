// Self-test of the staging acceptance scripts. Needs no credential and contacts nothing but 127.0.0.1.
//   node --test docs/staging/acceptance/self-test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCanary, headersContaining, loadConfig } from "./canary-sink.mjs";
import { Refusal, confirmTarget, hostInZone, makeRedactor, parseTarget, percentile, rawRequest } from "./lib/common.mjs";

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
    const res = await rawRequest(`${base}/_canary/results`, { headers: auth });
    assert.equal(res.status, 200);
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
