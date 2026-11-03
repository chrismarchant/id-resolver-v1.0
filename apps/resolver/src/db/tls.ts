/**
 * Database TLS (DATABASE_SSL) for every connection path: the service pool,
 * the migration runner and the ops commands.
 *
 * Modes:
 *  - "require":       TLS, the certificate chain verified against the system
 *                     CA store (or DATABASE_CA_CERT when set) AND the host
 *                     name checked (libpq verify-full).
 *  - "verify-pinned": TLS, the server's leaf certificate must have one of the
 *                     pinned SHA-256 fingerprints (DATABASE_TLS_PIN_SHA256,
 *                     at most two: current and next, for a rotation window).
 *                     The host name is NOT checked: the pin identifies the
 *                     exact certificate, whose CN/SAN (e.g. "localhost" on the
 *                     Railway PostgreSQL template) need not match the private
 *                     host name. With DATABASE_CA_CERT the chain must ALSO
 *                     verify against that CA (and its validity period).
 *  - "no-verify":     TLS without any verification (encrypted, not
 *                     authenticated). Refused in production unless
 *                     ALLOW_UNVERIFIED_DATABASE_TLS=true.
 *  - "disable":       plaintext. Refused in production.
 *
 * Why verify-pinned does not use node-postgres's own TLS: Node calls a
 * `checkServerIdentity` override only AFTER the chain has verified; for a
 * certificate that does not chain to a trusted CA it is never called, even
 * with `rejectUnauthorized: false`, so a pin check placed there would accept
 * any certificate. Instead `PinnedTlsSocket` (handed to node-postgres through
 * its `stream` option, with node-postgres's own TLS off) sends the PostgreSQL
 * SSLRequest, completes the TLS handshake, compares the leaf fingerprint with
 * the pins and only then reports "connect" to node-postgres. node-postgres
 * writes nothing (no startup message, no user name, no password) before
 * "connect", so on a mismatch not one byte of the protocol reaches the server.
 *
 * Error objects carry a fixed code only, never a host, a URL or certificate
 * contents.
 */
import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import net from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";

export type SslMode = "require" | "verify-pinned" | "no-verify" | "disable";
export const SSL_MODES = ["require", "verify-pinned", "no-verify", "disable"] as const satisfies readonly SslMode[];

export interface DbTlsConfig {
  mode: SslMode;
  /** Lowercase hex SHA-256 fingerprints of the accepted leaf certificates (verify-pinned only; 1 or 2). */
  pins?: readonly string[];
  /** PEM bundle: trust anchors for "require", additional chain verification for "verify-pinned". */
  caCert?: string;
}

/** A pool may be given a bare mode (no pins, no CA) or a full TLS configuration. */
export type DbTlsInput = SslMode | DbTlsConfig;

export const MAX_TLS_PINS = 2;
/** PostgreSQL SSLRequest: length 8, request code 80877103. */
export const SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

/** A TLS failure with a fixed, loggable code (matches pool.ts SAFE_CODE). */
export class DbTlsError extends Error {
  readonly code: string;
  constructor(code: "DB_TLS_PIN_MISMATCH" | "DB_TLS_VERIFY_FAILED" | "DB_TLS_REFUSED" | "DB_TLS_PROTOCOL" | "DB_TLS_TIMEOUT" | "DB_TLS_CLOSED" | "DB_TLS_CONFIG") {
    super(`database TLS failure (${code})`);
    this.name = "DbTlsError";
    this.code = code;
  }
}

export function toTlsConfig(input: DbTlsInput): DbTlsConfig {
  return typeof input === "string" ? { mode: input } : input;
}

/**
 * Parses DATABASE_TLS_PIN_SHA256: one or two SHA-256 fingerprints separated by
 * a comma, each 64 hex digits, optionally colon-separated (the form
 * `openssl x509 -fingerprint -sha256` prints), any case. Returns lowercase hex.
 * Throws an Error naming the variable only.
 */
