import { loadConfig, type Config } from "../../src/config/index.js";

export const TEST_AUTH_TOKEN = "test-resolver-token-0123456789abcdef0123456789abcdef";
export const TEST_HMAC_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "debug",
    INSTALLATION_ID: "inst-test",
    WEBSITE_ID: "site-test",
    RESOLVER_AUTH_TOKEN: TEST_AUTH_TOKEN,
    IP_HMAC_SECRET: TEST_HMAC_SECRET,
    DATABASE_URL: process.env["TEST_DATABASE_URL"] ?? "postgres://resolver:resolver@127.0.0.1:5432/id_resolver_test",
    DATABASE_SSL: "disable",
    PROVIDER_MODE: "mock",
    ENRICH_API_KEY: "sk_test_placeholder",
    REQUEST_DEADLINE_MS: "2000",
    ENRICH_TIMEOUT_MS: "800",
    LEASE_MS: "1500",
    CHILD_HARD_KILL_GRACE_MS: "300",
    MAX_CONCURRENT_CHILDREN: "4",
    RATE_LIMIT_PER_MINUTE: "1000",
    PENDING_WAIT_MS: "600",
    PENDING_POLL_MS: "25",
    ALLOW_DOCUMENTATION_RANGES: "true",
    ...overrides,
  });
}
