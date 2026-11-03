/**
 * Development smoke test (CHR-72; events phase and Gate 4 review fixes in
 * Gate 5). Runs INSIDE the resolver's own deployment environment so the
 * bearer tokens are read from this service's environment (sealed variables)
 * and never leave it. Output is secret-free JSON lines (src/ops/smoke-report.ts):
 * check names, HTTP statuses, enums and counts. Tokens, IPs, response bodies,
 * event_ids, page_key values and configuration values are never printed.
 * Operator guide: docs/DEV_SMOKE.md.
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
 * Suites (command line, src/ops/smoke-mode.ts smokeSuite):
 *   - full (default): everything below.
 *   - `--mode rollback-check`: liveness, credential separation, the feed
 *     (readable, exact reporting-feed.v1 shape, no address) and "POST
 *     /v1/events answers exactly like an unknown route", plus the public edge.
 *     It sends nothing that resolves, writes nothing and reads no database,
 *     and every check holds for every build since Gate 3, so the current
 *     smoke can check a deployment rolled back to a build without migration
 *     0008 (docs/DEV_SMOKE.md).
 *
 * Modes of the full suite, read from this process's environment with the
 * service's own parsers (src/ops/smoke-mode.ts); the target must run with the
 * same values, so run the smoke only once the running deployment has this
 * environment. Both are named in the summary line.
 *   - ALLOW_DOCUMENTATION_RANGES (`mode`): documentation_ranges_enabled (the
 *     usual development setting: RFC 5737 / RFC 3849 addresses are eligible,
 *     so the mock provider can qualify them) or documentation_ranges_disabled
 *     (a documentation address must answer ineligible; checks that need one
 *     to be eligible, and the kill-switch phase, are reported as skipped).
 *   - EVENTS_ENABLED / EVENT_CONSENT_MODE (`events_mode`): events phase
 *     (src/ops/smoke-events.ts) or, when disabled, "POST /v1/events answers
 *     404 exactly like an unknown route".
 *
 * Kill-switch orphan check (Gate 4 review G4-L2), before any other check,
 * when the target is this service: a switch engaged with the smoke's own
 * reason was left by a run that was killed while holding it (or is held by a
 * run in progress). The run stops at once with exit 2 and the release
 * command; it is never treated as "left as found".
 *
 * Kill-switch phase (CHR-72, src/ops/smoke-kill-switch.ts and
 * src/ops/smoke-controls.ts): read the runtime kill switch, engage it if it
 * is released (only if it still is, with this run's own reason), send one
 * entrance for a fresh synthetic address (never cached) and expect
 * `disabled`, recorded false, then in a `finally` release it again ONLY if
 * it still carries this run's reason (compare-and-set, G4-L3) and read it
 * back. A switch engaged by someone else, before or during the run, is never
 * released by the smoke (during the run: exit 2). Afterwards a cache-hit
 * entrance must qualify again and, when the smoke released the switch, a
 * fresh address must reach the (mock) provider again. SIGINT, SIGTERM,
 * SIGHUP and SIGQUIT are deferred while the switch may be held, so the
 * restore still runs. Runs only against this service or loopback (never
 * another *.railway.internal target), and only in
 * documentation_ranges_enabled mode.
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
 *   - events enabled: two browser_events rows (three under
 *     EVENT_CONSENT_MODE=not_required), page_key /smoke/<run>/ev, removed by
 *     retention like any event. Never in the reporting feed.
 *   - kill-switch phase: the switch is engaged for about one request (cache
 *     misses of ANY caller answer disabled meanwhile) and, when the smoke
 *     released it again, it stays released with this run's restore reason;
 *     one already-expired cache row (the released reservation of the probe)
 *     and one no_match cache row (the control, TTL_NO_MATCH_S), both removed
 *     by the maintenance run; one mock provider attempt counted against
 *     PERIOD_CALL_CAP.
 *   - The smoke never changes a variable or any other configuration.
 *
 * Usage (inside the service): node dist/ops/smoke.js [--mode rollback-check].
 * Exit 0 = no check failed (skipped checks are counted apart), 1 = a check
 * failed, 2 = refused or misconfigured, a switch left engaged by an earlier
 * smoke run, the kill switch not verifiably back in its prior state by this
 * run's own hand, or a signal interrupted the kill-switch phase.
 */