export function parseTlsPins(raw: string): string[] {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error("DATABASE_TLS_PIN_SHA256: at least one SHA-256 fingerprint is required");
  if (parts.length > MAX_TLS_PINS) throw new Error(`DATABASE_TLS_PIN_SHA256: at most ${MAX_TLS_PINS} fingerprints (current and next)`);
  const pins = parts.map((p) => {
    const hex = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){31}$/.test(p) ? p.replace(/:/g, "") : p;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("DATABASE_TLS_PIN_SHA256: each fingerprint must be 64 hex digits (colons allowed)");
    return hex.toLowerCase();
  });
  if (new Set(pins).size !== pins.length) throw new Error("DATABASE_TLS_PIN_SHA256: duplicate fingerprint");
  return pins;
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Validates DATABASE_CA_CERT: one or more PEM certificates and nothing that
 * looks like key material. A value pasted as one line with literal "\n"
 * sequences is accepted. Returns the normalised PEM bundle.
 */
export function parseCaCert(raw: string): string {
  const text = raw.includes("\\n") && !raw.includes("\n") ? raw.replace(/\\n/g, "\n") : raw;
  if (/PRIVATE\s+KEY/i.test(text)) throw new Error("DATABASE_CA_CERT must contain certificates only (it contains key material)");
  const blocks = text.match(PEM_CERT) ?? [];
  if (blocks.length === 0) throw new Error("DATABASE_CA_CERT: no PEM certificate found");
  for (const b of blocks) {
    try {
      new X509Certificate(b);
    } catch {
      throw new Error("DATABASE_CA_CERT: a certificate could not be parsed");
    }
  }
  return `${blocks.join("\n")}\n`;
}

/** Lowercase hex SHA-256 of a DER certificate. */
export function certFingerprintSha256(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}

function pinMatches(der: Buffer | undefined, pins: readonly Buffer[]): boolean {
  if (!der || der.length === 0) return false;
  const fp = createHash("sha256").update(der).digest();
  let ok = false;
  // Compare against every pin (no early exit).
  for (const p of pins) if (p.length === fp.length && timingSafeEqual(p, fp)) ok = true;
  return ok;
}

/**
 * Maps a handshake error to a stable code: certificate verification failures
 * (OpenSSL X509 codes such as SELF_SIGNED_CERT_IN_CHAIN, or a rejected
 * checkServerIdentity) are DB_TLS_VERIFY_FAILED / DB_TLS_PIN_MISMATCH; socket
 * errors (ECONNRESET, EPIPE) are DB_TLS_CLOSED; other Node/OpenSSL protocol
 * errors (ERR_SSL_...) are DB_TLS_PROTOCOL.
 */
function classifyTlsError(e: NodeJS.ErrnoException): DbTlsError {
  if (e instanceof DbTlsError) return e;
  const code = typeof e.code === "string" ? e.code : "";
  if (code.startsWith("ERR_TLS_CERT")) return new DbTlsError("DB_TLS_VERIFY_FAILED");
  if (/^E[A-Z]+$/.test(code)) return new DbTlsError("DB_TLS_CLOSED");
  if (code.startsWith("ERR_") || code === "") return new DbTlsError("DB_TLS_PROTOCOL");
  return new DbTlsError("DB_TLS_VERIFY_FAILED");
}

function sniFor(host: string): string | undefined {
  // SNI must not be an IP address (RFC 6066, section 3).
  return net.isIP(host) === 0 ? host : undefined;
}

/**
 * Opens a TCP connection, sends the SSLRequest and starts TLS on the same
 * socket once the server answers 'S'. Resolves with the socket after the
 * handshake; the caller verifies the peer. Exactly one byte is accepted
 * before the handshake: anything more is refused (CVE-2021-23222 class:
 * plaintext injected ahead of the TLS stream).
 */
