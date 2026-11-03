import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time bearer credential check. Both sides are hashed first so the
 * comparison length never depends on the supplied value.
 */
export function createCredentialChecker(expectedToken: string): (authorizationHeader: unknown) => boolean {
  const expected = createHash("sha256").update(expectedToken, "utf8").digest();
  return (authorizationHeader: unknown): boolean => {
    if (typeof authorizationHeader !== "string") return false;
    if (authorizationHeader.length > 1024) return false;
    const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader);
    if (!match || !match[1]) return false;
    const presented = createHash("sha256").update(match[1], "utf8").digest();
    return timingSafeEqual(presented, expected);
  };
}

/**
 * Pre-authentication throttle keyed on the peer socket address. Bounds how
 * many unauthenticated or malformed requests a single peer can make per
 * window so repeated 401s cannot be used to drain resources. The key is the
 * caller's (website server's) address, never a visitor IP, and is not logged.
 */
export function createFailureLimiter(opts: { max: number; windowMs: number; maxKeys?: number }) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const maxKeys = opts.maxKeys ?? 10_000;
  return {
    /** Returns true when the peer is over its budget. */
    isLimited(key: string, now = Date.now()): boolean {
      const b = buckets.get(key);
      return b !== undefined && b.resetAt > now && b.count >= opts.max;
    },
    /** Records one failure for the peer. */
    record(key: string, now = Date.now()): void {
      const b = buckets.get(key);
      if (b && b.resetAt > now) {
        b.count += 1;
        return;
      }
      if (buckets.size >= maxKeys) {
        for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
        if (buckets.size >= maxKeys) buckets.clear();
      }
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    },
  };
}
