/**
 * Separate runtime and migration database roles (Gate 5).
 *
 * The owner (DATABASE_URL) runs migrations and DDL and owns every object. The
 * service connects as a separate least-privilege LOGIN role (default
 * `idr_runtime`) that holds exactly the grants below and nothing else: no
 * ownership, no TRUNCATE, TRIGGER or REFERENCES, no DDL (no CREATE on the
 * schema or the database), no superuser, CREATEDB, CREATEROLE, REPLICATION or
 * BYPASSRLS, no role memberships (so no SET ROLE to the owner), and no SET on
 * `session_replication_role`. The 0006/0007 feed guards are triggers; only
 * the table owner (ALTER TABLE ... DISABLE TRIGGER) or a superuser
 * (session_replication_role) can bypass them, so a leaked runtime credential
 * cannot.
 *
 * Provisioning runs in the migrate step (src/db/migrate.ts), as the owner,
 * after the migrations, under the migration advisory lock and in one
 * transaction, every time it runs:
 *   - creates the role if it does not exist; refuses (fails the deploy) if a
 *     role of that name exists with any elevated attribute, membership or
 *     owned object, rather than demoting a role it did not create;
 *   - sets its password from DATABASE_RUNTIME_PASSWORD as a SCRAM-SHA-256
 *     verifier computed here, so the plaintext never appears in SQL text,
 *     server logs or pg_stat_activity;
 *   - revokes everything it holds in the schema and re-grants exactly
 *     RUNTIME_GRANTS. Grants for objects added by future migrations therefore
 *     come from this map, re-applied on every migrate: an explicit decision
 *     per object instead of ALTER DEFAULT PRIVILEGES granting blindly. An
 *     object without an entry gets no privilege at all (deny by default) and
 *     is reported by name; test/integration/runtime-role.test.ts fails while
 *     any object the migrations create has no entry.
 *
 *   - removes every session default stored on the role (ALTER ROLE ... RESET
 *     ALL, globally and IN DATABASE), which the role can set on itself.
 *
 * The service checks its own login at startup (checkConnectedRolePrivileges)
 * and refuses to run as a privileged role, or as one carrying session
 * defaults, when role separation is on.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { DbError, type Pool } from "./pool.js";

export const DEFAULT_RUNTIME_ROLE = "idr_runtime";
/** A plain lowercase identifier: never needs quoting, cannot collide with a reserved pg_ role. */
export const RUNTIME_ROLE_PATTERN = /^(?!pg_)[a-z_][a-z0-9_]{0,62}$/;
/**
 * Printable ASCII without '%' (SASLprep leaves it unchanged; the URL setters
 * encode every other character reversibly). 32-256 characters: generate it
 * with `openssl rand -hex 32`.
 */
export const RUNTIME_PASSWORD_PATTERN = /^[\x21-\x24\x26-\x7e]{32,256}$/;
export const SCRAM_ITERATIONS = 4096;

/** Privileges of the runtime role on one table. `update` as a column list grants UPDATE on those columns only. */
export interface TableGrant {
  select?: true;
  insert?: true;
  update?: true | readonly string[];
  delete?: true;
}

/**
 * The runtime role's exact privileges. Every table and sequence in the schema
 * must appear (an empty grant is an explicit "none"). Reasons:
 *
 *  - SELECT ... FOR UPDATE (cache lease, company lock, the SKIP LOCKED
 *    retention batches) needs UPDATE on at least one column, hence the
 *    single-column UPDATE (id) on company_observations and browser_events:
 *    on company_observations the 0006/0007 triggers reject any change of id
 *    anyway (a no-op SET id = id is the most it allows).
 *  - feed_retention_watermarks is SELECT only: the 0006 watermark trigger
 *    runs as its owner (migration 0009, SECURITY DEFINER), so retention
 *    deletes still advance it but the runtime role cannot write it directly.
 *    It can still advance it by deleting recent observations (DELETE on
 *    company_observations is needed for retention): visible to consumers as
 *    410 cursor_expired, never silent (RUNTIME.md, G5R2-L4).
 *  - feed_tombstones is SELECT only, and companies, company_observation_refs
 *    and company_scope_stats have no DELETE: erasure (ops:erase-company) is
 *    an owner operation, so a leaked runtime credential can neither forge nor
 *    remove an erasure, nor delete company history outside retention.
 *  - deployment_controls is SELECT only: the service reads the kill switch;
 *    engaging or releasing it (ops:kill-switch) is an owner operation.
 */
