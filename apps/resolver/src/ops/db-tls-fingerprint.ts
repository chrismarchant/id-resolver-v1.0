/**
 * `node dist/ops/db-tls-fingerprint.js` (locally `npm run ops:db-tls-fingerprint`)
 *
 * Discovery for DATABASE_SSL=verify-pinned. Connects to the host and port of
 * DATABASE_URL, sends the PostgreSQL SSLRequest, completes a TLS handshake
 * WITHOUT verifying the certificate, and closes. It never sends the startup
 * message: no user name, password or database name leaves the process, and
 * nothing is read from or written to the database.
 *
 * Prints one JSON object with ONLY the server leaf certificate's SHA-256
 * fingerprint (`sha256`, the value for DATABASE_TLS_PIN_SHA256), subject CN,
 * subject alternative names and validity dates, plus, when
 * DATABASE_TLS_PIN_SHA256 is set, whether the fingerprint is one of those
 * pins. Never the URL, host, port, user or password; errors print a fixed
 * code only.
 *
 * Trust on first use: the first fingerprint is only as trustworthy as the
 * network path it was read over. Run it from inside the service (Railway
 * private network, WireGuard-encrypted between services), never over a public
 * TCP proxy, and compare it with a second reading (see RUNTIME.md).
 */
import { pathToFileURL } from "node:url";
import { DbTlsError, fetchServerCertificate, parseTlsPins } from "../db/tls.js";

export interface FingerprintReport {
  sha256: string;
  subject_cn: string | null;
  subject_alt_names: string[];
  valid_from: string;
  valid_to: string;
  matches_configured_pin?: boolean;
}

/** Host and port of a postgres URL; throws a fixed message, never the URL. */
export function targetOf(databaseUrl: string): { host: string; port: number } {
  let u: URL;
  try {
    u = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  const host = u.hostname.replace(/^\[(.+)\]$/, "$1");
  if (host.length === 0) throw new Error("DATABASE_URL has no host");
  const port = u.port === "" ? 5432 : Number(u.port);
  return { host, port };
}

export async function fingerprintReport(env: NodeJS.ProcessEnv): Promise<FingerprintReport> {
  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pins = env["DATABASE_TLS_PIN_SHA256"] !== undefined ? parseTlsPins(env["DATABASE_TLS_PIN_SHA256"]) : undefined;
  const { host, port } = targetOf(databaseUrl);
  const cert = await fetchServerCertificate(host, port);
  return {
    sha256: cert.sha256,
    subject_cn: cert.subjectCn,
    subject_alt_names: cert.subjectAltNames,
    valid_from: cert.validFrom,
    valid_to: cert.validTo,
    ...(pins ? { matches_configured_pin: pins.includes(cert.sha256) } : {}),
  };
}

async function main(): Promise<void> {
  try {
    console.log(JSON.stringify(await fingerprintReport(process.env), null, 2));
  } catch (err) {
    // Fixed texts and codes only: never the URL, the host or a driver message.
    const detail =
      err instanceof DbTlsError
        ? err.code
        : err instanceof Error && /^(DATABASE_URL|DATABASE_TLS_PIN_SHA256)\b/.test(err.message)
          ? err.message
          : "failed";
    console.error(`ops:db-tls-fingerprint: ${detail}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
