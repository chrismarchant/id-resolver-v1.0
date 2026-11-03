import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * The compiled child entry (dist/child/main.js), built by test/helpers/global-setup.ts.
 * Tests that fork real children pass it as `childModulePath` so each fork
 * starts the production artefact (heap cap only, no TypeScript loader).
 */
export function compiledChildModulePath(): string {
  const p = resolve(ROOT, "dist", "child", "main.js");
  if (!existsSync(p)) throw new Error("dist/child/main.js is missing: the vitest global setup builds it (see test/helpers/global-setup.ts)");
  return p;
}
