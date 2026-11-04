-- =====================================================================
-- TabungFamily — schedules (run AFTER the edge function is deployed)
-- Replace YOUR_PROJECT_REF and YOUR_CRON_SECRET (same as the secret you set).
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Every day 8:00pm MYT (12:00 UTC).
-- Keeps the free project awake + sends reminder ONLY on the last day of the month.
select cron.schedule('tabung-daily', '0 12 * * *', $$
  select net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/tabung?task=daily',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','YOUR_CRON_SECRET'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);

-- 1 January 9:00am MYT (01:00 UTC): yearly statement PDF to every member (previous year).
select cron.schedule('tabung-statement', '0 1 1 1 *', $$
  select net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/tabung?task=statement',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','YOUR_CRON_SECRET'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000);
$$);

-- Check:   select * from cron.job;
-- History: select * from cron.job_run_details order by start_time desc limit 10;
