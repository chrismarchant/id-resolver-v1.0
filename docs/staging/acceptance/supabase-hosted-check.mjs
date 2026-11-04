#!/usr/bin/env node
// supabase-hosted-check.mjs: acceptance checks for the disposable HOSTED Supabase test project
// (docs/staging/SUPABASE_HOSTED_TEST.md). It covers the items that the local harness
// (integrations/supabase-edge/e2e/run.mjs) cannot: the hosted gateway, TLS, Auth, the deployed function, its
// wall-clock behaviour and cold starts, the hosted catalog (PG version, extension versions, role timeouts, ACLs,
// G4-L4), the hosted pg_cron/pg_net/Vault schedule, and reconciliation. Fault injection (SIGKILL, terminated
// backends, a retention prune) stays with the local harness: it needs control of the containers and the resolver.
//
//   node supabase-hosted-check.mjs --confirm-target <project ref> [--checks auth,sync,rls,catalog,cron,oracle]
//   node supabase-hosted-check.mjs --dry-run --confirm-target <project ref>       (validates, sends nothing)
//
// Environment (names only; nothing has a default that points anywhere):
//   SBH_URL                 https://<project-ref>.supabase.co                                   (required)
//   SBH_PUBLISHABLE_KEY     the project's publishable (or legacy anon) key                      (required)
//   SBH_SERVICE_ROLE_KEY    the project's secret (or legacy service_role) key                   (required)
//   SBH_SYNC_SECRET         the idr-sync function's IDR_SYNC_SECRET                              (required)
//   SBH_INSTALLATION_ID     the resolver installation id the function syncs                     (required)
//   SBH_DB_URL              optional: a Postgres connection string (role postgres, no sslmode parameter) for the
//                           catalog and cron checks. TLS is verified: SBH_DB_CA_FILE names the project's CA
//                           certificate (downloaded from the dashboard); SBH_DB_TLS_NOVERIFY=1 is an explicit opt-out
//   SBH_RESOLVER_URL, SBH_REPORTING_TOKEN   optional: the oracle (reads the feed, read-only) for projection = feed
//   SBH_TEST_EMAIL_DOMAIN   optional, default example.test: domain of the two temporary Auth users
//   SBH_EXPECT_SCHEMA       optional, default 4: idr_schema_version() expected
//   SBH_EXPECT_RECONCILE    optional, 1 when IDR_RECONCILE_DAYS > 0 on the function
//   SBH_FUNCTION            optional, default idr-sync
//   SBH_SEED_RESOLVER_URL, SBH_SEED_RESOLVER_TOKEN, SBH_SEED_WEBSITE_ID   only with --seed N: the DEVELOPMENT
//                           resolver (mock provider, ALLOW_DOCUMENTATION_RANGES=true) and its website token. N synthetic
//                           entrances for RFC 5737 / RFC 3849 documentation addresses are sent first. The script stops
//                           at the first answer that is not a mock lookup (a production resolver answers `ineligible`).
// Options: --local-stack (allow http://127.0.0.1:54321, the local harness's stack) --out <file> --invocations 4
//          --seed N (1-50000)
// Exit: 0 no FAIL, 1 at least one FAIL, 2 refused (nothing sent).
import { writeFileSync } from "node:fs";
import { Refusal, Results, confirmTarget, makeRedactor, median, parseArgs, parseTarget, requireEnv, sleep } from "./lib/common.mjs";

const args = parseArgs(process.argv.slice(2));
const LOCAL = args["local-stack"] === true;
const env = process.env;
const CHECKS = ["seed", "auth", "sync", "concurrency", "rls", "catalog", "cron", "oracle"];
const SEED_IPS = ["203.0.113.10", "203.0.113.11", "203.0.113.12", "2001:db8::10"]; // the mock provider's qualified documentation addresses
const TABLES = ["idr_companies", "idr_observations", "idr_tombstones", "idr_sync_state", "idr_sync_gaps"];
const SUMMARY_KEYS = ["gap_new", "gap_recorded", "gaps_resolved", "observations", "pages", "reconcile", "status", "tombstones"];
const RPC_ARGS = {
  idr_get_sync_state: { p_installation_id: "x" },
  idr_begin_resync: { p_installation_id: "x" },
  idr_schema_version: {},
};
const IDR_FUNCTIONS = [
  "idr_get_sync_state(text)",
  "idr_apply_feed_page(text,text,text,jsonb,text)",
  "idr_record_sync_status(text,text,boolean)",
  "idr_begin_resync(text)",
  "idr_reset_cursor(text,text)",
  "idr_reconcile_counts(text,date,date)",
  "idr_record_sync_gap(text,text,text)",
  "idr_resolve_sync_gaps(text,text)",
  "idr_schema_version()",
];

