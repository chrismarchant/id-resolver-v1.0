-- 0010: a per-period budget for provider calls that may be charged
-- (PERIOD_RESOLVED_CAP). Forward-only and additive: one column on
-- usage_periods, nothing else changes.
--
-- Enrich charges for a lookup that returns a domain and not for one that
-- returns none. Whether a call will be charged is unknown until it answers,
-- so every call reserves one slot here, atomically with provider_attempts,
-- and the slot is given back only when the answer proves the call was not
-- charged (no domain, or a definite error status). Concurrent callers can
-- therefore never hold more slots than the cap, and a crash between the
-- reservation and the give-back leaves the slot counted (it never undercounts).
--
-- The runtime role already holds table-level SELECT, INSERT and UPDATE on
-- usage_periods (src/db/runtime-role.ts), which covers the new column.
ALTER TABLE usage_periods
  ADD COLUMN IF NOT EXISTS provider_charge_slots bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'usage_periods'::regclass AND conname = 'usage_periods_provider_charge_slots_check'
  ) THEN
    ALTER TABLE usage_periods
      ADD CONSTRAINT usage_periods_provider_charge_slots_check CHECK (provider_charge_slots >= 0);
  END IF;
END
$$;
