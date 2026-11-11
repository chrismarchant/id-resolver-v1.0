// Lifecycle probe harness: local sink server + the built app (wrangler dev /
// workerd for the Cloudflare build, plain node for the node-server build) +
// timed requests. Prints one JSON document.
//
//   npm run build && node harness.mjs                       # Cloudflare build under workerd
//   NITRO_PRESET=node-server npm run build && PROBE_TARGET=node node harness.mjs
//
// Limit (G4-I8): local workerd / miniflare and the Node target show only the headers the adapter sets on its
// outbound requests. They cannot show what the Cloudflare production edge adds to a Worker subrequest (for example
// CF-Connecting-IP or X-Real-IP carrying the visitor's IP). Nothing here supports a D4 transport-isolation claim;
// the staging test T5 on the real edge decides (docs/staging/CLOUDFLARE_TEST_SITE.md, section 4).
import http from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SINK_PORT = 4599;
const APP_PORT = 8799;
const TARGET = process.env.PROBE_TARGET === "node" ? "node" : "cloudflare";
// SINK_MODE: ok (default) | 500 | hang (never answers) | down (nothing listens)
const SINK_MODE = process.env.SINK_MODE ?? "ok";
const received = [];
const sink = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    received.push({ at: performance.now(), url: req.url, hasBearer: /^Bearer \S{32,}$/.test(req.headers.authorization ?? ""), body: JSON.parse(b || "{}") });
    if (SINK_MODE === "hang") return;
    if (SINK_MODE === "500") return res.writeHead(500, { "content-type": "application/json" }).end('{"version":"1","error":"internal"}');
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: "1", status: "ineligible", source: "none", recorded: false }));
  });
});
if (SINK_MODE !== "down") await new Promise((r) => sink.listen(SINK_PORT, "127.0.0.1", r));

// The build stamps today's date as the Worker's compatibility date; the pinned workerd binary only accepts dates up to
// its own release, so run the Worker at the date the pinned workerd package declares (see test/hygiene.test.ts).
const WORKERD_DATE = TARGET === "node" ? "" : createRequire(import.meta.url)("workerd").compatibilityDate;
const cmd =
  TARGET === "node"
    ? ["node", [".output/server/index.mjs"]]
    : ["npx", ["wrangler", "dev", "-c", ".output/server/wrangler.json", "--compatibility-date", WORKERD_DATE, "--port", String(APP_PORT), "--ip", "127.0.0.1", "--local", "--var", "IDR_ENV_PROBE:present"]];
