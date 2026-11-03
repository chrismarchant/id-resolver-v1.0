/**
 * `npm run ops:kill-switch -- on|off --reason "text"`
 *
 *   on  = kill switch ENGAGED   -> enrichment_enabled = false (no paid calls)
 *   off = kill switch RELEASED  -> enrichment_enabled = true
 *
 * `disable` / `enable` are accepted as unambiguous aliases of on / off.
 * Cache reads continue while the switch is engaged.
 */
import { pathToFileURL } from "node:url";
import { createDb } from "../db/index.js";
import { failOps, loadOpsConfig } from "./env.js";

function parseArgs(argv: string[]): { engage: boolean; reason: string } {
  const action = argv[0];
  let engage: boolean;
  if (action === "on" || action === "disable") engage = true;
  else if (action === "off" || action === "enable") engage = false;
  else throw new Error('usage: ops:kill-switch -- on|off --reason "text"');
  const i = argv.indexOf("--reason");
  const reason = i === -1 ? undefined : argv[i + 1];
  if (!reason || reason.trim().length === 0) throw new Error("--reason is required");
  return { engage, reason: reason.trim() };
}

async function main(): Promise<void> {
  try {
    const { engage, reason } = parseArgs(process.argv.slice(2));
    const cfg = loadOpsConfig();
    const db = createDb({ databaseUrl: cfg.DATABASE_URL, ssl: cfg.DATABASE_TLS, max: 1 });
    try {
      await db.controls.setEnrichmentEnabled(cfg.INSTALLATION_ID, !engage, reason);
      const enabled = await db.controls.isEnrichmentEnabled(cfg.INSTALLATION_ID);
      console.log(
        JSON.stringify({
          installation_id: cfg.INSTALLATION_ID,
          kill_switch: enabled ? "released" : "engaged",
          enrichment_enabled: enabled,
          reason,
        }),
      );
    } finally {
      await db.close();
    }
  } catch (err) {
    failOps("ops:kill-switch", err);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
