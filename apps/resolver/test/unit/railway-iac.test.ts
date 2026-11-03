/**
 * Railway Infrastructure as Code (.railway/railway.ts, Gate 5): evaluates the
 * definition with the pinned `railway` SDK, exactly as the CLI's evaluation
 * does (default export called with a context and `project`), and asserts the
 * security-relevant settings. It cannot run `railway config plan`: that needs
 * an authenticated CLI and the live environment (docs/RAILWAY_IAC.md).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRailwayContext, project, type ProjectDefinition, type ServiceNode, type DatabaseNode, type VariableValue } from "railway/iac";
import { describe, expect, it } from "vitest";
import { ConfigSchema, REMOVED_VARIABLES } from "../../src/config/index.js";
import definition, { PRESERVED_VARIABLES } from "../../../../.railway/railway.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const SOURCE = readFileSync(resolve(ROOT, ".railway", "railway.ts"), "utf8");

async function evaluate(projectName?: string): Promise<ProjectDefinition> {
  return definition(createRailwayContext({ command: "plan", environment: "development", ...(projectName ? { projectName } : {}) }), project);
}

async function nodes() {
  const def = await evaluate("linked-project");
  const resources = (def.resources ?? []).flat();
  const resolver = resources.find((r) => r.address === "service.id-resolver") as ServiceNode;
  const postgres = resources.find((r) => r.address === "database.Postgres") as DatabaseNode;
  return { def, resources, resolver, postgres };
}

describe("Railway IaC definition (.railway/railway.ts)", () => {
  it("is a whole-project file declaring exactly the two resources of the environment (anything else would be deleted by apply)", async () => {
    const { def, resources } = await nodes();
    expect(resources.map((r) => r.address).sort()).toEqual(["database.Postgres", "service.id-resolver"]);
    // The linked project's own name is used, so evaluating never plans a rename.
    expect(def.name).toBe("linked-project");
    expect((await evaluate()).name).toBe("id-resolver");
  });

  it("id-resolver: Dockerfile build, pre-deploy migrate (300 s), healthcheck /healthz (60 s), restart on failure x3", async () => {
    const { resolver } = await nodes();
    expect(resolver.build).toEqual({ builder: "DOCKERFILE", dockerfilePath: "apps/resolver/Dockerfile" });
    expect(resolver.deploy?.preDeployCommand).toEqual(["node dist/db/migrate.js"]);
    expect(resolver.deploy?.preDeployTimeoutSeconds).toBe(300);
    expect(resolver.deploy?.healthcheckPath).toBe("/healthz");
    expect(resolver.deploy?.healthcheckTimeout).toBe(60);
    expect(resolver.deploy?.restartPolicyType).toBe("ON_FAILURE");
    expect(resolver.deploy?.restartPolicyMaxRetries).toBe(3);
    // The image's own start command (CMD) is used; the file does not override it.
    expect(resolver.deploy?.startCommand).toBeUndefined();
  });

  it("id-resolver: one replica in ams, 0.5 vCPU and 500 MB, IPv6 egress off", async () => {
    const { resolver } = await nodes();
    expect(resolver.deploy?.multiRegionConfig).toEqual({ ams: { numReplicas: 1 } });
    expect(resolver.deploy?.numReplicas).toBeUndefined();
    expect(resolver.deploy?.limitOverride).toEqual({ containers: { cpu: 0.5, memoryBytes: 500_000_000 } });
    expect(resolver.deploy?.ipv6EgressEnabled).toBe(false);
  });

  it("id-resolver: no TCP proxy and no declared domain (its generated public domain is never part of an IaC file); the source is not managed", async () => {
    const { resolver } = await nodes();
    expect(resolver.networking?.tcpProxies ?? {}).toEqual({});
    expect(resolver.networking?.customDomains ?? {}).toEqual({});
    expect(resolver.networking?.serviceDomains ?? {}).toEqual({});
    expect(resolver.source).toBeUndefined();
  });

  it("Postgres: the postgres-ssl template image with its data volume path, private only (no TCP proxy, no public domain declared)", async () => {
    const { postgres } = await nodes();
    expect(postgres.engine).toBe("postgres");
    expect(postgres.image).toMatch(/^ghcr\.io\/railwayapp-templates\/postgres-ssl:\d+$/);
    expect(postgres.defaultMountPath).toBe("/var/lib/postgresql/data");
    expect(postgres.output).toBe("DATABASE_URL");
    expect(postgres.networking).toBeUndefined();
    expect(postgres.variables).toBeUndefined();
    expect(postgres.deploy).toBeUndefined();
  });

  it("variables: DATABASE_URL references the Postgres service; every other value is preserve() (no value is inlined, sealed values stay on Railway)", async () => {
    const { resolver } = await nodes();
    const vars = resolver.variables as Record<string, VariableValue>;
    expect(vars["DATABASE_URL"]).toEqual({ type: "reference", resource: "database.Postgres", output: "DATABASE_URL" });
    const others = Object.entries(vars).filter(([k]) => k !== "DATABASE_URL");
    expect(others.map(([k]) => k).sort()).toEqual([...PRESERVED_VARIABLES].sort());
    for (const [name, value] of others) expect(value, name).toEqual({ type: "preserve" });
    // Mock-provider switches and secrets exist by name only.
    for (const name of ["ALLOW_MOCK_PROVIDER", "PROVIDER_MODE", "IP_HMAC_SECRET", "RESOLVER_AUTH_TOKEN", "REPORTING_AUTH_TOKEN", "DATABASE_RUNTIME_PASSWORD"]) {
      expect(vars[name], name).toEqual({ type: "preserve" });
    }
    expect(Object.values(vars).some((v) => v.type === "literal" || v.type === "raw")).toBe(false);
  });

  it("variables: the exact target set (dev after the Gate 5 rollout); no transitional override, no removed variable, every name a real configuration key", async () => {
    const { resolver } = await nodes();
    const names = Object.keys(resolver.variables ?? {}).sort();
    expect(names).toEqual(
      [
        "ALLOW_DOCUMENTATION_RANGES",
        "ALLOW_MOCK_PROVIDER",
        "DATABASE_RUNTIME_PASSWORD",
        "DATABASE_SSL",
        "DATABASE_TLS_PIN_SHA256",
        "DATABASE_URL",
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
      ].sort(),
    );
    expect(names).not.toContain("ALLOW_UNVERIFIED_DATABASE_TLS");
    expect(names).not.toContain("ALLOW_OWNER_DATABASE_ROLE");
    const known = new Set(Object.keys(ConfigSchema.shape));
    for (const n of names) {
      expect(known.has(n), n).toBe(true);
      expect(n in REMOVED_VARIABLES, n).toBe(false);
    }
  });

  it("the source holds no host name, domain, id, connection string or key material", () => {
    for (const pattern of [
      /\.railway\.internal/i,
      /\.up\.railway\.app/i,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      /postgres(ql)?:\/\//i,
      /BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/,
      /[0-9a-f]{40,}/i,
    ]) {
      expect(pattern.test(SOURCE), String(pattern)).toBe(false);
    }
    // No named partial: whole-project semantics are intended (and documented).
    expect(SOURCE).not.toMatch(/export const partial/);
  });

  it("the pinned SDK is an exact version", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
    expect(pkg.devDependencies?.["railway"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