export const RUNTIME_GRANTS: Readonly<Record<string, TableGrant>> = {
  schema_migrations: { select: true },
  companies: { select: true, insert: true, update: ["organisation_name", "last_seen_at"] },
  ip_resolution_cache: { select: true, insert: true, update: true, delete: true },
  usage_periods: { select: true, insert: true, update: true },
  deployment_controls: { select: true },
  company_observations: { select: true, insert: true, update: ["id"], delete: true },
  company_observation_refs: { select: true, insert: true },
  company_scope_stats: { select: true, insert: true, update: true },
  feed_tombstones: { select: true },
  feed_retention_watermarks: { select: true },
  browser_events: { select: true, insert: true, update: ["id"], delete: true },
};

/** USAGE (nextval) on the sequences behind the tables the runtime role inserts into; false = none. */
export const RUNTIME_SEQUENCE_GRANTS: Readonly<Record<string, boolean>> = {
  companies_id_seq: true,
  company_observations_id_seq: true,
  browser_events_id_seq: true,
  feed_tombstones_id_seq: false,
};

/** Raised by provisioning or the startup check; the code is fixed and loggable, never a value. */
export class RuntimeRoleError extends DbError {
  readonly reasons: string[];
  constructor(code: "RUNTIME_ROLE_PRIVILEGED" | "RUNTIME_ROLE_INVALID", reasons: string[] = []) {
    super(code);
    this.name = "RuntimeRoleError";
    this.reasons = reasons;
  }
}

/**
 * SCRAM-SHA-256 verifier in PostgreSQL's stored format
 * (`SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>`, RFC 5802/7677).
 * PostgreSQL stores a pre-hashed value as given, so the plaintext is never
 * sent in SQL. The password must already satisfy RUNTIME_PASSWORD_PATTERN
 * (ASCII, so SASLprep is the identity).
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = SCRAM_ITERATIONS): string {
  if (!RUNTIME_PASSWORD_PATTERN.test(password)) throw new RuntimeRoleError("RUNTIME_ROLE_INVALID");
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** A query function on one connection (the migrate connection: its own transaction and timeouts). */
export type Query = <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => Promise<QueryResult<R>>;

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new RuntimeRoleError("RUNTIME_ROLE_INVALID");
  return `"${name}"`;
}

const ROLE_STATE_SQL = `
SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
       EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS has_memberships,
       EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) AS owns_relations,
       EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = r.oid) AS owns_functions,
       EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid) AS owns_schemas,
       (SELECT datdba FROM pg_database WHERE datname = current_database()) = r.oid AS owns_database
FROM pg_roles r WHERE r.rolname = $1::text`;

const SCHEMA_OBJECTS_SQL = `
SELECT c.relname AS name, c.relkind AS kind
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
ORDER BY c.relname`;

interface RoleState {
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  has_memberships: boolean;
  owns_relations: boolean;
  owns_functions: boolean;
  owns_schemas: boolean;
  owns_database: boolean;
}

function elevated(s: RoleState): string[] {
  const out: string[] = [];
  if (s.rolsuper) out.push("superuser");
  if (s.rolcreaterole) out.push("createrole");
  if (s.rolcreatedb) out.push("createdb");
  if (s.rolreplication) out.push("replication");
  if (s.rolbypassrls) out.push("bypassrls");
  if (s.has_memberships) out.push("role_membership");
  if (s.owns_relations || s.owns_functions || s.owns_schemas || s.owns_database) out.push("owns_objects");
  return out;
}

export interface ProvisionResult {
  role: string;
  created: boolean;
  tables: number;
  sequences: number;
  /** Tables, views and sequences in the schema without an entry in the maps: no privilege was granted on them. */
  unmapped: string[];
}

