/**
 * `npm run ops:prune` deletes expired cache rows in bounded batches until none
 * remain, then (when OBSERVATION_RETENTION_DAYS > 0) observations older than
 * the retention window. Companies and per-company scope stats are never
 * deleted here; see docs/DATABASE.md "Retention and deletion".
 */
import { pathToFileURL } from "node:url";
import { createDb } from "../db/index.js";
import { failOps, loadOpsConfig } from "./env.js";

async function main(): Promise<void> {
  try {
    const cfg = loadOpsConfig();
    const db = createDb({ databaseUrl: cfg.DATABASE_URL, ssl: cfg.DATABASE_SSL, max: 1 });
    try {
      let total = 0;
      let batches = 0;
      for (;;) {
        const n = await db.cache.pruneExpired(cfg.CACHE_PRUNE_BATCH);
        if (n === 0) break;
        total += n;
        batches += 1;
      }
      let observations = 0;
      if (cfg.OBSERVATION_RETENTION_DAYS > 0) {
        const cutoff = new Date(Date.now() - cfg.OBSERVATION_RETENTION_DAYS * 86_400_000);
        for (;;) {
          const n = await db.activity.pruneObservationsBefore(cutoff, cfg.CACHE_PRUNE_BATCH);
          if (n === 0) break;
          observations += n;
        }
      }
      console.log(JSON.stringify({ pruned: total, batches, observations_pruned: observations, retention_days: cfg.OBSERVATION_RETENTION_DAYS }));
    } finally {
      await db.close();
    }
  } catch (err) {
    failOps("ops:prune", err);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
