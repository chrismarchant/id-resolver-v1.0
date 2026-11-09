export const FEED_PATH = "/v1/reporting/observations";
export const FEED_CONTRACT = "reporting-feed.v1";

const ACQUISITION = new Set(["direct", "search", "social", "email", "paid", "referral", "internal", "unknown"]);
const METHODS = new Set(["cache", "provider"]);
const CURSOR_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DECIMAL_ID_RE = /^[1-9][0-9]{0,19}$/;

export class FeedError extends Error {
  name = "FeedError";
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class FeedExpiredError extends FeedError {
  name = "FeedExpiredError";
  constructor() {
    super("reporting feed cursor expired (410)", 410);
  }
}

export async function readFeed(cfg, { fetch = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  try {
    return await walk(cfg, fetch, timeoutMs);
  } catch (e) {
    if (e instanceof FeedExpiredError) return walk(cfg, fetch, timeoutMs);
    throw e;
  }
}

async function walk(cfg, fetchImpl, timeoutMs) {
  const items = [];
  let after;
  for (let page = 0; page < cfg.maxPages; page += 1) {
    const url = new URL(`${cfg.reportingUrl}${FEED_PATH}`);
    url.searchParams.set("limit", String(cfg.pageSize));
    if (after !== undefined) url.searchParams.set("after", after);

    let res;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new FeedError(`reporting feed request failed: ${e?.name ?? "error"}`);
    }
    if (res.status === 410) throw new FeedExpiredError();
    if (!res.ok) throw new FeedError(`reporting feed answered HTTP ${res.status}`, res.status);

    let body;
    try {
      body = await res.json();
    } catch {
      throw new FeedError("reporting feed returned invalid JSON");
    }
    const parsed = parsePage(body, cfg.websiteId);
    items.push(...parsed.items);
    if (!parsed.hasMore) return items;
    if (parsed.nextCursor === after) throw new FeedError("reporting feed did not advance");
    after = parsed.nextCursor;
  }
  throw new FeedError(`reporting feed has more than ${cfg.maxPages} pages; raise IDR_MAX_PAGES`);
}

export function parsePage(body, websiteId) {
  if (!isObject(body)) throw new FeedError("feed page is not an object");
  if (body.contract !== FEED_CONTRACT) throw new FeedError("feed page has an unexpected contract");
  if (!isObject(body.scope) || body.scope.website_id !== websiteId) {
    throw new FeedError("feed page is for a different website");
  }
  if (!Array.isArray(body.items)) throw new FeedError("feed page has no items array");
  if (typeof body.has_more !== "boolean") throw new FeedError("feed page has no has_more flag");
  if (typeof body.next_cursor !== "string" || !CURSOR_RE.test(body.next_cursor)) {
    throw new FeedError("feed page has an invalid next_cursor");
  }
  return { items: body.items.map(parseItem), hasMore: body.has_more, nextCursor: body.next_cursor };
}

function parseItem(item, index) {
  if (!isObject(item)) throw new FeedError(`feed item ${index} is not an object`);
  if (item.type === "observation") {
    const ok =
      typeof item.observation_id === "string" &&
      DECIMAL_ID_RE.test(item.observation_id) &&
      isCompanyId(item.company_id) &&
      typeof item.domain === "string" &&
      item.domain.length > 0 &&
      item.domain.length <= 253 &&
      isNullableString(item.organisation_name, 4096) &&
      isTimestamp(item.observed_at) &&
      METHODS.has(item.method) &&
      isNullableString(item.page_key, 1024) &&
      (item.acquisition === null || ACQUISITION.has(item.acquisition)) &&
      isNullableString(item.entrance_contract, 64);
    if (!ok) throw new FeedError(`feed item ${index} is not a valid observation`);
    return {
      type: "observation",
      observation_id: item.observation_id,
      company_id: item.company_id,
      domain: item.domain,
      organisation_name: item.organisation_name,
      observed_at: item.observed_at,
      method: item.method,
      page_key: item.page_key,
      acquisition: item.acquisition,
      entrance_contract: item.entrance_contract,
    };
  }
  if (item.type === "company_erased") {
    if (!isCompanyId(item.company_id)) throw new FeedError(`feed item ${index} is not a valid erasure`);
    return { type: "company_erased", company_id: item.company_id };
  }
  throw new FeedError(`feed item ${index} has an unknown type`);
}

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCompanyId(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function isNullableString(v, max) {
  return v === null || (typeof v === "string" && v.length <= max);
}

function isTimestamp(v) {
  return typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
}
