-- Restrict exposed security-definer RPCs to authenticated users.
-- They all validate the caller's identity/company before performing any action.

revoke execute on function public.palmyra_onboard_company_with_payment_v2(text,text,character,character,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.palmyra_onboard_company_with_payment_v2(text,text,character,character,text,text,text,text,text,text,text) to authenticated;

revoke execute on function public.verify_pos_access_password(uuid,uuid,text) from public, anon;
grant execute on function public.verify_pos_access_password(uuid,uuid,text) to authenticated;

revoke execute on function public.revoke_other_devices(uuid) from public, anon;
grant execute on function public.revoke_other_devices(uuid) to authenticated;
