-- ============================================================================
-- Email Queue Dispatcher Setup
-- ============================================================================
--
-- Symptom this fixes:
--   Users sign up but never receive the confirmation email. The auth-email-hook
--   logs no errors. Messages enqueue into pgmq.auth_emails fine, but nothing
--   ever drains the queue.
--
-- Root cause:
--   The pg_cron job that polls the email queue every 5 s and POSTs to the
--   process-email-queue edge function gets dropped sometimes — by an admin
--   debugging session, a Supabase project reset, or pg_cron getting
--   re-installed. Without the cron, emails sit in the queue until TTL
--   expiry (15 min for auth) and then move silently to the DLQ.
--
-- What this script does:
--   1. Verifies pg_cron and pg_net extensions are enabled.
--   2. Stores the project's service-role key in vault as
--      'email_queue_service_role_key'.
--   3. Recreates the 'process-email-queue' cron job on a 5-second schedule.
--   4. Reports the current state so you can verify it worked.
--
-- HOW TO RUN:
--   1. Open the Supabase SQL Editor for THIS project.
--   2. Replace the two placeholders below with your actual values:
--        - <SERVICE_ROLE_KEY> : Project Settings → API → service_role key
--          (long JWT string starting with eyJ...). KEEP THIS PRIVATE.
--        - <PROJECT_REF>      : your project ref, e.g. YOUR_SUPABASE_PROJECT_REF
--          (the part before .supabase.co in your project URL).
--   3. Click "Run". You should see one row at the bottom confirming
--      the job was scheduled.
--
-- Idempotent: safe to run multiple times. Subsequent runs update the
-- secret + reschedule the cron without errors.
-- ============================================================================

DO $$
DECLARE
  v_service_key text := '<SERVICE_ROLE_KEY>';                    -- ← replace
  v_project_ref text := '<PROJECT_REF>';                          -- ← replace
  v_function_url text;
  v_secret_id uuid;
BEGIN
  -- 0. Sanity-check placeholders were replaced
  IF v_service_key LIKE '<%' OR v_project_ref LIKE '<%' THEN
    RAISE EXCEPTION 'You must replace <SERVICE_ROLE_KEY> and <PROJECT_REF> at the top of this script before running.';
  END IF;

  v_function_url := 'https://' || v_project_ref || '.supabase.co/functions/v1/process-email-queue';

  -- 1. Required extensions
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  CREATE EXTENSION IF NOT EXISTS pg_net;

  -- 2. Vault secret — upsert.
  -- vault.create_secret returns the new secret id; if a secret with that
  -- name already exists we update it instead.
  SELECT id INTO v_secret_id FROM vault.secrets WHERE name = 'email_queue_service_role_key';
  IF v_secret_id IS NULL THEN
    PERFORM vault.create_secret(v_service_key, 'email_queue_service_role_key', 'Service role key used by the email queue cron job to authorize calls to process-email-queue');
    RAISE NOTICE 'Created vault secret email_queue_service_role_key';
  ELSE
    PERFORM vault.update_secret(v_secret_id, v_service_key, 'email_queue_service_role_key', 'Service role key used by the email queue cron job to authorize calls to process-email-queue');
    RAISE NOTICE 'Updated existing vault secret email_queue_service_role_key';
  END IF;

  -- 3. Drop any existing schedule before re-creating, so this script is
  --    safe to run multiple times.
  PERFORM cron.unschedule('process-email-queue') FROM cron.job WHERE jobname = 'process-email-queue';

  -- 4. Schedule the dispatcher: every 5 seconds, kick the edge function
  --    only when (a) we're not in a rate-limit cooldown and (b) at least
  --    one message is waiting in either queue.
  PERFORM cron.schedule(
    'process-email-queue',
    '5 seconds',
    format($cron$
      DO $body$
      DECLARE
        v_key text;
        v_state record;
        v_pending int;
      BEGIN
        -- Honour rate-limit cooldown set by the dispatcher itself.
        SELECT retry_after_until INTO v_state
        FROM public.email_send_state
        ORDER BY id LIMIT 1;
        IF v_state.retry_after_until IS NOT NULL AND v_state.retry_after_until > NOW() THEN
          RETURN;
        END IF;

        -- Cheap polling: any non-invisible messages waiting?
        SELECT (
          (SELECT COUNT(*) FROM pgmq.q_auth_emails WHERE vt <= NOW())
          + (SELECT COUNT(*) FROM pgmq.q_transactional_emails WHERE vt <= NOW())
        ) INTO v_pending;

        IF COALESCE(v_pending, 0) = 0 THEN
          RETURN;
        END IF;

        -- Pull the service-role key from vault and POST to the edge function.
        SELECT decrypted_secret INTO v_key
        FROM vault.decrypted_secrets
        WHERE name = 'email_queue_service_role_key';

        PERFORM net.http_post(
          url := %L,
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || v_key,
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      END $body$;
    $cron$, v_function_url)
  );

  RAISE NOTICE 'Scheduled cron job process-email-queue → POST %', v_function_url;
END $$;

-- 5. Verify the result. You should see:
--   - one row in cron.job with jobname = 'process-email-queue', schedule = '5 seconds', active = true
--   - one row in vault.secrets with name = 'email_queue_service_role_key'
SELECT
  jobid,
  jobname,
  schedule,
  active,
  command IS NOT NULL AS has_command
FROM cron.job
WHERE jobname = 'process-email-queue';

SELECT name, created_at, updated_at
FROM vault.secrets
WHERE name = 'email_queue_service_role_key';

-- ── Optional: drain anything stuck right now ────────────────────────────────
-- If you have queued messages from before the cron was fixed, they'll either
-- TTL out or be picked up on the next cron tick. To drain immediately, you
-- can run this manually (it's the same call the cron makes):
--
-- SELECT net.http_post(
--   url := 'https://<PROJECT_REF>.supabase.co/functions/v1/process-email-queue',
--   headers := jsonb_build_object(
--     'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'),
--     'Content-Type', 'application/json'
--   ),
--   body := '{}'::jsonb
-- );
