-- PALMYRA SaaS active-company switching

create or replace function public.set_active_company(p_company_id uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare v_user uuid:=auth.uid(); v_company public.companies%rowtype;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  select c.* into v_company
  from public.companies c
  join public.company_memberships cm on cm.company_id=c.id
  where c.id=p_company_id and cm.user_id=v_user and cm.status='active'
  limit 1;
  if not found then raise exception 'company_access_denied'; end if;

  update public.profiles
    set active_company_id=p_company_id,updated_at=timezone('utc',now())
  where id=v_user;

  return jsonb_build_object(
    'company_id',v_company.id,'name',v_company.name,'slug',v_company.slug,
    'account_status',v_company.account_status,'default_currency_code',v_company.default_currency_code
  );
end;
$$;

revoke all on function public.set_active_company(uuid) from public,anon;
grant execute on function public.set_active_company(uuid) to authenticated;
