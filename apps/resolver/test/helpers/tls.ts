/**
 * TLS test fixtures, generated at runtime (nothing is committed: no key, no
 * certificate):
 *
 *  - makeCertificate(): a minimal X.509 v3 certificate (ECDSA P-256), DER
 *    encoded by hand with node:crypto signing, self-signed or issued by a
 *    test CA. Node has no certificate builder and CI must not depend on an
 *    openssl binary.
 *  - startTlsTerminator(): a PostgreSQL TLS terminator in front of the test
 *    database. It answers the SSLRequest with 'S', runs the TLS handshake
 *    with the given certificate and relays the decrypted protocol to the
 *    plaintext upstream. CI's postgres service containers have no TLS; this
 *    gives every test a TLS-speaking PostgreSQL endpoint whose certificate
 *    the test controls (self-signed, CN "localhost": the Railway template's
 *    shape), without touching the server's configuration.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

// ---- minimal DER ------------------------------------------------------------
function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
/** An OBJECT IDENTIFIER from its arcs (arrays, not dotted strings: a dotted OID reads like an IPv4 literal to the public-safety gate). */
function oid(parts: readonly number[]): Buffer {
  const bytes = [40 * (parts[0] as number) + (parts[1] as number)];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
function positiveInt(b: Buffer): Buffer {
  return tlv(0x02, (b[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}
function utcTime(d: Date): Buffer {
  const s = d.toISOString();
  return tlv(0x17, Buffer.from(`${s.slice(2, 4)}${s.slice(5, 7)}${s.slice(8, 10)}${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}Z`));
}
const name = (cn: string) => seq(set(seq(oid([2, 5, 4, 3]), tlv(0x0c, Buffer.from(cn, "utf8")))));
const ECDSA_SHA256 = seq(oid([1, 2, 840, 10045, 4, 3, 2]));

export interface TestCertificate {
  certPem: string;
  keyPem: string;
  der: Buffer;
  /** Lowercase hex SHA-256 of the DER certificate: the value for DATABASE_TLS_PIN_SHA256. */
  sha256: string;
  privateKey: KeyObject;
  subjectCn: string;
}

/**
 * A certificate for `cn` with SAN DNS:`cn` (none for a CA), valid from one
 * hour ago for `days` days. Self-signed unless `issuer` is given.
 */
export function makeCertificate(opts: { cn: string; issuer?: TestCertificate; ca?: boolean; days?: number; notBefore?: Date } = { cn: "localhost" }): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const notBefore = opts.notBefore ?? new Date(Date.now() - 3_600_000);
  const notAfter = new Date(notBefore.getTime() + (opts.days ?? 2) * 86_400_000);
  const extensions: Buffer[] = [];
  if (opts.ca) {
    extensions.push(seq(oid([2, 5, 29, 19]), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))));
    // keyUsage: keyCertSign | cRLSign
    extensions.push(seq(oid([2, 5, 29, 15]), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x03, Buffer.from([0x01, 0x06])))));
  } else {
    extensions.push(seq(oid([2, 5, 29, 17]), tlv(0x04, seq(tlv(0x82, Buffer.from(opts.cn, "ascii"))))));
  }
  const serial = randomBytes(12);
  serial[0] = ((serial[0] as number) & 0x7f) | 0x01; // positive and minimal: a leading 0x00 would not be valid DER
  const tbs = seq(
    tlv(0xa0, positiveInt(Buffer.from([2]))),
    positiveInt(serial),
    ECDSA_SHA256,
    name(opts.issuer ? opts.issuer.subjectCn : opts.cn),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(opts.cn),
    publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, seq(...extensions)),
  );
  const signature = sign("sha256", tbs, { key: opts.issuer ? opts.issuer.privateKey : privateKey, dsaEncoding: "der" });
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const x = new X509Certificate(der);
  return {
    certPem: x.toString(),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    der,
    sha256: createHash("sha256").update(der).digest("hex"),
    privateKey,
    subjectCn: opts.cn,
  };
}

