/**
 * `npm run ops:usage [-- --period YYYY-MM]` prints the usage snapshot as JSON.
 * Credits are reported in two clearly separate fields.
 */
import { pathToFileURL } from "node:url";
import { usagePeriodKey } from "../contracts/db.js";
import { createDb } from "../db/index.js";
import { failOps, loadOpsConfig } from "./env.js";

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;

function parsePeriodArg(argv: string[]): string | undefined {
  const i = argv.indexOf("--period");
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || !PERIOD_PATTERN.test(v)) throw new Error("--period must look like YYYY-MM (or YYYY-MM-DD)");
  return v;
}

async function main(): Promise<void> {
  try {
    const cfg = loadOpsConfig();
    const periodKey = parsePeriodArg(process.argv.slice(2)) ?? usagePeriodKey(cfg.USAGE_PERIOD, new Date());
    const db = createDb({ databaseUrl: cfg.DATABASE_URL, ssl: cfg.DATABASE_SSL, max: 1 });
    try {
      const s = await db.usage.snapshot({ installationId: cfg.INSTALLATION_ID, websiteId: cfg.WEBSITE_ID, periodKey });
      const enabled = await db.controls.isEnrichmentEnabled(cfg.INSTALLATION_ID);
      console.log(
        JSON.stringify(
          {
            installation_id: cfg.INSTALLATION_ID,
            website_id: cfg.WEBSITE_ID,
            period_key: s.periodKey,
            enrichment_enabled: enabled,
            counters: {
              resolver_requests: s.resolver_requests,
              cache_hits: s.cache_hits,
              provider_attempts: s.provider_attempts,
              domain_resolutions: s.domain_resolutions,
              qualified_matches: s.qualified_matches,
              no_matches: s.no_matches,
              excluded_results: s.excluded_results,
              unknown_results: s.unknown_results,
              failures: s.failures,
              uncertain_outcomes: s.uncertain_outcomes,
            },
            // Credits the provider itself reported in responses. Never inferred.
            provider_credits_reported: s.providerCreditsReported,
            // Locally estimated credits. An ESTIMATE, not a billing figure.
            provider_credits_estimated: s.providerCreditsEstimated,
          },
          null,
          2,
        ),
      );
    } finally {
      await db.close();
    }
  } catch (err) {
    failOps("ops:usage", err);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
