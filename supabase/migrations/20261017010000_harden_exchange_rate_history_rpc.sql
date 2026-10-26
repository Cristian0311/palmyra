-- Harden the exchange-rate history RPC.
-- The UI loads the durable history only after a user is authenticated.
-- Official public rates are not a reason to expose a SECURITY DEFINER RPC to anon.
REVOKE EXECUTE ON FUNCTION public.get_exchange_rate_history(timestamptz, integer) FROM anon;
ALTER FUNCTION public.get_exchange_rate_history(timestamptz, integer) SET search_path = '';