import { randomBytes } from "node:crypto";
import { createPool, type Pool } from "../db/index.js";
import { loadOpsConfig, type OpsConfig } from "./env.js";
import { createSmokeKillSwitchControls } from "./smoke-controls.js";
import { ADDRESS_NEEDLES, checkEventsAbsent, runEventsPhase } from "./smoke-events.js";
import { createEventsDbProbe } from "./smoke-events-db.js";
import { readFeed, type FeedRead } from "./smoke-feed.js";
import { call, parse, type HttpAnswer } from "./smoke-http.js";
import {
  deferSignals,
  isSmokeEngagement,
  killSwitchAlert,
  ORPHAN_MESSAGE,
  runKillSwitchPhase,
  smokeExitCode,
  type DeferredSignal,
  type KillSwitchControls,
  type KillSwitchPhaseResult,
} from "./smoke-kill-switch.js";
import {
  documentationRangeMode,
  eventsMode,
  eventsPhasePlan,
  KILL_SWITCH_CONTROL_PREFIX,
  KILL_SWITCH_PROBE_PREFIX,
  killSwitchPhasePlan,
  killSwitchProbeAddress,
  PROBE_RANDOM_BYTES,
  smokeSuite,
  type SmokeSuite,
} from "./smoke-mode.js";
import { SmokeReport } from "./smoke-report.js";
import { resolveSmokeTarget, type SmokeTargetKind } from "./smoke-target.js";

const report = new SmokeReport((line) => process.stdout.write(line));
const stderr = (message: string) => process.stderr.write(`${message}\n`);

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");
const entranceId = () => randomBytes(16).toString("base64url");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** HTTP status and response enums of one entrance, for check details (never the body itself). */
interface EntranceAnswer {
  status: number;
  body: Record<string, unknown> | undefined;
}
const describeAnswer = (a: EntranceAnswer) =>
  `status ${a.status} result ${String(a.body?.["status"])}/${String(a.body?.["source"])}/recorded=${String(a.body?.["recorded"])}`;

const SKIPPED_DOCS = "documentation ranges disabled";
const NOT_THIS_SERVICE = "target is not this service (the kill switch lives in this service's database)";

/** Everything a suite needs, resolved and validated before the first request. */
interface Ctx {
  suite: SmokeSuite;
  target: { base: string; kind: SmokeTargetKind };
  publicDomain: string | undefined;
  websiteToken: string;
  reportingToken: string;
  websiteId: string;
  run: string;
  wrong: string;
  json: Record<string, string>;
  websiteAuth: Record<string, string>;
  reportingAuth: Record<string, string>;
}

interface Summary {
  mode: string;
  events_mode: string;
  event_consent_mode: string;
  events_phase: string;
  kill_switch_phase: string;
  kill_switch_prior: string;
  kill_switch_restore: string;
  first_source: string;
}

function writeSummary(ctx: Ctx, s: Summary): void {
  const c = report.counts();
  process.stdout.write(
    `${JSON.stringify({
      event: "smoke_summary",
      run: ctx.run,
      suite: ctx.suite,
      target: ctx.target.kind,
      ...s,
      checks: c.checks,
      passed: c.passed,
      failed: c.failed,
      skipped: c.skipped,
    })}\n`,
  );
}

const postTo = (ctx: Ctx) => (path: string, headers: Record<string, string>, body: unknown) =>
  call(ctx.target.base, path, { method: "POST", headers, body: JSON.stringify(body) });

const getFeed = (ctx: Ctx) => () => readFeed((query) => call(ctx.target.base, `/v1/reporting/observations${query}`, { headers: ctx.reportingAuth }));

async function livenessChecks(ctx: Ctx): Promise<void> {
  report.check("private healthz 200", (await call(ctx.target.base, "/healthz")).status === 200, "GET /healthz");
  report.check("private readyz 200 (database reachable)", (await call(ctx.target.base, "/readyz")).status === 200, "GET /readyz");
}