function loadConfig() {
  const req = requireEnv(env, ["SBH_URL", "SBH_PUBLISHABLE_KEY", "SBH_SERVICE_ROLE_KEY", "SBH_SYNC_SECRET", "SBH_INSTALLATION_ID"]);
  const url = parseTarget("SBH_URL", req.SBH_URL, { allowLoopbackHttp: LOCAL });
  let ref;
  if (LOCAL) {
    if (url.protocol !== "http:") throw new Refusal("--local-stack expects the loopback http stack");
    ref = url.host;
  } else {
    const m = /^([a-z0-9]{10,40})\.supabase\.co$/.exec(url.hostname);
    if (!m || url.pathname !== "/") throw new Refusal("SBH_URL must be https://<project-ref>.supabase.co (no path)");
    ref = m[1];
  }
  confirmTarget(ref, typeof args["confirm-target"] === "string" ? args["confirm-target"] : "");
  let oracle = null;
  if (env.SBH_RESOLVER_URL || env.SBH_REPORTING_TOKEN) {
    const r = requireEnv(env, ["SBH_RESOLVER_URL", "SBH_REPORTING_TOKEN"]);
    oracle = { url: parseTarget("SBH_RESOLVER_URL", r.SBH_RESOLVER_URL, { allowLoopbackHttp: LOCAL }), token: r.SBH_REPORTING_TOKEN };
  }
  const checks = typeof args.checks === "string" ? args.checks.split(",") : CHECKS.filter((c) => c !== "seed");
  if (checks.some((c) => !CHECKS.includes(c))) throw new Refusal(`--checks must be a subset of ${CHECKS.join(",")}`);
  let seed = null;
  if (args.seed !== undefined) {
    const n = Number(args.seed);
    if (!Number.isInteger(n) || n < 1 || n > 50_000) throw new Refusal("--seed must be 1-50000");
    const s = requireEnv(env, ["SBH_SEED_RESOLVER_URL", "SBH_SEED_RESOLVER_TOKEN", "SBH_SEED_WEBSITE_ID"]);
    seed = { n, url: parseTarget("SBH_SEED_RESOLVER_URL", s.SBH_SEED_RESOLVER_URL, { allowLoopbackHttp: LOCAL }), token: s.SBH_SEED_RESOLVER_TOKEN, websiteId: s.SBH_SEED_WEBSITE_ID };
    if (!checks.includes("seed")) checks.unshift("seed");
  } else if (checks.includes("seed")) throw new Refusal("--checks seed needs --seed N");
  const domain = env.SBH_TEST_EMAIL_DOMAIN ?? "example.test";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Refusal("SBH_TEST_EMAIL_DOMAIN must be a domain");
  const fn = env.SBH_FUNCTION ?? "idr-sync";
  if (!/^[a-z0-9_-]{1,64}$/.test(fn)) throw new Refusal("SBH_FUNCTION must be a function name");
  return {
    url,
    ref,
    anon: req.SBH_PUBLISHABLE_KEY,
    service: req.SBH_SERVICE_ROLE_KEY,
    syncSecret: req.SBH_SYNC_SECRET,
    inst: req.SBH_INSTALLATION_ID,
    dbUrl: env.SBH_DB_URL ?? null,
    oracle,
    checks,
    domain,
    fn,
    expectSchema: Number(env.SBH_EXPECT_SCHEMA ?? 4),
    expectReconcile: env.SBH_EXPECT_RECONCILE === "1",
    invocations: Number(args.invocations ?? 4),
    seed,
  };
}

