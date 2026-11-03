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
 * Documentation-range mode (CHR-72), read from ALLOW_DOCUMENTATION_RANGES in
 * this process's environment with the service's own parser (unset = false),
 * and named in the summary line as `mode`:
 *   - documentation_ranges_enabled (the usual development setting): RFC 5737
 *     / RFC 3849 addresses are eligible, so the mock provider can qualify
 *     them; every check below runs.
 *   - documentation_ranges_disabled: a documentation address must answer
 *     ineligible, recorded false. Checks that need one to be eligible or to
 *     qualify (and the kill-switch phase, whose probe needs an eligible
 *     address that belongs to no real network) report
 *     `pass: true, detail: "skipped: documentation ranges disabled"`.
 * The target must run with the same value: run the smoke only once the
 * running deployment has this environment (src/ops/smoke-mode.ts).
 *
 * Kill-switch phase (CHR-72, src/ops/smoke-kill-switch.ts): with this
 * environment's DATABASE_URL and INSTALLATION_ID and the existing controls
 * repository, read the runtime kill switch, engage it if it is released,
 * send one entrance for a fresh synthetic address (never cached) and expect
 * `disabled`, recorded false, then ALWAYS put the switch back as found (in a
 * `finally`, verified by reading it back). A switch that was already engaged
 * is never written: it is probed and left engaged. Afterwards a cache-hit
 * entrance must qualify again and, when the smoke released the switch, a
 * fresh address must reach the (mock) provider again. SIGINT/SIGTERM are
 * deferred while the switch may be held, so the restore still runs. Runs only
 * against this service or loopback (never another *.railway.internal
 * target), and only in documentation_ranges_enabled mode.
 *
 * Side effects of a run, all synthetic:
 *   - documentation_ranges_enabled: three observations (domain example.com,
 *     page_key /smoke/<run>, acquisition direct) in the target's activity
 *     store: two before the feed checks and one after the kill-switch
 *     restore. They are ordinary reporting-feed items, so the Insights
 *     projection fed by that deployment (the dev projection) receives them;
 *     filter on the /smoke/ page_key prefix. They leave the resolver only
 *     through retention like any other observation. documentation_ranges_disabled:
 *     none.
 *   - kill-switch phase: the switch is engaged for about one request (cache
 *     misses of ANY caller answer disabled meanwhile) and, when it was
 *     released, written back released with the reason RESTORE_REASON; one
 *     already-expired cache row (the released reservation of the probe) and
 *     one no_match cache row (the control, TTL_NO_MATCH_S), both removed by
 *     the maintenance run; one mock provider attempt counted against
 *     PERIOD_CALL_CAP.
 *
 * Usage (inside the service): node dist/ops/smoke.js. Exit 0 = all passed,
 * 1 = a check failed, 2 = refused or misconfigured, or the kill switch could
 * not be verified back in its prior state, or a signal interrupted the
 * kill-switch phase.
 */
import { randomBytes } from "node:crypto";
import { createDb } from "../db/index.js";
import { loadOpsConfig, type OpsConfig } from "./env.js";
import { restoreFailureMessage, runKillSwitchPhase, smokeExitCode, type KillSwitchPhaseResult } from "./smoke-kill-switch.js";
import {
  documentationRangeMode,
  KILL_SWITCH_CONTROL_PREFIX,
  KILL_SWITCH_PROBE_PREFIX,
  killSwitchPhasePlan,
  killSwitchProbeAddress,
  PROBE_RANDOM_BYTES,
} from "./smoke-mode.js";
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

/** HTTP status and response enums of one entrance, for check details (never the body itself). */
interface EntranceAnswer {
  status: number;
  body: Record<string, unknown> | undefined;
}
const describeAnswer = (a: EntranceAnswer) =>
  `status ${a.status} result ${String(a.body?.["status"])}/${String(a.body?.["source"])}/recorded=${String(a.body?.["recorded"])}`;

