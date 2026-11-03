import type { CompanyRepository } from "../contracts/db.js";
import type { Logger } from "../log/index.js";
import { guarded, type Pool } from "./pool.js";

/** Upsert by canonical domain. The id is stable; the name is never overwritten with null. */
export const UPSERT_COMPANY_SQL = `
INSERT INTO companies (domain, organisation_name, first_seen_at, last_seen_at)
VALUES ($1::text, $2::text, $3::timestamptz, $3::timestamptz)
ON CONFLICT (domain) DO UPDATE SET
  organisation_name = COALESCE(EXCLUDED.organisation_name, companies.organisation_name),
  last_seen_at = GREATEST(companies.last_seen_at, EXCLUDED.last_seen_at)
RETURNING id`;

export function createCompanyRepository(pool: Pool, logger?: Logger): CompanyRepository {
  return {
    async upsert(company, now) {
      return guarded(logger, async () => {
        const res = await pool.query<{ id: string }>(UPSERT_COMPANY_SQL, [company.domain, company.organisationName, now]);
        return Number((res.rows[0] as { id: string }).id);
      });
    },
  };
}
