// Writes dist/idr-collector.min.js (self-hostable ESM) and prints its gzip size.
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { bundleCollector, GZIP_BUDGET_BYTES } from "./bundle.mjs";

const code = await bundleCollector();
const gz = gzipSync(code, { level: 9 }).length;
mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("../dist/idr-collector.min.js", import.meta.url), code);
console.log(`idr-collector.min.js: ${code.length} bytes, ${gz} bytes gzip (budget ${GZIP_BUDGET_BYTES})`);
if (gz > GZIP_BUDGET_BYTES) {
  console.error("over the gzip budget");
  process.exit(1);
}
