export const TOKEN = "t".repeat(40);

export const ENV = {
  IDR_REPORTING_URL: "https://resolver.example.test",
  IDR_REPORTING_TOKEN: TOKEN,
  IDR_WEBSITE_ID: "example-website",
  BQ_PROJECT: "example-project",
  BQ_DATASET: "idr",
  BQ_TABLE: "company_visits",
  BQ_LOCATION: "EU",
};

export function observation(id, companyId, extra = {}) {
  return {
    type: "observation",
    observation_id: String(id),
    company_id: companyId,
    domain: `company${companyId}.example`,
    organisation_name: `Company ${companyId}`,
    observed_at: "2026-11-05T09:00:00.000Z",
    method: "provider",
    page_key: "/",
    acquisition: "direct",
    entrance_contract: "entrance.v1",
    ...extra,
  };
}

export function page(items, { hasMore = false, next = "c0", websiteId = "example-website" } = {}) {
  return {
    version: "1",
    contract: "reporting-feed.v1",
    scope: { installation_id: "example-installation", website_id: websiteId },
    items,
    next_cursor: next,
    has_more: hasMore,
  };
}

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function recordingFetch(handler) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return handler(call, calls.length);
  };
  fn.calls = calls;
  return fn;
}

export function activityItem(periodKey, extra = {}) {
  return {
    period_key: periodKey,
    visits_submitted: 81,
    outcomes: { qualified: 3, no_match: 15, excluded: 0, unknown: 0, pending: 3, ineligible: 0, disabled: 60, uncertain: 0, unavailable: 0 },
    cache_hits: 4,
    provider_lookups: 14,
    domains_found: 2,
    charged_lookups: 2,
    company_visits: 3,
    company_first_visits: 2,
    ...extra,
  };
}

export function activityBody(items, { period = "day", websiteId = "example-website" } = {}) {
  return {
    version: "1",
    scope: { installation_id: "example-installation", website_id: websiteId },
    period,
    from: "2025-11-06",
    to: "2026-11-06",
    items,
  };
}
