/**
 * Background-context discovery, based on the verified TanStack Start 1.168 /
 * Nitro 3 lifecycle (see verification/RESULTS.md):
 *
 *  - Cloudflare (nitro cloudflare-module): `request.waitUntil` is a function;
 *    `import("cloudflare:workers").waitUntil` also works. A promise that is
 *    neither awaited nor registered is cancelled when the response completes.
 *  - Node (nitro node-server): `request.waitUntil` exists; an un-awaited promise
 *    simply runs to completion; `cloudflare:workers` cannot be imported.
 *  - `getEvent()` from `nitro/context` returns undefined inside TanStack Start
 *    request middleware, so it is not used.
 */
export type WaitUntil = (promise: Promise<unknown>) => void;

export type Background =
  | { kind: "wait_until"; waitUntil: WaitUntil }
  /** Long-lived process (Node, Bun, Deno): an un-awaited promise completes. */
  | { kind: "detached" }
  /** Edge isolate with no way to outlive the response. */
  | { kind: "none" };

let cfWaitUntilPromise: Promise<WaitUntil | null> | undefined;

/** True on Cloudflare Workers / workerd. */
export function isWorkers(): boolean {
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";
}

function isEdgeIsolate(): boolean {
  return isWorkers() || typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== "undefined";
}

function loadCloudflareWaitUntil(): Promise<WaitUntil | null> {
  cfWaitUntilPromise ??= (async () => {
    try {
      // Computed specifier: bundlers must not try to resolve `cloudflare:workers`
      // (a static import fails the Vite/Rolldown build and breaks Node targets).
      const spec = ["cloudflare", "workers"].join(":");
      const mod = (await import(/* @vite-ignore */ spec)) as { waitUntil?: unknown };
      return typeof mod.waitUntil === "function" ? (mod.waitUntil as WaitUntil) : null;
    } catch {
      return null;
    }
  })();
  return cfWaitUntilPromise;
}

/** Exposed for tests. */
export function resetRuntimeCache(): void {
  cfWaitUntilPromise = undefined;
}

export async function findBackground(request: Request): Promise<Background> {
  const r = request as unknown as { waitUntil?: unknown };
  if (typeof r.waitUntil === "function") {
    return { kind: "wait_until", waitUntil: (p) => (r.waitUntil as WaitUntil).call(request, p) };
  }
  if (isWorkers()) {
    const wu = await loadCloudflareWaitUntil();
    if (wu) return { kind: "wait_until", waitUntil: wu };
  }
  return isEdgeIsolate() ? { kind: "none" } : { kind: "detached" };
}
