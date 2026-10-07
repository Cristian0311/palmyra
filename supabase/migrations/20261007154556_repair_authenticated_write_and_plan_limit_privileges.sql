-- PALMYRA: repair authenticated privileges required by existing RLS policies
-- and by the plan-limit helper used from security-definer triggers.

GRANT EXECUTE ON FUNCTION private.plan_entity_limit_ok(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.plan_entity_limit_ok(uuid, text, uuid) TO service_role;

GRANT UPDATE ON TABLE public.companies TO authenticated;
GRANT INSERT ON TABLE public.exchange_rates TO authenticated;

GRANT UPDATE ON TABLE public.companies TO service_role;
GRANT INSERT ON TABLE public.exchange_rates TO service_role;
