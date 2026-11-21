-- Currency/bitcoin alerts: threshold configurable as percentage OR absolute
-- amount (e.g. "avisar si la tasa sube o baja 5 pesos"). Additive only.
ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS exchange_alert_mode text NOT NULL DEFAULT 'percent'
    CHECK (exchange_alert_mode IN ('percent', 'absolute')),
  ADD COLUMN IF NOT EXISTS exchange_alert_min_change_abs numeric NOT NULL DEFAULT 0
    CHECK (exchange_alert_min_change_abs >= 0);
