// The one definition of the shipped browser build. Used by `npm run build`
// (scripts/build-min.mjs) and by the size and CSP tests, so the tests measure
// exactly what is shipped.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
/** gzip budget for the minified ESM build, in bytes (3 KB). */
export const GZIP_BUDGET_BYTES = 3 * 1024;

/** Minified single-file ESM build of the collector, returned as a string (nothing is written). */
export async function bundleCollector() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    legalComments: "none",
    charset: "utf8",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}
