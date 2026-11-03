// The real resolver (apps/resolver/dist, built with `npm run build -w @idr/resolver`)
// as a local process: its own database on a NON-shared PostgreSQL cluster (the
// feed horizon is cluster-wide), mock provider, bound to 127.0.0.1. Synthetic
// data only: RFC 5737 / RFC 3849 documentation addresses scripted in the
// resolver's own mock provider.
import { spawn, execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const run = promisify(execFile);

/** Scripted in apps/resolver/src/provider/mock.ts (qualified COM and EDU). */
export const IP_EXAMPLE_COM = "203.0.113.10";
export const IP_EXAMPLE_EDU = "2001:db8::10";

export class Resolver {
  /**
   * @param {{ repo: string, pgBase: string, dbName: string, port: number, installationId: string,
   *   websiteId: string, resolverToken: string, reportingToken: string, logFile: string, preload: string }} o
   */
  constructor(o) {
    this.o = o;
    this.url = `http://127.0.0.1:${o.port}`;
    this.dbUrl = `${o.pgBase}/${o.dbName}`;
    /** @type {import("node:child_process").ChildProcess | null} */
    this.proc = null;
    this.log = createWriteStream(o.logFile, { flags: "a", mode: 0o600 });
    this.pool = null;
  }

  dist(rel) {
    return `${this.o.repo}/apps/resolver/dist/${rel}`;
  }

  baseEnv() {
    return {
      PATH: process.env["PATH"] ?? "",
      // Local plaintext database: development (production refuses DATABASE_SSL=disable, also for migrate).
      NODE_ENV: "development",
      DATABASE_URL: this.dbUrl,
      DATABASE_SSL: "disable",
      INSTALLATION_ID: this.o.installationId,
      WEBSITE_ID: this.o.websiteId,
    };
  }

  /** Drops and recreates the resolver database, then runs the resolver's own migrations. */
  async resetDatabase() {
    await this.closePool();
    const admin = new pg.Client({ connectionString: `${this.o.pgBase}/postgres` });
    await admin.connect();
    try {
      await admin.query(`drop database if exists ${this.o.dbName} with (force)`);
      await admin.query(`create database ${this.o.dbName}`);
    } finally {
      await admin.end();
    }
    const r = await run(process.execPath, [this.dist("db/migrate.js")], { env: this.baseEnv(), cwd: `${this.o.repo}/apps/resolver` });
    this.log.write(`[migrate] ${r.stdout}${r.stderr}\n`);
  }

  db() {
    if (!this.pool) this.pool = new pg.Pool({ connectionString: this.dbUrl, max: 3 });
    return this.pool;
  }

  async closePool() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /** Starts `node dist/main.js` with the given IP_HMAC_SECRET (it also keys feed cursors). */
  async start({ hmacSecret, keyVersion = 1 }) {
    if (this.proc) throw new Error("resolver already running");
    const env = {
      ...this.baseEnv(),
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: String(this.o.port),
      LOG_LEVEL: "warn",
      RESOLVER_AUTH_TOKEN: this.o.resolverToken,
      REPORTING_AUTH_TOKEN: this.o.reportingToken,
      IP_HMAC_SECRET: hmacSecret,
      IP_HMAC_KEY_VERSION: String(keyVersion),
      PROVIDER_MODE: "mock",
      ALLOW_DOCUMENTATION_RANGES: "true",
      OBSERVATION_RETENTION_DAYS: "30",
      RATE_LIMIT_PER_MINUTE: "100000",
      // The maintenance run would prune nothing (30-day window); keep it out of the way.
      CACHE_PRUNE_INTERVAL_S: "86400",
    };
    const p = spawn(process.execPath, [this.dist("main.js")], { env, cwd: `${this.o.repo}/apps/resolver`, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.pipe(this.log, { end: false });
    p.stderr.pipe(this.log, { end: false });
    this.proc = p;
    p.on("exit", () => {
      if (this.proc === p) this.proc = null;
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const r = await fetch(`${this.url}/readyz`, { signal: AbortSignal.timeout(1000) });
        if (r.status === 200) return;
      } catch {
        // not listening yet
      }
      if (!this.proc) throw new Error("resolver exited during startup (see resolver.log)");
      if (Date.now() > deadline) throw new Error("resolver not ready within 20 s");
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async stop() {
    const p = this.proc;
    if (!p) return;
    const exited = new Promise((r) => p.once("exit", r));
    p.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 12_000))]);
    if (this.proc === p) p.kill("SIGKILL");
    this.proc = null;
  }

  /** One entrance.v1 report from the website; returns the resolver's answer. */
  async entrance(ip, pageKey, acquisition = "direct") {
    const body = {
      contract: "entrance.v1",
      website_id: this.o.websiteId,
      ip,
      entrance_id: randomBytes(16).toString("base64url"),
      occurred_at: new Date().toISOString(),
      page_key: pageKey,
      acquisition,
      eligibility: "e2e-1",
    };
    const r = await fetch(`${this.url}/v1/entrances`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.o.resolverToken}` },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (r.status !== 200 || j.status !== "qualified" || j.recorded !== true) {
      throw new Error(`entrance not recorded: http ${r.status} status ${j.status} recorded ${j.recorded}`);
    }
    return j;
  }

  /** n entrances, alternating between the two scripted companies unless `ip` is given. */
  async entrances(n, tag, ip) {
    for (let i = 0; i < n; i++) {
      await this.entrance(ip ?? (i % 3 === 2 ? IP_EXAMPLE_EDU : IP_EXAMPLE_COM), `/e2e/${tag}/${i}`, i % 2 === 0 ? "direct" : "search");
    }
  }

  /** Direct feed read (oracle; never through the fault proxy). */
  async feedPage(after, limit = 500) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (after !== null && after !== undefined) q.set("after", after);
    const r = await fetch(`${this.url}/v1/reporting/observations?${q}`, { headers: { authorization: `Bearer ${this.o.reportingToken}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  /** The whole retained feed from the start: items in stream order and the cursor at its end. */
  async feedAll(limit = 500) {
    const items = [];
    /** @type {string | null} */
    let after = null;
    for (;;) {
      const p = await this.feedPage(after, limit);
      if (p.status !== 200) throw new Error(`feed read failed: ${p.status}`);
      items.push(...p.body.items);
      after = p.body.next_cursor;
      if (!p.body.has_more) return { items, cursor: after };
    }
  }

  /** `ops:erase-company --company-id <id>` (the resolver's own CLI). */
  async eraseCompany(companyId) {
    const r = await run(process.execPath, [this.dist("ops/erase-company.js"), "--company-id", String(companyId)], { env: this.baseEnv() });
    return JSON.parse(r.stdout.trim());
  }

  /**
   * `ops:prune` (the resolver's own CLI, unmodified) run as if at `fakeNowMs`:
   * it deletes observations observed before fakeNowMs - retentionDays.
   */
  async prune({ fakeNowMs, retentionDays }) {
    const r = await run(process.execPath, ["--import", this.o.preload, this.dist("ops/prune.js")], {
      env: { ...this.baseEnv(), OBSERVATION_RETENTION_DAYS: String(retentionDays), E2E_FAKE_NOW_MS: String(fakeNowMs) },
    });
    return JSON.parse(r.stdout.trim());
  }
}
