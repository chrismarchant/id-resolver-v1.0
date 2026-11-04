/**
 * No raw-IP-capable column in the resolver's schema (docs/GUARDRAILS.md G5,
 * resolver side). After migrations 0001-0009 are applied to a fresh database,
 * no column of any table, view or materialised view has a network-address
 * type (inet, cidr, macaddr, macaddr8; also through a domain or an array), no
 * bytea column exists outside the explicit allowlist below, and no column has
 * an address-like name outside it. Negative tests plant each kind of column in
 * a rolled-back transaction and prove the detector reports it.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate.js";
import { createPool, type Pool } from "../../src/db/pool.js";
import { createScratchDatabase } from "../helpers/db.js";

/**
 * The only bytea column, and the only address-named one, with the reason it is
 * not a raw IP: ip_resolution_cache.ip_fingerprint is the 32-byte
 * HMAC-SHA-256 of the canonical address under IP_HMAC_SECRET (versioned by
 * key_version), CHECK (octet_length = 32). A keyed one-way digest: the address
 * cannot be recovered from it without the secret, which never reaches the
 * database, and rotating the secret orphans every row (RUNTIME.md). The raw
 * address exists only in memory for one request.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([["ip_resolution_cache.ip_fingerprint", "bytea"]]);

const NETWORK_TYPES = ["inet", "cidr", "macaddr", "macaddr8"];
const ADDRESS_NAME = /(^|_)(ip|ips|ipv4|ipv6|ip_addr|ip_address|addr|address|remote_addr|client_ip|forwarded_for|xff|mac)(_|$)/;

type Queryable = Pick<Pool, "query">;
interface Column {
  rel: string;
  col: string;
  declared: string;
  /** The declared type and every type it stands for (domain base types, array element types). */
  resolved: string[];
}

/** Every column of every user relation (tables, partitions, views, materialised views, foreign tables) in every user schema. */
async function allColumns(q: Queryable): Promise<Column[]> {
  const r = await q.query<Column>(
    `WITH RECURSIVE cols AS (
       SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS rel,
              a.attname AS col, format_type(a.atttypid, a.atttypmod) AS declared, a.atttypid AS typ
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped),
     walk AS (
       SELECT rel, col, declared, typ, 0 AS depth FROM cols
       UNION ALL
       SELECT w.rel, w.col, w.declared, CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.typelem END, w.depth + 1
         FROM walk w JOIN pg_type t ON t.oid = w.typ
        WHERE w.depth < 16 AND (t.typtype = 'd' OR (t.typcategory = 'A' AND t.typelem <> 0)))
     SELECT rel, col, declared, array_agg(DISTINCT format_type(typ, NULL) ORDER BY format_type(typ, NULL)) AS resolved
       FROM walk GROUP BY rel, col, declared ORDER BY rel, col`,
  );
  return r.rows;
}

/** Every violation (empty = clean). */
async function rawIpCapableColumns(q: Queryable): Promise<string[]> {
  const out: string[] = [];
  for (const c of await allColumns(q)) {
    const key = `${c.rel}.${c.col}`;
    const allowed = ALLOWED.get(key);
    if (c.resolved.some((t) => NETWORK_TYPES.includes(t))) out.push(`${key}: network-address type ${c.declared}`);
    if (c.resolved.includes("bytea") && allowed !== c.declared) out.push(`${key}: bytea column not on the allowlist`);
    if (ADDRESS_NAME.test(c.col) && allowed === undefined) out.push(`${key}: address-like column name`);
  }
  return out;
}

describe("resolver schema: no raw-IP-capable column (G5)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
  let pool: Pool;

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    pool = createPool({ databaseUrl: scratch.url, ssl: "disable", max: 2 });
    const files = readdirSync(join(import.meta.dirname, "..", "..", "migrations")).filter((f) => f.endsWith(".sql")).sort();
    const r = await applyMigrations(pool);
    expect(r.applied).toEqual(files);
    expect(files[0]).toMatch(/^0001_/);
    expect(files[files.length - 1]).toMatch(/^0009_/);
  });
  afterAll(async () => {
    await pool.end();
    await scratch.drop();
  });

  it("after 0001-0009 on a fresh database: no network-address type, bytea only on the allowlist, no address-named column", async () => {
    expect(await rawIpCapableColumns(pool)).toEqual([]);
    // Sanity: the scan is meaningful, it sees the allowlisted column and the feed tables.
    const cols = await allColumns(pool);
    expect(cols.find((c) => `${c.rel}.${c.col}` === "ip_resolution_cache.ip_fingerprint")).toMatchObject({ declared: "bytea", resolved: ["bytea"] });
    expect(cols.some((c) => c.rel === "company_observations" && c.col === "page_key")).toBe(true);
    expect(cols.some((c) => c.rel === "feed_tombstones")).toBe(true);
    // The allowlisted digest is fixed-size: a raw address could not be stored there in any encoding.
    const check = await pool.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.ip_resolution_cache'::regclass AND contype = 'c'",
    );
    expect(check.rows.map((r) => r.def)).toContain("CHECK ((octet_length(ip_fingerprint) = 32))");
  });

  it.each([
    ["an inet column", "CREATE TABLE planted (client inet)", "planted.client: network-address type inet"],
    ["a cidr array", "CREATE TABLE planted (nets cidr[])", "planted.nets: network-address type cidr[]"],
    ["a macaddr8 column", "CREATE TABLE planted (m macaddr8)", "planted.m: network-address type macaddr8"],
    ["an inet hidden behind a domain", "CREATE DOMAIN planted_addr AS inet; CREATE TABLE planted (origin planted_addr)", "planted.origin: network-address type planted_addr"],
    ["an inet in a view", "CREATE VIEW planted AS SELECT '192.0.2.1'::inet AS seen", "planted.seen: network-address type inet"],
    ["a new bytea column", "ALTER TABLE companies ADD COLUMN blob bytea", "companies.blob: bytea column not on the allowlist"],
    ["an address-named text column", "ALTER TABLE company_observations ADD COLUMN client_ip text", "company_observations.client_ip: address-like column name"],
    ["an inet in another schema", "CREATE SCHEMA planted_s; CREATE TABLE planted_s.t (a inet)", "planted_s.t.a: network-address type inet"],
  ])("detects %s (planted in a rolled-back transaction)", async (_name, ddl, violation) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(ddl);
      expect(await rawIpCapableColumns(c)).toContain(violation);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    expect(await rawIpCapableColumns(pool)).toEqual([]);
  });
});
