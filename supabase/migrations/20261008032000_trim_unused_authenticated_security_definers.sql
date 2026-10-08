begin;

-- PALMYRA: reduce the authenticated SECURITY DEFINER API to RPCs
-- currently required by the application. Legacy/unused RPCs remain available
-- to trusted database code but are not exposed through the Data API.

revoke execute on function public.palmyra_onboard_company(text,text,character,character,text,text,text,text,text) from authenticated;
revoke execute on function public.palmyra_onboard_company_with_payment(text,text,character,character,text,text,text,text,text,text) from authenticated;

revoke execute on function public.create_employee_pos_secure(uuid,uuid,text,text,numeric,uuid,uuid[],text,text,numeric) from authenticated;

revoke execute on function public.select_company_plan(uuid,uuid) from authenticated;
revoke execute on function public.get_company_members_for_admin(uuid) from authenticated;

revoke execute on function public.get_platform_control_center() from authenticated;
revoke execute on function public.get_platform_infrastructure_metrics() from authenticated;
revoke execute on function public.get_platform_plans() from authenticated;
revoke execute on function public.set_platform_company_plan(uuid,uuid) from authenticated;
revoke execute on function public.update_platform_plan(uuid,numeric,integer,jsonb,jsonb,boolean) from authenticated;

revoke execute on function public.set_platform_support_settings(text,text,text) from authenticated;
revoke execute on function public.set_manual_cash_payment(uuid,text,text) from authenticated;

commit;