let cfg;
try {
  cfg = loadConfig();
  if (cfg.checks.some((c) => c === "catalog" || c === "cron") && !cfg.dbUrl) {
    console.error("note: SBH_DB_URL not set; the catalog and cron checks will be reported as SKIP");
  }
} catch (e) {
  if (e instanceof Refusal) {
    console.error(`refused: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

const SECRETS = [cfg.anon, cfg.service, cfg.syncSecret, cfg.oracle?.token, cfg.dbUrl, cfg.inst, cfg.seed?.token];
const redact = (t) => makeRedactor(SECRETS, { "<project>": cfg.url.host, "<resolver>": cfg.oracle?.url.host, "<seed-resolver>": cfg.seed?.url.host })(t);
const R = new Results(redact);
const metrics = {};

if (args["dry-run"] === true) {
  R.begin("dry-run");
  R.info("configuration valid; nothing was sent", `checks: ${cfg.checks.join(",")}; db: ${cfg.dbUrl ? "set" : "not set"}; oracle: ${cfg.oracle ? "set" : "not set"}`);
  finish();
}

// ---------------------------------------------------------------------------------------------------------------
async function http(path, { method = "GET", headers = {}, body, base = cfg.url } = {}) {
  const t0 = performance.now();
  const res = await fetch(new URL(path, base), {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json, ms: performance.now() - t0, headers: res.headers };
}
const svc = { apikey: cfg.service, authorization: `Bearer ${cfg.service}` };
const rest = (path, o = {}) => http(`/rest/v1/${path}`, o);
const fnPath = `/functions/v1/${cfg.fn}`;
const invoke = (headers = {}, method = "POST") => http(fnPath, { method, headers, body: method === "POST" ? {} : undefined });
const denied = (r) => r.status === 401 || r.status === 403 || (r.status === 404 && r.text.includes("PGRST"));

async function db() {
  if (!cfg.dbUrl) return null;
  try {
    const pg = (await import("pg")).default;
    const { readFileSync } = await import("node:fs");
    const ssl = LOCAL
      ? false
      : env.SBH_DB_CA_FILE
        ? { rejectUnauthorized: true, ca: readFileSync(env.SBH_DB_CA_FILE, "utf8") }
        : { rejectUnauthorized: env.SBH_DB_TLS_NOVERIFY !== "1" };
    if (!LOCAL && !env.SBH_DB_CA_FILE && env.SBH_DB_TLS_NOVERIFY === "1") R.info("database TLS", "encrypted WITHOUT certificate verification (SBH_DB_TLS_NOVERIFY=1)");
    const client = new pg.Client({ connectionString: cfg.dbUrl, ssl, statement_timeout: 30_000 });
    await client.connect();
    return client;
  } catch (e) {
    R.check("database connection (SBH_DB_URL)", false, e instanceof Error ? e.message : "failed");
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
async function seedChecks() {
  R.begin("H0 seed synthetic observations (development resolver, mock provider, documentation addresses)");
  const { randomBytes } = await import("node:crypto");
  const tag = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 4) || "seed";
  const statuses = {};
  let sent = 0;
  let stop = null;
  const one = async (i) => {
    const body = {
      contract: "entrance.v1",
      website_id: cfg.seed.websiteId,
      ip: SEED_IPS[i % SEED_IPS.length],
      entrance_id: randomBytes(16).toString("base64url"),
      occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      page_key: `/staging/seed-${tag}-${i % 1000}`,
      acquisition: i % 2 === 0 ? "direct" : "search",
      eligibility: "tsa-1",
    };
    const r = await http("/v1/entrances", { method: "POST", base: cfg.seed.url, headers: { authorization: `Bearer ${cfg.seed.token}` }, body });
    const k = `${r.status}:${r.json?.status ?? r.json?.error ?? "-"}`;
    statuses[k] = (statuses[k] ?? 0) + 1;
    if (r.status !== 200 || !["qualified", "no_match"].includes(r.json?.status)) stop = k;
  };
  // The first entrance alone: a production resolver answers `ineligible` for a documentation address.
  await one(0);
  sent = 1;
  if (stop === null) {
    let next = 1;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < cfg.seed.n && stop === null) await one(next++).then(() => sent++);
      }),
    );
  }
  R.check("every seeded entrance was a mock lookup (qualified or no_match); stopped at the first other answer", stop === null, `${sent} sent; ${Object.entries(statuses).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

async function authChecks() {
  R.begin("H1 function authentication through the hosted gateway");
  const cases = [
    ["no secret", {}],
    ["wrong secret", { "x-idr-sync-secret": "x".repeat(cfg.syncSecret.length) }],
    ["secret with one character changed", { "x-idr-sync-secret": cfg.syncSecret.slice(0, -1) + (cfg.syncSecret.endsWith("a") ? "b" : "a") }],
    ["platform keys instead of the secret", { apikey: cfg.anon, authorization: `Bearer ${cfg.service}` }],
  ];
  for (const [name, h] of cases) {
    const r = await invoke(h);
    R.check(`${name}: empty 401`, r.status === 401 && r.text === "", `HTTP ${r.status}, ${r.text.length} bytes`);
  }
  const g = await invoke({ "x-idr-sync-secret": cfg.syncSecret }, "GET");
  R.check("GET with the right secret: 401", g.status === 401, `HTTP ${g.status}`);
}

async function syncChecks() {
  R.begin("H2 authenticated sync: status, summary-only response, wall clock, cold vs warm");
  const runs = [];
  for (let i = 0; i < cfg.invocations; i++) {
    const r = await invoke({ "x-idr-sync-secret": cfg.syncSecret });
    runs.push(r);
    if (i === 0) await sleep(1000);
  }
  const first = runs[0];
  R.check("first invocation: status ok or partial", first.status === 200 && ["ok", "partial", "cursor_rejected"].includes(first.json?.status), `HTTP ${first.status} ${first.json?.status ?? "-"}`);
  const keys = [...new Set(runs.map((r) => Object.keys(r.json ?? {}).sort().join(",")))];
  R.check("responses hold the summary fields only (no cursor, domain or credential)", keys.length === 1 && keys[0] === SUMMARY_KEYS.join(","), keys.join(" | "));
  const ms = runs.map((r) => Math.round(r.ms));
  metrics.invocationMs = ms;
  R.info("wall clock per invocation (first may be a cold start)", `${ms.join(", ")} ms; warm median ${Math.round(median(ms.slice(1)))} ms`);
  const last = runs[runs.length - 1].json;
  R.check("a later run is drained (ok)", last?.status === "ok", `${last?.status}; pages ${last?.pages}`);
  if (cfg.expectReconcile) {
    R.check("reconciliation ran and matched (IDR_RECONCILE_DAYS > 0)", last?.reconcile?.checked === true && last?.reconcile?.matched === true, JSON.stringify(last?.reconcile));
  } else {
    R.info("reconciliation", `reconcile = ${JSON.stringify(last?.reconcile)} (set SBH_EXPECT_RECONCILE=1 when IDR_RECONCILE_DAYS > 0)`);
  }
  const sv = await rest("rpc/idr_schema_version", { method: "POST", headers: svc, body: {} });
  R.check(`idr_schema_version() = ${cfg.expectSchema}`, sv.status === 200 && Number(sv.json) === cfg.expectSchema, `HTTP ${sv.status} ${sv.text.slice(0, 8)}`);
  const st = await rest(`idr_sync_state?installation_id=eq.${encodeURIComponent(cfg.inst)}&select=status,needs_resync`, { headers: svc });
  R.check("idr_sync_state: one row, no resync needed", st.status === 200 && st.json?.length === 1 && st.json[0].needs_resync === false, `${st.json?.[0]?.status ?? "-"}`);
  const gaps = await rest("idr_sync_gaps?select=id&resolved_at=is.null", { headers: svc });
  R.check("no open idr_sync_gaps row", gaps.status === 200 && gaps.json?.length === 0, `${gaps.json?.length ?? "?"} open`);
}

async function concurrencyChecks() {
  R.begin("H7 three concurrent invocations on the hosted runtime (compare-and-set)");
  const before = await count("idr_observations");
  const runs = await Promise.all([0, 1, 2].map(() => invoke({ "x-idr-sync-secret": cfg.syncSecret })));
  const statuses = runs.map((r) => r.json?.status ?? `HTTP ${r.status}`);
  R.check("every run ends ok, partial or cas_conflict", statuses.every((x) => ["ok", "partial", "cas_conflict"].includes(x)), statuses.join(", "));
  const settle = await invoke({ "x-idr-sync-secret": cfg.syncSecret });
  R.check("a following run is drained (ok)", settle.json?.status === "ok", `${settle.json?.status}`);
  R.info("observations before / after", `${before} / ${await count("idr_observations")} (duplicates are impossible by key; the oracle check compares with the feed)`);
}

async function count(table) {
  const r = await rest(`${table}?select=*&limit=1`, { headers: { ...svc, prefer: "count=exact" } });
  const m = /\/(\d+)$/.exec(r.headers.get("content-range") ?? "");
  return m ? Number(m[1]) : -1;
}

async function rlsChecks() {
  R.begin("H3 RLS with real hosted Auth");
  const created = [];
  try {
    for (const t of [...TABLES, "idr_daily_company_activity"]) {
      const a = await rest(`${t}?select=*&limit=1`, { headers: { apikey: cfg.anon } });
      R.check(`anon cannot read ${t}`, denied(a) || (a.status === 200 && a.json?.length === 0), `HTTP ${a.status}`);
    }
    for (const [fn, a] of Object.entries(RPC_ARGS)) {
      const r = await rest(`rpc/${fn}`, { method: "POST", headers: { apikey: cfg.anon }, body: a });
      R.check(`anon cannot execute ${fn}`, denied(r), `HTTP ${r.status}`);
    }
    const run = Math.random().toString(36).slice(2, 8);
    const su = await http("/auth/v1/signup", { method: "POST", headers: { apikey: cfg.anon }, body: { email: `signup-${run}@${cfg.domain}`, password: `pw-${crypto.randomUUID()}` } });
    R.check("public sign-up is disabled", su.status === 422 || su.status === 403 || su.status === 400, `HTTP ${su.status} ${su.json?.error_code ?? su.json?.code ?? ""}`);

    const mk = async (label) => {
      const email = `idr-accept-${label}-${run}@${cfg.domain}`;
      const password = `pw-${crypto.randomUUID()}`;
      const r = await http("/auth/v1/admin/users", { method: "POST", headers: svc, body: { email, password, email_confirm: true } });
      if (r.status !== 200 && r.status !== 201) throw new Error(`admin create user answered ${r.status}`);
      created.push(r.json.id);
      return { id: r.json.id, email, password };
    };
    const signIn = async (u) => {
      const r = await http("/auth/v1/token?grant_type=password", { method: "POST", headers: { apikey: cfg.anon }, body: { email: u.email, password: u.password } });
      if (r.status !== 200) throw new Error(`sign-in answered ${r.status}`);
      return r.json.access_token;
    };
    const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    const header = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString("utf8"));
    const asUser = (tok) => ({ apikey: cfg.anon, authorization: `Bearer ${tok}` });

    const plain = await mk("plain");
    let t1 = await signIn(plain);
    R.info("user token algorithm", `${header(t1).alg}`);
    const dbCounts = {};
    for (const t of TABLES) dbCounts[t] = await count(t);
    const haveRows = Object.values(dbCounts).every((n) => n > 0) || dbCounts.idr_observations > 0;
    for (const t of TABLES) {
      const r = await rest(`${t}?select=*`, { headers: asUser(t1) });
      R.check(`signed-in user without the claim sees no rows in ${t}`, r.status === 200 && r.json?.length === 0, `HTTP ${r.status}, ${r.json?.length ?? "?"} rows (table holds ${dbCounts[t]})`);
    }
    const upd = await http("/auth/v1/user", { method: "PUT", headers: asUser(t1), body: { data: { idr_reader: true } } });
    t1 = await signIn(plain);
    const um = await rest("idr_observations?select=*", { headers: asUser(t1) });
    R.check("self-set user_metadata.idr_reader grants nothing", upd.status === 200 && claims(t1).user_metadata?.idr_reader === true && um.json?.length === 0, `update HTTP ${upd.status}`);

    const reader = await mk("reader");
    const tOld = await signIn(reader);
    const grant = await http(`/auth/v1/admin/users/${reader.id}`, { method: "PUT", headers: svc, body: { app_metadata: { idr_reader: true } } });
    R.check("claim granted through the admin API", grant.status === 200, `HTTP ${grant.status}`);
    const old = await rest("idr_observations?select=*", { headers: asUser(tOld) });
    R.check("a token issued before the grant still sees nothing", old.status === 200 && old.json?.length === 0);
    const t2 = await signIn(reader);
    R.check("a new token carries app_metadata.idr_reader = true", claims(t2).app_metadata?.idr_reader === true);
    for (const t of TABLES) {
      const r = await rest(`${t}?select=*`, { headers: { ...asUser(t2), prefer: "count=exact", range: "0-0" } });
      const m = /\/(\d+)$/.exec(r.headers.get("content-range") ?? "");
      const visible = m ? Number(m[1]) : -1;
      if (dbCounts[t] > 0) R.check(`reader sees every row of ${t}`, (r.status === 200 || r.status === 206) && visible === dbCounts[t], `${visible} of ${dbCounts[t]}`);
      else R.skip(`reader sees every row of ${t}`, "the table is empty (inconclusive)");
    }
    if (!haveRows) R.info("projection empty", "run a sync with data first, or the reader checks are inconclusive");
    const before = await Promise.all(TABLES.map(count));
    const writes = [
      ["insert idr_observations", "idr_observations", "POST", { installation_id: "x", observation_id: 1, company_id: 1, observed_at: new Date().toISOString(), method: "cache" }],
      ["update idr_sync_state", `idr_sync_state?installation_id=eq.${encodeURIComponent(cfg.inst)}`, "PATCH", { cursor: null }],
      ["delete idr_companies", "idr_companies?company_id=gte.0", "DELETE", undefined],
      ["delete idr_sync_gaps", "idr_sync_gaps?id=gte.0", "DELETE", undefined],
    ];
    for (const [name, path, method, body] of writes) {
      const r = await rest(path, { method, headers: asUser(t2), body });
      R.check(`reader cannot ${name}`, r.status === 401 || r.status === 403, `HTTP ${r.status}`);
    }
    for (const [fn, a] of Object.entries(RPC_ARGS)) {
      const r = await rest(`rpc/${fn}`, { method: "POST", headers: asUser(t2), body: a });
      R.check(`reader cannot execute ${fn}`, denied(r), `HTTP ${r.status}`);
    }
    const after = await Promise.all(TABLES.map(count));
    R.check("no write attempt changed any table", JSON.stringify(before) === JSON.stringify(after));
    await http(`/auth/v1/admin/users/${reader.id}`, { method: "PUT", headers: svc, body: { app_metadata: { idr_reader: false } } });
    const t3 = await signIn(reader);
    const revoked = await rest("idr_observations?select=*", { headers: asUser(t3) });
    const still = await rest("idr_observations?select=*&limit=1", { headers: asUser(t2) });
    R.check("after revocation a new token sees nothing; the earlier token keeps reading until it expires", revoked.json?.length === 0 && (dbCounts.idr_observations === 0 || still.json?.length === 1));
    R.info("JWT lifetime of the earlier token", `${claims(t2).exp - claims(t2).iat} s (keep it short: revocation waits for expiry)`);
  } catch (e) {
    R.check("RLS scenario completed", false, e instanceof Error ? e.message : "error");
  } finally {
    let removed = 0;
    for (const id of created) {
      const r = await http(`/auth/v1/admin/users/${id}`, { method: "DELETE", headers: svc });
      if (r.status === 200 || r.status === 204) removed++;
    }
    R.check("temporary Auth users deleted", removed === created.length, `${removed} of ${created.length}`);
  }
}

async function catalogChecks() {
  R.begin("H4 hosted catalog: versions, role timeouts, ACLs, G4-L4");
  const c = await db();
  if (!c) return R.skip("catalog checks", "SBH_DB_URL not set or unreachable");
  try {
    const q = async (sql, params) => (await c.query(sql, params)).rows;
    const v = (await q("select current_setting('server_version') as v"))[0].v;
    metrics.postgres = v;
    R.info("Postgres server_version", v);
    for (const e of await q("select extname, extversion from pg_extension where extname = any($1) order by 1", [["pg_cron", "pg_net", "supabase_vault", "pgsodium"]])) R.info(`extension ${e.extname}`, e.extversion);
    for (const r of await q("select rolname, rolconfig from pg_roles where rolname = any($1) order by 1", [["authenticator", "authenticated", "anon", "service_role"]])) {
      R.info(`role settings ${r.rolname}`, (r.rolconfig ?? []).filter((s) => /timeout/.test(s)).join(" ") || "no timeouts");
    }
    const acl = await q(
      "select f, r, has_function_privilege(r, 'public.' || f, 'execute') as x from unnest($1::text[]) f, unnest(array['anon','authenticated','service_role']) r",
      [IDR_FUNCTIONS],
    );
    const badFn = acl.filter((a) => a.x !== (a.r === "service_role"));
    R.check("only service_role may execute the idr_* functions", badFn.length === 0, badFn.map((a) => `${a.r}:${a.f}`).join(" ") || `${acl.length} checked`);
    const all = [...TABLES, "idr_daily_company_activity"];
    const tp = await q(
      "select t, r, p, has_table_privilege(r, 'public.' || t, p) as x from unnest($1::text[]) t, unnest(array['anon','authenticated','service_role']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p",
      [all],
    );
    const has = (t, r, p) => tp.find((a) => a.t === t && a.r === r && a.p === p)?.x === true;
    const viol = [];
    for (const t of all) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) if (has(t, "anon", p)) viol.push(`anon:${p}:${t}`);
      for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) if (has(t, "authenticated", p)) viol.push(`authenticated:${p}:${t}`);
      if (!has(t, "authenticated", "SELECT")) viol.push(`authenticated lacks SELECT:${t}`);
    }
    for (const p of ["DELETE", "TRUNCATE"]) if (has("idr_sync_gaps", "service_role", p)) viol.push(`service_role:${p}:idr_sync_gaps`);
    R.check("table privileges: anon none; authenticated SELECT only; no DELETE/TRUNCATE on idr_sync_gaps", viol.length === 0, viol.join(" ") || `${tp.length} checked`);
    const extra = tp.filter((a) => a.r === "service_role" && a.x && (["TRUNCATE", "REFERENCES", "TRIGGER"].includes(a.p) || (a.t === "idr_daily_company_activity" && a.p !== "SELECT"))).map((a) => `${a.p}:${a.t}`);
    const seq = await q(
      "select r, p, has_sequence_privilege(r, 'public.idr_sync_gaps_id_seq', p) as x from unnest(array['anon','authenticated']) r, unnest(array['USAGE','SELECT','UPDATE']) p",
    ).catch(() => []);
    const seqExtra = seq.filter((s) => s.x).map((s) => `${s.r}:${s.p}`);
    const g4l4 = [...extra, ...seqExtra.map((s) => `seq:${s}`)];
    if (cfg.expectSchema >= 5) R.check("G4-L4 fixed: no extra service_role or sequence privileges", g4l4.length === 0, g4l4.join(" ") || "none");
    else R.info("G4-L4 (open in schema 4): privileges from Supabase default privileges beyond the SQL's grants", g4l4.join(" ") || "none");
    const rls = await q("select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1)", [TABLES]);
    R.check("RLS enabled on every projection table", rls.length === TABLES.length && rls.every((x) => x.relrowsecurity));
  } finally {
    await c.end();
  }
}