export function negotiatePostgresTls(opts: {
  host: string;
  port: number;
  tlsOptions: tls.ConnectionOptions;
  timeoutMs?: number;
  /** Receives the raw socket as soon as it exists (setNoDelay, setKeepAlive, ref/unref). */
  onRawSocket?: (raw: net.Socket) => void;
}): { promise: Promise<tls.TLSSocket>; abort: (err?: Error) => void } {
  let raw: net.Socket | undefined;
  let secure: tls.TLSSocket | undefined;
  let settled = false;
  let rejectFn: (e: Error) => void = () => undefined;
  const abort = (err?: Error) => {
    secure?.destroy();
    raw?.destroy();
    if (!settled) {
      settled = true;
      rejectFn(err ?? new DbTlsError("DB_TLS_CLOSED"));
    }
  };
  const promise = new Promise<tls.TLSSocket>((resolve, reject) => {
    rejectFn = reject;
    const fail = (err: Error) => abort(err);
    const timer = setTimeout(() => fail(new DbTlsError("DB_TLS_TIMEOUT")), opts.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    timer.unref();
    const done = (s: tls.TLSSocket) => {
      clearTimeout(timer);
      if (settled) {
        s.destroy();
        return;
      }
      settled = true;
      resolve(s);
    };
    raw = net.connect({ host: opts.host, port: opts.port });
    opts.onRawSocket?.(raw);
    const onRawError = () => fail(new DbTlsError("DB_TLS_CLOSED"));
    const onRawClose = () => fail(new DbTlsError("DB_TLS_CLOSED"));
    raw.on("error", onRawError);
    raw.once("close", onRawClose);
    raw.once("connect", () => raw?.write(SSL_REQUEST));
    raw.once("data", (chunk: Buffer) => {
      const r = raw as net.Socket;
      if (chunk.length !== 1) return fail(new DbTlsError("DB_TLS_PROTOCOL"));
      if (chunk[0] !== 0x53 /* 'S' */) return fail(new DbTlsError("DB_TLS_REFUSED"));
      r.removeListener("error", onRawError);
      r.removeListener("close", onRawClose);
      const servername = sniFor(opts.host);
      secure = tls.connect({ ...opts.tlsOptions, socket: r, ...(servername ? { servername } : {}) });
      secure.once("secureConnect", () => {
        clearTimeout(timer);
        done(secure as tls.TLSSocket);
      });
      secure.once("error", (e: NodeJS.ErrnoException) => fail(classifyTlsError(e)));
      secure.once("close", () => fail(new DbTlsError("DB_TLS_CLOSED")));
    });
  });
  // The caller may never await (e.g. destroyed first): never an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, abort };
}

/**
 * TLS options for the inner handshake of verify-pinned. Without a CA the
 * chain is not checked (the pin is checked by the caller before any data
 * flows). With a CA the chain must verify against it, and the host-name
 * check is replaced by the pin check; a mismatch fails the handshake.
 */
function pinnedTlsOptions(pins: readonly Buffer[], caCert: string | undefined): tls.ConnectionOptions {
  if (!caCert) return { rejectUnauthorized: false, minVersion: "TLSv1.2" };
  return {
    rejectUnauthorized: true,
    ca: caCert,
    minVersion: "TLSv1.2",
    checkServerIdentity: (_host, cert) => (pinMatches(cert.raw, pins) ? undefined : new DbTlsError("DB_TLS_PIN_MISMATCH")),
  };
}

/**
 * A socket-shaped stream for node-postgres (`stream` option) that is TLS
 * underneath: connect() negotiates TLS, checks the pin, and only then emits
 * "connect". Data is relayed between node-postgres and the verified TLS
 * socket. node-postgres itself must be configured with `ssl: false`.
 */
export class PinnedTlsSocket extends Duplex {
  private readonly pins: readonly Buffer[];
  private readonly caCert: string | undefined;
  private readonly handshakeTimeoutMs: number;
  private raw: net.Socket | undefined;
  private secure: tls.TLSSocket | undefined;
  private abortHandshake: ((err?: Error) => void) | undefined;
  private noDelay = true;
  private keepAlive: { enable: boolean; delay?: number } | undefined;
  private unrefd = false;
  /** True once the pin has been verified; nothing is written before. */
  verified = false;

  constructor(opts: { pins: readonly string[]; caCert?: string; handshakeTimeoutMs?: number }) {
    super({ allowHalfOpen: false });
    if (opts.pins.length === 0) throw new DbTlsError("DB_TLS_CONFIG");
    this.pins = opts.pins.map((p) => Buffer.from(p, "hex"));
    this.caCert = opts.caCert;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  connect(port: number | string, host?: string): this {
    if (host === undefined || (typeof port === "string" && !/^\d+$/.test(port))) {
      // A Unix-domain socket path: PostgreSQL never offers TLS there.
      process.nextTick(() => this.destroy(new DbTlsError("DB_TLS_REFUSED")));
      return this;
    }
    const { promise, abort } = negotiatePostgresTls({
      host,
      port: Number(port),
      tlsOptions: pinnedTlsOptions(this.pins, this.caCert),
      timeoutMs: this.handshakeTimeoutMs,
      onRawSocket: (raw) => {
        this.raw = raw;
        raw.setNoDelay(this.noDelay);
        if (this.keepAlive) raw.setKeepAlive(this.keepAlive.enable, this.keepAlive.delay);
        if (this.unrefd) raw.unref();
      },
    });
    this.abortHandshake = abort;
    promise.then(
      (secure) => {
        if (this.destroyed) {
          secure.destroy();
          return;
        }
        this.secure = secure;
        // The decisive check: the presented leaf certificate must be pinned.
        if (!pinMatches(secure.getPeerCertificate(false)?.raw, this.pins)) {
          this.destroy(new DbTlsError("DB_TLS_PIN_MISMATCH"));
          return;
        }
        this.verified = true;
        secure.on("data", (chunk: Buffer) => {
          if (!this.push(chunk)) secure.pause();
        });
        secure.once("end", () => this.push(null));
        secure.on("error", (e: Error) => this.destroy(e));
        secure.once("close", () => this.destroy());
        this.emit("connect");
      },
      (err: Error) => this.destroy(err),
    );
    return this;
  }

  override _read(): void {
    this.secure?.resume();
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.verified || !this.secure) {
      callback(new DbTlsError("DB_TLS_CLOSED"));
      return;
    }
    this.secure.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.secure) this.secure.end(() => callback());
    else callback();
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    this.abortHandshake?.(err ?? undefined);
    this.secure?.destroy();
    this.raw?.destroy();
    callback(err);
  }

  setNoDelay(noDelay = true): this {
    this.noDelay = noDelay;
    this.raw?.setNoDelay(noDelay);
    return this;
  }

  setKeepAlive(enable = false, initialDelay?: number): this {
    this.keepAlive = { enable, ...(initialDelay !== undefined ? { delay: initialDelay } : {}) };
    this.raw?.setKeepAlive(enable, initialDelay);
    return this;
  }

  ref(): this {
    this.unrefd = false;
    this.raw?.ref();
    return this;
  }

  unref(): this {
    this.unrefd = true;
    this.raw?.unref();
    return this;
  }
}

