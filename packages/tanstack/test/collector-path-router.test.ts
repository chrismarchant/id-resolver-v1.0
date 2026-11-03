import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as collectorPath from "../src/collector-path.js";
import { isEligible } from "../src/index.js";

// Differential test (G5R2-L1): the entrance middleware's collector-path exclusion against the real TanStack router
// code that decides which route a request reaches. It loads router-core from the probe app's own lockfile install
// (packages/tanstack/verification/cf-lifecycle: router-core 1.171.34, start-server-core 1.169.39) and replays
// start-server-core's dispatch:
//   createStartHandler.js:281  getNormalizedURL(request.url)   (308 redirect at :284 for a leading "//")
//   createStartHandler.js:479  executeRewriteInput(router.rewrite, url).pathname
//   createStartHandler.js:480  router.getMatchedRoutes(pathname)
// Requirement: no spelling the router dispatches to the collector route is left eligible. Same gating as the probe
// tests: skipped (reported as skipped) without the probe install, mandatory with IDR_REQUIRE_PROBE=1.

const coreDir = join(resolve(import.meta.dirname, ".."), "verification", "cf-lifecycle", "node_modules", "@tanstack", "router-core", "dist", "esm");
const haveRouter = existsSync(join(coreDir, "index.js"));
const requireProbe = process.env["IDR_REQUIRE_PROBE"] === "1";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Router = any;

/** The hand-written spellings, around the collector path and next to it. */
const HAND = [
  "/idr/e", "/IDR/E", "/Idr/E", "/idr/e/", "/idr/e//", "//idr/e", "///idr/e", "/idr//e", "/idr/%65", "/%69dr/e", "/%69%64%72/%65",
  "/%49DR/%45", "/idr%2Fe", "/idr%2fe", "/idr/e%2F", "/idr/./e", "/idr/x/../e", "/x/../idr/e", "/idr/%2e/e", "/idr/e/.", "/idr\\e",
  "/idr/e%20", "/idr/e%20%20", "/IDR/E%20", "/idr/%65%20", "/idr/e/%20", "/idr/e%20/", "/idr/e%20/%20", "/idr/e%20?x=1", "/idr/e?%20",
  "/idr/e%09", "/idr/e%0A", "/idr/e%0D", "/idr/e%00", "/idr/e%0B", "/idr/e%0C", "/idr/e%1F", "/idr/e%7F", "/idr/e%C2%A0", "/idr/e%E2%80%8B",
  "/idr/e%EF%BB%BF", "/idr/e.", "/idr/e;x", "/idr/e%3B", "/idr/%C5%BF", "/idr/%EF%BD%85", "/idr/e%C0", "/idr/%E0%A4%A", "/idr/%%65",
  "/idr/%2565", "/idr/e%25", "/idr/e%5C", "/idr/e+", "/idr/e%2B", "/idr/e~", "/idr/e?x=1", "/idr/e#f", "/idr/e/x", "/idr/ex", "/idr",
  "/idr/", "/pricing", "/%20idr/e", "/idr%20/e", "/idr/%20e", "/idr/e%20x", "/idr/e%09%20", "/idr/e%20%09", "/IDR/%45%20%20/",
  // A stray "%" plus a decoded "2" and "e" form "%2e", which the router's second URL parse treats as a dot segment.
  "/x/%2%65%2%65/idr/e", "/x/%2%45%2%45/idr/e", "/%C3%A9/%2%65%2%65/idr/e", "/%C0/%%32%65%%32%65/idr/e", "/idr/%2%65/e", "/idr/e/%2%65",
  "/idr/e/%2%65%2%65/idr/e", "/idr/x/%2%65%2%65/e%20", "/idr/e%ED%A0%80", "/idr/e%F0%9F%98%80", "/idr/e%F4%90%80%80", "/idr/e%80", "/idr/e%C0%AE",
];

const TOKENS = [
  "idr", "e", "IDR", "E", "%65", "%45", "%69", "%64", "%72", "/", "//", "%2F", "%20", "%09", "%2e", ".", "..", "%00", "%5C", "%25", ";",
  "%3B", "%C2%A0", "%E2%80%8B", "%EF%BB%BF", "%0A", "%0D", "%0B", "%0C", "%1F", "%7F", "+", "%2B", "~", "%7E", "-", "_", " ", "\t",
  "%E2%84%AA", "%C5%BF", "%EF%BD%85", "%C0%AE", "%", "%2", "?", "#", "\\", "%20%20", "/%20", "%2%65", "%2%45", "%%32%65",
  "/%2%65%2%65/", "%ED%A0%80", "%F0%9F%98%80", "%80", "%C3%A9", "/x/",
];

/** Deterministic PRNG (mulberry32), so a failure is reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/** Random mutations built around the real path (1 to 3 inserts or replacements), as in the review's fuzz. */
function mutations(count: number, seed: number): string[] {
  const rnd = prng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const parts = ["/", "idr", "/", "e"];
    const k = 1 + rnd(3);
    for (let j = 0; j < k; j++) {
      if (rnd(2)) parts.splice(rnd(parts.length + 1), 0, TOKENS[rnd(TOKENS.length)]!);
      else parts.splice(rnd(parts.length), 1, TOKENS[rnd(TOKENS.length)]!);
    }
    const p = parts.join("");
    out.push(p.startsWith("/") ? p : `/${p}`);
  }
  return out;
}

