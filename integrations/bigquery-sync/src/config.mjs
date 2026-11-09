export class ConfigError extends Error {
  name = "ConfigError";
}

const REQUIRED = [
  "IDR_REPORTING_URL",
  "IDR_REPORTING_TOKEN",
  "IDR_WEBSITE_ID",
  "BQ_PROJECT",
  "BQ_DATASET",
  "BQ_TABLE",
  "BQ_LOCATION",
];

const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const BQ_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const LOCATION_RE = /^[A-Za-z0-9-]{2,40}$/;
const WEBSITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const PAGE_SIZE = 500;
export const DEFAULT_MAX_PAGES = 200;

export function readConfig(env) {
  const missing = REQUIRED.filter((k) => typeof env[k] !== "string" || env[k].trim() === "");
  if (missing.length > 0) throw new ConfigError(`missing configuration: ${missing.join(", ")}`);

  let url;
  try {
    url = new URL(env.IDR_REPORTING_URL.trim());
  } catch {
    throw new ConfigError("IDR_REPORTING_URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new ConfigError("IDR_REPORTING_URL must use https");
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("IDR_REPORTING_URL must not contain credentials, a query string or a fragment");
  }

  const token = env.IDR_REPORTING_TOKEN.trim();
  if (token.length < 32) throw new ConfigError("IDR_REPORTING_TOKEN is too short");

  const websiteId = env.IDR_WEBSITE_ID.trim();
  if (!WEBSITE_ID_RE.test(websiteId)) throw new ConfigError("IDR_WEBSITE_ID is not valid");

  const project = env.BQ_PROJECT.trim();
  const dataset = env.BQ_DATASET.trim();
  const table = env.BQ_TABLE.trim();
  const location = env.BQ_LOCATION.trim();
  if (!PROJECT_RE.test(project)) throw new ConfigError("BQ_PROJECT is not a valid project id");
  if (!BQ_NAME_RE.test(dataset)) throw new ConfigError("BQ_DATASET is not a valid dataset id");
  if (!BQ_NAME_RE.test(table)) throw new ConfigError("BQ_TABLE is not a valid table id");
  if (!LOCATION_RE.test(location)) throw new ConfigError("BQ_LOCATION is not valid");

  let maxPages = DEFAULT_MAX_PAGES;
  if (env.IDR_MAX_PAGES !== undefined && env.IDR_MAX_PAGES !== "") {
    maxPages = Number(env.IDR_MAX_PAGES);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 2000) {
      throw new ConfigError("IDR_MAX_PAGES must be a whole number from 1 to 2000");
    }
  }

  return {
    reportingUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    token,
    websiteId,
    project,
    dataset,
    table,
    location,
    pageSize: PAGE_SIZE,
    maxPages,
  };
}