/** Credential separation. Every request here is refused before its body is read: nothing resolves. */
async function credentialChecks(ctx: Ctx, entrance: (ip: string) => unknown): Promise<void> {
  const post = (headers: Record<string, string>) => call(ctx.target.base, "/v1/entrances", { method: "POST", headers, body: JSON.stringify(entrance("203.0.113.10")) });
  let r = await post(ctx.json);
  report.check("entrances without credential -> 401", r.status === 401, `status ${r.status}`);
  r = await post({ ...ctx.json, authorization: `Bearer ${ctx.wrong}` });
  report.check("entrances with wrong credential -> 401", r.status === 401, `status ${r.status}`);
  r = await post({ ...ctx.json, ...ctx.reportingAuth });
  report.check("reporting credential rejected on entrances -> 401", r.status === 401, `status ${r.status}`);
  r = await call(ctx.target.base, "/v1/reporting/observations", { headers: { authorization: `Bearer ${ctx.websiteToken}` } });
  report.check("website credential rejected on feed -> 401", r.status === 401, `status ${r.status}`);
  r = await call(ctx.target.base, "/v1/reporting/observations");
  report.check("feed without credential -> 401", r.status === 401, `status ${r.status}`);
}

const FEED_ITEM_FIELD_PROBLEMS = new Set(["observation_keys", "tombstone_keys", "item_type", "item_not_object"]);

/** The feed checks shared by both suites. */
function feedChecks(feed: FeedRead): void {
  report.check("feed readable with the reporting credential", feed.ok, feed.ok ? "200" : "non-200");
  const address = ADDRESS_NEEDLES.some((n) => feed.includes(n));
  const unexpected = feed.shapeProblems.some((p) => FEED_ITEM_FIELD_PROBLEMS.has(p));
  report.check("feed responses carry no IP or unexpected field", !address && !unexpected, address || unexpected ? "leak detected" : "clean");
  report.check(
    "feed pages keep the reporting-feed.v1 shape",
    feed.ok && feed.shapeProblems.length === 0,
    !feed.ok ? "non-200" : feed.shapeProblems.length === 0 ? `exact (${feed.pages} pages)` : `problems ${feed.shapeProblems.join(",")}`,
  );
}