/** Every combination of the spellings of each part and of the suffixes. */
function grid(): string[] {
  const out: string[] = [];
  for (const a of ["idr", "IDR", "%69dr", "%69%64%72", "Idr"])
    for (const sep of ["/", "//", "%2F", "/./"])
      for (const b of ["e", "E", "%65", "%45"])
        for (const tail of ["", "/", "//", "%20", "%20%20", "/%20", "%20/", "%09", "%00", "%0A", "%C2%A0", ".", "%2e", ";", "%2F", "?q=1", "%20?q=1", "%20%09"]) out.push(`/${a}${sep}${b}${tail}`);
  return out;
}

const NAV = { accept: "text/html", "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

describe.skipIf(!haveRouter && !requireProbe)("collector path vs the real TanStack router dispatch (differential, G5R2-L1)", () => {
  async function load() {
    const core: any = await import(join(coreDir, "index.js"));
    const ssr: any = await import(join(coreDir, "ssr", "server.js"));
    const make = (opts: Record<string, unknown> = {}): Router => {
      const root = new core.BaseRootRoute({});
      const idr = new core.BaseRoute({ getParentRoute: () => root, path: "/idr/e" });
      const page = new core.BaseRoute({ getParentRoute: () => root, path: "/pricing" });
      return new core.RouterCore({ routeTree: root.addChildren([idr, page]), isServer: true, ...opts });
    };
    /** What start-server-core does with a request URL before it picks a route (createStartHandler.js:281-284, 479-480). */
    const dispatch = (router: Router, href: string): "collector" | "redirect" | "other" => {
      let n: { url: URL; handledProtocolRelativeURL: boolean };
      try {
        n = ssr.getNormalizedURL(href);
      } catch {
        return "other";
      }
      if (n.handledProtocolRelativeURL) return "redirect";
      const pathname = core.executeRewriteInput(router.rewrite, n.url).pathname as string;
      const [, rawParams, found] = router.getMatchedRoutes(pathname);
      return found?.fullPath === "/idr/e" && rawParams["**"] === undefined ? "collector" : "other";
    };
    return { core, ssr, make, dispatch };
  }

  function run(dispatch: (href: string) => string, spellings: string[]) {
    const key = collectorPath.resolveCollectorPath("/idr/e");
    let dispatched = 0;
    let parsed = 0;
    let overExcluded = 0;
    const bypass = new Set<string>();
    for (const s of spellings) {
      const href = `https://www.example.com${s}`;
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        continue;
      }
      parsed++;
      const d = dispatch(url.href) === "collector";
      const viaHelper = collectorPath.isCollectorPath(url.pathname, key);
      const viaEligibility = (() => {
        const r = isEligible(new Request(url.href, { headers: NAV }));
        return !r.eligible && r.reason === "collector_path";
      })();
      if (d) dispatched++;
      if (d && !(viaHelper && viaEligibility)) bypass.add(url.pathname);
      if (!d && viaHelper) overExcluded++;
    }
    return { parsed, dispatched, overExcluded, bypass: [...bypass] };
  }

  it("no spelling the router dispatches to /idr/e stays eligible: hand-written, grid and 50,000 random mutations", async () => {
    const { make, dispatch } = await load();
    const router = make();
    const spellings = [...HAND, ...grid(), ...mutations(50_000, 20261103)];
    const r = run((href) => dispatch(router, href), spellings);
    // Printed for the record (counts only).
    console.log(`collector-path differential (caseSensitive false): ${JSON.stringify({ ...r, bypass: r.bypass.length })}`);
    expect(r.bypass).toEqual([]);
    // The test is only meaningful if many spellings really reach the route, the trailing-space family included.
    expect(r.dispatched).toBeGreaterThan(1_000);
    for (const s of ["/idr/e%20", "/IDR/E%20%20", "/idr/%65%20"]) expect(dispatch(router, `https://www.example.com${s}`)).toBe("collector");
  });

  it("the same with a case-sensitive router (the exclusion is case-insensitive, a superset)", async () => {
    const { make, dispatch } = await load();
    const router = make({ caseSensitive: true });
    const r = run((href) => dispatch(router, href), [...HAND, ...grid(), ...mutations(10_000, 7)]);
    expect(r.bypass).toEqual([]);
    expect(r.dispatched).toBeGreaterThan(100);
  });

  it("routerPathname reproduces the router's own normalisation exactly (getNormalizedURL, then trimPathRight)", async () => {
    const { core, ssr } = await load();
    const routerPathname = (collectorPath as { routerPathname?: (p: string) => string | null }).routerPathname;
    expect(typeof routerPathname).toBe("function");
    const mismatches: string[] = [];
    let compared = 0;
    for (const s of [...HAND, ...grid(), ...mutations(20_000, 99)]) {
      let url: URL;
      try {
        url = new URL(`https://www.example.com${s}`);
      } catch {
        continue;
      }
      // Only where the router itself dispatches on the path alone: no leading "//" (a 308 redirect), no query or
      // fragment (with one, the router keeps trailing spaces; the exclusion deliberately strips them anyway).
      if (url.pathname.startsWith("//") || url.search !== "" || url.hash !== "") continue;
      const theirs = core.trimPathRight(ssr.getNormalizedURL(url.href).url.pathname as string) as string;
      const ours = routerPathname!(url.pathname);
      compared++;
      if (ours !== theirs) mismatches.push(`${url.pathname} -> router ${theirs}, ours ${String(ours)}`);
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(compared).toBeGreaterThan(10_000);
  });
});
