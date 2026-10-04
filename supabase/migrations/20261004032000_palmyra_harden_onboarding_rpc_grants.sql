-- PALMYRA: onboarding/payment RPCs are authenticated-only.
revoke all on function public.palmyra_onboard_company_with_payment(text,text,bpchar,bpchar,text,text,text,text,text,text) from anon, public;
grant execute on function public.palmyra_onboard_company_with_payment(text,text,bpchar,bpchar,text,text,text,text,text,text) to authenticated;

revoke all on function public.select_company_plan_with_payment(uuid,uuid,text) from anon, public;
grant execute on function public.select_company_plan_with_payment(uuid,uuid,text) to authenticated;