async function cronChecks() {
  R.begin("H5 hosted pg_cron + pg_net + Vault schedule");
  const c = await db();
  if (!c) return R.skip("cron checks", "SBH_DB_URL not set or unreachable");
  try {
    const q = async (sql, params) => (await c.query(sql, params)).rows;
    const job = await q("select jobid, schedule, active from cron.job where jobname = 'idr-sync'");
    R.check("cron job idr-sync exists and is active", job.length === 1 && job[0].active === true, job.length ? `schedule ${job[0].schedule}` : "missing");
    if (job.length === 1) {
      const runs = await q("select status, count(*)::int as n from cron.job_run_details where jobid = $1 and start_time > now() - interval '1 hour' group by status", [job[0].jobid]);
      R.check("cron runs in the last hour succeeded", runs.length > 0 && runs.every((r) => r.status === "succeeded"), runs.map((r) => `${r.status}:${r.n}`).join(" ") || "no runs");
    }
    const net = await q("select status_code, timed_out, count(*)::int as n from net._http_response where created > now() - interval '1 hour' group by 1, 2 order by 1");
    R.check("pg_net responses in the last hour are 200 (none timed out)", net.length > 0 && net.every((r) => r.status_code === 200 && !r.timed_out), net.map((r) => `${r.status_code ?? "null"}/${r.timed_out ? "timeout" : "ok"}:${r.n}`).join(" ") || "none");
    const vault = await q("select name from vault.secrets where name = any($1) order by 1", [["idr_sync_secret", "idr_sync_url"]]);
    R.check("Vault holds idr_sync_url and idr_sync_secret (names only; never decrypted here)", vault.length === 2);
  } finally {
    await c.end();
  }
}

