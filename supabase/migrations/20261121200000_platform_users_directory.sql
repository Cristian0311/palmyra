-- Read-only user directory for the platform admin console.
-- Additive: two security-definer functions gated by platform_admins.
begin;

create or replace function public.get_platform_users(p_search text default null, p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_limit integer; v_search text;
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  v_limit:=least(greatest(coalesce(p_limit,200),1),500);
  v_search:=nullif(lower(trim(coalesce(p_search,''))),'');
  return coalesce((
    select jsonb_agg(x order by (x->>'created_at') desc)
    from (
      select jsonb_build_object(
        'user_id',au.id,
        'email',au.email,
        'full_name',nullif(trim(pr.full_name),''),
        'phone',coalesce(nullif(trim(pr.phone),''),nullif(trim(au.phone),'')),
        'locale',pr.locale,
        'created_at',au.created_at,
        'last_sign_in_at',au.last_sign_in_at,
        'email_confirmed',au.email_confirmed_at is not null,
        'is_platform_admin',exists(select 1 from public.platform_admins pa where pa.user_id=au.id),
        'company_id',m.company_id,
        'company_name',c.name,
        'membership_status',m.status::text,
        'is_owner',coalesce(m.is_owner,false),
        'active_company_id',pr.active_company_id
      ) as x
      from auth.users au
      left join public.profiles pr on pr.id=au.id
      left join lateral (
        select cm.company_id,cm.status,cm.is_owner,cm.joined_at
        from public.company_memberships cm
        where cm.user_id=au.id
        order by cm.is_owner desc,cm.joined_at desc nulls last
        limit 1
      ) m on true
      left join public.companies c on c.id=m.company_id
      where v_search is null
         or lower(coalesce(au.email,'')) like '%'||v_search||'%'
         or lower(coalesce(pr.full_name,'')) like '%'||v_search||'%'
         or lower(coalesce(pr.phone,'')) like '%'||v_search||'%'
         or lower(coalesce(c.name,'')) like '%'||v_search||'%'
      order by au.created_at desc
      limit v_limit
    ) q
  ),'[]'::jsonb);
end $$;
revoke all on function public.get_platform_users(text,integer) from public,anon;
grant execute on function public.get_platform_users(text,integer) to authenticated;

create or replace function public.get_platform_user_detail(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_target jsonb;
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  select jsonb_build_object(
    'user_id',au.id,
    'email',au.email,
    'full_name',nullif(trim(pr.full_name),''),
    'phone',coalesce(nullif(trim(pr.phone),''),nullif(trim(au.phone),'')),
    'locale',pr.locale,
    'created_at',au.created_at,
    'last_sign_in_at',au.last_sign_in_at,
    'email_confirmed',au.email_confirmed_at is not null,
    'is_platform_admin',exists(select 1 from public.platform_admins pa where pa.user_id=au.id),
    'company_id',pr.active_company_id,
    'company_name',(select c.name from public.companies c where c.id=pr.active_company_id),
    'membership_status',null,
    'is_owner',coalesce((select cm.is_owner from public.company_memberships cm where cm.user_id=au.id and cm.company_id=pr.active_company_id),false),
    'active_company_id',pr.active_company_id
  ) into v_target
  from auth.users au
  left join public.profiles pr on pr.id=au.id
  where au.id=p_user_id;
  if v_target is null then raise exception 'user_not_found'; end if;
  return jsonb_build_object(
    'user',v_target,
    'memberships',coalesce((
      select jsonb_agg(x order by (x->>'joined_at') desc nulls last)
      from (
        select jsonb_build_object(
          'company_id',cm.company_id,
          'company_name',c.name,
          'account_status',c.account_status,
          'is_owner',cm.is_owner,
          'status',cm.status::text,
          'joined_at',cm.joined_at
        ) as x
        from public.company_memberships cm
        left join public.companies c on c.id=cm.company_id
        where cm.user_id=p_user_id
      ) q
    ),'[]'::jsonb),
    'employees',coalesce((
      select jsonb_agg(x order by (x->>'created_at') desc)
      from (
        select jsonb_build_object(
          'id',e.id,
          'company_name',c.name,
          'employee_code',e.employee_code,
          'full_name',e.full_name,
          'active',e.active,
          'created_at',e.created_at
        ) as x
        from public.employees e
        left join public.companies c on c.id=e.company_id
        where e.user_id=p_user_id
      ) q
    ),'[]'::jsonb)
  );
end $$;
revoke all on function public.get_platform_user_detail(uuid) from public,anon;
grant execute on function public.get_platform_user_detail(uuid) to authenticated;

commit;
