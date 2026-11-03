/**
 * Railway Infrastructure as Code: the ID Resolver development environment
 * (Gate 5). Evaluated by the Railway CLI (`railway config plan` / `apply`,
 * CLI 5.42.1 or newer); runbook in docs/RAILWAY_IAC.md.
 *
 * WHOLE-PROJECT FILE: no named partial is exported, so `railway config apply`
 * DELETES every resource of the environment that is not declared here, and
 * every variable of a declared service that is not listed. Never apply
 * without a reviewed plan that shows "already up to date" or only the
 * intended changes.
 *
 * Public repository: no value is written here. Every variable is preserve()
 * (Railway keeps the value it holds; sealed values never leave Railway),
 * except DATABASE_URL, a reference to the PostgreSQL service. No host name,
 * domain, project, service or environment id appears: generated Railway
 * domains are never part of an IaC file, and ids are resolved by the CLI
 * from the linked project.
 *
 * Not managed here (left as they are): the service's source (repository and
 * branch) and the PostgreSQL service's own template variables, region and
 * volume, which the managed-database helper owns.
 *
 * Erasable TypeScript only (the CLI strips types; no enums or namespaces).
 * test/unit/railway-iac.test.ts (apps/resolver) evaluates this definition
 * and asserts its security-relevant settings.
 */
import { database, defineRailway, preserve, project, service } from "railway/iac";

/** Railway's PostgreSQL template image: TLS with a certificate generated on the volume (self-signed CA). */
export const POSTGRES_IMAGE = "ghcr.io/railwayapp-templates/postgres-ssl:18";
export const POSTGRES_DATA_PATH = "/var/lib/postgresql/data";

/** Region and size of the resolver service (one replica; RUNTIME.md "Process model"). */
export const RESOLVER_REGION = "ams";
export const RESOLVER_CPU = 0.5;
export const RESOLVER_MEMORY_BYTES = 500_000_000;

/**
 * Every variable the id-resolver service holds besides DATABASE_URL, by name
 * only, values preserved. Sealed on Railway: IP_HMAC_SECRET,
 * REPORTING_AUTH_TOKEN, RESOLVER_AUTH_TOKEN, DATABASE_RUNTIME_PASSWORD (the
 * last one is created by the owner; see docs/RAILWAY_IAC.md "Dev rollout").
 * A variable missing from this list would be DELETED by an apply.
 */
export const PRESERVED_VARIABLES = [
  "ALLOW_DOCUMENTATION_RANGES",
  "ALLOW_MOCK_PROVIDER",
  "DATABASE_RUNTIME_PASSWORD",
  "DATABASE_SSL",
  "DATABASE_TLS_PIN_SHA256",
  "ENRICHMENT_ENABLED",
  "INSTALLATION_ID",
  "IP_HMAC_SECRET",
  "LOG_LEVEL",
  "OBSERVATION_RETENTION_DAYS",
  "PERIOD_CALL_CAP",
  "PROVIDER_MODE",
  "REPORTING_AUTH_TOKEN",
  "RESOLVER_AUTH_TOKEN",
  "WEBSITE_ID",
] as const;

export default defineRailway((ctx) => {
  // Private network only: no TCP proxy and no public domain are declared for it.
  const postgres = database("Postgres", "postgres", {
    image: POSTGRES_IMAGE,
    output: "DATABASE_URL",
    defaultMountPath: POSTGRES_DATA_PATH,
  });

  const resolver = service("id-resolver", {
    build: { builder: "DOCKERFILE", dockerfilePath: "apps/resolver/Dockerfile" },
    // Migrations (as the owner) and runtime-role provisioning run before every deploy; a failure stops the deploy.
    preDeploy: ["node dist/db/migrate.js"],
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    replicas: { [RESOLVER_REGION]: 1 },
    deploy: {
      preDeployTimeoutSeconds: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 3,
      limitOverride: { containers: { cpu: RESOLVER_CPU, memoryBytes: RESOLVER_MEMORY_BYTES } },
      ipv6EgressEnabled: false,
    },
    env: {
      // The owner's connection string, over the private network (the service derives the runtime login from it).
      DATABASE_URL: postgres.env.DATABASE_URL,
      ...Object.fromEntries(PRESERVED_VARIABLES.map((name) => [name, preserve()])),
    },
  });

  // The linked project's own name (the CLI provides it), so the file never plans a rename.
  return project(ctx.projectName ?? "id-resolver", { resources: [postgres, resolver] });
});
