import { loadConfig } from "./config.ts";
import { runSync } from "./engine.ts";
import { PostgrestStore } from "./postgrest-store.ts";
import type { SyncResult, SyncStatus } from "./types.ts";

export const SYNC_SECRET_HEADER = "x-idr-sync-secret";

export interface HandlerDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Receives variable names / status codes only, never values. */
  log?: (message: string) => void;
}

/** Constant-time comparison: both sides are hashed to equal length first. */
export async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const HTTP_BY_STATUS: Record<SyncStatus, number> = {
  ok: 200,
  partial: 200,
  cas_conflict: 200,
  reconcile_mismatch: 200,
  rate_limited: 200,
  needs_resync: 409,
  auth_failed: 502,
  upstream_error: 502,
  contract_error: 502,
  cursor_rejected: 200,
  store_error: 500,
  schema_mismatch: 500,
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function summary(r: SyncResult): unknown {
  return {
    status: r.status,
    pages: r.pages,
    observations: r.observations,
    tombstones: r.tombstones,
    reconcile: r.reconcile === null ? null : { checked: r.reconcile.checked, matched: r.reconcile.matched },
    // needs_resync: true once the continuity gap is durably in idr_sync_gaps.
    gap_recorded: r.gap?.recorded === true,
    gap_new: r.gap?.newGap === true,
    gaps_resolved: r.gapsResolved,
  };
}

/** Status, counts and flags only: never cursors, ids, domains or other data. */
function logLine(r: SyncResult): string {
  const parts = [`sync ${r.status}`, `pages=${r.pages}`, `observations=${r.observations}`, `tombstones=${r.tombstones}`];
  if (r.gap !== null) parts.push(`gap_recorded=${r.gap.recorded}`, `gap_new=${r.gap.newGap}`);
  if (r.gapsResolved > 0) parts.push(`gaps_resolved=${r.gapsResolved}`);
  return parts.join(" ");
}

/**
 * Runtime-agnostic request handler for the Edge Function. Anything other than
 * a POST carrying the correct shared secret gets an empty 401. The response
 * body of an authorised call contains counts and status only.
 */
export async function handleSyncRequest(req: Request, deps: HandlerDeps): Promise<Response> {
  const unauthorized = () => new Response(null, { status: 401 });
  const expected = deps.env["IDR_SYNC_SECRET"] ?? "";
  const provided = req.headers.get(SYNC_SECRET_HEADER) ?? "";
  // Compare even when the method is wrong or the secret is unset, so timing is uniform.
  const match = await secretsMatch(provided, expected);
  if (req.method !== "POST" || expected.length < 32 || !match) return unauthorized();

  const cfg = loadConfig(deps.env);
  if (!cfg.ok) {
    deps.log?.(`misconfigured: ${cfg.problems.join("; ")}`);
    return json({ status: "misconfigured" }, 500);
  }
  const c = cfg.config;
  const store = new PostgrestStore({
    supabaseUrl: c.supabaseUrl,
    serviceRoleKey: c.serviceRoleKey,
    installationId: c.sync.installationId,
    fetch: deps.fetch,
  });
  try {
    const result = await runSync(c.sync, {
      fetch: deps.fetch,
      store,
      now: deps.now ?? (() => Date.now()),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: deps.random ?? Math.random,
    });
    deps.log?.(logLine(result));
    if (result.status === "schema_mismatch") {
      deps.log?.("schema mismatch: the projection SQL is not the version this function requires; re-run sql/0001_idr_projection.sql (nothing was fetched or written)");
    }
    if (result.status === "needs_resync") {
      deps.log?.(
        result.gap?.recorded === true
          ? "continuity gap open (cursor_expired): recorded in idr_sync_gaps; operator action required (idr_begin_resync)"
          : "continuity gap open (cursor_expired): RECORDING IT FAILED, retried next run; operator action required",
      );
    }
    return json(summary(result), HTTP_BY_STATUS[result.status]);
  } catch {
    deps.log?.("sync failed unexpectedly");
    return json({ status: "error" }, 500);
  }
}
