import type { FeedItem, FeedPage } from "./types.ts";

const DEC_ID = /^[0-9]{1,19}$/;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
function optStr(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === "string" && v.length <= max ? v : undefined;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function validTimestamp(v: string): boolean {
  return !Number.isNaN(Date.parse(v));
}

/**
 * Validates one feed page against reporting-feed.v1 and projects it onto the
 * whitelisted fields. Unknown item types are dropped (forward compatibility);
 * unknown fields are never forwarded to the store.
 * Returns null when the page violates the contract.
 */
export function parseFeedPage(body: unknown, installationId: string): FeedPage | null {
  if (!isRecord(body)) return null;
  if (body["version"] !== "1" || body["contract"] !== "reporting-feed.v1") return null;
  const scope = body["scope"];
  if (!isRecord(scope) || scope["installation_id"] !== installationId) return null;
  const nextCursor = str(body["next_cursor"], 4096);
  if (nextCursor === null || typeof body["has_more"] !== "boolean") return null;
  const raw = body["items"];
  if (!Array.isArray(raw)) return null;

  const items: FeedItem[] = [];
  for (const it of raw) {
    if (!isRecord(it)) return null;
    if (it["type"] === "observation") {
      const id = it["observation_id"];
      const company = it["company_id"];
      const domain = str(it["domain"], 253);
      const observedAt = str(it["observed_at"], 64);
      const method = str(it["method"], 32);
      const orgName = optStr(it["organisation_name"], 512);
      const pageKey = optStr(it["page_key"], 256);
      const acquisition = optStr(it["acquisition"], 32);
      const ec = optStr(it["entrance_contract"], 40);
      if (
        typeof id !== "string" || !DEC_ID.test(id) ||
        typeof company !== "number" || !Number.isSafeInteger(company) ||
        domain === null || observedAt === null || !validTimestamp(observedAt) || method === null ||
        orgName === undefined || pageKey === undefined || acquisition === undefined || ec === undefined
      ) return null;
      items.push({
        type: "observation",
        observation_id: id,
        company_id: company,
        domain,
        organisation_name: orgName,
        observed_at: observedAt,
        method,
        page_key: pageKey,
        acquisition,
        entrance_contract: ec,
      });
    } else if (it["type"] === "company_erased") {
      const id = it["tombstone_id"];
      const company = it["company_id"];
      const erasedAt = str(it["erased_at"], 64);
      if (
        typeof id !== "string" || !DEC_ID.test(id) ||
        typeof company !== "number" || !Number.isSafeInteger(company) ||
        erasedAt === null || !validTimestamp(erasedAt)
      ) return null;
      items.push({ type: "company_erased", tombstone_id: id, company_id: company, erased_at: erasedAt });
    }
    // Unknown item types are ignored on purpose.
  }
  return { items, nextCursor, hasMore: body["has_more"] };
}

export interface SummaryCounts {
  observations: number;
  observedCompanies: number;
}

export function parseSummary(body: unknown, installationId: string): SummaryCounts | null {
  if (!isRecord(body) || body["version"] !== "1") return null;
  const scope = body["scope"];
  if (!isRecord(scope) || scope["installation_id"] !== installationId) return null;
  const o = body["observations"];
  const c = body["observed_companies"];
  if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0) return null;
  if (typeof c !== "number" || !Number.isSafeInteger(c) || c < 0) return null;
  return { observations: o, observedCompanies: c };
}