/**
 * Creates or updates the runtime role and applies RUNTIME_GRANTS exactly. Runs
 * inside the caller's transaction on `query` (the migrate connection, as the
 * owner). Throws RuntimeRoleError / DbError with fixed codes only.
 */
export async function provisionRuntimeRole(query: Query, opts: { role: string; password: string }): Promise<ProvisionResult> {
  if (!RUNTIME_ROLE_PATTERN.test(opts.role)) throw new RuntimeRoleError("RUNTIME_ROLE_INVALID");
  const role = quoteIdent(opts.role);
  const verifier = scramSha256Verifier(opts.password);
  const self = await query<{ u: string }>("SELECT current_user::text AS u");
  if (self.rows[0]?.u === opts.role) throw new RuntimeRoleError("RUNTIME_ROLE_INVALID", ["is_owner"]);

  const existing = await query<RoleState>(ROLE_STATE_SQL, [opts.role]);
  const state = existing.rows[0];
  if (state) {
    const bad = elevated(state);
    if (bad.length > 0) throw new RuntimeRoleError("RUNTIME_ROLE_PRIVILEGED", bad);
  }
  const attributes = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT";
  // The verifier is base64 plus "$:" and the iteration count; quote it with format(%L) all the same.
  const ddl = await query<{ sql: string }>(`SELECT format('${state ? "ALTER" : "CREATE"} ROLE %I WITH ${attributes} PASSWORD %L', $1::text, $2::text) AS sql`, [
    opts.role,
    verifier,
  ]);
  await query((ddl.rows[0] as { sql: string }).sql);
  // G5R2-L3: session defaults set on the role (ALTER ROLE ... SET, also by the
  // role itself with a leaked credential, e.g. default_transaction_read_only)
  // would apply to every later service session. Remove them, globally and for
  // this database; the service's session settings live in code (pool.ts).
  const resets = await query<{ global: string; local: string }>(
    "SELECT format('ALTER ROLE %I RESET ALL', $1::text) AS global, format('ALTER ROLE %I IN DATABASE %I RESET ALL', $1::text, current_database()) AS local",
    [opts.role],
  );
  const reset = resets.rows[0] as { global: string; local: string };
  await query(reset.global);
  await query(reset.local);

  const objects = await query<{ name: string; kind: string }>(SCHEMA_OBJECTS_SQL);
  const unmapped = objects.rows
    .filter((o) => (o.kind === "S" ? !(o.name in RUNTIME_SEQUENCE_GRANTS) : !(o.name in RUNTIME_GRANTS)))
    .map((o) => o.name);

  const db = await query<{ d: string }>("SELECT current_database()::text AS d");
  const dbName = (db.rows[0] as { d: string }).d;
  const dbIdent = (await query<{ q: string }>("SELECT quote_ident($1::text) AS q", [dbName])).rows[0] as { q: string };
  await query(`GRANT CONNECT ON DATABASE ${dbIdent.q} TO ${role}`);
  await query(`REVOKE CREATE ON DATABASE ${dbIdent.q} FROM ${role}`);
  await query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
  await query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
  await query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);

  let tables = 0;
  for (const [table, grant] of Object.entries(RUNTIME_GRANTS)) {
    if (!objects.rows.some((o) => o.name === table && o.kind !== "S")) continue;
    const t = quoteIdent(table);
    const whole = [grant.select && "SELECT", grant.insert && "INSERT", grant.update === true && "UPDATE", grant.delete && "DELETE"].filter(
      (p): p is string => typeof p === "string",
    );
    if (whole.length > 0) await query(`GRANT ${whole.join(", ")} ON TABLE public.${t} TO ${role}`);
    if (Array.isArray(grant.update)) await query(`GRANT UPDATE (${grant.update.map(quoteIdent).join(", ")}) ON TABLE public.${t} TO ${role}`);
    tables += 1;
  }
  let sequences = 0;
  for (const [seq, usage] of Object.entries(RUNTIME_SEQUENCE_GRANTS)) {
    if (!usage || !objects.rows.some((o) => o.name === seq && o.kind === "S")) continue;
    await query(`GRANT USAGE ON SEQUENCE public.${quoteIdent(seq)} TO ${role}`);
    sequences += 1;
  }

  // The resulting state must be least privilege, whatever PUBLIC or a default
  // privilege might have added (e.g. CREATE on schema public for PUBLIC on
  // PostgreSQL 14 and older).
  const check = await query<PrivilegeRow>(privilegeCheckSql("$1::text", await hasParameterPrivileges(query)), [opts.role]);
  const reasons = privilegeReasons(check.rows[0]);
  if (reasons.length > 0) throw new RuntimeRoleError("RUNTIME_ROLE_PRIVILEGED", reasons);
  return { role: opts.role, created: !state, tables, sequences, unmapped };
}

