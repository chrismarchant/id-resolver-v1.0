/**
 * Development smoke test (CHR-72). Runs INSIDE the resolver's own deployment
 * environment so the bearer tokens are read from this service's environment
 * (sealed variables) and never leave it. Output is secret-free: check names,
 * HTTP statuses and pass/fail only. Tokens, IPs and response bodies are never
 * printed.
 *
 * Safety: refuses to run unless PROVIDER_MODE=mock. With a live provider, the
 * qualified-entrance checks would trigger paid lookups. That guard reads THIS
 * process's environment, so it can only vouch for a target that runs with
 * this environment; the target is therefore restricted (src/ops/smoke-target.ts,
 * CHR-66 N7):
 *   - private (every authenticated check): by default
 *     http://$RAILWAY_PRIVATE_DOMAIN:$PORT, this same service and environment;
 *     or SMOKE_BASE_URL, accepted only for a loopback host (127.0.0.1, [::1],
 *     localhost) or a *.railway.internal host (Railway's encrypted private
 *     network; for another service there, the operator asserts it runs with
 *     PROVIDER_MODE=mock). Any other host is refused (exit 2): the tokens
 *     would leave the private network, over http in clear text, and the guard
 *     would say nothing about that target's provider mode.
 *   - public: https://$RAILWAY_PUBLIC_DOMAIN, if set, for edge checks only
 *     (TLS, CORS, unauthenticated rejection; only a random wrong token is sent).
 *
 * Side effect: every run WRITES two synthetic observations (domain
 * example.com, page_key /smoke/<run>, acquisition direct) into the target's
 * activity store. They are ordinary reporting-feed items, so the Insights
 * projection fed by that deployment (the dev projection) receives them; filter
 * on the /smoke/ page_key prefix. They leave the resolver only through
 * retention like any other observation.
 *
 * Usage (inside the service): node dist/ops/smoke.js. Exit 0 = all passed,
 * 1 = a check failed, 2 = refused or misconfigured.
 */
import { randomBytes } from "node:crypto";
import { resolveSmokeTarget } from "./smoke-target.js";

interface Result {
  check: string;
  pass: boolean;
  detail: string;
}

