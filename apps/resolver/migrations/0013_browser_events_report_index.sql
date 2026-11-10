-- 0013: index for reading browser events by time (GET /v1/reporting/events,
-- read by the BigQuery sync once a day). Forward-only and additive: no table,
-- column, constraint, trigger or row changes. browser_events stays outside the
-- observation feed and is still never joined to company data (owner decision D4).
CREATE INDEX IF NOT EXISTS browser_events_report_idx
  ON browser_events (installation_id, website_id, occurred_at, id);
