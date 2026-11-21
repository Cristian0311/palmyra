-- APPLIED 2026-11-20 to production.
-- Platform admin console: companies overview, company status control and
-- support-request triage. All entry points are security definer and verify
-- platform_admins membership; the browser never decides privilege.
begin;

create or replace function public.get_platform_companies()
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  return coalesce((
    select jsonb_agg(x order by lower(x->>'name'))
    from (
      select jsonb_build_object(
        'id',c.id,
        'name',c.name,
        'slug',c.slug,
        'account_status',c.account_status,
        'active',c.active,
        'created_at',c.created_at,
        'plan_code',p.code,
        'plan_name',p.name,
        'plan_status',s.status,
        'period_end',coalesce(s.trial_ends_at,s.current_period_end),
        'products',(select count(*) from public.products pr where pr.company_id=c.id and pr.status is distinct from 'archived'),
        'employees',(select count(*) from public.employees e where e.company_id=c.id and e.active),
        'warehouses',(select count(*) from public.warehouses w where w.company_id=c.id and w.active)
      ) as x
      from public.companies c
      left join public.subscriptions s on s.company_id=c.id
      left join public.plans p on p.id=s.plan_id
    ) q
  ),'[]'::jsonb);
end $$;
revoke all on function public.get_platform_companies() from public,anon;
grant execute on function public.get_platform_companies() to authenticated;

create or replace function public.set_platform_company_status(p_company_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  if p_status is null or p_status not in ('active','suspended','setup','pending_payment') then
    raise exception 'invalid_company_status';
  end if;
  update public.companies
     set account_status=p_status, active=(p_status<>'suspended'), updated_at=now()
   where id=p_company_id;
  if not found then raise exception 'company_not_found'; end if;
  return jsonb_build_object('ok',true,'company_id',p_company_id,'account_status',p_status);
end $$;
revoke all on function public.set_platform_company_status(uuid,text) from public,anon;
grant execute on function public.set_platform_company_status(uuid,text) to authenticated;

create or replace function public.set_platform_support_request_status(p_request_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  if p_status is null or p_status not in ('open','in_progress','resolved','closed') then
    raise exception 'invalid_support_status';
  end if;
  update public.support_requests set status=p_status, updated_at=now() where id=p_request_id;
  if not found then raise exception 'support_request_not_found'; end if;
  return jsonb_build_object('ok',true,'request_id',p_request_id,'status',p_status);
end $$;
revoke all on function public.set_platform_support_request_status(uuid,text) from public,anon;
grant execute on function public.set_platform_support_request_status(uuid,text) to authenticated;

-- Two overloads of set_platform_support_settings existed (3 and 5 arguments);
-- PostgREST cannot choose between them when the client sends three named
-- parameters. Keep only the 5-argument version, which is a superset.
drop function if exists public.set_platform_support_settings(text,text,text);

commit;
