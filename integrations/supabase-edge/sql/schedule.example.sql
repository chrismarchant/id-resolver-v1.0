-- schedule.example.sql
-- EXAMPLE ONLY. Calls the idr-sync Edge Function on a schedule using pg_cron +
-- pg_net. The function URL and the shared secret are read from Supabase Vault
-- at run time; nothing client-specific is stored in this file.
--
-- 1. Enable the extensions (Dashboard > Database > Extensions): pg_cron, pg_net, supabase_vault.
-- 2. Store the two values in Vault (replace the placeholders; run once):
--      select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/idr-sync', 'idr_sync_url');
--      select vault.create_secret('<same value as the IDR_SYNC_SECRET function secret>', 'idr_sync_secret');
-- 3. Schedule (every 5 minutes here; choose N to fit the feed volume):

select cron.schedule(
  'idr-sync',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'idr_sync_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-idr-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'idr_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Inspect:   select * from cron.job where jobname = 'idr-sync';
--            select * from net._http_response order by created desc limit 5;
-- Unschedule: select cron.unschedule('idr-sync');
-- Rotate the secret: see SETUP.md (update the Vault secret and the function secret together).
