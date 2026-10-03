-- PALMYRA remove obsolete onboarding overload
revoke all on function public.palmyra_onboard_company(text,text,bpchar,bpchar,text,text,text,text) from public,anon,authenticated;
drop function if exists public.palmyra_onboard_company(text,text,bpchar,bpchar,text,text,text,text);
