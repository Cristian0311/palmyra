-- Durable, append-only exchange-rate history for PALMYRA.
-- The alert baseline remains separate: it is intentionally one row per currency.

CREATE TABLE IF NOT EXISTS public.exchange_rate_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name text NOT NULL,
  value numeric NOT NULL CHECK (value > 0),
  source text NOT NULL DEFAULT 'elTOQUE',
  captured_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exchange_rate_history_code_captured_at_key UNIQUE (code, captured_at)
);

CREATE INDEX IF NOT EXISTS exchange_rate_history_captured_at_idx
  ON public.exchange_rate_history (captured_at DESC);
CREATE INDEX IF NOT EXISTS exchange_rate_history_code_captured_at_idx
  ON public.exchange_rate_history (code, captured_at DESC);

ALTER TABLE public.exchange_rate_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.exchange_rate_history FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.exchange_rate_history TO service_role;

-- Keep older, browser-only chart points private to their owner when migrating
-- the localStorage cache. They must never contaminate the authoritative global market series.
CREATE TABLE IF NOT EXISTS public.exchange_rate_user_history (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL,
  rates jsonb NOT NULL CHECK (jsonb_typeof(rates) = 'object'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, captured_at)
);

ALTER TABLE public.exchange_rate_user_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.exchange_rate_user_history FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.exchange_rate_user_history TO service_role;

-- Bootstrap one historical point from the current alert baseline. Future observations
-- are appended by monitor-exchange-rates, not upserted over prior values.
INSERT INTO public.exchange_rate_history (code, name, value, source, captured_at)
SELECT code, name, value, source, COALESCE(captured_at, updated_at, now())
FROM public.exchange_rate_alert_snapshots
ON CONFLICT (code, captured_at) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_exchange_rate_history(
  p_since timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 2500
)
RETURNS TABLE (captured_at timestamptz, rates jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  WITH official_points AS (
    SELECT h.captured_at,
           jsonb_object_agg(h.code, to_jsonb(h.value) ORDER BY h.code) AS rates
    FROM public.exchange_rate_history h
    WHERE p_since IS NULL OR h.captured_at >= p_since
    GROUP BY h.captured_at
  ),
  candidates AS (
    SELECT o.captured_at, o.rates, 1 AS priority
    FROM official_points o
    UNION ALL
    SELECT h.captured_at, h.rates, 0 AS priority
    FROM public.exchange_rate_user_history h
    WHERE h.user_id = auth.uid()
      AND (p_since IS NULL OR h.captured_at >= p_since)
  ),
  deduplicated AS (
    SELECT DISTINCT ON (c.captured_at) c.captured_at, c.rates
    FROM candidates c
    ORDER BY c.captured_at, c.priority DESC
  ),
  newest AS (
    SELECT d.captured_at, d.rates
    FROM deduplicated d
    ORDER BY d.captured_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 2500), 1), 10000)
  )
  SELECT n.captured_at, n.rates
  FROM newest n
  ORDER BY n.captured_at ASC;
$function$;

REVOKE ALL ON FUNCTION public.get_exchange_rate_history(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_exchange_rate_history(timestamptz, integer) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.import_exchange_rate_legacy_history(p_snapshots jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_item jsonb;
  v_captured_at timestamptz;
  v_rates jsonb;
  v_clean_rates jsonb;
  v_value integer;
  v_imported integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Se necesita una sesión autenticada para importar el histórico del navegador.'
      USING ERRCODE = '28000';
  END IF;
  IF p_snapshots IS NULL OR jsonb_typeof(p_snapshots) <> 'array' THEN
    RETURN 0;
  END IF;
  IF jsonb_array_length(p_snapshots) > 2500 THEN
    RAISE EXCEPTION 'El histórico enviado supera el límite de 2500 puntos.'
      USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_snapshots) AS entries(value)
  LOOP
    BEGIN
      IF jsonb_typeof(v_item) <> 'object'
         OR COALESCE(v_item->>'capturedAt', '') = ''
         OR jsonb_typeof(v_item->'rates') <> 'object' THEN
        CONTINUE;
      END IF;

      v_captured_at := (v_item->>'capturedAt')::timestamptz;
      IF v_captured_at < now() - interval '5 years'
         OR v_captured_at > now() + interval '5 minutes' THEN
        CONTINUE;
      END IF;

      v_rates := v_item->'rates';
      SELECT jsonb_object_agg(upper(parsed.key), to_jsonb(parsed.numeric_value))
      INTO v_clean_rates
      FROM (
        SELECT e.key,
               CASE WHEN e.value ~ '^[0-9]+([.][0-9]+)?$'
                    THEN e.value::numeric
                    ELSE NULL::numeric
               END AS numeric_value
        FROM jsonb_each_text(v_rates) AS e(key, value)
      ) AS parsed
      WHERE upper(parsed.key) ~ '^[A-Z0-9_-]{2,20}$'
        AND parsed.numeric_value > 0
        AND parsed.numeric_value <= 1000000000000;

      IF v_clean_rates IS NULL OR v_clean_rates = '{}'::jsonb THEN
        CONTINUE;
      END IF;

      INSERT INTO public.exchange_rate_user_history (user_id, captured_at, rates)
      VALUES (v_user_id, v_captured_at, v_clean_rates)
      ON CONFLICT (user_id, captured_at) DO NOTHING;
      GET DIAGNOSTICS v_value = ROW_COUNT;
      v_imported := v_imported + v_value;
    EXCEPTION WHEN OTHERS THEN
      -- A malformed legacy point must not block the rest of the valid history.
      CONTINUE;
    END;
  END LOOP;

  RETURN v_imported;
END;
$function$;

REVOKE ALL ON FUNCTION public.import_exchange_rate_legacy_history(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_exchange_rate_legacy_history(jsonb) TO authenticated;
