// Edits the config.toml written by `supabase init` for the local e2e project:
//  - project_id;
//  - disables the services the harness does not use (their images are not
//    pulled: realtime, studio, storage, local SMTP, analytics);
//  - [auth]: jwt_secret read from the environment (generated per work dir,
//    never committed), public sign-up off (SETUP.md "Who may read");
//  - appends the reference adapter's own supabase/config.toml
//    ([functions.idr-sync] verify_jwt = false), the merge SETUP.md step 3 asks for.
// Usage: node configure-project.mjs <project config.toml> <adapter supabase/config.toml> <project_id>
import { readFileSync, writeFileSync } from "node:fs";

const [target, adapterConfig, projectId] = process.argv.slice(2);
if (!target || !adapterConfig || !projectId) throw new Error("usage: configure-project.mjs <config.toml> <adapter config.toml> <project_id>");

const MARKER = "# idr-e2e: configured";
let text = readFileSync(target, "utf8");
if (text.includes(MARKER)) process.exit(0);

const DISABLE = new Set(["realtime", "studio", "local_smtp", "storage", "storage.s3_protocol", "storage.vector", "analytics"]);
const out = [];
let section = "";
let sawSignup = false;
for (const line of text.split("\n")) {
  const header = /^\[([^\]]+)\]\s*$/.exec(line);
  if (header) {
    section = header[1];
    out.push(line);
    if (section === "auth") out.push('jwt_secret = "env(IDR_E2E_JWT_SECRET)"');
    continue;
  }
  if (section === "" && /^project_id\s*=/.test(line)) {
    out.push(`project_id = "${projectId}"`);
    continue;
  }
  if (DISABLE.has(section) && /^enabled\s*=/.test(line)) {
    out.push("enabled = false");
    continue;
  }
  if (section === "auth" && /^enable_signup\s*=/.test(line)) {
    out.push("enable_signup = false");
    sawSignup = true;
    continue;
  }
  out.push(line);
}
if (!sawSignup) throw new Error("configure-project: [auth] enable_signup not found (CLI config format changed?)");
text = out.join("\n");
text += `\n${MARKER}\n# --- merged from integrations/supabase-edge/supabase/config.toml ---\n${readFileSync(adapterConfig, "utf8")}`;
writeFileSync(target, text);
