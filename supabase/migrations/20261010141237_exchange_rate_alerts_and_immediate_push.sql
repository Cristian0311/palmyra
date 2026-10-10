ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS exchange_currency_alerts_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS exchange_currency_codes text[] NOT NULL DEFAULT ARRAY['USD','EUR','MLC']::text[],
  ADD COLUMN IF NOT EXISTS exchange_bitcoin_alerts_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS exchange_alert_min_change_pct numeric NOT NULL DEFAULT 0
    CHECK (exchange_alert_min_change_pct >= 0 AND exchange_alert_min_change_pct <= 100);

CREATE INDEX IF NOT EXISTS notification_preferences_exchange_alerts_idx
  ON public.notification_preferences (updated_at)
  WHERE exchange_currency_alerts_enabled OR exchange_bitcoin_alerts_enabled;

CREATE TABLE IF NOT EXISTS public.exchange_rate_alert_snapshots (
  code text PRIMARY KEY,
  name text NOT NULL,
  value numeric NOT NULL CHECK (value > 0),
  source text NOT NULL DEFAULT 'elTOQUE',
  captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.exchange_rate_alert_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.exchange_rate_alert_snapshots FROM anon, authenticated;
GRANT ALL ON TABLE public.exchange_rate_alert_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_notification_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private'
AS $function$
DECLARE
  v_priority text;
  v_enqueued integer := 0;
BEGIN
  v_priority := CASE
    WHEN lower(coalesce(new.kind, '')) IN ('critical','error','security','danger') THEN 'critical'
    ELSE 'routine'
  END;

  IF new.user_id IS NOT NULL THEN
    INSERT INTO public.notification_outbox
      (company_id, recipient_user_id, notification_id, event_type, payload, dedupe_key, priority, scheduled_at, available_at)
    VALUES
      (new.company_id, new.user_id, new.id, new.kind,
       jsonb_build_object('title', new.title, 'body', new.body, 'notification_id', new.id, 'url', '/notifications'),
       new.id::text, v_priority, now(), now())
    ON CONFLICT (company_id, recipient_user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS v_enqueued = ROW_COUNT;
  ELSE
    INSERT INTO public.notification_outbox
      (company_id, recipient_user_id, notification_id, event_type, payload, dedupe_key, priority, scheduled_at, available_at)
    SELECT new.company_id, cm.user_id, new.id, new.kind,
       jsonb_build_object('title', new.title, 'body', new.body, 'notification_id', new.id, 'url', '/notifications'),
       new.id::text, v_priority, now(), now()
    FROM public.company_memberships cm
    WHERE cm.company_id = new.company_id AND cm.status = 'active'
    ON CONFLICT (company_id, recipient_user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS v_enqueued = ROW_COUNT;
  END IF;

  -- pg_net is asynchronous: queue an immediate wake-up instead of waiting for
  -- the one-minute fallback cron. Never fail the notification insert if wake-up fails.
  IF v_enqueued > 0 THEN
    BEGIN
      IF EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'PALMYRA_PROJECT_URL')
         AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'PALMYRA_NOTIFICATION_WORKER_SECRET') THEN
        PERFORM net.http_post(
          url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'PALMYRA_PROJECT_URL')
                 || '/functions/v1/deliver-notifications',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'PALMYRA_NOTIFICATION_WORKER_SECRET')
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 20000
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[notification-worker] immediate wake-up failed: %', SQLERRM;
    END;
  END IF;

  RETURN new;
END;
$function$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'monitor-exchange-rates-every-five-minutes'
  ) THEN
    PERFORM cron.schedule(
      'monitor-exchange-rates-every-five-minutes',
      '*/5 * * * *',
      $job$
        SELECT net.http_post(
          url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'PALMYRA_PROJECT_URL')
                 || '/functions/v1/monitor-exchange-rates',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'PALMYRA_NOTIFICATION_WORKER_SECRET')
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 25000
        ) AS request_id;
      $job$
    );
  END IF;
END;
$migration$;