async function publicEdgeChecks(ctx: Ctx): Promise<void> {
  if (!ctx.publicDomain) {
    report.skip("public edge checks", "no RAILWAY_PUBLIC_DOMAIN");
    return;
  }
  const pub = `https://${ctx.publicDomain}`;
  let r = await call(pub, "/healthz");
  report.check("public healthz 200 over TLS", r.status === 200, `status ${r.status}`);
  r = await call(pub, "/v1/entrances", { method: "POST", headers: ctx.json, body: "{not json" });
  report.check("public: unauthenticated invalid body -> 401 (auth before parsing)", r.status === 401, `status ${r.status}`);
  r = await call(pub, "/v1/reporting/observations", { headers: { authorization: `Bearer ${ctx.wrong}` } });
  report.check("public: wrong credential on feed -> 401", r.status === 401, `status ${r.status}`);
  r = await call(pub, "/v1/entrances", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  report.check("public: no CORS allow-origin header", r.headers.get("access-control-allow-origin") === null, `acao ${r.headers.get("access-control-allow-origin") === null ? "absent" : "present"}`);
  r = await call(pub, "/healthz");
  report.check("public: Cache-Control no-store and nosniff headers", (r.headers.get("cache-control") ?? "").includes("no-store") && r.headers.get("x-content-type-options") === "nosniff", "headers checked");
}

function entranceBody(ctx: Ctx, pageKey: string) {
  return (ip: string, id = entranceId(), occurredAt = new Date()) => ({
    contract: "entrance.v1",
    website_id: ctx.websiteId,
    ip,
    entrance_id: id,
    occurred_at: occurredAt.toISOString(),
    page_key: pageKey,
    acquisition: "direct",
    eligibility: "tsa-1",
  });
}

/** `--mode rollback-check`: read-only checks that hold for every build since Gate 3. */
async function rollbackCheck(ctx: Ctx): Promise<number> {
  const entrance = entranceBody(ctx, `/smoke/${ctx.run}`);
  await livenessChecks(ctx);
  await credentialChecks(ctx, (ip) => entrance(ip));
  feedChecks(await getFeed(ctx)());
  // A build before Gate 4 answers every authenticated unknown route 400, a later one 404: absent means "the same as an unknown route".
  await checkEventsAbsent({
    report,
    post: postTo(ctx),
    websiteAuth: ctx.websiteAuth,
    json: ctx.json,
    websiteId: ctx.websiteId,
    run: ctx.run,
    expectStatus: undefined,
    names: {
      withCredential: "rollback: POST /v1/events with the website credential answers exactly like an unknown route (absent)",
      withoutCredential: "rollback: POST /v1/events without credential -> 401, exactly like an unknown route",
    },
  });
  await publicEdgeChecks(ctx);
  writeSummary(ctx, {
    mode: "not_applicable",
    events_mode: "not_applicable",
    event_consent_mode: "not_applicable",
    events_phase: "check_absent",
    kill_switch_phase: "not_run",
    kill_switch_prior: "not_read",
    kill_switch_restore: "not_run",
    first_source: "not_applicable",
  });
  return smokeExitCode(report.counts().failed, "not_run");
}

async function fullSuite(ctx: Ctx, ops: OpsConfig | undefined, pool: Pool | undefined): Promise<number> {
  const docMode = documentationRangeMode(process.env);
  const evMode = eventsMode(process.env);
  // Validated in main() before the pool was created; repeated for the type checker.
  if (!docMode.ok || !evMode.ok) return 2;
  const mode = docMode.mode;
  const docs = mode === "documentation_ranges_enabled";
  const ksPlan = killSwitchPhasePlan(mode, ctx.target.kind);
  const evPlan = eventsPhasePlan(evMode.mode, ctx.target.kind);
  const controls: KillSwitchControls | undefined = pool && ops ? createSmokeKillSwitchControls(pool, ops.INSTALLATION_ID) : undefined;
  const summaryBase = { mode, events_mode: evMode.mode, event_consent_mode: evMode.consentMode, events_phase: evPlan, kill_switch_phase: ksPlan };
  const { websiteAuth, json } = ctx;
  const pageKey = `/smoke/${ctx.run}`;
  const entrance = entranceBody(ctx, pageKey);
  const post = (headers: Record<string, string>, body: unknown) => call(ctx.target.base, "/v1/entrances", { method: "POST", headers, body: JSON.stringify(body) });

  // ---- kill switch left engaged by an earlier smoke run? (G4-L2) ------------
  const KS_ORPHAN = "kill switch: not left engaged by an earlier smoke run";
  if (!controls) {
    report.skip(KS_ORPHAN, NOT_THIS_SERVICE);
  } else {
    const reading = await controls.read().catch(() => "unreadable" as const);
    if (reading !== "unreadable" && isSmokeEngagement(reading)) {
      // Stop before any other request: the switch is not this run's to probe, release or count as found.
      report.check(KS_ORPHAN, false, "engaged with the smoke's own reason");
      writeSummary(ctx, { ...summaryBase, kill_switch_prior: "engaged", kill_switch_restore: "orphan_left_engaged", first_source: "not_run" });
      stderr(ORPHAN_MESSAGE);
      return smokeExitCode(report.counts().failed, "orphan_left_engaged");
    }
    report.check(KS_ORPHAN, reading !== "unreadable", reading === "unreadable" ? "switch unreadable" : `reads ${reading.state}`);
  }

  // ---- liveness ---------------------------------------------------------
  await livenessChecks(ctx);

  // ---- authentication and credential separation --------------------------
  await credentialChecks(ctx, (ip) => entrance(ip));

  // ---- entrance resolution (mock provider; RFC 5737 synthetic addresses) ---
  const allowedKeys = ["recorded", "source", "status", "version"];
  let r: HttpAnswer = await post(websiteAuth, entrance("203.0.113.10"));
  let b = parse(r.text);
  if (docs) {
    report.check("qualified entrance -> 200 qualified, recorded", r.status === 200 && b?.["status"] === "qualified" && b?.["recorded"] === true, describeAnswer({ status: r.status, body: b }));
  } else {
    report.skip("qualified entrance -> 200 qualified, recorded", SKIPPED_DOCS);
    // The mock provider would qualify this address: only the eligibility rule stops it.
    report.check("documentation-range address (IPv4) -> ineligible, nothing recorded", r.status === 200 && b?.["status"] === "ineligible" && b?.["recorded"] === false, describeAnswer({ status: r.status, body: b }));
  }
  // D2 holds for every answer: the qualified one, or the ineligible one when documentation ranges are disabled.
  report.check("response carries no company data (D2: exactly version,status,source,recorded)", b !== undefined && JSON.stringify(Object.keys(b).sort()) === JSON.stringify(allowedKeys), `keys ${b ? Object.keys(b).sort().join(",") : "none"}`);
  const firstSource = String(b?.["source"]);

  if (docs) {
    const secondId = entranceId();
    r = await post(websiteAuth, entrance("203.0.113.10", secondId));
    b = parse(r.text);
    report.check("repeat address -> cache hit still records an observation", r.status === 200 && b?.["status"] === "qualified" && b?.["source"] === "cache" && b?.["recorded"] === true, describeAnswer({ status: r.status, body: b }));

    r = await post(websiteAuth, entrance("203.0.113.10", secondId));
    b = parse(r.text);
    report.check("replayed entrance_id -> 200 (idempotent)", r.status === 200 && b?.["status"] === "qualified", `status ${r.status}`);

    r = await post(websiteAuth, entrance("203.0.113.13"));
    b = parse(r.text);
    report.check("no-domain address -> no_match, nothing recorded", r.status === 200 && b?.["status"] === "no_match" && b?.["recorded"] === false, `status ${r.status} result ${String(b?.["status"])}`);
  } else {
    report.skip("repeat address -> cache hit still records an observation", SKIPPED_DOCS);
    report.skip("replayed entrance_id -> 200 (idempotent)", SKIPPED_DOCS);
    report.skip("no-domain address -> no_match, nothing recorded", SKIPPED_DOCS);
    // The mock provider would qualify this address too (RFC 3849).
    r = await post(websiteAuth, entrance("2001:db8::10"));
    b = parse(r.text);
    report.check("documentation-range address (IPv6) -> ineligible, nothing recorded", r.status === 200 && b?.["status"] === "ineligible" && b?.["recorded"] === false, describeAnswer({ status: r.status, body: b }));
  }

  r = await post(websiteAuth, entrance("10.0.0.1"));
  b = parse(r.text);
  report.check("private address -> ineligible, nothing recorded", r.status === 200 && b?.["status"] === "ineligible" && b?.["recorded"] === false, `status ${r.status} result ${String(b?.["status"])}`);

  r = await post(websiteAuth, entrance("203.0.113.10", entranceId(), new Date(Date.now() - 3_600_000)));
  report.check("occurred_at outside the 300 s window -> 400", r.status === 400, `status ${r.status}`);

  r = await post(websiteAuth, { ...entrance("203.0.113.10"), referrer: "https://example.com/" });
  report.check("unknown request field -> 400 (strict schema)", r.status === 400, `status ${r.status}`);

  // ---- activity persistence via the reporting feed ------------------------
  // The feed serves only finished transactions; allow a short horizon lag.
  // With documentation ranges disabled nothing of this run is expected in the feed: read it once.
  const expectedMine = docs ? 2 : 0;
  let feed = await getFeed(ctx)();
  let mine = feed.items.filter((it) => it["type"] === "observation" && it["page_key"] === pageKey);
  for (let attempt = 1; docs && attempt < 10 && feed.ok && mine.length < expectedMine; attempt++) {
    await sleep(1_000);
    feed = await getFeed(ctx)();
    mine = feed.items.filter((it) => it["type"] === "observation" && it["page_key"] === pageKey);
  }
  if (docs) {
    report.check("feed holds exactly 2 observations for this run (replay not double-counted)", mine.length === 2, `count ${mine.length}`);
    report.check(
      "feed observations carry company, page and acquisition context",
      mine.length > 0 && mine.every((o) => o["domain"] === "example.com" && o["acquisition"] === "direct" && o["entrance_contract"] === "entrance.v1"),
      `methods ${mine.map((o) => String(o["method"])).join(",")}`,
    );
  } else {
    report.skip("feed holds exactly 2 observations for this run (replay not double-counted)", SKIPPED_DOCS);
    report.skip("feed observations carry company, page and acquisition context", SKIPPED_DOCS);
  }
  feedChecks(feed);

  // ---- browser events (event.v1) -------------------------------------------
  // Before the kill-switch phase, so no entrance of this run is in flight while the database window is open.
  if (evPlan === "check_disabled") {
    await checkEventsAbsent({ report, post: postTo(ctx), websiteAuth, json, websiteId: ctx.websiteId, run: ctx.run, expectStatus: 404 });
  } else {
    await runEventsPhase({
      report,
      post: postTo(ctx),
      websiteAuth,
      reportingAuth: ctx.reportingAuth,
      json,
      websiteId: ctx.websiteId,
      run: ctx.run,
      consentMode: evMode.consentMode,
      db: evPlan === "run" && pool && ops ? createEventsDbProbe(pool, { installationId: ops.INSTALLATION_ID, websiteId: ops.WEBSITE_ID }) : undefined,
      readFeed: getFeed(ctx),
      runObservationsBefore: mine.length,
    });
  }

  // ---- runtime kill switch (CHR-72) ---------------------------------------
  // After the feed checks, so the post-restore observation does not change their count.
  const KS_PRIOR = "kill switch: prior state read";
  const KS_ENGAGED = "kill switch: engaged for the probe (read back)";
  const KS_DISABLED = "kill switch engaged: uncached address -> disabled, nothing recorded";
  const KS_RESTORED = "kill switch: restored to its prior state (read back)";
  const KS_CACHE_HIT = "after restore: cache-hit entrance qualifies, recorded";
  const KS_CONTROL = "after restore: uncached address reaches the provider again (no_match)";
  let ks: KillSwitchPhaseResult<EntranceAnswer> | undefined;
  let interruptedBy: DeferredSignal | undefined;
  let alert: string | undefined;
  if (ksPlan !== "run" || !controls) {
    const why = ksPlan === "skipped_documentation_ranges_disabled" ? SKIPPED_DOCS : NOT_THIS_SERVICE;
    for (const check of [KS_PRIOR, KS_ENGAGED, KS_DISABLED, KS_RESTORED, KS_CACHE_HIT, KS_CONTROL]) report.skip(check, why);
  } else {
    // While the switch may be held engaged, a signal must not skip the restore:
    // it is noted, the phase finishes (bounded), and the run exits 2.
    const undefer = deferSignals((signal) => {
      interruptedBy ??= signal;
    });
    try {
      const probeAddress = killSwitchProbeAddress(KILL_SWITCH_PROBE_PREFIX, randomBytes(PROBE_RANDOM_BYTES));
      ks = await runKillSwitchPhase<EntranceAnswer>({
        controls,
        run: ctx.run,
        probe: async () => {
          const pr = await post(websiteAuth, entrance(probeAddress));
          return { status: pr.status, body: parse(pr.text) };
        },
      });
    } finally {
      undefer();
    }
    report.check(KS_PRIOR, ks.prior !== "unreadable" && ks.engage !== "smoke_orphan", ks.engage === "smoke_orphan" ? "prior engaged by a smoke run (orphan)" : `prior ${ks.prior}`);
    report.check(KS_ENGAGED, ks.engage === "engaged_by_smoke" || ks.engage === "already_engaged", ks.engage);
    if (ks.probe.kind === "result") {
      const a = ks.probe.value;
      report.check(KS_DISABLED, a.status === 200 && a.body?.["status"] === "disabled" && a.body?.["source"] === "none" && a.body?.["recorded"] === false, describeAnswer(a));
    } else {
      report.check(KS_DISABLED, false, `probe ${ks.probe.kind}`);
    }
    report.check(KS_RESTORED, ks.restore === "restored" || ks.restore === "left_engaged_as_found", `restore ${ks.restore}, reads ${ks.final}`);
    alert = killSwitchAlert(ks.prior, ks.restore, ks.final);
    if (alert) stderr(alert);
    if (interruptedBy) {
      stderr(`smoke: interrupted by ${interruptedBy} during the kill-switch phase; the restore ran first (restore ${ks.restore})`);
    } else {
      // A cache hit is answered before the switch is consulted, so this holds in every prior state.
      r = await post(websiteAuth, entrance("203.0.113.10"));
      const hit: EntranceAnswer = { status: r.status, body: parse(r.text) };
      report.check(KS_CACHE_HIT, hit.status === 200 && hit.body?.["status"] === "qualified" && hit.body?.["source"] === "cache" && hit.body?.["recorded"] === true, describeAnswer(hit));
      if (ks.prior === "released" && ks.restore === "restored") {
        // Proves the disabled answer came from the switch (the only thing changed) and that the
        // running service, not only the database, sees it released again.
        r = await post(websiteAuth, entrance(killSwitchProbeAddress(KILL_SWITCH_CONTROL_PREFIX, randomBytes(PROBE_RANDOM_BYTES))));
        const control: EntranceAnswer = { status: r.status, body: parse(r.text) };
        report.check(KS_CONTROL, control.status === 200 && control.body?.["status"] === "no_match" && control.body?.["source"] === "provider" && control.body?.["recorded"] === false, describeAnswer(control));
      } else if (ks.prior === "engaged") {
        report.skip(KS_CONTROL, "kill switch was engaged before the run (left engaged)");
      } else {
        report.skip(KS_CONTROL, `kill switch not released by this run (restore ${ks.restore})`);
      }
    }
  }

  // ---- public edge (TLS, CORS, unauthenticated rejection) -----------------
  // Interrupted: finish now (exit 2) without starting more requests.
  if (!interruptedBy) await publicEdgeChecks(ctx);

  writeSummary(ctx, {
    ...summaryBase,
    kill_switch_prior: ks?.prior ?? "not_read",
    kill_switch_restore: ks?.restore ?? "not_run",
    first_source: firstSource,
  });
  // Repeated last, so it is the final thing an operator sees.
  if (alert) stderr(alert);
  return smokeExitCode(report.counts().failed, ks?.restore ?? "not_run", interruptedBy !== undefined);
}

async function main(): Promise<number> {
  // A terminal that goes away (SIGHUP) must not turn a later write into a crash.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);

  const suite = smokeSuite(process.argv.slice(2));
  if (!suite.ok) {
    stderr(`smoke: refusing: ${suite.reason}`);
    return 2;
  }
  if (env("PROVIDER_MODE") !== "mock") {
    stderr("smoke: refusing to run unless PROVIDER_MODE=mock (qualified checks would call a paid provider)");
    return 2;
  }
  const target = resolveSmokeTarget(process.env);
  if (!target.ok) {
    // The reason names variables and rules only, never their values.
    stderr(`smoke: refusing target: ${target.reason}`);
    return 2;
  }
  const websiteToken = env("RESOLVER_AUTH_TOKEN");
  const reportingToken = env("REPORTING_AUTH_TOKEN");
  const websiteId = env("WEBSITE_ID");
  if (!websiteToken || !reportingToken || !websiteId) {
    stderr("smoke: missing RESOLVER_AUTH_TOKEN, REPORTING_AUTH_TOKEN or WEBSITE_ID");
    return 2;
  }
  const json = { "content-type": "application/json" };
  const ctx: Ctx = {
    suite: suite.suite,
    target: { base: target.base, kind: target.kind },
    publicDomain: env("RAILWAY_PUBLIC_DOMAIN"),
    websiteToken,
    reportingToken,
    websiteId,
    run: randomHex(5),
    wrong: randomHex(32),
    json,
    websiteAuth: { ...json, authorization: `Bearer ${websiteToken}` },
    reportingAuth: { authorization: `Bearer ${reportingToken}` },
  };
  if (ctx.suite === "rollback_check") return rollbackCheck(ctx);

  const docMode = documentationRangeMode(process.env);
  if (!docMode.ok) {
    stderr(`smoke: refusing: ${docMode.reason}`);
    return 2;
  }
  const evMode = eventsMode(process.env);
  if (!evMode.ok) {
    stderr(`smoke: refusing: ${evMode.reason}`);
    return 2;
  }
  // The kill switch and the event rows live in THIS environment's database, which only
  // this service (or a loopback service started with this environment) uses.
  let ops: OpsConfig | undefined;
  if (target.kind !== "railway_internal") {
    try {
      ops = loadOpsConfig(process.env);
    } catch (err) {
      // loadOpsConfig names variables and rules only, never values.
      stderr(`smoke: refusing: the kill-switch and event checks need this service's database settings (${err instanceof Error ? err.message : "invalid configuration"})`);
      return 2;
    }
  }
  const pool = ops ? createPool({ databaseUrl: ops.DATABASE_URL, ssl: ops.DATABASE_SSL, max: 2 }) : undefined;
  try {
    return await fullSuite(ctx, ops, pool);
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // Never print error objects: they could carry request details.
    stderr(`smoke: internal error (${err instanceof Error ? err.name : "unknown"})`);
    process.exitCode = 2;
  },
);
