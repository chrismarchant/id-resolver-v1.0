/**
 * vitest global setup: compile the project once so that end-to-end tests can
 * fork the compiled child (dist/child/main.js), the artefact the container
 * runs, instead of the TypeScript source through the tsx loader.
 *
 * Why: the loader costs roughly 0.45 s of CPU per forked child. Several
 * children forked at once on a small runner (GitHub-hosted, 2 vCPUs) then
 * spend the whole 2 s test request deadline starting up and answer
 * `unavailable`, which fails the concurrency cases without exercising any
 * resolver logic. The compiled child starts in about 0.2 s. Measurements are
 * recorded in the V0.1 verification notes (see docs/PROVENANCE.md).
 *
 * The build is the same `tsc -p tsconfig.json` the Dockerfile runs; it only
 * writes dist/, which is git-ignored. Set ID_RESOLVER_SKIP_TEST_BUILD=1 to
 * reuse an existing dist/ (local iteration only).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

export default function setup(): void {
  if (process.env["ID_RESOLVER_SKIP_TEST_BUILD"] === "1" && existsSync(resolve(ROOT, "dist", "child", "main.js"))) return;
  // Resolved through Node module resolution so npm workspace hoisting works.
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", resolve(ROOT, "tsconfig.json")], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`test build failed (tsc exit ${String(r.status)})`);
  if (!existsSync(resolve(ROOT, "dist", "child", "main.js"))) throw new Error("test build produced no dist/child/main.js");
}