const SKIPPED_DOCS = "skipped: documentation ranges disabled";

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
  const docMode = documentationRangeMode(process.env);
  if (!docMode.ok) {
    process.stderr.write(`smoke: refusing: ${docMode.reason}\n`);
    return 2;
  }
  const mode = docMode.mode;
  const docs = mode === "documentation_ranges_enabled";
  const ksPlan = killSwitchPhasePlan(mode, target.kind);
  let ops: OpsConfig | undefined;
  if (ksPlan === "run") {
    try {
      ops = loadOpsConfig(process.env);
    } catch (err) {
      // loadOpsConfig names variables and rules only, never values.
      process.stderr.write(`smoke: refusing: the kill-switch phase needs this service's database settings (${err instanceof Error ? err.message : "invalid configuration"})\n`);
      return 2;
    }
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
  if (docs) {
    record("qualified entrance -> 200 qualified, recorded", r.status === 200 && b?.["status"] === "qualified" && b?.["recorded"] === true, `status ${r.status} result ${String(b?.["status"])}/${String(b?.["source"])}/recorded=${String(b?.["recorded"])}`);
  } else {
    record("qualified entrance -> 200 qualified, recorded", true, SKIPPED_DOCS);
    // The mock provider would qualify this address: only the eligibility rule stops it.
    record("documentation-range address (IPv4) -> ineligible, nothing recorded", r.status === 200 && b?.["status"] === "ineligible" && b?.["recorded"] === false, describeAnswer({ status: r.status, body: b }));
  }
  // D2 holds for every answer: the qualified one, or the ineligible one when documentation ranges are disabled.
  record("response carries no company data (D2: exactly version,status,source,recorded)", b !== undefined && JSON.stringify(Object.keys(b).sort()) === JSON.stringify(allowedKeys), `keys ${b ? Object.keys(b).sort().join(",") : "none"}`);
  const firstSource = String(b?.["source"]);

  if (docs) {
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
  } else {
    record("repeat address -> cache hit still records an observation", true, SKIPPED_DOCS);
    record("replayed entrance_id -> 200 (idempotent)", true, SKIPPED_DOCS);
    record("no-domain address -> no_match, nothing recorded", true, SKIPPED_DOCS);
    // The mock provider would qualify this address too (RFC 3849).
    r = await post(websiteAuth, entrance("2001:db8::10"));
    b = parse(r.text);
    record("documentation-range address (IPv6) -> ineligible, nothing recorded", r.status === 200 && b?.["status"] === "ineligible" && b?.["recorded"] === false, describeAnswer({ status: r.status, body: b }));
  }

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
  // With documentation ranges disabled nothing of this run is expected in the feed: read it once.
  const expectedMine = docs ? 2 : 0;
  for (let attempt = 0; attempt < (docs ? 10 : 1) && (attempt === 0 || mine.length < expectedMine); attempt++) {
    mine = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const q = after ? `?after=${encodeURIComponent(after)}&limit=500` : "?limit=500";
      const fr = await call(privateBase, `/v1/reporting/observations${q}`, { headers: reportingAuth });
      feedOk = fr.status === 200;
      if (!feedOk) break;
      if (fr.text.includes("203.0.113.") || fr.text.includes("10.0.0.1") || fr.text.includes("2001:db8")) leak = true;
      const body = parse(fr.text);
      const items = Array.isArray(body?.["items"]) ? (body!["items"] as Record<string, unknown>[]) : [];
      for (const it of items) {
        if (Object.keys(it).some((k) => !allowedItemKeys.has(k))) leak = true;
        if (it["type"] === "observation" && it["page_key"] === pageKey) mine.push(it);
      }
      after = typeof body?.["next_cursor"] === "string" ? (body["next_cursor"] as string) : undefined;
      if (body?.["has_more"] !== true) break;
    }
    if (docs && mine.length < expectedMine) await new Promise((res) => setTimeout(res, 1_000));
  }
  record("feed readable with the reporting credential", feedOk, feedOk ? "200" : "non-200");
  if (docs) {
    record("feed holds exactly 2 observations for this run (replay not double-counted)", mine.length === 2, `count ${mine.length}`);
    record(
      "feed observations carry company, page and acquisition context",
      mine.length > 0 && mine.every((o) => o["domain"] === "example.com" && o["acquisition"] === "direct" && o["entrance_contract"] === "entrance.v1"),
      `methods ${mine.map((o) => String(o["method"])).join(",")}`,
    );
  } else {
    record("feed holds exactly 2 observations for this run (replay not double-counted)", true, SKIPPED_DOCS);
    record("feed observations carry company, page and acquisition context", true, SKIPPED_DOCS);
  }
  record("feed responses carry no IP or unexpected field", !leak, leak ? "leak detected" : "clean");

  // ---- runtime kill switch (CHR-72) ---------------------------------------
  // After the feed checks, so the post-restore observation does not change their count.
  const KS_PRIOR = "kill switch: prior state read";
  const KS_ENGAGED = "kill switch: engaged for the probe (read back)";
  const KS_DISABLED = "kill switch engaged: uncached address -> disabled, nothing recorded";
  const KS_RESTORED = "kill switch: restored to its prior state (read back)";
  const KS_CACHE_HIT = "after restore: cache-hit entrance qualifies, recorded";
  const KS_CONTROL = "after restore: uncached address reaches the provider again (no_match)";
  let ks: KillSwitchPhaseResult<EntranceAnswer> | undefined;
  let interrupted = false;
  if (ksPlan !== "run" || ops === undefined) {
    const why = ksPlan === "skipped_documentation_ranges_disabled" ? SKIPPED_DOCS : "skipped: target is not this service (the kill switch lives in this service's database)";
    for (const check of [KS_PRIOR, KS_ENGAGED, KS_DISABLED, KS_RESTORED, KS_CACHE_HIT, KS_CONTROL]) record(check, true, why);
  } else {
    const installationId = ops.INSTALLATION_ID;
    const db = createDb({ databaseUrl: ops.DATABASE_URL, ssl: ops.DATABASE_SSL, max: 1 });
    // While the switch may be held engaged, a signal must not skip the restore:
    // it is noted, the phase finishes (bounded), and the run exits 2.
    const onSignal = () => {
      interrupted = true;
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      const probeAddress = killSwitchProbeAddress(KILL_SWITCH_PROBE_PREFIX, randomBytes(PROBE_RANDOM_BYTES));
      ks = await runKillSwitchPhase<EntranceAnswer>({
        controls: {
          isEnrichmentEnabled: () => db.controls.isEnrichmentEnabled(installationId),
          setEnrichmentEnabled: (enabled, reason) => db.controls.setEnrichmentEnabled(installationId, enabled, reason),
        },
        probe: async () => {
          const pr = await post(websiteAuth, entrance(probeAddress));
          return { status: pr.status, body: parse(pr.text) };
        },
      });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await db.close();
    }
    record(KS_PRIOR, ks.prior !== "unreadable", `prior ${ks.prior}`);
    record(KS_ENGAGED, ks.engage === "engaged_by_smoke" || ks.engage === "already_engaged", ks.engage);
    if (ks.probe.kind === "result") {
      const a = ks.probe.value;
      record(KS_DISABLED, a.status === 200 && a.body?.["status"] === "disabled" && a.body?.["source"] === "none" && a.body?.["recorded"] === false, describeAnswer(a));
    } else {
      record(KS_DISABLED, false, `probe ${ks.probe.kind}`);
    }
    record(KS_RESTORED, ks.restore === "restored" || ks.restore === "left_engaged_as_found", `restore ${ks.restore}, reads ${ks.final}`);
    if (ks.restore === "failed" && ks.prior !== "unreadable") process.stderr.write(`${restoreFailureMessage(ks.prior, ks.final)}\n`);
    if (interrupted) {
      process.stderr.write(`smoke: interrupted by a signal during the kill-switch phase; the restore ran first (restore ${ks.restore})\n`);
    } else {
      // A cache hit is answered before the switch is consulted, so this holds in both prior states.
      r = await post(websiteAuth, entrance("203.0.113.10"));
      const hit: EntranceAnswer = { status: r.status, body: parse(r.text) };
      record(KS_CACHE_HIT, hit.status === 200 && hit.body?.["status"] === "qualified" && hit.body?.["source"] === "cache" && hit.body?.["recorded"] === true, describeAnswer(hit));
      if (ks.prior === "released") {
        // Proves the disabled answer came from the switch (the only thing changed) and that the
        // running service, not only the database, sees it released again.
        r = await post(websiteAuth, entrance(killSwitchProbeAddress(KILL_SWITCH_CONTROL_PREFIX, randomBytes(PROBE_RANDOM_BYTES))));
        const control: EntranceAnswer = { status: r.status, body: parse(r.text) };
        record(KS_CONTROL, control.status === 200 && control.body?.["status"] === "no_match" && control.body?.["source"] === "provider" && control.body?.["recorded"] === false, describeAnswer(control));
      } else {
        record(KS_CONTROL, true, "skipped: kill switch was engaged before the run (left engaged)");
      }
    }
  }

  // ---- public edge (TLS, CORS, unauthenticated rejection) -----------------
  if (interrupted) {
    // Interrupted: finish now (exit 2) without starting more requests.
  } else if (publicDomain) {
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
  process.stdout.write(
    `${JSON.stringify({
      event: "smoke_summary",
      run,
      target: target.kind,
      mode,
      kill_switch_phase: ksPlan,
      kill_switch_prior: ks?.prior ?? "not_read",
      kill_switch_restore: ks?.restore ?? "not_run",
      checks: results.length,
      passed: results.length - failed,
      failed,
      first_source: firstSource,
    })}\n`,
  );
  // Repeated last, so it is the final thing an operator sees.
  if (ks?.restore === "failed" && ks.prior !== "unreadable") process.stderr.write(`${restoreFailureMessage(ks.prior, ks.final)}\n`);
  return smokeExitCode(failed, ks?.restore ?? "not_run", interrupted);
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
