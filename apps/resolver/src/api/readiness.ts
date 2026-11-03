/**
 * Readiness database probe, cached and single-flight (CHR-66 F6).
 *
 * GET /readyz is unauthenticated and outside the rate limit (load balancers
 * and the platform must reach it), and the database ping runs on the pool the
 * entrance jobs and the reporting feed share. Uncached, a flood of probes
 * turned 1:1 into pool demand. Now:
 *
 *  - one ping result (success or failure) is reused for READINESS_CACHE_MS;
 *  - while a ping is in flight every caller awaits that same ping, so at most
 *    one readiness query uses the pool at any time and at most one starts per
 *    window, however many probes arrive;
 *  - a ping that throws counts as not ready and is cached like any failure.
 *
 * Readiness may therefore lag the database by up to READINESS_CACHE_MS plus
 * one ping (db.ping is bounded at 1 s). Job-slot capacity is not cached: the
 * route checks it on every request.
 */
export const READINESS_CACHE_MS = 1_000;

export interface CachedProbeOptions {
  /** How long one result is reused. Default READINESS_CACHE_MS. */
  ttlMs?: number;
  /** Clock in ms. Default Date.now. */
  now?: () => number;
}

export function createCachedProbe(ping: () => Promise<boolean>, opts: CachedProbeOptions = {}): () => Promise<boolean> {
  const ttlMs = opts.ttlMs ?? READINESS_CACHE_MS;
  const now = opts.now ?? Date.now;
  let cached: { ok: boolean; at: number } | null = null;
  let inflight: Promise<boolean> | null = null;
  return () => {
    if (cached !== null) {
      const age = now() - cached.at;
      // A clock that moved backwards never extends the cache.
      if (age >= 0 && age < ttlMs) return Promise.resolve(cached.ok);
    }
    if (inflight !== null) return inflight;
    const run = (async () => {
      let ok = false;
      try {
        ok = (await ping()) === true;
      } catch {
        ok = false;
      }
      cached = { ok, at: now() };
      return ok;
    })().finally(() => {
      inflight = null;
    });
    inflight = run;
    return run;
  };
}