const results: Result[] = [];
function record(check: string, pass: boolean, detail: string): void {
  results.push({ check, pass, detail });
  process.stdout.write(`${JSON.stringify({ event: "smoke_check", check, pass, detail })}\n`);
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");
const entranceId = () => randomBytes(16).toString("base64url");

async function call(base: string, path: string, init: RequestInit = {}): Promise<{ status: number; text: string; headers: Headers }> {
  const r = await fetch(`${base}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  if (env("PROVIDER_MODE") !== "mock") {
    process.stderr.write("smoke: refusing to run unless PROVIDER_MODE=mock (qualified checks would call a paid provider)\n");
    return 2;
  }
  const target = resolveSmokeTarget(process.env);
  if (!target.ok) {
    // The reason names variables and rules only, never their values.
    process.stderr.write(`smoke: refusing target: ${target.reason}\n`);
    return 2;
  }
  const websiteToken = env("RESOLVER_AUTH_TOKEN");
  const reportingToken = env("REPORTING_AUTH_TOKEN");
  const websiteId = env("WEBSITE_ID");
  const privateBase = target.base;
  const publicDomain = env("RAILWAY_PUBLIC_DOMAIN");
  if (!websiteToken || !reportingToken || !websiteId) {
    process.stderr.write("smoke: missing RESOLVER_AUTH_TOKEN, REPORTING_AUTH_TOKEN or WEBSITE_ID\n");
    return 2;
  }
  const wrong = randomHex(32);
  const json = { "content-type": "application/json" };
  const websiteAuth = { ...json, authorization: `Bearer ${websiteToken}` };
  const reportingAuth = { authorization: `Bearer ${reportingToken}` };
  const run = randomBytes(5).toString("hex");
  const pageKey = `/smoke/${run}`;
  const entrance = (ip: string, id = entranceId(), occurredAt = new Date()) => ({
    contract: "entrance.v1",
    website_id: websiteId,
    ip,
    entrance_id: id,
    occurred_at: occurredAt.toISOString(),
    page_key: pageKey,
    acquisition: "direct",
    eligibility: "tsa-1",
  });
  const post = (headers: Record<string, string>, body: unknown) => call(privateBase, "/v1/entrances", { method: "POST", headers, body: JSON.stringify(body) });

  // ---- liveness ---------------------------------------------------------
  record("private healthz 200", (await call(privateBase, "/healthz")).status === 200, "GET /healthz");
  record("private readyz 200 (database reachable)", (await call(privateBase, "/readyz")).status === 200, "GET /readyz");

  // ---- authentication and credential separation --------------------------
  let r = await post(json, entrance("203.0.113.10"));
  record("entrances without credential -> 401", r.status === 401, `status ${r.status}`);
  r = await post({ ...json, authorization: `Bearer ${wrong}` }, entrance("203.0.113.10"));
  record("entrances with wrong credential -> 401", r.status === 401, `status ${r.status}`);
  r = await post({ ...json, ...reportingAuth }, entrance("203.0.113.10"));
  record("reporting credential rejected on entrances -> 401", r.status === 401, `status ${r.status}`);
  r = await call(privateBase, "/v1/reporting/observations", { headers: { authorization: `Bearer ${websiteToken}` } });
  record("website credential rejected on feed -> 401", r.status === 401, `status ${r.status}`);
  r = await call(privateBase, "/v1/reporting/observations");
  record("feed without credential -> 401", r.status === 401, `status ${r.status}`);

  // ---- entrance resolution (mock provider; RFC 5737 synthetic addresses) ---
  const allowedKeys = ["recorded", "source", "status", "version"];
  r = await post(websiteAuth, entrance("203.0.113.10"));
  let b = parse(r.text);
  record("qualified entrance -> 200 qualified, recorded", r.status === 200 && b?.["status"] === "qualified" && b?.["recorded"] === true, `status ${r.status} result ${String(b?.["status"])}/${String(b?.["source"])}/recorded=${String(b?.["recorded"])}`);
  record("response carries no company data (D2: exactly version,status,source,recorded)", b !== undefined && JSON.stringify(Object.keys(b).sort()) === JSON.stringify(allowedKeys), `keys ${b ? Object.keys(b).sort().join(",") : "none"}`);
  const firstSource = String(b?.["source"]);

  const secondId = entranceId();
  r = await post(websiteAuth, entrance("203.0.113.10", secondId));
  b = parse(r.text);
  record("repeat address -> cache hit still records an observation", r.status === 200 && b?.["status"] === "qualified" && b?.["source"] === "cache" && b?.["recorded"] === true, `status ${r.status} result ${String(b?.["status"])}/${String(b?.["source"])}/recorded=${String(b?.["recorded"])}`);

  r = await post(websiteAuth, entrance("203.0.113.10", secondId));
  b = parse(r.text);
  record("replayed entrance_id -> 200 (idempotent)", r.status === 200 && b?.["status"] === "qualified", `status ${r.status}`);

  r = await post(websiteAuth, entrance("203.0.113.13"));
  b = parse(r.text);
  record("no-domain address -> no_match, nothing recorded", r.status === 200 && b?.["status"] === "no_match" && b?.["recorded"] === false, `status ${r.status} result ${String(b?.["status"])}`);

  r = await post(websiteAuth, entrance("10.0.0.1"));
  b = parse(r.text);
  record("private address -> ineligible, nothing recorded", r.status === 200 && b?.["status"] === "ineligible" && b?.["recorded"] === false, `status ${r.status} result ${String(b?.["status"])}`);

  r = await post(websiteAuth, entrance("203.0.113.10", entranceId(), new Date(Date.now() - 3_600_000)));
  record("occurred_at outside the 300 s window -> 400", r.status === 400, `status ${r.status}`);

  r = await post(websiteAuth, { ...entrance("203.0.113.10"), referrer: "https://example.com/" });
  record("unknown request field -> 400 (strict schema)", r.status === 400, `status ${r.status}`);

  // ---- activity persistence via the reporting feed ------------------------
  // The feed serves only finished transactions; allow a short horizon lag.
  let mine: Record<string, unknown>[] = [];
  let feedOk = false;
  let leak = false;
  const allowedItemKeys = new Set(["type", "observation_id", "company_id", "domain", "organisation_name", "observed_at", "method", "page_key", "acquisition", "entrance_contract", "tombstone_id", "erased_at"]);
  for (let attempt = 0; attempt < 10 && mine.length < 2; attempt++) {
    mine = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const q = after ? `?after=${encodeURIComponent(after)}&limit=500` : "?limit=500";
      const fr = await call(privateBase, `/v1/reporting/observations${q}`, { headers: reportingAuth });
      feedOk = fr.status === 200;
      if (!feedOk) break;
      if (fr.text.includes("203.0.113.") || fr.text.includes("10.0.0.1")) leak = true;
      const body = parse(fr.text);
      const items = Array.isArray(body?.["items"]) ? (body!["items"] as Record<string, unknown>[]) : [];
      for (const it of items) {
        if (Object.keys(it).some((k) => !allowedItemKeys.has(k))) leak = true;
        if (it["type"] === "observation" && it["page_key"] === pageKey) mine.push(it);
      }
      after = typeof body?.["next_cursor"] === "string" ? (body["next_cursor"] as string) : undefined;
      if (body?.["has_more"] !== true) break;
    }
    if (mine.length < 2) await new Promise((res) => setTimeout(res, 1_000));
  }
  record("feed readable with the reporting credential", feedOk, feedOk ? "200" : "non-200");
  record("feed holds exactly 2 observations for this run (replay not double-counted)", mine.length === 2, `count ${mine.length}`);
  record(
    "feed observations carry company, page and acquisition context",
    mine.length > 0 && mine.every((o) => o["domain"] === "example.com" && o["acquisition"] === "direct" && o["entrance_contract"] === "entrance.v1"),
    `methods ${mine.map((o) => String(o["method"])).join(",")}`,
  );
  record("feed responses carry no IP or unexpected field", !leak, leak ? "leak detected" : "clean");

  // ---- public edge (TLS, CORS, unauthenticated rejection) -----------------
  if (publicDomain) {
    const pub = `https://${publicDomain}`;
    r = await call(pub, "/healthz");
    record("public healthz 200 over TLS", r.status === 200, `status ${r.status}`);
    r = await call(pub, "/v1/entrances", { method: "POST", headers: json, body: "{not json" });
    record("public: unauthenticated invalid body -> 401 (auth before parsing)", r.status === 401, `status ${r.status}`);
    r = await call(pub, "/v1/reporting/observations", { headers: { authorization: `Bearer ${wrong}` } });
    record("public: wrong credential on feed -> 401", r.status === 401, `status ${r.status}`);
    r = await call(pub, "/v1/entrances", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    record("public: no CORS allow-origin header", r.headers.get("access-control-allow-origin") === null, `acao ${r.headers.get("access-control-allow-origin") === null ? "absent" : "present"}`);
    r = await call(pub, "/healthz");
    record("public: Cache-Control no-store and nosniff headers", (r.headers.get("cache-control") ?? "").includes("no-store") && r.headers.get("x-content-type-options") === "nosniff", "headers checked");
  } else {
    record("public edge checks", true, "skipped: no RAILWAY_PUBLIC_DOMAIN");
  }

  const failed = results.filter((x) => !x.pass).length;
  process.stdout.write(`${JSON.stringify({ event: "smoke_summary", run, target: target.kind, checks: results.length, passed: results.length - failed, failed, first_source: firstSource })}\n`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // Never print error objects: they could carry request details.
    process.stderr.write(`smoke: internal error (${err instanceof Error ? err.name : "unknown"})\n`);
    process.exitCode = 2;
  },
);
