-- 0009: support for the least-privilege runtime role (Gate 5). Forward-only:
-- 0001-0008 are unchanged, no table, column, index or row changes. The role
-- itself and its grants are not created here: the role name is
-- configurable and its password is a deployment secret, so the migrate step
-- (src/db/runtime-role.ts) provisions them after the migrations, as the
-- owner, every time it runs.
--
-- The 0006 watermark trigger function now runs with the privileges of its
-- owner (the migration owner) instead of the deleting role. Every DELETE of
-- company_observations still advances the scope's retention watermark in the
-- same statement, whoever deletes; but the runtime role needs no INSERT or
-- UPDATE privilege on feed_retention_watermarks at all, so a leaked runtime
-- credential cannot write the watermark directly (backward moves 0007
-- rejects anyway). It can still advance it by deleting recent observations,
-- since retention needs DELETE on company_observations; consumers behind it
-- then get 410 cursor_expired (visible, never silent; G5R2-L4, RUNTIME.md).
-- Behaviour for the owner is unchanged; a rollback to a build without role
-- separation keeps working (it connects as the owner).
--
-- search_path is pinned for the SECURITY DEFINER function: pg_catalog is
-- searched first implicitly, then public, and pg_temp last, so a caller's
-- temporary objects can never shadow the tables it writes. The transition
-- table (feed_deleted_observations) is an ephemeral named relation of the
-- trigger and is resolved before any schema. EXECUTE is revoked from PUBLIC:
-- a trigger function cannot be called directly, and firing a trigger does not
-- check EXECUTE.
ALTER FUNCTION feed_record_observation_deletes() SECURITY DEFINER;
ALTER FUNCTION feed_record_observation_deletes() SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION feed_record_observation_deletes() FROM PUBLIC;