const wr = spawn(cmd[0], cmd[1], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", PORT: String(APP_PORT), HOST: "127.0.0.1", NITRO_PORT: String(APP_PORT), NITRO_HOST: "127.0.0.1", IDR_ENV_PROBE: "present" },
});
let log = "";
wr.stdout.on("data", (d) => (log += d));
wr.stderr.on("data", (d) => (log += d));
const base = `http://127.0.0.1:${APP_PORT}`;
// Without Accept: text/html TanStack answers "Only HTML requests are supported here" with an empty body.
const HTML = { headers: { accept: "text/html", "user-agent": "Mozilla/5.0 probe" } };
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${base}/m/none/warm`, HTML)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
for (let i = 0; i < 3; i++) await (await fetch(`${base}/m/none/warm${i}`, HTML)).text();
received.length = 0;

const out = { sinkMode: SINK_MODE, target: TARGET, node: process.version, lifecycle: [], idrPackage: null, collectorRoute: null, collectorBrowser: null };

// A. Raw lifecycle modes (300 ms delayed POST to the sink).
const modes = ["none", "unawaited", "awaited", "cfworkers", "request", "event"];
for (const mode of SINK_MODE === "ok" ? modes : []) {
  const id = `${mode}x`;
  const t0 = performance.now();
  const res = await fetch(`${base}/m/${mode}/${id}`, HTML);
  const ttfb = performance.now() - t0;
  const body = await res.text();
  const total = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 1500));
  const hit = received.find((r) => r.body.id === id);
  const diag = await (await fetch(`${base}/diag/${id}`, HTML)).json();
  out.lifecycle.push({
    mode, status: res.status, ttfb_ms: Math.round(ttfb), total_ms: Math.round(total), pageRendered: body.includes("probe page"),
    sink_received: !!hit,
    sink_arrival_after_response_complete_ms: hit ? Math.round(hit.at - (t0 + total)) : null,
    diag,
  });
}

// B. The real package, registered as documented, with a browser-like request.
// (wrangler dev may overwrite CF-Connecting-IP with the local client address;
// the hook result below shows what the package decided.)
const BROWSER = { headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (X11; Linux x86_64) probe", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "cf-connecting-ip": "198.51.100.23", "x-forwarded-for": "198.51.100.23", referer: "https://www.example.org/x" } };
received.length = 0;
// node:http, because fetch (undici) forces Sec-Fetch-Mode to "cors".
function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.get({ host: "127.0.0.1", port: APP_PORT, path, headers }, (res) => {
      const ttfb = performance.now() - t0;
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, ttfb, body: b }));
    });
    req.on("error", reject);
  });
}
{
  const r = await rawGet("/landing/page?utm_medium=email&secret=1", BROWSER.headers);
  await new Promise((x) => setTimeout(x, SINK_MODE === "hang" ? 12000 : 1500));
  const hit = received.find((x) => x.body.contract === "entrance.v1");
  out.idrPackage = {
    status: r.status, ttfb_ms: Math.round(r.ttfb), pageRendered: r.body.includes("landing"),
    sinkGotEntrance: !!hit, sinkUrl: hit?.url ?? null, sinkHasBearer: hit?.hasBearer ?? null,
    payload: hit ? { ...hit.body, ip: "<redacted-in-log>" } : null,
    hookResults: (await (await fetch(`${base}/diag/idr`, HTML)).json()).filter((x) => !x.includes("excluded_path")),
  };
}
// C. The first-party collector route (createCollectorRoute, src/routes/idr.e.ts) on the same runtime.
//    A browser-shaped POST plus hostile headers, a cross-site POST, and (when Chrome is available) a real browser
//    loading the page so that the collector bundle in __root.tsx sends its own beacon.
function rawPost(path, headers, body) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request({ host: "127.0.0.1", port: APP_PORT, path, method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
      const ttfb = performance.now() - t0;
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, ttfb, body: b, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(22)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b & 63]).join("");
const SECRETS = ["198.51.100.23", "203.0.113.9", "192.0.2.44", "secret-cookie", "SecretAgent", "secret-ref"];
const HOSTILE = { "cf-connecting-ip": "198.51.100.23", "x-forwarded-for": "203.0.113.9", "x-real-ip": "192.0.2.44", cookie: "sid=secret-cookie", "user-agent": "SecretAgent/1.0", referer: `${base}/secret-ref?x=1` };
const ORIGIN_OK = { origin: base, "sec-fetch-site": "same-origin", "content-type": "text/plain;charset=UTF-8" };
if (SINK_MODE === "ok" || SINK_MODE === "500") {
  received.length = 0;
  const ev = { v: 1, event_id: randomId(), occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), type: "conversion_intent", name: "cta_click", path: "/orders/12345", consent: "not_required" };
  const accepted = await rawPost("/idr/e", { ...ORIGIN_OK, ...HOSTILE }, JSON.stringify(ev));
  const replay = await rawPost("/idr/e", ORIGIN_OK, JSON.stringify(ev));
  const crossSite = await rawPost("/idr/e", { ...ORIGIN_OK, origin: "https://evil.example.net", "sec-fetch-site": "cross-site" }, JSON.stringify({ ...ev, event_id: randomId() }));
  const withQuery = await rawPost("/idr/e", ORIGIN_OK, JSON.stringify({ ...ev, event_id: randomId(), path: "/pricing?email=x" }));
  await new Promise((x) => setTimeout(x, 1500));
  const events = received.filter((x) => x.url === "/v1/events");
  out.collectorRoute = {
    accepted: { status: accepted.status, ttfb_ms: Math.round(accepted.ttfb), body: accepted.body, setCookie: accepted.headers["set-cookie"] ?? null, cacheControl: accepted.headers["cache-control"] },
    replayStatus: replay.status, crossSiteStatus: crossSite.status, queryPathStatus: withQuery.status,
    sinkEvents: events.length, sinkUrl: events[0]?.url ?? null, sinkHasBearer: events[0]?.hasBearer ?? null,
    forwardedKeys: events[0] ? Object.keys(events[0].body).sort() : null,
    forwarded: events[0]?.body ?? null,
    forwardedContainsAnyHeaderValue: events.some((x) => SECRETS.some((s) => JSON.stringify(x.body).includes(s))),
    hookResults: (await (await fetch(`${base}/diag/idr`, HTML)).json()).filter((x) => x.includes('"route":"collector"')),
  };

  // Real browser: the page's own collector bundle sends a page_view beacon to /idr/e on this runtime.
  const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && existsSync(p));
  if (chrome) {
    received.length = 0;
    const profile = mkdtempSync(join(tmpdir(), "idr-probe-chrome-"));
    const ch = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `${base}/landing/browser-check`], { stdio: "ignore", detached: true });
    for (let i = 0; i < 100 && !received.some((x) => x.url === "/v1/events"); i++) await new Promise((x) => setTimeout(x, 100));
    await new Promise((x) => setTimeout(x, 500));
    try { process.kill(-ch.pid, "SIGKILL"); } catch {}
    rmSync(profile, { recursive: true, force: true });
    const ev2 = received.filter((x) => x.url === "/v1/events");
    out.collectorBrowser = { chrome: true, sinkEvents: ev2.length, forwarded: ev2.map((x) => x.body), hookResults: (await (await fetch(`${base}/diag/idr`, HTML)).json()).filter((x) => x.includes('"route":"collector"')).slice(-2) };
  } else {
    out.collectorBrowser = { chrome: false };
  }
}
console.log(JSON.stringify(out, null, 2));
console.log("--- process log tail ---");
console.log(log.split("\n").filter((l) => !/^\s+(GET|POST) http/.test(l)).slice(-12).join("\n"));
try { process.kill(-wr.pid, "SIGTERM"); } catch {}
if (SINK_MODE !== "down") sink.close();
process.exit(0);
