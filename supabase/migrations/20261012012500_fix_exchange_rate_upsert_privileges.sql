-- Supabase upsert uses INSERT ... ON CONFLICT DO UPDATE. INSERT-only grants
-- are insufficient, even when the first attempt would create a new row.
-- The existing exchange_rates_update RLS policy still enforces settings.manage.
GRANT UPDATE ON TABLE public.exchange_rates TO authenticated;
