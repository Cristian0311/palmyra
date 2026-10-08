-- The compensation trigger is database-internal and must never be exposed through PostgREST.
revoke execute on function public.apply_company_compensation_to_employee() from anon, authenticated;
revoke execute on function public.apply_company_compensation_to_employee() from public;