export interface TlsTerminator {
  host: string;
  port: number;
  /** `upstreamUrl` with host and port replaced by the terminator's (`host` may be "localhost" for host-name checks). */
  urlFor(upstreamUrl: string, host?: string): string;
  /** Replaces the certificate for new connections (rotation tests). */
  setCertificate(cert: TestCertificate, chain?: TestCertificate[]): void;
  /**
   * sslRequests: SSLRequests answered with 'S' (the client reached TLS);
   * handshakes: server-side completed handshakes (a client that aborts right
   * after verifying the server may never complete it); bytesAfterHandshake:
   * decrypted application bytes received from clients (the protocol: startup
   * message, credentials, queries).
   */
  stats: { sslRequests: number; handshakes: number; bytesAfterHandshake: number; connections: number };
  close(): Promise<void>;
}

/**
 * Starts a TLS terminator in front of `upstream` (host:port of a plaintext
 * PostgreSQL). `mode` simulates misbehaving servers: "refuse" answers 'N',
 * "inject" sends extra bytes right after 'S' (CVE-2021-23222 shape), "hang"
 * never answers the SSLRequest.
 */
export async function startTlsTerminator(opts: {
  upstreamUrl: string;
  cert: TestCertificate;
  chain?: TestCertificate[];
  mode?: "ok" | "refuse" | "inject" | "hang";
}): Promise<TlsTerminator> {
  const up = new URL(opts.upstreamUrl);
  const upstreamHost = up.hostname;
  const upstreamPort = Number(up.port || "5432");
  let context = tls.createSecureContext({ key: opts.cert.keyPem, cert: [opts.cert.certPem, ...(opts.chain ?? []).map((c) => c.certPem)].join("\n") });
  const stats = { sslRequests: 0, handshakes: 0, bytesAfterHandshake: 0, connections: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    stats.connections += 1;
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      if (head.length < 8) return;
      client.removeListener("data", onHead);
      client.pause();
      if (opts.mode === "hang") return;
      const isSslRequest = head.readUInt32BE(0) === 8 && head.readUInt32BE(4) === 80877103;
      if (!isSslRequest || opts.mode === "refuse") {
        client.end(Buffer.from("N"));
        return;
      }
      stats.sslRequests += 1;
      client.write(opts.mode === "inject" ? Buffer.from("SXX") : Buffer.from("S"));
      const secure = new tls.TLSSocket(client, { isServer: true, secureContext: context });
      sockets.add(secure as unknown as net.Socket);
      secure.on("error", () => secure.destroy());
      // Counted from the start, not only after "secure": any decrypted byte a client sends counts.
      const pending: Buffer[] = [];
      let upstream: net.Socket | undefined;
      secure.on("data", (d: Buffer) => {
        stats.bytesAfterHandshake += d.length;
        if (upstream) upstream.write(d);
        else pending.push(d);
      });
      secure.once("secure", () => {
        stats.handshakes += 1;
        const up = net.connect({ host: upstreamHost, port: upstreamPort });
        upstream = up;
        sockets.add(up);
        for (const d of pending.splice(0)) up.write(d);
        up.on("error", () => secure.destroy());
        up.on("data", (d: Buffer) => secure.write(d));
        secure.on("close", () => up.destroy());
        up.on("close", () => secure.destroy());
      });
    };
    client.on("data", onHead);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    host: "127.0.0.1",
    port,
    stats,
    urlFor(upstreamUrl: string, host = "127.0.0.1") {
      const u = new URL(upstreamUrl);
      u.hostname = host;
      u.port = String(port);
      return u.toString();
    },
    setCertificate(cert, chain = []) {
      context = tls.createSecureContext({ key: cert.keyPem, cert: [cert.certPem, ...chain.map((c) => c.certPem)].join("\n") });
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
