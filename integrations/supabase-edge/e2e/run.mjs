#!/usr/bin/env node
// End-to-end scenarios for the idr-sync reference adapter on a LOCAL Supabase
// stack (see README.md): the Edge Function under Supabase's Edge Runtime,
// reached through Kong, writing through PostgREST into the stack's Postgres,
// pulling from the real resolver (apps/resolver/dist) on 127.0.0.1 through a
// fault-injecting proxy. Synthetic data only. Prints PASS/FAIL per check and
// writes results.json / results.md into the work directory; exit 1 on any FAIL.
//
// Prerequisites: `stack.sh up` has run; the resolver is built
// (`npm run build -w @idr/resolver`); E2E_RESOLVER_PG_URL_BASE names a
// superuser on a PostgreSQL cluster that nothing else uses (the feed horizon is
// cluster-wide), e.g. postgres://user:pass@127.0.0.1:5433 (no database part).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { anyFeed, firstPage, startFaultProxy } from "./lib/fault-proxy.mjs";
import { IP_EXAMPLE_COM, IP_EXAMPLE_EDU, Resolver } from "./lib/resolver.mjs";
import { forgedJwt, jwtClaims, Stack } from "./lib/supabase.mjs";

const sh = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const REPO = resolve(PKG, "../..");
const WORK = process.env["E2E_WORK"] ?? `${process.env["TMPDIR"] ?? tmpdir()}/idr-supabase-e2e`;
const INST = "idr-e2e";
const DAY_MS = 86_400_000;
const SUMMARY_KEYS = ["gap_new", "gap_recorded", "gaps_resolved", "observations", "pages", "reconcile", "status", "tombstones"];
const TABLES = ["idr_companies", "idr_observations", "idr_tombstones", "idr_sync_state", "idr_sync_gaps"];
/** idr_schema_version() of sql/0001_idr_projection.sql (PROJECTION_SCHEMA_VERSION in src/core/types.ts). */
const SCHEMA_VERSION = 6;
/** Trigger functions: no role but the owner holds EXECUTE (CHR-66 G4-L4). */
const TRIGGER_FUNCTIONS = ["idr_sync_gaps_guard"];
/** Expected grantees of an idr_* function's ACL. */
const expectedFnGrantees = (proname, owner) => (TRIGGER_FUNCTIONS.includes(proname) ? [owner] : [owner, "service_role"].sort());
const IDR_FUNCTIONS = [
  "idr_get_sync_state(text)",
  "idr_apply_feed_page(text,text,text,jsonb,text,boolean)",
  "idr_record_sync_status(text,text,boolean)",
  "idr_begin_resync(text)",
  "idr_reset_cursor(text,text)",
  "idr_reconcile_counts(text,date,date)",
  "idr_record_sync_gap(text,text,text)",
  "idr_resolve_sync_gaps(text,text)",
  "idr_schema_version()",
];

function envFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const secrets = envFile(`${WORK}/secrets.env`);
const status = JSON.parse(readFileSync(`${WORK}/status.json`, "utf8"));
const pgBase = process.env["E2E_RESOLVER_PG_URL_BASE"];
if (!pgBase) throw new Error("set E2E_RESOLVER_PG_URL_BASE (superuser URL of a NON-shared cluster, no database part)");
if (new URL(pgBase).port === "5432" && process.env["E2E_ALLOW_SHARED_CLUSTER"] !== "1") {
  throw new Error("refusing port 5432: the feed horizon is cluster-wide; use a dedicated cluster (or set E2E_ALLOW_SHARED_CLUSTER=1)");
}
const proxyPort = Number(process.env["E2E_PROXY_PORT"] ?? 54380);
const resolverPort = Number(process.env["E2E_RESOLVER_PORT"] ?? 54390);
const network = process.env["E2E_DOCKER_NETWORK"] ?? "idr_e2e_net";

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------
/** @type {{ scenario: string, check: string, ok: boolean, detail: string }[]} */
const results = [];
/** @type {Record<string, string>} */
const versions = {};
let scenario = "";
function check(name, ok, detail = "") {
  results.push({ scenario, check: name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"} [${scenario}] ${name}${detail ? ` (${detail})` : ""}`);
  return Boolean(ok);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
const randomHex = (n) => randomBytes(n).toString("hex");

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------
const gateway = (await sh("docker", ["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", network])).stdout.trim();
const stack = new Stack({ status, syncSecret: secrets["E2E_SYNC_SECRET"], projectId: INST });
const resolver = new Resolver({
  repo: REPO,
  pgBase,
  dbName: "idr_e2e_resolver",
  port: resolverPort,
  installationId: INST,
  websiteId: "idr-e2e-web",
  resolverToken: secrets["E2E_RESOLVER_TOKEN"],
  reportingToken: secrets["E2E_REPORTING_TOKEN"],
  logFile: `${WORK}/resolver.log`,
  preload: `${HERE}/lib/clock-preload.mjs`,
});
const proxy = await startFaultProxy({
  host: gateway,
  port: proxyPort,
  target: { host: "127.0.0.1", port: resolverPort },
  reportingToken: secrets["E2E_REPORTING_TOKEN"],
});

// ---------------------------------------------------------------------------
// oracle: what the projection must hold, from the feed itself
// ---------------------------------------------------------------------------
/** Cumulative model of every item the oracle has read from the feed, applied in stream order. */
const model = { obs: new Map(), companies: new Map(), tombs: new Map() };
function applyToModel(items) {
  for (const it of items) {
    if (it.type === "observation") {
      model.companies.set(it.company_id, { domain: it.domain, organisation_name: it.organisation_name });
      if (!model.obs.has(it.observation_id)) model.obs.set(it.observation_id, it);
    } else if (it.type === "company_erased") {
      model.tombs.set(it.tombstone_id, it);
      for (const [id, o] of model.obs) if (o.company_id === it.company_id) model.obs.delete(id);
      model.companies.delete(it.company_id);
    }
  }
}
/** Reads the whole retained feed directly from the resolver and merges it into the model. */
async function oracleSync() {
  const f = await resolver.feedAll();
  applyToModel(f.items);
  return f;
}

async function projection() {
  const obs = await stack.q(
    "select observation_id::text as id, company_id::int as company_id, observed_at, method, page_key, acquisition, entrance_contract from public.idr_observations where installation_id = $1",
    [INST],
  );
  const companies = await stack.q("select company_id::int as company_id, domain, organisation_name from public.idr_companies where installation_id = $1", [INST]);
  const tombs = await stack.q("select tombstone_id::text as id, company_id::int as company_id, erased_at from public.idr_tombstones where installation_id = $1", [INST]);
  return { obs: obs.rows, companies: companies.rows, tombs: tombs.rows };
}

/** Exact comparison of the projection with the model; returns a one-line, data-free summary. */
async function compareWithModel() {
  const p = await projection();
  let missing = 0;
  let extra = 0;
  let mismatched = 0;
  const seen = new Set();
  for (const row of p.obs) {
    seen.add(row.id);
    const m = model.obs.get(row.id);
    if (!m) {
      extra++;
      continue;
    }
    if (
      m.company_id !== row.company_id ||
      Date.parse(m.observed_at) !== row.observed_at.getTime() ||
      m.method !== row.method ||
      m.page_key !== row.page_key ||
      m.acquisition !== row.acquisition ||
      m.entrance_contract !== row.entrance_contract
    ) mismatched++;
  }
  for (const id of model.obs.keys()) if (!seen.has(id)) missing++;
  let companyDiff = 0;
  for (const c of p.companies) {
    const m = model.companies.get(c.company_id);
    if (!m || m.domain !== c.domain || m.organisation_name !== c.organisation_name) companyDiff++;
  }
  companyDiff += Math.max(0, model.companies.size - p.companies.length);
  let tombDiff = Math.abs(model.tombs.size - p.tombs.length);
  for (const t of p.tombs) {
    const m = model.tombs.get(t.id);
    if (!m || m.company_id !== t.company_id || Date.parse(m.erased_at) !== t.erased_at.getTime()) tombDiff++;
  }
  const ok = missing === 0 && extra === 0 && mismatched === 0 && companyDiff === 0 && tombDiff === 0;
  return {
    ok,
    detail: `observations ${p.obs.length}/${model.obs.size} (missing ${missing}, extra ${extra}, mismatched ${mismatched}), companies ${p.companies.length}/${model.companies.size}, tombstones ${p.tombs.length}/${model.tombs.size}`,
  };
}

async function state() {
  const r = await stack.q(
    "select cursor, status, needs_resync, reset_from_cursor, last_applied_at, last_run_at, resync_generation::int, replay_generation::int from public.idr_sync_state where installation_id = $1",
    [INST],
  );
  return r.rows[0] ?? null;
}
async function gaps() {
  return (await stack.q("select id::int, kind, expired_cursor, detected_at, last_applied_at, last_observed_at, resolved_at, resolution, detected_generation::int from public.idr_sync_gaps where installation_id = $1 order by id", [INST])).rows;
}
async function obsCount() {
  return Number((await stack.q("select count(*) as n from public.idr_observations where installation_id = $1", [INST])).rows[0].n);
}

function summaryShapeOk(r) {
  return r.json !== null && JSON.stringify(Object.keys(r.json).sort()) === JSON.stringify(SUMMARY_KEYS);
}
/** The response must carry counts and status only: no domain, cursor or credential. */
async function noLeak(r) {
  const st = await state();
  const forbidden = ["example.", secrets["E2E_REPORTING_TOKEN"], secrets["E2E_SYNC_SECRET"], st?.cursor, st?.reset_from_cursor].filter((x) => typeof x === "string" && x.length > 0);
  return !forbidden.some((x) => r.text.includes(x));
}
const brief = (r) => `HTTP ${r.status} ${r.json ? `status=${r.json.status} pages=${r.json.pages} obs=${r.json.observations} tomb=${r.json.tombstones} gap_recorded=${r.json.gap_recorded} gap_new=${r.json.gap_new} gaps_resolved=${r.json.gaps_resolved}` : `body ${r.text.length} bytes`}`;

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
async function resetProjection(sqlPath = `${PKG}/sql/0001_idr_projection.sql`) {
  await stack.q(`do $$ begin
      if to_regclass('cron.job') is not null then perform cron.unschedule(jobid) from cron.job where jobname = 'idr-sync'; end if;
    end $$`);
  await stack.q("drop view if exists public.idr_daily_company_activity");
  await stack.q(`drop table if exists ${TABLES.map((t) => `public.${t}`).join(", ")} cascade`);
  await stack.q(`do $$ declare f record; begin
      for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname like 'idr\\_%' loop
        execute 'drop function ' || f.sig;
      end loop;
    end $$`);
  // SETUP.md step 1, applied fresh (as on a new project), as `postgres`.
  await applySql(sqlPath);
}

async function applySql(sqlPath) {
  await stack.q(readFileSync(sqlPath, "utf8"));
  await stack.q("notify pgrst, 'reload schema'");
  await sleep(1500);
}

// ---------------------------------------------------------------------------
// S0b: code/SQL skew, then the in-place upgrade, on Supabase's own catalog
// ---------------------------------------------------------------------------
async function s0Upgrade() {
  scenario = "S0b skew and upgrade";
  // The previous release's script, verbatim (test/fixtures), as an existing client project would have it.
  await resetProjection(`${PKG}/test/fixtures/0001_idr_projection.f12b1ad.sql`);
  try {
    await upgradeChecks();
  } finally {
    // Fresh projection for the scenarios that follow, whatever happened above.
    await resetProjection();
  }
}

async function upgradeChecks() {
  const stateRows = async () => Number((await stack.q("select count(*) as n from public.idr_sync_state")).rows[0].n);
  const m = proxy.mark();
  const r = await stack.invoke();
  check("function over the previous release's SQL: HTTP 500 schema_mismatch, resolver not called, nothing written", r.status === 500 && r.json?.status === "schema_mismatch" && proxy.since(m).length === 0 && (await stateRows()) === 0, brief(r));
  const item = { type: "observation", observation_id: "900001", company_id: 900001, domain: "legacy.example", organisation_name: null, observed_at: "2026-11-02T12:00:00.000Z", method: "cache", page_key: null, acquisition: null, entrance_contract: null };
  const old = await stack.rpcService("idr_apply_feed_page", { p_installation_id: INST, p_expected_cursor: null, p_next_cursor: "legacy-c1", p_items: [item] });
  check("previous release's 4-argument apply works through PostgREST (existing data)", old.status === 200 && old.json?.applied === true, `HTTP ${old.status}`);
  await applySql(`${PKG}/sql/0001_idr_projection.sql`);
  const sv = await stack.rpcService("idr_get_sync_state", { p_installation_id: INST });
  const gone = (await stack.q("select to_regprocedure('public.idr_apply_feed_page(text,text,text,jsonb)') is null as g")).rows[0].g;
  const owner = (await stack.q("select current_user as u")).rows[0].u;
  const acl = (await stack.q("select proname, proacl::text[] as acl from pg_proc where pronamespace = 'public'::regnamespace and proname like 'idr\\_%'")).rows;
  const bad = acl.filter((x) => JSON.stringify((x.acl ?? []).map((a) => a.split("=")[0]).sort()) !== JSON.stringify(expectedFnGrantees(x.proname, owner)));
  check(
    `re-running the current SQL upgrades in place: row and cursor kept, schema_version ${SCHEMA_VERSION}, old signature dropped, ACLs exactly owner + service_role (owner only on the trigger function)`,
    sv.json?.schema_version === SCHEMA_VERSION && sv.json.cursor === "legacy-c1" && (await obsCount()) === 1 && gone && acl.length === IDR_FUNCTIONS.length + 1 && bad.length === 0,
    bad.map((x) => x.proname).join(",") || `${acl.length} functions`,
  );
}

async function setup() {
  scenario = "S0 setup";
  await resetProjection();
  await resolver.resetDatabase();
  await resolver.start({ hmacSecret: secrets["E2E_IP_HMAC_SECRET"] });
  await stack.waitForFunction();
  const sv = await stack.rpcService("idr_get_sync_state", { p_installation_id: INST });
  check("projection SQL applied; service_role RPC answers through PostgREST", sv.status === 200 && sv.json?.schema_version === SCHEMA_VERSION, `HTTP ${sv.status}, schema_version ${sv.json?.schema_version}`);

  versions["supabase_db"] = (await stack.q("select version() as v")).rows[0].v;
  versions["resolver_db"] = (await resolver.db().query("select version() as v")).rows[0].v;
  const auth = await stack.authHealth();
  versions["gotrue"] = `${auth.name ?? "GoTrue"} ${auth.version ?? "?"}`;
  for (const c of ["db", "rest", "auth", "kong", "edge_runtime"]) {
    const name = `supabase_${c}_${INST}`;
    const r = await sh("docker", ["inspect", "-f", "{{.Config.Image}} {{.Image}}", name]);
    versions[`image_${c}`] = r.stdout.trim();
  }
  const er = await sh("docker", ["logs", stack.edgeContainer]).catch(() => ({ stdout: "", stderr: "" }));
  const using = /Using (supabase-edge-runtime-[0-9.]+ \(compatible with Deno v[0-9.]+\))/.exec(`${er.stdout}${er.stderr}`);
  versions["edge_runtime"] = using ? using[1] : "unknown";
  versions["node"] = process.version;
  versions["postgrest"] = (await sh("docker", ["exec", `supabase_rest_${INST}`, "postgrest", "--version"])).stdout.trim().split("\n")[0];
  if (process.env["SUPABASE_CLI"]) versions["supabase_cli"] = (await sh(process.env["SUPABASE_CLI"], ["--version"])).stdout.trim();

  // Deploy-equivalent bundling (what `supabase functions deploy` uploads is an eszip): bundle
  // the function from the project layout SETUP.md step 3 describes, offline (--network none).
  const edgeImage = versions["image_edge_runtime"].split(" ")[0];
  const out = `${WORK}/bundle`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await sh("docker", ["run", "--rm", "--network", "none", "-v", `${WORK}/project:/project:ro`, "-v", `${out}:/out`, "--entrypoint", "edge-runtime", edgeImage,
    "bundle", "--entrypoint", "/project/supabase/functions/idr-sync/index.ts", "--output", "/out/idr-sync.eszip"]);
  const eszip = readFileSync(`${out}/idr-sync.eszip`);
  const modules = [...new Set(eszip.toString("latin1").match(/project\/[A-Za-z0-9_./-]+\.ts/g) ?? [])].sort();
  const expected = ["project/supabase/functions/idr-sync/index.ts", ...["config", "engine", "handler", "index", "postgrest-store", "types", "validate"].map((m) => `project/src/core/${m}.ts`)].sort();
  const leaks = [secrets["E2E_SYNC_SECRET"], secrets["E2E_REPORTING_TOKEN"]].filter((x) => eszip.includes(Buffer.from(x)));
  check("function bundles offline into an eszip with exactly the entry point and the 7 src/core modules (no secret)", JSON.stringify(modules) === JSON.stringify(expected) && leaks.length === 0, `${modules.length} modules, ${eszip.length} bytes`);
  const extv = (await stack.q("select string_agg(extname || ' ' || extversion, ', ' order by extname) as v from pg_extension")).rows[0].v;
  versions["supabase_db_extensions"] = extv;
}

// ---------------------------------------------------------------------------
// S2: function auth
// ---------------------------------------------------------------------------
async function s2FunctionAuth() {
  scenario = "S2 function auth";
  const m = proxy.mark();
  const secret = secrets["E2E_SYNC_SECRET"];
  const flipped = secret.slice(0, -1) + (secret.endsWith("0") ? "1" : "0");
  const cases = [
    ["no secret header", { secret: null }],
    ["wrong secret", { secret: randomHex(32) }],
    ["secret with its last character changed", { secret: flipped }],
    ["first half of the secret", { secret: secret.slice(0, 32) }],
    ["correct secret but GET", { method: "GET" }],
    ["correct secret but PUT", { method: "PUT" }],
    ["platform keys (anon apikey + service_role bearer) instead of the secret", { secret: null, headers: { apikey: stack.anonKey, authorization: `Bearer ${stack.serviceKey}` } }],
  ];
  for (const [name, o] of cases) {
    const r = await stack.invoke(o);
    check(`${name} -> 401 with an empty body`, r.status === 401 && r.text === "", `HTTP ${r.status}, body ${r.text.length} bytes`);
  }
  check("no rejected call reached the resolver", proxy.since(m).length === 0, `${proxy.since(m).length} proxied requests`);
  check("no sync state written by rejected calls", (await state()) === null);
}

// ---------------------------------------------------------------------------
// S1: authenticated sync, projection = feed, cursor persisted
// ---------------------------------------------------------------------------
async function s1Sync() {
  scenario = "S1 sync";
  await resolver.entrances(24, "s1");
  const m = proxy.mark();
  const r = await stack.invoke();
  check("first run drains the feed", r.status === 200 && r.json?.status === "ok" && r.json.observations === 24 && r.json.tombstones === 0, brief(r));
  check("response holds exactly the summary fields", summaryShapeOk(r), r.json ? Object.keys(r.json).join(",") : "");
  check("response carries no domain, cursor or credential", await noLeak(r));
  const feedReqs = proxy.since(m).filter(anyFeed);
  check("every feed request carried the reporting token", feedReqs.length > 0 && feedReqs.every((e) => e.reportingAuth), `${feedReqs.length} feed requests`);
  check("one feed request per page", feedReqs.length === r.json?.pages, `${feedReqs.length} requests, ${r.json?.pages} pages`);
  const f = await oracleSync();
  const cmp = await compareWithModel();
  check("projection equals the feed", cmp.ok, cmp.detail);
  const st = await state();
  check("cursor persisted = the feed's end cursor", st?.cursor === f.cursor && st.cursor !== null);
  check("state ok, no resync pending, last_applied_at set", st?.status === "ok" && st.needs_resync === false && st.last_applied_at !== null && st.reset_from_cursor === null, `status ${st?.status}`);

  // The reporting credential matters: without it, or with the website token, nothing is read or written.
  await resolver.entrances(2, "s1-auth");
  const before = await obsCount();
  proxy.addRule({ id: "no-auth", match: anyFeed, action: "auth", authorization: null, times: 1 });
  const r1 = await stack.invoke();
  proxy.clearRules();
  proxy.addRule({ id: "website-token", match: anyFeed, action: "auth", authorization: `Bearer ${secrets["E2E_RESOLVER_TOKEN"]}`, times: 1 });
  const r2 = await stack.invoke();
  proxy.clearRules();
  const st2 = await state();
  check("feed request without the reporting token -> auth_failed (HTTP 502)", r1.status === 502 && r1.json?.status === "auth_failed", brief(r1));
  check("feed request with the website token -> auth_failed (HTTP 502)", r2.status === 502 && r2.json?.status === "auth_failed", brief(r2));
  check("auth failures wrote nothing and kept the cursor", (await obsCount()) === before && st2?.cursor === f.cursor && st2.status === "auth_failed", `status ${st2?.status}`);
  const r3 = await stack.invoke();
  await oracleSync();
  const cmp3 = await compareWithModel();
  check("next run with the right token catches up", r3.status === 200 && r3.json?.status === "ok" && r3.json.observations === 2 && cmp3.ok, `${brief(r3)}; ${cmp3.detail}`);
}

// ---------------------------------------------------------------------------
// S3: replay and idempotency
// ---------------------------------------------------------------------------
async function s3Replay() {
  scenario = "S3 replay/idempotency";
  const st0 = await state();
  const snap = async () => (await stack.q("select count(*)::int as n, max(received_at) as r, (select count(*)::int from public.idr_companies) as c from public.idr_observations")).rows[0];
  const s0 = await snap();

  // a) same cursor again
  const ra = await stack.invoke();
  const sa = await snap();
  const sta = await state();
  check("re-run at the end cursor: ok, nothing new", ra.status === 200 && ra.json?.status === "ok" && ra.json.observations === 0 && ra.json.pages === 1, brief(ra));
  check("re-run left rows and cursor untouched (same count, same max received_at)", sa.n === s0.n && sa.r?.getTime() === s0.r?.getTime() && sta?.cursor === st0.cursor);

  // b) stale cursor: the state as restored from an older backup (cursor after the first 10 items)
  const p1 = await resolver.feedPage(null, 5);
  const p2 = await resolver.feedPage(p1.body.next_cursor, 5);
  const stale = p2.body.next_cursor;
  await stack.q("update public.idr_sync_state set cursor = $1 where installation_id = $2", [stale, INST]);
  const rb = await stack.invoke();
  const sb = await snap();
  const stb = await state();
  check("replay from a stale cursor: ok, every item already applied", rb.status === 200 && rb.json?.status === "ok" && rb.json.observations === 0 && rb.json.pages >= 3, brief(rb));
  check("stale replay added no row and returned the cursor to the end", sb.n === s0.n && sb.c === s0.c && sb.r?.getTime() === s0.r?.getTime() && stb?.cursor === st0.cursor);

  // c) operator resync (idr_begin_resync via PostgREST as service_role) without a gap
  const rs = await stack.rpcService("idr_begin_resync", { p_installation_id: INST });
  const stc0 = await state();
  check("idr_begin_resync (voluntary): cursor reset, old position kept for the re-check", rs.status === 200 && rs.json?.ok === true && rs.json.gap_recorded === false && stc0?.cursor === null && stc0.reset_from_cursor === st0.cursor && stc0.status === "resync_requested", `HTTP ${rs.status}, status ${stc0?.status}`);
  const m = proxy.mark();
  const rc = await stack.invoke();
  const reqs = proxy.since(m).filter(anyFeed);
  const stc = await state();
  check("resync run: re-check of the old position first (after=<old>, limit=1, 200), then the replay from the start", reqs[0]?.hasAfter === true && reqs[0].limit === "1" && reqs[0].status === 200 && reqs[1]?.hasAfter === false, reqs.map((e) => `${e.hasAfter ? "after" : "start"}/${e.limit}/${e.status}`).join(" "));
  check("resync run: ok, idempotent (0 new rows), re-check cleared, cursor at the end, no gap", rc.json?.status === "ok" && rc.json.observations === 0 && stc?.reset_from_cursor === null && stc.cursor === st0.cursor && (await gaps()).length === 0 && (await snap()).n === s0.n, brief(rc));

  // d) concurrent invocations (responses delayed so that they overlap)
  await resolver.entrances(15, "s3-concurrent");
  proxy.addRule({ id: "slow", match: anyFeed, action: "delay", ms: 400 });
  const rs3 = await Promise.all([stack.invoke(), stack.invoke(), stack.invoke()]);
  proxy.clearRules();
  const statuses = rs3.map((x) => x.json?.status);
  const inserted = rs3.reduce((a, x) => a + (x.json?.observations ?? 0), 0);
  check("3 concurrent runs: one drains, the others stop at the compare-and-set", statuses.includes("ok") && statuses.filter((s) => s === "cas_conflict").length >= 1 && statuses.every((s) => s === "ok" || s === "cas_conflict"), statuses.join(","));
  check("3 concurrent runs inserted each observation exactly once", inserted === 15, `${inserted} inserted in total`);
  const rd = await stack.invoke();
  const f = await oracleSync();
  const cmp = await compareWithModel();
  const dup = (await stack.q("select count(*)::int - count(distinct observation_id)::int as d from public.idr_observations")).rows[0].d;
  check("after the concurrent runs: projection equals the feed, no duplicates, cursor at the end", cmp.ok && dup === 0 && (await state())?.cursor === f.cursor && rd.json?.observations === 0, `${cmp.detail}; follow-up ${brief(rd)}`);

  // e) compare-and-set at the SQL level, through PostgREST: 5 concurrent applies of one page
  await resolver.entrances(3, "s3-cas");
  const st5 = await state();
  const page = await resolver.feedPage(st5.cursor, 5);
  const args = { p_installation_id: INST, p_expected_cursor: st5.cursor, p_next_cursor: page.body.next_cursor, p_items: page.body.items, p_expected_reset_from: null };
  const applies = await Promise.all(Array.from({ length: 5 }, () => stack.rpcService("idr_apply_feed_page", args)));
  const won = applies.filter((x) => x.json?.applied === true);
  const lost = applies.filter((x) => x.json?.applied === false);
  check("5 concurrent idr_apply_feed_page with one expected cursor: exactly one applies", won.length === 1 && lost.length === 4 && won[0].json.observations === 3, `${won.length} applied, ${lost.length} refused`);
  check("the winner advanced the cursor once", (await state())?.cursor === page.body.next_cursor);
  const re = await stack.invoke();
  await oracleSync();
  const cmpe = await compareWithModel();
  check("function continues from the CAS winner's cursor", re.json?.status === "ok" && re.json.observations === 0 && cmpe.ok, `${brief(re)}; ${cmpe.detail}`);

  // f) more pages than IDR_MAX_PAGES (50): partial, then the next run continues
  await resolver.entrances(260, "s3-volume");
  const rf1 = await stack.invoke();
  const stf1 = await state();
  check("260 new observations = 52 pages of 5 > IDR_MAX_PAGES: partial (HTTP 200) after 50 pages", rf1.status === 200 && rf1.json?.status === "partial" && rf1.json.pages === 50 && rf1.json.observations === 250 && stf1?.status === "partial", brief(rf1));
  const rf2 = await stack.invoke();
  const ff = await oracleSync();
  const cmpf = await compareWithModel();
  check("next run continues from the stored cursor and drains", rf2.json?.status === "ok" && rf2.json.pages === 2 && rf2.json.observations === 10 && (await state())?.cursor === ff.cursor && cmpf.ok, `${brief(rf2)}; ${cmpf.detail}`);
}

// ---------------------------------------------------------------------------
// S4: tombstones
// ---------------------------------------------------------------------------
async function s4Tombstones() {
  scenario = "S4 tombstones";
  const com = (await stack.q("select company_id::int as id from public.idr_companies where domain = 'example.com'")).rows[0]?.id;
  const edu = (await stack.q("select company_id::int as id from public.idr_companies where domain = 'example.edu'")).rows[0]?.id;
  const n = async (id) => Number((await stack.q("select count(*) as n from public.idr_observations where company_id = $1", [id])).rows[0].n);
  const comBefore = await n(com);
  const eduBefore = await n(edu);
  const st0 = await state();
  const er = await resolver.eraseCompany(com);
  check("ops:erase-company erased the company and wrote one tombstone", er.erased === true && er.tombstones === 1 && er.observations_deleted === comBefore, `observations_deleted ${er.observations_deleted}, projection had ${comBefore}`);
  check("projection unchanged until the consumer pulls", (await n(com)) === comBefore);
  const next = await resolver.feedPage(st0.cursor, 5);
  const fresh = await resolver.feedAll();
  check(
    "the tombstone follows every observation the consumer applied (it is the only item after its cursor) and the erased observations left the feed",
    next.body.items.length === 1 && next.body.items[0].type === "company_erased" && next.body.items[0].company_id === com && !fresh.items.some((i) => i.type === "observation" && i.company_id === com),
  );
  const r = await stack.invoke();
  const tomb = (await stack.q("select tombstone_id::text as id, company_id::int as c from public.idr_tombstones")).rows;
  check("run applies the tombstone", r.json?.status === "ok" && r.json.tombstones === 1 && r.json.observations === 0, brief(r));
  check("company and all its observations removed; tombstone recorded; other company untouched", (await n(com)) === 0 && (await stack.q("select 1 from public.idr_companies where company_id = $1", [com])).rowCount === 0 && tomb.length === 1 && tomb[0].c === com && (await n(edu)) === eduBefore, `${comBefore} observations removed`);
  applyToModel(fresh.items);
  const cmp = await compareWithModel();
  check("projection equals the feed", cmp.ok, cmp.detail);

  // Re-observation: same domain, NEW company id; the tombstone applies to its own id only.
  await resolver.entrance(IP_EXAMPLE_COM, "/e2e/s4-reobserved/0");
  const r2 = await stack.invoke();
  const newCom = (await stack.q("select company_id::int as id from public.idr_companies where domain = 'example.com'")).rows;
  check("re-observed domain arrives as a new company id", r2.json?.observations === 1 && newCom.length === 1 && newCom[0].id !== com, brief(r2));
  // Full replay from the start re-applies the tombstone idempotently.
  await stack.rpcService("idr_begin_resync", { p_installation_id: INST });
  const r3 = await stack.invoke();
  await oracleSync();
  const cmp3 = await compareWithModel();
  check("full replay re-applies the tombstone idempotently; the new company survives, the erased one stays gone", r3.json?.status === "ok" && r3.json.observations === 0 && r3.json.tombstones === 0 && cmp3.ok && (await n(com)) === 0, `${brief(r3)}; ${cmp3.detail}`);
}

// ---------------------------------------------------------------------------
// S5: interruption recovery
// ---------------------------------------------------------------------------
async function s5Interruption() {
  scenario = "S5 interruption";
  // a) kill the Edge Runtime while page 3 is in flight (the resolver has answered, the function has not applied it)
  await resolver.entrances(20, "s5-kill");
  const n0 = await obsCount();
  let k = 0;
  const hold = proxy.addRule({ id: "hold-3rd", match: (e) => e.feed && ++k === 3, action: "hold", times: 1 });
  const pending = stack.invoke();
  await Promise.race([hold.held, sleep(30_000).then(() => Promise.reject(new Error("page 3 never requested")))]);
  const mid = await state();
  const nMid = await obsCount();
  await stack.killEdgeRuntime();
  const killed = await pending;
  hold.release();
  proxy.clearRules();
  check("function killed (SIGKILL of the Edge Runtime) mid-sync: the caller gets no success", killed.status !== 200, `HTTP ${killed.status}`);
  check("pages applied before the kill are committed (2 pages = 10 observations), nothing after", nMid - n0 === 10 && (await obsCount()) === nMid && (await state())?.cursor === mid?.cursor, `${nMid - n0} applied before the kill`);
  await stack.startEdgeRuntime();
  const r = await stack.invoke();
  await oracleSync();
  const cmp = await compareWithModel();
  check("next run resumes from the committed cursor: the remaining 10, no loss, no duplicate", r.json?.status === "ok" && r.json.observations === 10 && cmp.ok, `${brief(r)}; ${cmp.detail}`);

  // b) the store fails between fetch and apply (apply blocked on the state row, its backend terminated)
  await resolver.entrances(10, "s5-store");
  const nb0 = await obsCount();
  const stb0 = await state();
  const locker = await stack.pool.connect();
  await locker.query("begin");
  await locker.query("select 1 from public.idr_sync_state where installation_id = $1 for update", [INST]);
  const pb = stack.invoke();
  const pid = await waitFor(
    async () => (await stack.q("select pid from pg_stat_activity where wait_event_type = 'Lock' and query like '%idr_apply_feed_page%' and pid <> pg_backend_pid()")).rows[0]?.pid,
    20_000,
    "the apply to block",
  );
  const term = (await stack.q("select pg_terminate_backend($1) as ok", [pid])).rows[0].ok;
  await sleep(500);
  await locker.query("rollback");
  locker.release();
  const rb = await pb;
  const stb = await state();
  check("apply failed (PostgREST backend terminated): store_error, HTTP 500", term === true && rb.status === 500 && rb.json?.status === "store_error", brief(rb));
  check("failed apply rolled back: cursor and rows unchanged", (await obsCount()) === nb0 && stb?.cursor === stb0?.cursor && stb.status === "store_error", `status ${stb?.status}`);
  const rb2 = await stack.invoke();
  await oracleSync();
  const cmpb = await compareWithModel();
  check("next run applies the page: no loss, no duplicate", rb2.json?.status === "ok" && rb2.json.observations === 10 && cmpb.ok, `${brief(rb2)}; ${cmpb.detail}`);

  // c) ambiguous outcome: the function dies while its apply RPC is in flight (blocked on the
  //    state row lock, below the 8 s statement_timeout). PostgREST does not cancel a statement
  //    whose client went away, so the apply commits after the caller is gone.
  await resolver.entrances(5, "s5-ambiguous");
  const nc0 = await obsCount();
  const stc0 = await state();
  const locker2 = await stack.pool.connect();
  await locker2.query("begin");
  await locker2.query("select 1 from public.idr_sync_state where installation_id = $1 for update", [INST]);
  const pc = stack.invoke();
  await waitFor(async () => (await stack.q("select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%idr_apply_feed_page%'")).rowCount > 0, 20_000, "the apply to block");
  await stack.killEdgeRuntime();
  const rc = await pc;
  await sleep(1000);
  await locker2.query("rollback");
  locker2.release();
  await sleep(1000);
  const stc = await state();
  check("function killed while its apply waited: the caller gets no success", rc.status !== 200, `HTTP ${rc.status}`);
  check("the orphaned apply committed after the function died (cursor advanced, 5 rows)", stc?.cursor !== stc0?.cursor && (await obsCount()) === nc0 + 5);
  await stack.startEdgeRuntime();
  const rc2 = await stack.invoke();
  await oracleSync();
  const cmpc = await compareWithModel();
  check("next run continues from the committed cursor: nothing re-applied, no loss, no duplicate", rc2.json?.status === "ok" && rc2.json.observations === 0 && cmpc.ok, `${brief(rc2)}; ${cmpc.detail}`);

  // d) the apply waits longer than PostgREST's statement_timeout (role authenticator, 8 s on
  //    this stack): cancelled server-side well before the store's 20 s client timeout.
  const roleCfg = ((await stack.q("select rolconfig from pg_roles where rolname = 'authenticator'")).rows[0]?.rolconfig ?? []).filter((x) => /^(statement|lock)_timeout=/.test(x)).join(" ");
  await resolver.entrances(5, "s5-timeout");
  const nd0 = await obsCount();
  const std0 = await state();
  const locker3 = await stack.pool.connect();
  await locker3.query("begin");
  await locker3.query("select 1 from public.idr_sync_state where installation_id = $1 for update", [INST]);
  const t0 = Date.now();
  const pd = stack.invoke();
  await waitFor(async () => (await stack.q("select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%idr_apply_feed_page%'")).rowCount > 0, 20_000, "the apply to block");
  // After the apply fails, the function records its status, which waits on the same lock.
  await waitFor(async () => (await stack.q("select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%idr_record_sync_status%'")).rowCount > 0, 40_000, "the function to give up");
  const gaveUpAfter = Date.now() - t0;
  await locker3.query("rollback");
  locker3.release();
  const rd = await pd;
  const std = await state();
  check(
    "apply blocked past the authenticator role's statement/lock timeout: cancelled server-side (before the store's 20 s client timeout), store_error, rolled back",
    rd.json?.status === "store_error" && gaveUpAfter < 20_000 && std?.cursor === std0?.cursor && (await obsCount()) === nd0,
    `gave up after ${Math.round(gaveUpAfter / 1000)} s; authenticator: ${roleCfg}`,
  );
  const rd2 = await stack.invoke();
  await oracleSync();
  const cmpd = await compareWithModel();
  check("next run applies the page: no loss, no duplicate", rd2.json?.status === "ok" && rd2.json.observations === 5 && cmpd.ok, `${brief(rd2)}; ${cmpd.detail}`);
}

// ---------------------------------------------------------------------------
// S7: RLS through PostgREST with real Auth (GoTrue) tokens
// ---------------------------------------------------------------------------
async function s7Rls() {
  scenario = "S7 RLS via PostgREST";
  const run = randomHex(4);
  const READS = [...TABLES, "idr_daily_company_activity"];
  const dbCount = async (t) => Number((await stack.q(`select count(*) as n from public.${t}`)).rows[0].n);
  // 42501 (permission denied) is 401 for anon and 403 for authenticated in PostgREST.
  const denied = (r) => (r.status === 401 || r.status === 403) && !(Array.isArray(r.json) && r.json.length > 0);
  const RPC_ARGS = {
    idr_begin_resync: { p_installation_id: INST },
    idr_get_sync_state: { p_installation_id: INST },
    idr_record_sync_status: { p_installation_id: INST, p_status: "ok", p_needs_resync: false },
    idr_reset_cursor: { p_installation_id: INST, p_expected_cursor: "c9" },
    idr_apply_feed_page: { p_installation_id: INST, p_expected_cursor: null, p_next_cursor: "c1", p_items: [], p_expected_reset_from: null },
    idr_record_sync_gap: { p_installation_id: INST, p_kind: "cursor_expired", p_expected_cursor: null },
  };

  // anon: legacy anon JWT and the new publishable key
  for (const t of READS) {
    const a = await stack.rest(`${t}?select=*`, { apikey: stack.anonKey, token: stack.anonKey });
    const b = await stack.rest(`${t}?select=*`, { apikey: stack.publishableKey, token: null });
    check(`anon cannot read ${t}`, denied(a) && denied(b), `HTTP ${a.status} (anon key), ${b.status} (publishable key)`);
  }
  for (const [fn, args] of Object.entries(RPC_ARGS)) {
    const r = await stack.rest(`rpc/${fn}`, { method: "POST", apikey: stack.anonKey, token: stack.anonKey, body: args });
    check(`anon cannot execute ${fn}`, denied(r), `HTTP ${r.status}`);
  }

  // a forged token with the claim
  const forged = forgedJwt({ role: "authenticated", aud: "authenticated", sub: "e2e-forged", exp: Math.floor(Date.now() / 1000) + 600, app_metadata: { idr_reader: true } });
  const fr = await stack.rest("idr_observations?select=*", { token: forged });
  check("a token signed with another key is rejected", fr.status === 401, `HTTP ${fr.status}`);

  // public sign-up is off (SETUP.md); staff are created with the admin API
  const su = await stack.publicSignUp(`signup-${run}@example.test`, randomHex(12));
  check("public sign-up refused", su.status === 422 && su.code === "signup_disabled", `HTTP ${su.status} ${su.code}`);

  // a signed-in user without the claim
  const pw1 = randomHex(12);
  const u1 = await stack.adminCreateUser(`plain-${run}@example.test`, pw1);
  let t1 = await stack.signIn(`plain-${run}@example.test`, pw1);
  check("GoTrue issued an authenticated token without the claim", jwtClaims(t1).role === "authenticated" && jwtClaims(t1).app_metadata?.idr_reader === undefined);
  for (const t of READS) {
    const r = await stack.rest(`${t}?select=*`, { token: t1 });
    check(`authenticated without claim sees no rows in ${t}`, r.status === 200 && Array.isArray(r.json) && r.json.length === 0 && (await dbCount(t)) > 0, `HTTP ${r.status}, ${Array.isArray(r.json) ? r.json.length : "?"} rows (db has ${await dbCount(t)})`);
  }
  // user_metadata is user-editable and must not grant anything
  const upd = await stack.selfUpdateUserMetadata(t1, { idr_reader: true });
  t1 = await stack.signIn(`plain-${run}@example.test`, pw1);
  const um = await stack.rest("idr_observations?select=*", { token: t1 });
  check("self-set user_metadata.idr_reader=true grants nothing", upd === 200 && jwtClaims(t1).user_metadata?.idr_reader === true && um.status === 200 && um.json?.length === 0, `update HTTP ${upd}, read ${um.json?.length} rows`);

  // a reader: claim granted with the admin API
  const pw2 = randomHex(12);
  const u2 = await stack.adminCreateUser(`reader-${run}@example.test`, pw2);
  const tOld = await stack.signIn(`reader-${run}@example.test`, pw2);
  await stack.adminSetReader(u2.id, true);
  const oldRead = await stack.rest("idr_observations?select=*", { token: tOld });
  check("a token issued before the grant still sees nothing (sign in again)", oldRead.status === 200 && oldRead.json?.length === 0);
  const t2 = await stack.signIn(`reader-${run}@example.test`, pw2);
  check("new token carries app_metadata.idr_reader = true", jwtClaims(t2).app_metadata?.idr_reader === true);
  for (const t of TABLES) {
    const r = await stack.rest(`${t}?select=*`, { token: t2 });
    const db = await dbCount(t);
    check(`reader sees every row of ${t}`, r.status === 200 && Array.isArray(r.json) && r.json.length === db && db > 0, `${r.json?.length} of ${db}`);
  }
  const view = await stack.rest("idr_daily_company_activity?select=entrances", { token: t2 });
  const viewSum = Array.isArray(view.json) ? view.json.reduce((a, x) => a + Number(x.entrances), 0) : -1;
  check("reader can read the daily activity view (security_invoker)", view.status === 200 && viewSum === (await dbCount("idr_observations")), `sum of entrances ${viewSum}`);

  const before = await Promise.all(TABLES.map(dbCount));
  const writes = [
    ["insert idr_observations", "idr_observations", { method: "POST", body: { installation_id: INST, observation_id: 1, company_id: 1, observed_at: new Date().toISOString(), method: "cache" } }],
    ["update idr_sync_state", "idr_sync_state?installation_id=eq." + INST, { method: "PATCH", body: { cursor: null } }],
    ["delete idr_companies", "idr_companies?installation_id=eq." + INST, { method: "DELETE" }],
    ["delete idr_sync_gaps", "idr_sync_gaps?installation_id=eq." + INST, { method: "DELETE" }],
    ["insert idr_tombstones", "idr_tombstones", { method: "POST", body: { installation_id: INST, tombstone_id: 1, company_id: 1, erased_at: new Date().toISOString() } }],
  ];
  for (const [name, path, o] of writes) {
    const r = await stack.rest(path, { ...o, token: t2 });
    check(`reader cannot ${name}`, r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  }
  for (const [fn, args] of Object.entries(RPC_ARGS)) {
    const r = await stack.rest(`rpc/${fn}`, { method: "POST", token: t2, body: args });
    check(`reader cannot execute ${fn}`, denied(r), `HTTP ${r.status}`);
  }
  const after = await Promise.all(TABLES.map(dbCount));
  check("no write attempt changed any table", JSON.stringify(before) === JSON.stringify(after));

  // revocation: a new sign-in loses access; an already issued token keeps it until it expires (documented)
  await stack.adminSetReader(u2.id, false);
  const stillOld = await stack.rest("idr_observations?select=*", { token: t2 });
  const t3 = await stack.signIn(`reader-${run}@example.test`, pw2);
  const revoked = await stack.rest("idr_observations?select=*", { token: t3 });
  check("after revocation a new token sees nothing; the earlier token keeps reading until it expires (SETUP.md 5.4)", revoked.json?.length === 0 && (stillOld.json?.length ?? 0) > 0, `old token ${stillOld.json?.length} rows, new token ${revoked.json?.length}`);

  // service_role and the ACLs the unit tests claim, read from the catalog of this stack
  const sr = await stack.rpcService("idr_get_sync_state", { p_installation_id: INST });
  check("service_role RPC works", sr.status === 200 && sr.json?.schema_version === SCHEMA_VERSION && typeof sr.json.cursor === "string");
  const acl = (
    await stack.q(
      `select f, r, has_function_privilege(r, 'public.' || f, 'execute') as x
         from unnest($1::text[]) f, unnest(array['anon','authenticated','service_role']) r`,
      [IDR_FUNCTIONS],
    )
  ).rows;
  const badFn = acl.filter((a) => a.x !== (a.r === "service_role"));
  check("only service_role may execute the idr_* functions (catalog)", badFn.length === 0, badFn.map((a) => `${a.r}:${a.f}`).join(" ") || `${acl.length} grants checked`);
  const owner = (await stack.q("select current_user as u")).rows[0].u;
  const proacl = (await stack.q("select proname, proacl::text[] as acl from pg_proc where pronamespace = 'public'::regnamespace and proname like 'idr\\_%'")).rows;
  const badAcl = proacl.filter((x) => JSON.stringify((x.acl ?? []).map((a) => a.split("=")[0]).sort()) !== JSON.stringify(expectedFnGrantees(x.proname, owner)));
  check("every idr_* function's ACL holds exactly its owner and service_role, the trigger function its owner only (as rls.test.ts claims)", proacl.length === IDR_FUNCTIONS.length + 1 && badAcl.length === 0, badAcl.map((x) => `${x.proname}: ${(x.acl ?? []).map((a) => a.split("=")[0]).join(",")}`).join("; ") || `${proacl.length} functions`);
  const tp = (
    await stack.q(
      `select t, r, p, has_table_privilege(r, 'public.' || t, p) as x
         from unnest($1::text[]) t, unnest(array['anon','authenticated','service_role']) r,
              unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p`,
      [[...TABLES, "idr_daily_company_activity"]],
    )
  ).rows;
  const has = (t, r, p) => tp.find((a) => a.t === t && a.r === r && a.p === p)?.x === true;
  const WRITE = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];
  const viol = [];
  for (const t of [...TABLES, "idr_daily_company_activity"]) {
    for (const p of ["SELECT", ...WRITE]) if (has(t, "anon", p)) viol.push(`anon:${p}:${t}`);
    for (const p of WRITE) if (has(t, "authenticated", p)) viol.push(`authenticated:${p}:${t}`);
    if (!has(t, "authenticated", "SELECT")) viol.push(`authenticated lacks SELECT:${t}`);
    if (!has(t, "service_role", "SELECT")) viol.push(`service_role lacks SELECT:${t}`);
  }
  // CHR-66 R2-8: service_role reads only; it writes through the SECURITY DEFINER functions alone.
  for (const t of [...TABLES, "idr_daily_company_activity"]) for (const p of WRITE) if (has(t, "service_role", p)) viol.push(`service_role:${p}:${t}`);
  check("table privileges: anon none; authenticated and service_role SELECT only; writes only through the idr_* functions (catalog)", viol.length === 0, viol.join(" ") || `${tp.length} privileges checked`);
  // CHR-66 G4-L4: nothing beyond what the SQL grants survives Supabase's default privileges.
  const extra = tp.filter((a) => a.x && (["TRUNCATE", "REFERENCES", "TRIGGER"].includes(a.p) || (a.t === "idr_daily_company_activity" && a.p !== "SELECT"))).map((a) => `${a.r}:${a.p}:${a.t}`);
  const seq = (
    await stack.q(
      `select r, has_sequence_privilege(r, pg_get_serial_sequence('public.idr_sync_gaps', 'id'), 'USAGE,SELECT,UPDATE') as x
         from unnest(array['anon','authenticated','service_role']) r`,
    )
  ).rows.filter((a) => a.x).map((a) => `${a.r}:sequence`);
  check("no TRUNCATE, REFERENCES or TRIGGER for any API role, no write on the view, no privilege on the gap id sequence, despite Supabase's default privileges (catalog)", extra.length + seq.length === 0, [...extra, ...seq].join(" ") || "none");
  const rls = (await stack.q("select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1)", [TABLES])).rows;
  check("RLS enabled on every projection table", rls.length === TABLES.length && rls.every((x) => x.relrowsecurity));
  // keep the user ids out of the output
  void u1;
}

// ---------------------------------------------------------------------------
// S6: continuity gap (410) through a real retention prune
// ---------------------------------------------------------------------------
/** Two batches separated in observed_at by a boundary; the prune removes the first. */
async function stallAndPrune(tagA, nA, tagB, nB) {
  await resolver.entrances(nA, tagA, IP_EXAMPLE_EDU);
  await sleep(2500);
  const boundary = Date.now();
  await sleep(2500);
  await resolver.entrances(nB, tagB, IP_EXAMPLE_EDU);
  const ids = async (tag) => (await resolver.db().query("select id::text from company_observations where page_key like $1", [`/e2e/${tag}/%`])).rows.map((r) => r.id);
  const aIds = await ids(tagA);
  const bIds = await ids(tagB);
  const total = Number((await resolver.db().query("select count(*) as n from company_observations")).rows[0].n);
  const pr = await resolver.prune({ fakeNowMs: boundary + DAY_MS, retentionDays: 1 });
  const left = (await resolver.db().query("select id::text from company_observations")).rows.map((r) => r.id).sort();
  return { aIds, bIds, total, pr, left };
}

async function s6Gap() {
  scenario = "S6a gap: stalled consumer, 410";
  let r = await stack.invoke();
  const st0 = await state();
  const C = st0.cursor;
  const maxObserved = (await stack.q("select max(observed_at) as m from public.idr_observations")).rows[0].m;
  const { aIds, bIds, total, pr, left } = await stallAndPrune("gap-a", 6, "gap-b", 4);
  check(
    "ops:prune (OBSERVATION_RETENTION_DAYS=1, run as of boundary + 1 day) pruned everything before the boundary, kept the later batch",
    pr.observations_pruned === total - bIds.length && JSON.stringify(left) === JSON.stringify([...bIds].sort()),
    `pruned ${pr.observations_pruned} of ${total}; ${left.length} retained`,
  );
  const wm = (await resolver.db().query("select count(*)::int as n from feed_retention_watermarks")).rows[0].n;
  const direct = await resolver.feedPage(C, 5);
  check("resolver: the consumer's cursor is behind the watermark -> 410 cursor_expired", wm === 1 && direct.status === 410 && direct.body?.error === "cursor_expired", `HTTP ${direct.status}`);

  const m = proxy.mark();
  r = await stack.invoke();
  const g1 = await gaps();
  const st1 = await state();
  check("run -> HTTP 409 needs_resync, gap_recorded, gap_new", r.status === 409 && r.json?.status === "needs_resync" && r.json.gap_recorded === true && r.json.gap_new === true, brief(r));
  check(
    "exactly one idr_sync_gaps row: cursor_expired, the stale cursor, last_applied_at and last_observed_at from the projection, open",
    g1.length === 1 && g1[0].kind === "cursor_expired" && g1[0].expired_cursor === C && g1[0].resolved_at === null && g1[0].resolution === null &&
      g1[0].last_applied_at?.getTime() === st0.last_applied_at?.getTime() && g1[0].last_observed_at?.getTime() === maxObserved?.getTime(),
  );
  check("cursor neither advanced nor skipped; needs_resync set", st1?.cursor === C && st1.needs_resync === true && st1.status === "needs_resync");
  check("the run made one feed request (the 410)", proxy.since(m).length === 1 && proxy.since(m)[0].status === 410);
  const m2 = proxy.mark();
  const r2 = await stack.invoke();
  const r3 = await stack.invoke();
  check("repeated runs: 409, gap_recorded, no new row, no resolver call", [r2, r3].every((x) => x.status === 409 && x.json?.gap_recorded === true && x.json.gap_new === false) && (await gaps()).length === 1 && proxy.since(m2).length === 0, `${brief(r2)}; ${brief(r3)}`);

  // the gap log is append-only even for service_role and the table owner
  const del = await stack.rest(`idr_sync_gaps?id=eq.${g1[0].id}`, { method: "DELETE", apikey: stack.serviceKey, token: stack.serviceKey });
  const patch = await stack.rest(`idr_sync_gaps?id=eq.${g1[0].id}`, { method: "PATCH", apikey: stack.serviceKey, token: stack.serviceKey, body: { expired_cursor: null } });
  const ownerDel = await stack.q("delete from public.idr_sync_gaps").then(() => "deleted", (e) => e.code);
  const ownerTrunc = await stack.q("truncate public.idr_sync_gaps").then(() => "truncated", (e) => e.code);
  check("gap row cannot be deleted or rewritten (service_role via PostgREST, owner via SQL)", del.status === 403 && patch.status >= 400 && ownerDel === "23514" && ownerTrunc === "23514" && (await gaps()).length === 1, `DELETE ${del.status}, PATCH ${patch.status}, owner delete ${ownerDel}, owner truncate ${ownerTrunc}`);

  // operator: idr_begin_resync, then drain
  const rb = await stack.rpcService("idr_begin_resync", { p_installation_id: INST });
  const st2 = await state();
  check("idr_begin_resync after needs_resync: flag cleared, cursor reset, no re-check (gap already on record)", rb.status === 200 && rb.json?.gap_recorded === false && st2?.cursor === null && st2.needs_resync === false && st2.reset_from_cursor === null && st2.status === "resync_requested");
  const r4 = await stack.invoke();
  const g2 = await gaps();
  check("drain after the resync: ok, gaps_resolved = 1", r4.status === 200 && r4.json?.status === "ok" && r4.json.gaps_resolved === 1, brief(r4));
  check("the gap row persists, resolved once (full_resync)", g2.length === 1 && g2[0].resolved_at !== null && g2[0].resolution === "full_resync" && g2[0].expired_cursor === C);
  const p = await projection();
  const have = new Set(p.obs.map((o) => o.id));
  check("rebuilt from the retained buffer: later batch present, pruned batch permanently absent", bIds.every((id) => have.has(id)) && aIds.every((id) => !have.has(id)), `${bIds.length} retained present, ${aIds.length} pruned absent`);
  const kept = [...model.obs.keys()].every((id) => have.has(id));
  check("observations pruned at the resolver but applied earlier stay in the projection (client-owned history)", kept, `${model.obs.size} earlier observations`);
  await oracleSync();
  const cmp = await compareWithModel();
  check("projection = everything served before the gap + the retained buffer", cmp.ok, cmp.detail);

  scenario = "S6b gap: voluntary resync re-check";
  const rv0 = await stack.invoke();
  const C2 = (await state()).cursor;
  const s = await stallAndPrune("gap-c", 3, "gap-d", 2);
  const rb2 = await stack.rpcService("idr_begin_resync", { p_installation_id: INST });
  const sv = await state();
  check("voluntary idr_begin_resync keeps the old position for the re-check", rv0.json?.status === "ok" && rb2.json?.gap_recorded === false && sv?.reset_from_cursor === C2 && sv.cursor === null && sv.needs_resync === false);
  const mv = proxy.mark();
  const rv = await stack.invoke();
  const reqs = proxy.since(mv).filter(anyFeed);
  const g3 = await gaps();
  check("re-check of the old position -> 410 (first request)", reqs[0]?.hasAfter === true && reqs[0].limit === "1" && reqs[0].status === 410);
  check("gap recorded without halting; the requested replay drains and resolves it in the same run (HTTP 200)", rv.status === 200 && rv.json?.status === "ok" && rv.json.gap_recorded === true && rv.json.gap_new === true && rv.json.gaps_resolved === 1, brief(rv));
  check("second gap row: the re-checked cursor, resolved full_resync; the first row unchanged", g3.length === 2 && g3[1].expired_cursor === C2 && g3[1].resolution === "full_resync" && g3[0].resolved_at?.getTime() === g2[0].resolved_at?.getTime());
  const pv = new Set((await projection()).obs.map((o) => o.id));
  check("later batch present, pruned batch absent", s.bIds.every((id) => pv.has(id)) && s.aIds.every((id) => !pv.has(id)));
  await oracleSync();
  const cmpv = await compareWithModel();
  check("projection consistent with the model", cmpv.ok, cmpv.detail);

  scenario = "S6c R3-A: 400 after key rotation, single-shot first page";
  await resolver.entrances(8, "s6c");
  const rr = await stack.invoke();
  const C3 = (await state()).cursor;
  await resolver.stop();
  await resolver.start({ hmacSecret: secrets["E2E_IP_HMAC_SECRET_ROTATED"], keyVersion: 2 });
  const direct400 = await resolver.feedPage(C3, 1);
  check("after rotating IP_HMAC_SECRET the resolver answers 400 to the stored (within-retention) cursor", rr.json?.status === "ok" && direct400.status === 400, `HTTP ${direct400.status}`);
  const gapsBefore = (await gaps()).length;
  const m3 = proxy.mark();
  proxy.addRule({ id: "fail-first-replay-page", match: firstPage, action: "fail", status: 503, times: 1 });
  const rf = await stack.invoke();
  proxy.clearRules();
  const reqs3 = proxy.since(m3).filter(anyFeed);
  const st3 = await state();
  check("first replay page failed once (503): run ends upstream_error (HTTP 502)", rf.status === 502 && rf.json?.status === "upstream_error", brief(rf));
  check("that page was requested exactly once: no retry, no backoff (IDR_MAX_RETRIES=2)", reqs3.length === 2 && reqs3[0].hasAfter && reqs3[0].status === 400 && !reqs3[1].hasAfter && reqs3[1].status === 503, reqs3.map((e) => `${e.hasAfter ? "after" : "start"}/${e.status}`).join(" "));
  check("position kept for the next run: cursor null, reset_from_cursor = the rejected cursor, no gap", st3?.cursor === null && st3.reset_from_cursor === C3 && st3.needs_resync === false && (await gaps()).length === gapsBefore);
  // next run: re-check (400 again), single-shot first page, then normal retries (one later page fails once)
  const m4 = proxy.mark();
  proxy.addRule({ id: "fail-a-later-page", match: (e) => e.feed && e.hasAfter && e.limit === "5", action: "fail", status: 503, times: 1 });
  const rn = await stack.invoke();
  proxy.clearRules();
  const reqs4 = proxy.since(m4).filter(anyFeed);
  const failedAt = reqs4.findIndex((e) => e.status === 503);
  check("next run: re-check 400, then the first page once, then a failed later page is retried", reqs4[0]?.limit === "1" && reqs4[0].status === 400 && reqs4.filter((e) => !e.hasAfter).length === 1 && failedAt > 1 && reqs4[failedAt + 1]?.status === 200, reqs4.map((e) => `${e.hasAfter ? "after" : "start"}/${e.limit}/${e.status}`).join(" "));
  const st4 = await state();
  const f4 = await oracleSync();
  const cmp4 = await compareWithModel();
  check("run reports cursor_rejected (HTTP 200); re-check cleared; cursor = new end cursor; no gap", rn.status === 200 && rn.json?.status === "cursor_rejected" && st4?.reset_from_cursor === null && st4.cursor === f4.cursor && (await gaps()).length === gapsBefore, brief(rn));
  check("projection consistent after the key rotation replay", cmp4.ok, cmp4.detail);
  const rz = await stack.invoke();
  check("following run is a plain ok", rz.json?.status === "ok" && rz.json.observations === 0, brief(rz));
}

// ---------------------------------------------------------------------------
// S8: the scheduled path, pg_cron + pg_net + Vault (sql/schedule.example.sql)
// ---------------------------------------------------------------------------
async function s8Cron() {
  scenario = "S8 pg_cron + pg_net";
  await stack.q("create extension if not exists pg_cron");
  await stack.q("create extension if not exists pg_net");
  // Vault, as in schedule.example.sql (the function URL as the DB container reaches Kong)
  const upsert = async (name, value) => {
    const id = (await stack.q("select id from vault.secrets where name = $1", [name])).rows[0]?.id;
    if (id) await stack.q("select vault.update_secret($1, $2)", [id, value]);
    else await stack.q("select vault.create_secret($1, $2)", [value, name]);
  };
  await upsert("idr_sync_url", "http://kong:8000/functions/v1/idr-sync");
  await upsert("idr_sync_secret", secrets["E2E_SYNC_SECRET"]);
  // The job body exactly as in schedule.example.sql; only the schedule is shortened to 10 s.
  const example = readFileSync(`${PKG}/sql/schedule.example.sql`, "utf8");
  const body = /\$\$([\s\S]*?)\$\$/.exec(example)?.[1];
  if (!body || !/^\s*'idr-sync',/m.test(example)) throw new Error("schedule.example.sql changed shape");
  await resolver.entrances(3, "s8-cron");
  const n0 = await obsCount();
  const t0 = new Date();
  await stack.q("select cron.schedule('idr-sync', '10 seconds', $1)", [body]);
  let resp;
  try {
    resp = await waitFor(
      async () => (await stack.q("select status_code, content from net._http_response where created > $1 and status_code is not null order by created limit 1", [t0])).rows[0],
      90_000,
      "a pg_net response",
    );
  } finally {
    await stack.q("select cron.unschedule('idr-sync')");
  }
  const content = (() => {
    try {
      return JSON.parse(resp.content);
    } catch {
      return null;
    }
  })();
  const runs = (await stack.q("select status from cron.job_run_details where start_time > $1", [t0])).rows;
  check("cron job ran (cron.job_run_details succeeded)", runs.length > 0 && runs.every((x) => x.status === "succeeded"), runs.map((x) => x.status).join(","));
  check("pg_net call to the function returned 200 with the run summary", resp.status_code === 200 && (content?.status === "ok" || content?.status === "cas_conflict"), `HTTP ${resp.status_code} status ${content?.status}`);
  await waitFor(async () => (await obsCount()) === n0 + 3, 20_000, "the scheduled run's rows");
  await oracleSync();
  const cmp = await compareWithModel();
  check("the scheduled run applied the new observations", cmp.ok, cmp.detail);
}

// ---------------------------------------------------------------------------
async function final() {
  scenario = "S9 final";
  const dup = (await stack.q("select count(*)::int - count(distinct (installation_id, observation_id))::int as d from public.idr_observations")).rows[0].d;
  const cmp = await compareWithModel();
  check("final projection equals the model, no duplicate observation", cmp.ok && dup === 0, cmp.detail);
  const counts = (await stack.q("select (select count(*) from public.idr_observations)::int o, (select count(*) from public.idr_companies)::int c, (select count(*) from public.idr_tombstones)::int t, (select count(*) from public.idr_sync_gaps)::int g")).rows[0];
  versions["final_counts"] = `observations ${counts.o}, companies ${counts.c}, tombstones ${counts.t}, gaps ${counts.g}`;
}

const scenarios = [setup, s0Upgrade, s2FunctionAuth, s1Sync, s3Replay, s4Tombstones, s5Interruption, s6Gap, s7Rls, s8Cron, final];
const started = Date.now();
try {
  for (const s of scenarios) {
    try {
      await s();
    } catch (e) {
      check(`scenario aborted: ${e instanceof Error ? e.message : String(e)}`, false);
      if (s === setup) break;
    }
  }
} finally {
  proxy.clearRules();
  await resolver.stop();
  await resolver.closePool();
  await proxy.close();
  await stack.close();
}
const failed = results.filter((r) => !r.ok);
const md = [
  `# idr-sync local e2e results`,
  ``,
  `Run at ${new Date(started).toISOString()}, ${Math.round((Date.now() - started) / 1000)} s, ${results.length - failed.length} passed, ${failed.length} failed.`,
  ``,
  `## Versions`,
  ``,
  ...Object.entries(versions).map(([k, v]) => `- ${k}: ${v}`),
  ``,
  `## Checks`,
  ``,
  `| scenario | check | result | detail |`,
  `| --- | --- | --- | --- |`,
  ...results.map((r) => `| ${r.scenario} | ${r.check} | ${r.ok ? "PASS" : "**FAIL**"} | ${r.detail.replace(/\|/g, "/")} |`),
  ``,
].join("\n");
writeFileSync(`${WORK}/results.md`, md, { mode: 0o600 });
writeFileSync(`${WORK}/results.json`, JSON.stringify({ versions, results }, null, 2), { mode: 0o600 });
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed; ${WORK}/results.md`);
process.exit(failed.length === 0 ? 0 : 1);
