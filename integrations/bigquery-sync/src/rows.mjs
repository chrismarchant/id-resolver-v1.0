export function toRows(items, syncedAt) {
  const erased = new Set();
  for (const item of items) if (item.type === "company_erased") erased.add(item.company_id);

  const rows = new Map();
  for (const item of items) {
    if (item.type !== "observation" || erased.has(item.company_id)) continue;
    rows.set(item.observation_id, {
      observation_id: item.observation_id,
      company_id: item.company_id,
      domain: item.domain,
      organisation_name: item.organisation_name,
      observed_at: item.observed_at,
      method: item.method,
      page_key: item.page_key,
      acquisition: item.acquisition,
      entrance_contract: item.entrance_contract,
      synced_at: syncedAt,
    });
  }
  return { rows: [...rows.values()], erasedCompanies: erased.size };
}
