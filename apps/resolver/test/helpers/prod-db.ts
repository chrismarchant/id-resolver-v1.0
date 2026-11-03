/**
 * Production-posture database settings for tests that run the real service
 * (or an ops command) with NODE_ENV=production: verified TLS
 * (DATABASE_SSL=verify-pinned) through a runtime-generated TLS terminator in
 * front of the plaintext test database. Production refuses `disable` and
 * unverified TLS, so these processes cannot use the plain test URL.
 */
import { getTestDatabaseUrl } from "./db.js";
import { makeCertificate, startTlsTerminator, type TestCertificate, type TlsTerminator } from "./tls.js";

export interface ProductionDb {
  terminator: TlsTerminator;
  cert: TestCertificate;
  /** DATABASE_URL (through the terminator, owner credentials), DATABASE_SSL and the pin. */
  env(databaseUrl?: string): Record<string, string>;
  /** `databaseUrl` (default: the test database) routed through the terminator. */
  url(databaseUrl?: string): string;
  close(): Promise<void>;
}

export async function startProductionDb(): Promise<ProductionDb> {
  const cert = makeCertificate({ cn: "localhost" });
  const terminator = await startTlsTerminator({ upstreamUrl: getTestDatabaseUrl(), cert });
  const url = (databaseUrl = getTestDatabaseUrl()) => terminator.urlFor(databaseUrl);
  return {
    terminator,
    cert,
    url,
    env: (databaseUrl = getTestDatabaseUrl()) => ({
      DATABASE_URL: url(databaseUrl),
      DATABASE_SSL: "verify-pinned",
      DATABASE_TLS_PIN_SHA256: cert.sha256,
    }),
    close: () => terminator.close(),
  };
}
