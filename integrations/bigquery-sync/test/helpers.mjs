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
