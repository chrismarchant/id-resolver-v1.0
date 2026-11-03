import { createStart, createMiddleware } from "@tanstack/react-start";
import { createIdrServerMiddleware } from "../../../src/index";

// Fixed, synthetic test token (public-repo allowlisted pattern). Used by the
// bundle-safety test to prove it never reaches client assets.
const PROBE_TOKEN = "0123456789abcdef0123456789abcdef";

// The real package, registered exactly as documented. Points at the local sink.
const IDR_RESULTS: string[] = ((globalThis as any).__idrResults ??= []);
const idr = createMiddleware().server(
  createIdrServerMiddleware({
    resolverUrl: "http://127.0.0.1:4599",
    allowInsecureHttp: true,
    allowDocumentationRanges: true,
    token: PROBE_TOKEN,
    websiteId: "probe-site",
    trustPolicy: { mode: "cloudflare" },
    onDeliveryResult: (r) => { IDR_RESULTS.push(JSON.stringify(r)); },
    eligibility: { excludePaths: [/^\/(?:m|diag)\//] },
  }),
);

const SINK = "http://127.0.0.1:4599/sink";
const DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function deliver(mode: string, id: string, t0: number): Promise<string> {
  await sleep(DELAY_MS);
  try {
    const r = await fetch(SINK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, id, sentAfterMs: Date.now() - t0 }),
    });
    return `sink:${r.status}`;
  } catch (e) {
    return `err:${(e as Error).name}`;
  }
}

// Mode is chosen by the request path (/m/<mode>/<id>) so each probe is isolated.
const DIAG: Record<string, Record<string, string>> = ((globalThis as any).__idrDiag ??= {});

const probe = createMiddleware().server(async ({ request, next }) => {
  const url = new URL(request.url);
  const d = /^\/diag\/([a-z0-9]+)$/.exec(url.pathname);
  if (d && d[1] === "idr") return new Response(JSON.stringify(IDR_RESULTS), { headers: { "content-type": "application/json" } });
  if (d) return new Response(JSON.stringify(DIAG[d[1]!] ?? {}), { headers: { "content-type": "application/json" } });
  const m = /^\/m\/([a-z-]+)\/([a-z0-9]+)$/.exec(url.pathname);
  if (!m) return next();
  const [, mode, id] = m as unknown as [string, string, string];
  const t0 = Date.now();
  const diag: Record<string, string> = {};
  switch (mode) {
    case "none":
      diag["env"] = `process.env.IDR_ENV_PROBE=${typeof process !== "undefined" ? process.env?.IDR_ENV_PROBE : "no-process"}`;
      diag["ua"] = String((globalThis as any).navigator?.userAgent);
      break;
    case "unawaited":
      void deliver(mode, id, t0);
      break;
    case "awaited":
      diag["result"] = await deliver(mode, id, t0);
      break;
    case "cfworkers": {
      // import { waitUntil } from "cloudflare:workers"
      try {
        const spec = "cloudflare:" + "workers"; // computed: invisible to the bundler
        const { waitUntil: cfWaitUntil } = (await import(/* @vite-ignore */ spec)) as { waitUntil: (p: Promise<unknown>) => void };
        cfWaitUntil(deliver(mode, id, t0));
        diag["waitUntil"] = "cloudflare:workers ok";
      } catch (e) {
        diag["waitUntil"] = `cloudflare:workers threw ${(e as Error).message}`;
      }
      break;
    }
    case "request": {
      // Nitro's cloudflare preset sets req.waitUntil on the incoming Request.
      const r = request as unknown as { waitUntil?: (p: Promise<unknown>) => void; runtime?: { cloudflare?: { context?: { waitUntil?: (p: Promise<unknown>) => void } } } };
      diag["request"] = `waitUntil=${typeof r.waitUntil} runtime.cf.ctx.waitUntil=${typeof r.runtime?.cloudflare?.context?.waitUntil}`;
      r.waitUntil?.(deliver(mode, id, t0));
      break;
    }
    case "event": {
      // Nitro event context
      try {
        const { getEvent } = (await import("nitro/context")) as any;
        const ev = getEvent?.();
        const ctx = ev?.req?.runtime?.cloudflare?.context ?? ev?.context?.cloudflare?.context;
        const wu = ev?.waitUntil ?? ctx?.waitUntil;
        diag["event"] = `ev=${!!ev} keys=${ev ? Object.keys(ev).join("|") : ""} wu=${typeof wu}`;
        if (typeof wu === "function") (ev?.waitUntil ? ev.waitUntil(deliver(mode, id, t0)) : ctx.waitUntil(deliver(mode, id, t0)));
      } catch (e) {
        diag["event"] = `threw ${(e as Error).message}`;
      }
      break;
    }
  }
  const result = await next();
  DIAG[id] = { ...diag, nextResultType: typeof result, nextResultKeys: result && typeof result === "object" ? Object.keys(result).join("|") : "", responseIsResponse: String((result as any)?.response instanceof Response) };
  return result; // returned unmodified
});

export const startInstance = createStart(() => ({ requestMiddleware: [probe, idr] }));
