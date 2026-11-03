// Lifecycle probe harness: local sink server + the built app (wrangler dev /
// workerd for the Cloudflare build, plain node for the node-server build) +
// timed requests. Prints one JSON document.
//
//   npm run build && node harness.mjs                       # Cloudflare build under workerd
//   NITRO_PRESET=node-server npm run build && PROBE_TARGET=node node harness.mjs
import http from "node:http";
import { spawn } from "node:child_process";

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

const cmd =
  TARGET === "node"
    ? ["node", [".output/server/index.mjs"]]
    : ["npx", ["wrangler", "dev", "-c", ".output/server/wrangler.json", "--port", String(APP_PORT), "--ip", "127.0.0.1", "--local", "--var", "IDR_ENV_PROBE:present"]];
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

const out = { sinkMode: SINK_MODE, target: TARGET, node: process.version, lifecycle: [], idrPackage: null };

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
console.log(JSON.stringify(out, null, 2));
console.log("--- process log tail ---");
console.log(log.split("\n").filter((l) => !/^\s+(GET|POST) http/.test(l)).slice(-12).join("\n"));
try { process.kill(-wr.pid, "SIGTERM"); } catch {}
if (SINK_MODE !== "down") sink.close();
process.exit(0);