export interface PgTlsOptions {
  ssl: false | tls.ConnectionOptions;
  stream?: () => Duplex;
}

/** node-postgres options for a TLS configuration (pool.ts). */
export function pgTlsOptions(input: DbTlsInput): PgTlsOptions {
  const cfg = toTlsConfig(input);
  switch (cfg.mode) {
    case "disable":
      return { ssl: false };
    case "no-verify":
      return { ssl: { rejectUnauthorized: false } };
    case "require":
      return { ssl: { rejectUnauthorized: true, ...(cfg.caCert ? { ca: cfg.caCert } : {}) } };
    case "verify-pinned": {
      const pins = cfg.pins ?? [];
      if (pins.length === 0 || pins.length > MAX_TLS_PINS || pins.some((p) => !/^[0-9a-f]{64}$/.test(p))) throw new DbTlsError("DB_TLS_CONFIG");
      const caCert = cfg.caCert;
      return { ssl: false, stream: () => new PinnedTlsSocket({ pins, ...(caCert ? { caCert } : {}) }) };
    }
  }
}

export interface ServerCertificateInfo {
  sha256: string;
  subjectCn: string | null;
  subjectAltNames: string[];
  validFrom: string;
  validTo: string;
}

/**
 * Discovery only (ops/db-tls-fingerprint.ts): TLS handshake WITHOUT
 * verification, read the leaf certificate, close. Sends the SSLRequest and
 * the TLS handshake and nothing else: no startup message, no user name, no
 * password. Trust on first use; see docs.
 */
export async function fetchServerCertificate(host: string, port: number, timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS): Promise<ServerCertificateInfo> {
  const { promise } = negotiatePostgresTls({ host, port, tlsOptions: { rejectUnauthorized: false, minVersion: "TLSv1.2" }, timeoutMs });
  const secure = await promise;
  try {
    const peer = secure.getPeerCertificate(false);
    if (!peer?.raw) throw new DbTlsError("DB_TLS_PROTOCOL");
    const x = new X509Certificate(peer.raw);
    const cn = /(?:^|\n)CN=([^\n]*)/.exec(x.subject)?.[1] ?? null;
    const sans = (x.subjectAltName ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return {
      sha256: certFingerprintSha256(peer.raw),
      subjectCn: cn,
      subjectAltNames: sans,
      validFrom: new Date(x.validFrom).toISOString(),
      validTo: new Date(x.validTo).toISOString(),
    };
  } finally {
    secure.destroy();
  }
}