async function oracleChecks() {
  R.begin("H6 projection = feed (oracle)");
  if (!cfg.oracle) return R.skip("oracle", "SBH_RESOLVER_URL / SBH_REPORTING_TOKEN not set");
  const obs = new Set();
  const companies = new Set();
  const tombs = new Set();
  const erased = new Set();
  let after = null;
  for (let page = 0; page < 500; page++) {
    const path = `/v1/reporting/observations?limit=500${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const r = await http(path, { base: cfg.oracle.url, headers: { authorization: `Bearer ${cfg.oracle.token}` } });
    if (r.status !== 200) return R.check("feed readable with the reporting token", false, `HTTP ${r.status}`);
    for (const it of r.json.items) {
      if (it.type === "observation") {
        obs.add(it.observation_id);
        companies.add(String(it.company_id));
      } else {
        tombs.add(it.tombstone_id);
        erased.add(String(it.company_id));
      }
    }
    after = r.json.next_cursor;
    if (!r.json.has_more) break;
  }
  for (const id of erased) companies.delete(id);
  const pageAll = async (table, col) => {
    const out = new Set();
    for (let off = 0; ; off += 1000) {
      const r = await rest(`${table}?select=${col}&installation_id=eq.${encodeURIComponent(cfg.inst)}&order=${col}&limit=1000&offset=${off}`, { headers: svc });
      for (const row of r.json ?? []) out.add(String(row[col]));
      if (!Array.isArray(r.json) || r.json.length < 1000) break;
    }
    return out;
  };
  const pObs = await pageAll("idr_observations", "observation_id");
  const pTombs = await pageAll("idr_tombstones", "tombstone_id");
  const missing = [...obs].filter((id) => !pObs.has(id)).length;
  R.check("every observation the feed still serves is in the projection", missing === 0, `${obs.size} in the feed, ${pObs.size} in the projection, ${missing} missing`);
  R.check("every tombstone is in the projection", [...tombs].every((id) => pTombs.has(id)), `${tombs.size} tombstones`);
  R.info("projection rows older than the resolver's retention buffer are expected (the client owns history)", `${[...pObs].filter((id) => !obs.has(id)).length} rows`);
}

function finish() {
  const summary = R.summary();
  console.log(`summary: ${summary.pass} pass, ${summary.fail} fail, ${summary.info} info, ${summary.skip} skip`);
  if (typeof args.out === "string") {
    const doc = { script: "supabase-hosted-check", version: 1, ranAt: new Date().toISOString(), localStack: LOCAL, checks: cfg.checks, summary, items: R.items, metrics: JSON.parse(redact(JSON.stringify(metrics))) };
    writeFileSync(args.out, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  }
  process.exit(summary.fail > 0 ? 1 : 0);
}

const RUN = { seed: seedChecks, auth: authChecks, sync: syncChecks, concurrency: concurrencyChecks, rls: rlsChecks, catalog: catalogChecks, cron: cronChecks, oracle: oracleChecks };
try {
  for (const c of CHECKS) if (cfg.checks.includes(c)) await RUN[c]();
} catch (e) {
  R.check("checks completed without an error", false, redact(e instanceof Error ? e.message : String(e)));
}
finish();
