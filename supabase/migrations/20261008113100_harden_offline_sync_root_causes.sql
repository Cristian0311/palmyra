begin;
grant execute on function private.plan_entity_limit_ok(uuid,text,uuid) to authenticated;
grant execute on function public.palmyra_record_salary_settlement(uuid,jsonb) to authenticated;
commit;