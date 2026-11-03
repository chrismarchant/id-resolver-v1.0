// Access to the local Supabase stack: the Edge Function through Kong, PostgREST,
// the Auth (GoTrue) admin and user APIs, and the database (as `postgres`, the
// role the SQL editor uses on a hosted project) for the test oracle.
import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const run = promisify(execFile);

export class Stack {
  /** @param {{ status: Record<string, string>, syncSecret: string, projectId: string }} o */
  constructor(o) {
    this.s = o.status;
    this.syncSecret = o.syncSecret;
    this.api = o.status.API_URL;
    this.anonKey = o.status.ANON_KEY;
    this.serviceKey = o.status.SERVICE_ROLE_KEY;
    this.publishableKey = o.status.PUBLISHABLE_KEY;
    this.edgeContainer = `supabase_edge_runtime_${o.projectId}`;
    this.dbContainer = `supabase_db_${o.projectId}`;
    this.pool = new pg.Pool({ connectionString: o.status.DB_URL, max: 4 });
  }

  /**
   * Invokes the function the way pg_net / curl would: POST with the shared secret.
   * @param {{ secret?: string | null, method?: string, headers?: Record<string, string>, timeoutMs?: number }} [o]
   */
  async invoke(o = {}) {
    const headers = { ...(o.headers ?? {}) };
    const secret = o.secret === undefined ? this.syncSecret : o.secret;
    if (secret !== null) headers["x-idr-sync-secret"] = secret;
    try {
      const r = await fetch(`${this.api}/functions/v1/idr-sync`, {
        method: o.method ?? "POST",
        headers,
        signal: AbortSignal.timeout(o.timeoutMs ?? 90_000),
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // empty or non-JSON body
      }
      return { status: r.status, text, json };
    } catch (e) {
      return { status: 0, text: String(e?.name ?? "error"), json: null };
    }
  }

  /** Waits until the function answers (401 to an unauthenticated POST). */
  async waitForFunction(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.invoke({ secret: null, timeoutMs: 5000 });
      if (r.status === 401) return;
      if (Date.now() > deadline) throw new Error(`function not serving (last HTTP ${r.status})`);
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  /** Kills the Edge Runtime container (SIGKILL), i.e. the function mid-flight. */
  async killEdgeRuntime() {
    await run("docker", ["kill", "--signal", "KILL", this.edgeContainer]);
  }

  async startEdgeRuntime() {
    await run("docker", ["start", this.edgeContainer]);
    await this.waitForFunction();
  }

  /**
   * PostgREST through Kong.
   * @param {string} path e.g. "idr_observations?select=*"
   * @param {{ apikey?: string | null, token?: string | null, method?: string, body?: unknown, prefer?: string }} [o]
   */
  async rest(path, o = {}) {
    const headers = { "content-type": "application/json" };
    const apikey = o.apikey === undefined ? this.anonKey : o.apikey;
    if (apikey !== null) headers["apikey"] = apikey;
    if (o.token) headers["authorization"] = `Bearer ${o.token}`;
    if (o.prefer) headers["prefer"] = o.prefer;
    const r = await fetch(`${this.api}/rest/v1/${path}`, {
      method: o.method ?? "GET",
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // empty body
    }
    return { status: r.status, json, text, server: r.headers.get("server") };
  }

  /** RPC as service_role (the Edge Function's credential, or an operator's SQL session). */
  rpcService(fn, args) {
    return this.rest(`rpc/${fn}`, { method: "POST", apikey: this.serviceKey, token: this.serviceKey, body: args });
  }

  async adminCreateUser(email, password) {
    const r = await fetch(`${this.api}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: this.serviceKey, authorization: `Bearer ${this.serviceKey}`, "content-type": "application/json" },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const j = await r.json();
    if (r.status !== 200) throw new Error(`admin create user: ${r.status}`);
    return j;
  }

  /** SETUP.md "Who may read": grant (or revoke) the claim with the admin API. */
  async adminSetReader(userId, value) {
    const r = await fetch(`${this.api}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: { apikey: this.serviceKey, authorization: `Bearer ${this.serviceKey}`, "content-type": "application/json" },
      body: JSON.stringify({ app_metadata: { idr_reader: value } }),
    });
    if (r.status !== 200) throw new Error(`admin update user: ${r.status}`);
    return r.json();
  }

  async signIn(email, password) {
    const r = await fetch(`${this.api}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: this.anonKey, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json();
    if (r.status !== 200) throw new Error(`sign-in: ${r.status}`);
    return j.access_token;
  }

  /** The user edits their OWN user_metadata (allowed to any signed-in user). */
  async selfUpdateUserMetadata(token, data) {
    const r = await fetch(`${this.api}/auth/v1/user`, {
      method: "PUT",
      headers: { apikey: this.anonKey, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
    return r.status;
  }

  async publicSignUp(email, password) {
    const r = await fetch(`${this.api}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: this.anonKey, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, code: j.error_code ?? j.code ?? null };
  }

  async authHealth() {
    const r = await fetch(`${this.api}/auth/v1/health`, { headers: { apikey: this.anonKey } });
    return r.json();
  }

  q(sql, params) {
    return this.pool.query(sql, params);
  }

  async close() {
    await this.pool.end();
  }
}

/** Decodes a JWT payload (no verification; for assertions about claims). */
export function jwtClaims(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

/** An HS256 JWT signed with a key the stack does not know (a forged token). */
export function forgedJwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc(claims);
  const sig = createHmac("sha256", randomBytes(32)).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
