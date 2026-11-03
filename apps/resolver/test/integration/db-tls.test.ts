/**
 * Database TLS against a real PostgreSQL protocol endpoint (Gate 5).
 *
 * CI's PostgreSQL service containers have no TLS, so every test here talks to
 * a TLS terminator (test/helpers/tls.ts) in front of the test database, with
 * certificates generated at runtime: self-signed with CN "localhost" (the
 * shape of the Railway template's certificate), or issued by a test CA. The
 * terminator only accepts the SSLRequest, so a successful query proves the
 * connection used TLS; its counters prove what reached it.
 *
 * Optional: TEST_DATABASE_NATIVE_TLS=1 also runs the pinned path against the
 * test server's own TLS (a server with ssl=on), discovering its fingerprint
 * with the ops helper first.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../../src/db/pool.js";
import { DbTlsError, fetchServerCertificate, type DbTlsConfig } from "../../src/db/tls.js";
import { fingerprintReport } from "../../src/ops/db-tls-fingerprint.js";
import { createScratchDatabase, getTestDatabaseUrl } from "../helpers/db.js";
import { makeCertificate, startTlsTerminator, type TestCertificate, type TlsTerminator } from "../helpers/tls.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const pools: Pool[] = [];
const terminators: TlsTerminator[] = [];

function pool(databaseUrl: string, ssl: DbTlsConfig, max = 2): Pool {
  const p = createPool({ databaseUrl, ssl, max });
  pools.push(p);
  return p;
}

async function terminator(cert: TestCertificate, mode?: "ok" | "refuse" | "inject" | "hang", chain?: TestCertificate[]): Promise<TlsTerminator> {
  const t = await startTlsTerminator({ upstreamUrl: getTestDatabaseUrl(), cert, ...(mode ? { mode } : {}), ...(chain ? { chain } : {}) });
  terminators.push(t);
  return t;
}

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as { code?: unknown }).code ?? (e as Error).message);
  }
  return "no error";
}

function run(script: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, script), ...args], { cwd: ROOT, env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const kill = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(kill);
      done({ code, stdout, stderr });
    });
  });
}

afterEach(async () => {
  while (pools.length > 0) await pools.pop()!.end().catch(() => undefined);
  while (terminators.length > 0) await terminators.pop()!.close();
});

describe("DATABASE_SSL=verify-pinned (pinned leaf certificate, self-signed, CN mismatch)", () => {
  const cert = makeCertificate({ cn: "localhost" });

  it("connects when the presented leaf matches the pin; the whole session (SCRAM auth, queries) runs over the pinned TLS stream", async () => {
    const t = await terminator(cert);
    // 127.0.0.1 is not in the certificate (CN/SAN localhost): no host-name check applies to a pin.
    const p = pool(t.urlFor(getTestDatabaseUrl()), { mode: "verify-pinned", pins: [cert.sha256] }, 4);
    expect((await p.query<{ one: number }>("SELECT 1 AS one")).rows[0]!.one).toBe(1);
    // Large results and concurrent connections through the relay (backpressure, several sockets).
    const big = await p.query<{ n: number }>("SELECT length(repeat('x', 2000000)) AS n, repeat('y', 2000000) AS payload");
    expect(big.rows[0]!.n).toBe(2_000_000);
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => p.query<{ v: number }>("SELECT $1::int AS v", [i])));
    expect(many.map((r) => r.rows[0]!.v)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(t.stats.handshakes).toBeGreaterThanOrEqual(1);
    await p.end();
    pools.pop();
  });

  it("fails closed on a pin mismatch, before ANY protocol byte (startup message, user, password) is sent", async () => {
    const t = await terminator(cert);
    const other = makeCertificate({ cn: "localhost" });
    const p = pool(t.urlFor(getTestDatabaseUrl()), { mode: "verify-pinned", pins: [other.sha256] });
    expect(await errorCode(p.query("SELECT 1"))).toBe("DB_TLS_PIN_MISMATCH");
    expect(t.stats.sslRequests).toBeGreaterThanOrEqual(1);
    expect(t.stats.bytesAfterHandshake).toBe(0);
  });

  it("accepts colon-separated, upper-case pins via config and compares exactly (a one-bit difference fails)", async () => {
    const t = await terminator(cert);
    const flipped = (parseInt(cert.sha256.slice(-1), 16) ^ 1).toString(16);
    const p = pool(t.urlFor(getTestDatabaseUrl()), { mode: "verify-pinned", pins: [cert.sha256.slice(0, -1) + flipped] });
    expect(await errorCode(p.query("SELECT 1"))).toBe("DB_TLS_PIN_MISMATCH");
    expect(t.stats.bytesAfterHandshake).toBe(0);
  });

  it("rotation window: with pins current,next both certificates connect; after the rotation the old pin alone is refused, and the new pin alone refuses the old certificate", async () => {
    const next = makeCertificate({ cn: "localhost" });
    const t = await terminator(cert);
    const url = t.urlFor(getTestDatabaseUrl());
    const both = pool(url, { mode: "verify-pinned", pins: [cert.sha256, next.sha256] }, 1);
    expect((await both.query("SELECT 1 AS one")).rows[0].one).toBe(1);
    await both.end();
    pools.pop();

    // The server switches to the next certificate (e.g. pg_reload_conf after the files were replaced).
    t.setCertificate(next);
    const both2 = pool(url, { mode: "verify-pinned", pins: [cert.sha256, next.sha256] }, 1);
    expect((await both2.query("SELECT 1 AS one")).rows[0].one).toBe(1);
    const oldOnly = pool(url, { mode: "verify-pinned", pins: [cert.sha256] }, 1);
    expect(await errorCode(oldOnly.query("SELECT 1"))).toBe("DB_TLS_PIN_MISMATCH");

    // Rollback of the server to the old certificate after the pin list dropped it: refused.
    t.setCertificate(cert);
    const newOnly = pool(url, { mode: "verify-pinned", pins: [next.sha256] }, 1);
    expect(await errorCode(newOnly.query("SELECT 1"))).toBe("DB_TLS_PIN_MISMATCH");
  });

  it("TLS parameters in DATABASE_URL cannot downgrade or redirect it (ssl=0, sslmode=disable, sslrootcert=...)", async () => {
    const t = await terminator(cert);
    const u = new URL(t.urlFor(getTestDatabaseUrl()));
    u.searchParams.set("ssl", "0");
    u.searchParams.set("sslmode", "disable");
    u.searchParams.set("sslrootcert", "/nonexistent/should-never-be-read.crt");
    u.searchParams.set("sslnegotiation", "postgres");
    const ok = pool(u.toString(), { mode: "verify-pinned", pins: [cert.sha256] }, 1);
    expect((await ok.query("SELECT 1 AS one")).rows[0].one).toBe(1);
    const bad = pool(u.toString(), { mode: "verify-pinned", pins: [makeCertificate({ cn: "localhost" }).sha256] }, 1);
    expect(await errorCode(bad.query("SELECT 1"))).toBe("DB_TLS_PIN_MISMATCH");
    // require stays require: the self-signed certificate is still rejected despite ?ssl=0.
    const req = pool(u.toString(), { mode: "require" }, 1);
    expect(await errorCode(req.query("SELECT 1"))).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it("refuses a server that declines TLS ('N') and a server that injects bytes after 'S' (CVE-2021-23222 shape), sending nothing", async () => {
    const refusing = await terminator(cert, "refuse");
    const p1 = pool(refusing.urlFor(getTestDatabaseUrl()), { mode: "verify-pinned", pins: [cert.sha256] }, 1);
    expect(await errorCode(p1.query("SELECT 1"))).toBe("DB_TLS_REFUSED");
    const injecting = await terminator(cert, "inject");
    const p2 = pool(injecting.urlFor(getTestDatabaseUrl()), { mode: "verify-pinned", pins: [cert.sha256] }, 1);
    expect(await errorCode(p2.query("SELECT 1"))).toBe("DB_TLS_PROTOCOL");
    expect(refusing.stats.handshakes + injecting.stats.handshakes).toBe(0);
    expect(refusing.stats.bytesAfterHandshake + injecting.stats.bytesAfterHandshake).toBe(0);
  });

  it("a server that never answers the SSLRequest fails within the pool's connection timeout (no hang)", async () => {
    const hanging = await terminator(cert, "hang");
    const p = pool(hanging.urlFor(getTestDatabaseUrl()), { mode: "verify-pinned", pins: [cert.sha256] }, 1);
    const started = Date.now();
    expect(await errorCode(p.query("SELECT 1"))).not.toBe("no error");
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("a configuration without a valid pin is refused before connecting", () => {
    expect(() => createPool({ databaseUrl: getTestDatabaseUrl(), ssl: { mode: "verify-pinned" } })).toThrow(DbTlsError);
    expect(() => createPool({ databaseUrl: getTestDatabaseUrl(), ssl: "verify-pinned" })).toThrow(DbTlsError);
    expect(() => createPool({ databaseUrl: getTestDatabaseUrl(), ssl: { mode: "verify-pinned", pins: ["AB"] } })).toThrow(DbTlsError);
  });
});

describe("DATABASE_SSL=verify-pinned with DATABASE_CA_CERT (chain AND pin)", () => {
  const ca = makeCertificate({ cn: "root-ca", ca: true, days: 30 });
  const leaf = makeCertificate({ cn: "localhost", issuer: ca });

  it("connects when the chain verifies against the CA and the leaf is pinned (host name not checked)", async () => {
    const t = await terminator(leaf);
    const p = pool(t.urlFor(getTestDatabaseUrl()), { mode: "verify-pinned", pins: [leaf.sha256], caCert: ca.certPem }, 1);
    expect((await p.query("SELECT 1 AS one")).rows[0].one).toBe(1);
  });

  it("refuses a chain-valid certificate that is not pinned, and a pinned certificate from another CA, sending nothing", async () => {
    const otherLeaf = makeCertificate({ cn: "localhost", issuer: ca });
    const t = await terminator(otherLeaf);
    const p = pool(t.urlFor(getTestDatabaseUrl()), { mode: "verify-pinned", pins: [leaf.sha256], caCert: ca.certPem }, 1);
    expect(await errorCode(p.query("SELECT 1"))).toBe("DB_TLS_PIN_MISMATCH");

    const strangerCa = makeCertificate({ cn: "root-ca", ca: true });
    const strangerLeaf = makeCertificate({ cn: "localhost", issuer: strangerCa });
    const t2 = await terminator(strangerLeaf);
    const p2 = pool(t2.urlFor(getTestDatabaseUrl()), { mode: "verify-pinned", pins: [strangerLeaf.sha256], caCert: ca.certPem }, 1);
    expect(await errorCode(p2.query("SELECT 1"))).toBe("DB_TLS_VERIFY_FAILED");
    expect(t.stats.bytesAfterHandshake + t2.stats.bytesAfterHandshake).toBe(0);
  });

  it("with a CA the validity period is enforced; pin-only mode accepts an expired pinned certificate (documented)", async () => {
    const expired = makeCertificate({ cn: "localhost", issuer: ca, notBefore: new Date(Date.now() - 10 * 86_400_000), days: 2 });
    const t = await terminator(expired);
    const url = t.urlFor(getTestDatabaseUrl());
    const withCa = pool(url, { mode: "verify-pinned", pins: [expired.sha256], caCert: ca.certPem }, 1);
    expect(await errorCode(withCa.query("SELECT 1"))).toBe("DB_TLS_VERIFY_FAILED");
    const pinOnly = pool(url, { mode: "verify-pinned", pins: [expired.sha256] }, 1);
    expect((await pinOnly.query("SELECT 1 AS one")).rows[0].one).toBe(1);
  });
});

describe("DATABASE_SSL=require and no-verify", () => {
  it("require rejects a self-signed certificate; with DATABASE_CA_CERT it verifies the chain and the host name", async () => {
    const ca = makeCertificate({ cn: "root-ca", ca: true });
    const leaf = makeCertificate({ cn: "localhost", issuer: ca });
    const t = await terminator(leaf);
    const noCa = pool(t.urlFor(getTestDatabaseUrl(), "localhost"), { mode: "require" }, 1);
    expect(await errorCode(noCa.query("SELECT 1"))).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    const withCa = pool(t.urlFor(getTestDatabaseUrl(), "localhost"), { mode: "require", caCert: ca.certPem }, 1);
    expect((await withCa.query("SELECT 1 AS one")).rows[0].one).toBe(1);
    // Same chain, but the host name (127.0.0.1) is not in the certificate: refused.
    const wrongHost = pool(t.urlFor(getTestDatabaseUrl()), { mode: "require", caCert: ca.certPem }, 1);
    expect(await errorCode(wrongHost.query("SELECT 1"))).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  it("no-verify encrypts without verifying (any certificate is accepted)", async () => {
    const t = await terminator(makeCertificate({ cn: "anything" }));
    const p = pool(t.urlFor(getTestDatabaseUrl()), { mode: "no-verify" }, 1);
    expect((await p.query("SELECT 1 AS one")).rows[0].one).toBe(1);
    expect(t.stats.handshakes).toBe(1);
  });
});

describe("ops/db-tls-fingerprint (discovery helper)", () => {
  const cert = makeCertificate({ cn: "localhost" });

  it("reports only the leaf fingerprint, subject CN, SANs and validity, and sends nothing after the handshake (no startup message, no credentials)", async () => {
    const t = await terminator(cert);
    const report = await fingerprintReport({ DATABASE_URL: t.urlFor(getTestDatabaseUrl()) });
    expect(Object.keys(report).sort()).toEqual(["sha256", "subject_alt_names", "subject_cn", "valid_from", "valid_to"]);
    expect(report.sha256).toBe(cert.sha256);
    expect(report.subject_cn).toBe("localhost");
    expect(report.subject_alt_names).toEqual(["DNS:localhost"]);
    expect(Date.parse(report.valid_to)).toBeGreaterThan(Date.parse(report.valid_from));
    expect(t.stats.sslRequests).toBe(1);
    expect(t.stats.bytesAfterHandshake).toBe(0);
  });

  it("the CLI prints JSON without the URL, host, port, user, password or database name, and reports whether the configured pin matches", async () => {
    const t = await terminator(cert);
    const url = t.urlFor(getTestDatabaseUrl());
    const u = new URL(url);
    const secretFree = (out: string) => {
      for (const needle of [url, u.host, u.hostname, `:${u.port}`, decodeURIComponent(u.username), decodeURIComponent(u.password), u.pathname.slice(1), "postgres://"]) {
        expect(out.includes(needle), "helper output leaked a connection detail").toBe(false);
      }
    };
    const r = await run("src/ops/db-tls-fingerprint.ts", [], { DATABASE_URL: url });
    expect(r.code, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed["sha256"]).toBe(cert.sha256);
    secretFree(r.stdout + r.stderr);

    const match = await run("src/ops/db-tls-fingerprint.ts", [], { DATABASE_URL: url, DATABASE_TLS_PIN_SHA256: `${makeCertificate({ cn: "x" }).sha256},${cert.sha256}` });
    expect(JSON.parse(match.stdout)["matches_configured_pin"]).toBe(true);
    const miss = await run("src/ops/db-tls-fingerprint.ts", [], { DATABASE_URL: url, DATABASE_TLS_PIN_SHA256: makeCertificate({ cn: "x" }).sha256 });
    expect(JSON.parse(miss.stdout)["matches_configured_pin"]).toBe(false);
    expect(t.stats.bytesAfterHandshake).toBe(0);
    secretFree(match.stdout + match.stderr + miss.stdout + miss.stderr);
  });

  it("on failure it prints a fixed code only", async () => {
    const t = await terminator(cert, "refuse");
    const url = t.urlFor(getTestDatabaseUrl());
    const r = await run("src/ops/db-tls-fingerprint.ts", [], { DATABASE_URL: url });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim()).toBe("ops:db-tls-fingerprint: DB_TLS_REFUSED");
    const none = await run("src/ops/db-tls-fingerprint.ts", [], {});
    expect(none.stderr.trim()).toBe("ops:db-tls-fingerprint: DATABASE_URL is required");
  });
});

describe("every connection path honours the TLS configuration: migrate and the ops commands", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
  const cert = makeCertificate({ cn: "localhost" });
  let t: TlsTerminator;
  beforeAll(async () => {
    scratch = await createScratchDatabase();
    t = await startTlsTerminator({ upstreamUrl: getTestDatabaseUrl(), cert });
  });
  afterAll(async () => {
    await t.close();
    await scratch.drop();
  });

  const secretFree = (out: string, url: string) => {
    for (const needle of [url, scratch.url, "resolver:resolver", "127.0.0.1"]) expect(out.includes(needle), "CLI output leaked a connection detail").toBe(false);
  };

  it("migrate (NODE_ENV=production): verify-pinned migrates; a wrong pin fails closed with a fixed code; disable and no-verify are refused before connecting", async () => {
    const url = t.urlFor(scratch.url);
    const wrong = await run("src/db/migrate.ts", [], { DATABASE_URL: url, DATABASE_SSL: "verify-pinned", DATABASE_TLS_PIN_SHA256: makeCertificate({ cn: "localhost" }).sha256 });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("migrate: failed (DB_TLS_PIN_MISMATCH)");
    secretFree(wrong.stdout + wrong.stderr, url);

    const handshakesBefore = t.stats.handshakes;
    const ok = await run("src/db/migrate.ts", [], { DATABASE_URL: url, DATABASE_SSL: "verify-pinned", DATABASE_TLS_PIN_SHA256: cert.sha256 });
    expect(ok.code, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).migrated).toContain("0001_initial.sql");
    expect(t.stats.handshakes).toBeGreaterThan(handshakesBefore);
    secretFree(ok.stdout + ok.stderr, url);

    const disabled = await run("src/db/migrate.ts", [], { DATABASE_URL: scratch.url, DATABASE_SSL: "disable" });
    expect(disabled.code).toBe(1);
    expect(disabled.stderr).toContain("DATABASE_SSL=disable is refused when NODE_ENV=production");
    const unverified = await run("src/db/migrate.ts", [], { DATABASE_URL: url, DATABASE_SSL: "no-verify" });
    expect(unverified.code).toBe(1);
    expect(unverified.stderr).toContain("unless ALLOW_UNVERIFIED_DATABASE_TLS=true");
    const overridden = await run("src/db/migrate.ts", [], { DATABASE_URL: url, DATABASE_SSL: "no-verify", ALLOW_UNVERIFIED_DATABASE_TLS: "true" });
    expect(overridden.code, overridden.stderr).toBe(0);
    expect(overridden.stderr).toContain("migrate: warning: override ALLOW_UNVERIFIED_DATABASE_TLS is active");
    secretFree(disabled.stderr + unverified.stderr + overridden.stdout + overridden.stderr, url);
    // Development keeps plaintext for local work.
    const dev = await run("src/db/migrate.ts", [], { DATABASE_URL: scratch.url, DATABASE_SSL: "disable", NODE_ENV: "development" });
    expect(dev.code, dev.stderr).toBe(0);
  });

  it("ops commands (usage, kill-switch) connect over verify-pinned and refuse a wrong pin", async () => {
    const url = t.urlFor(scratch.url);
    const base = { DATABASE_URL: url, DATABASE_SSL: "verify-pinned", INSTALLATION_ID: "inst-tls", WEBSITE_ID: "site-tls" };
    const usage = await run("src/ops/usage.ts", [], { ...base, DATABASE_TLS_PIN_SHA256: cert.sha256 });
    expect(usage.code, usage.stderr).toBe(0);
    expect(JSON.parse(usage.stdout).installation_id).toBe("inst-tls");
    const ks = await run("src/ops/kill-switch.ts", ["on", "--reason", "tls test"], { ...base, DATABASE_TLS_PIN_SHA256: cert.sha256 });
    expect(ks.code, ks.stderr).toBe(0);
    const wrong = await run("src/ops/usage.ts", [], { ...base, DATABASE_TLS_PIN_SHA256: makeCertificate({ cn: "localhost" }).sha256 });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr.trim()).toBe("ops:usage: error (DB_TLS_PIN_MISMATCH)");
    const plain = await run("src/ops/usage.ts", [], { ...base, DATABASE_URL: scratch.url, DATABASE_SSL: "disable" });
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain("DATABASE_SSL=disable is refused when NODE_ENV=production");
    secretFree(usage.stdout + usage.stderr + ks.stdout + ks.stderr + wrong.stderr + plain.stderr, url);
  });
});

describe.skipIf(process.env["TEST_DATABASE_NATIVE_TLS"] !== "1")("native server TLS (TEST_DATABASE_NATIVE_TLS=1: the test server runs with ssl=on)", () => {
  it("discovers the server's own certificate, connects pinned to it with TLS in use server-side, and refuses a wrong pin and unpinned verification", async () => {
    const u = new URL(getTestDatabaseUrl());
    const cert = await fetchServerCertificate(u.hostname, Number(u.port || "5432"));
    const p = pool(getTestDatabaseUrl(), { mode: "verify-pinned", pins: [cert.sha256] }, 1);
    const r = await p.query<{ ssl: boolean }>("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
    expect(r.rows[0]!.ssl).toBe(true);
    const wrong = pool(getTestDatabaseUrl(), { mode: "verify-pinned", pins: [makeCertificate({ cn: "x" }).sha256] }, 1);
    expect(await errorCode(wrong.query("SELECT 1"))).toBe("DB_TLS_PIN_MISMATCH");
    const req = pool(getTestDatabaseUrl(), { mode: "require" }, 1);
    expect(await errorCode(req.query("SELECT 1"))).not.toBe("no error");
  });
});
