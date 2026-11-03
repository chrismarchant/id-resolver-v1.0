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
  };
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
    deps.log?.(`sync ${result.status} pages=${result.pages}`);
    return json(summary(result), HTTP_BY_STATUS[result.status]);
  } catch {
    deps.log?.("sync failed unexpectedly");
    return json({ status: "error" }, 500);
  }
}
