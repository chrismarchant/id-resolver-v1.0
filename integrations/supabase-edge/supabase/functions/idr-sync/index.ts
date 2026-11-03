// Thin Deno entry for the ID Resolver Insights sync. All logic lives in
// src/core (runtime-agnostic, unit-tested under Node). No client-specific
// values appear here: configuration comes from Supabase secrets.
//
// Required secrets: IDR_BASE_URL, IDR_REPORTING_TOKEN, IDR_INSTALLATION_ID,
// IDR_SYNC_SECRET. Provided by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import { handleSyncRequest } from "../../../src/core/index.ts";

Deno.serve((req: Request) =>
  handleSyncRequest(req, {
    env: Deno.env.toObject(),
    fetch,
    log: (m: string) => console.log(`[idr-sync] ${m}`),
  })
);
