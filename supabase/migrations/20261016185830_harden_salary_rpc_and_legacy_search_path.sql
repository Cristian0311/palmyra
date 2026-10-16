-- Restrict salary settlement writes to authenticated callers.
-- The function already checks auth.uid(), company access and cash.close/payroll.manage.
revoke all on function public.palmyra_record_salary_settlement(uuid, jsonb) from public, anon;
grant execute on function public.palmyra_record_salary_settlement(uuid, jsonb) to authenticated;

-- This deterministic UUID helper uses only pg_catalog built-ins; pin its search path.
alter function public.legacy_pos_uuid(text) set search_path = pg_catalog;
