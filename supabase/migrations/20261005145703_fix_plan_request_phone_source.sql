-- Fix historical hardcoded WhatsApp phone in plan-request creation.
-- Source the requester phone from their profile/Auth user instead.

do $migration$
declare
  v_oid oid;
  v_def text;
  v_args text;
  v_new_phone constant text := 'coalesce(nullif(trim((select pr.phone from public.profiles pr where pr.id=v_user)), ''''), nullif(trim((select au.phone from auth.users au where au.id=v_user)), ''''), '''')';
begin
  for v_oid, v_args in
    select p.oid, pg_get_function_identity_arguments(p.oid)
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname in ('palmyra_onboard_company','select_company_plan')
  loop
    v_def := pg_get_functiondef(v_oid);

    if position('55581669' in v_def) = 0 then
      continue;
    end if;

    v_def := replace(v_def, '''55581669''', v_new_phone);
    execute v_def;
  end loop;
end
$migration$;

update public.plan_requests pr
set whatsapp_phone = coalesce(
  nullif(trim((select p.phone from public.profiles p where p.id=pr.requested_by)), ''),
  nullif(trim((select u.phone from auth.users u where u.id=pr.requested_by)), ''),
  ''
)
where pr.whatsapp_phone='55581669';