interface PrivilegeRow {
  has_role_settings: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  has_memberships: boolean;
  owns_objects: boolean;
  can_create_in_schema: boolean;
  can_create_schema: boolean;
  can_truncate_or_trigger: boolean;
  can_set_replication_role: boolean;
}

/**
 * One row describing what `who` (a role name expression) could do that the
 * runtime role must not. MEMBER (not USAGE) so a NOINHERIT membership in the
 * owner role, which still allows SET ROLE, counts as ownership.
 */
function privilegeCheckSql(who: string, parameterPrivileges: boolean): string {
  return `
SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
       EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS has_memberships,
       EXISTS (SELECT 1 FROM pg_db_role_setting s
               WHERE s.setrole = r.oid
                 AND s.setdatabase IN (0, (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()))) AS has_role_settings,
       EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND pg_has_role(r.oid, c.relowner, 'MEMBER')) AS owns_objects,
       has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create_in_schema,
       has_database_privilege(r.oid, current_database(), 'CREATE') AS can_create_schema,
       EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
                 AND (has_table_privilege(r.oid, c.oid, 'TRUNCATE') OR has_table_privilege(r.oid, c.oid, 'TRIGGER')
                      OR has_table_privilege(r.oid, c.oid, 'REFERENCES'))) AS can_truncate_or_trigger,
       ${parameterPrivileges ? "r.rolsuper OR has_parameter_privilege(r.oid, 'session_replication_role', 'SET')" : "r.rolsuper"} AS can_set_replication_role
FROM pg_roles r WHERE r.rolname = ${who}`;
}

function privilegeReasons(row: PrivilegeRow | undefined): string[] {
  if (!row) return ["role_missing"];
  const out: string[] = [];
  if (row.rolsuper) out.push("superuser");
  if (row.rolcreaterole) out.push("createrole");
  if (row.rolcreatedb) out.push("createdb");
  if (row.rolreplication) out.push("replication");
  if (row.rolbypassrls) out.push("bypassrls");
  if (row.has_memberships) out.push("role_membership");
  if (row.owns_objects) out.push("owns_objects");
  if (row.can_create_in_schema) out.push("create_in_schema");
  if (row.can_create_schema) out.push("create_schema");
  if (row.can_truncate_or_trigger) out.push("truncate_or_trigger");
  if (row.can_set_replication_role) out.push("set_session_replication_role");
  // Session defaults stored on the role (ALTER ROLE ... SET), for all databases or this one (G5R2-L3).
  if (row.has_role_settings) out.push("role_settings");
  return out;
}

/**
 * Startup self-check of the service's own login (current_user). Returns the
 * list of privileges it must not have; empty means least privilege.
 */
export async function checkConnectedRolePrivileges(pool: Pool): Promise<string[]> {
  const version = await pool.query<{ v: number }>("SELECT current_setting('server_version_num')::int AS v");
  const res = await pool.query<PrivilegeRow>(privilegeCheckSql("current_user", (version.rows[0]?.v ?? 0) >= 150000));
  return privilegeReasons(res.rows[0]);
}

/** GRANT SET ON PARAMETER (and has_parameter_privilege) exist from PostgreSQL 15. */
async function hasParameterPrivileges(query: Query): Promise<boolean> {
  const version = await query<{ v: number }>("SELECT current_setting('server_version_num')::int AS v");
  return (version.rows[0]?.v ?? 0) >= 150000;
}
