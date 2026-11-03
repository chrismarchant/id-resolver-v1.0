import type { SyncConfig } from "./types.ts";

export interface EdgeConfig {
  sync: SyncConfig;
  syncSecret: string;
  supabaseUrl: string;
  serviceRoleKey: string;
}

export type ConfigResult = { ok: true; config: EdgeConfig } | { ok: false; problems: string[] };

type Env = Record<string, string | undefined>;

function intIn(env: Env, name: string, def: number, min: number, max: number, problems: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    problems.push(`${name} must be an integer in [${min}, ${max}]`);
    return def;
  }
  return Number(raw);
}

function checkUrl(name: string, raw: string | undefined, allowInsecure: boolean, problems: string[]): string {
  if (!raw) {
    problems.push(`${name} is required`);
    return "";
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    problems.push(`${name} is not a valid URL`);
    return "";
  }
  if (u.protocol !== "https:" && !(allowInsecure && u.protocol === "http:")) {
    problems.push(`${name} must use https`);
  }
  if (u.username || u.password || u.search || u.hash) problems.push(`${name} must not contain credentials, query or fragment`);
  return raw.replace(/\/+$/, "");
}

/** Validates environment configuration. Problems name variables, never values. */
export function loadConfig(env: Env): ConfigResult {
  const problems: string[] = [];
  const allowInsecure = env["IDR_ALLOW_INSECURE_HTTP"] === "true";
  const baseUrl = checkUrl("IDR_BASE_URL", env["IDR_BASE_URL"], allowInsecure, problems);
  const supabaseUrl = checkUrl("SUPABASE_URL", env["SUPABASE_URL"], allowInsecure, problems);

  const need = (name: string, minLen: number): string => {
    const v = env[name];
    if (!v || v.length < minLen) {
      problems.push(`${name} is required (min length ${minLen})`);
      return "";
    }
    return v;
  };
  const token = need("IDR_REPORTING_TOKEN", 16);
  const syncSecret = need("IDR_SYNC_SECRET", 32);
  const serviceRoleKey = need("SUPABASE_SERVICE_ROLE_KEY", 16);
  const installationId = need("IDR_INSTALLATION_ID", 1);
  if (installationId.length > 128) problems.push("IDR_INSTALLATION_ID is too long");

  const sync: SyncConfig = {
    baseUrl,
    token,
    installationId,
    pageLimit: intIn(env, "IDR_PAGE_LIMIT", 200, 1, 500, problems),
    maxPages: intIn(env, "IDR_MAX_PAGES", 50, 1, 1000, problems),
    budgetMs: intIn(env, "IDR_BUDGET_MS", 50_000, 1000, 140_000, problems),
    requestTimeoutMs: intIn(env, "IDR_REQUEST_TIMEOUT_MS", 15_000, 500, 60_000, problems),
    maxRetries: intIn(env, "IDR_MAX_RETRIES", 5, 0, 10, problems),
    baseDelayMs: intIn(env, "IDR_BACKOFF_BASE_MS", 500, 10, 10_000, problems),
    maxDelayMs: intIn(env, "IDR_BACKOFF_MAX_MS", 8000, 10, 60_000, problems),
    reconcileDays: intIn(env, "IDR_RECONCILE_DAYS", 0, 0, 31, problems),
  };
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { sync, syncSecret, supabaseUrl, serviceRoleKey } };
}
