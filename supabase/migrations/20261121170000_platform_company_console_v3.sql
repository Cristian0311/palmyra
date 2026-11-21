-- Company console v3: full per-company administration from the platform admin.
-- Additive: one note table, new read/write RPCs. No existing rows are touched
-- by this file; RPCs update rows only when an administrator calls them.
begin;

-- ---------------------------------------------------------------------------
-- 1. Internal notes (platform-only, never exposed to the company)
-- ---------------------------------------------------------------------------
create table if not exists public.platform_company_notes (
  company_id uuid primary key references public.companies(id) on delete cascade,
  note text not null default '',
  updated_by uuid,
  updated_at timestamptz not null default timezone('utc',now())
);
alter table public.platform_company_notes enable row level security;
revoke all on table public.platform_company_notes from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Shared guard
-- ---------------------------------------------------------------------------
create or replace function private.assert_platform_admin()
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  return v_user;
end $$;
revoke all on function private.assert_platform_admin() from public,anon,authenticated;

-- ---------------------------------------------------------------------------
-- 3. Console read model: profile, plan, dates, usage, owner, team, note
-- ---------------------------------------------------------------------------
create or replace function public.get_platform_company_console(p_company_id uuid)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_company jsonb; v_owner jsonb; v_members jsonb;
begin
  perform private.assert_platform_admin();

  select jsonb_build_object(
    'id',c.id,'name',c.name,'slug',c.slug,'account_status',c.account_status,
    'active',c.active,'created_at',c.created_at,'updated_at',c.updated_at,
    'currency',trim(c.default_currency_code)
  ) into v_company
  from public.companies c where c.id=p_company_id;
  if v_company is null then raise exception 'company_not_found'; end if;

  select jsonb_build_object(
    'user_id',cm.user_id,
    'full_name',coalesce(nullif(trim(p.full_name),''),au.email),
    'email',au.email,
    'phone',coalesce(nullif(trim(p.phone),''),au.phone)
  ) into v_owner
  from public.company_memberships cm
  left join public.profiles p on p.id=cm.user_id
  left join auth.users au on au.id=cm.user_id
  where cm.company_id=p_company_id and cm.is_owner
  order by (cm.status='active') desc
  limit 1;

  select coalesce(jsonb_agg(x order by (x->>'is_owner') desc, lower(x->>'full_name')), '[]'::jsonb)
  into v_members
  from (
    select jsonb_build_object(
      'user_id',cm.user_id,
      'full_name',coalesce(nullif(trim(p.full_name),''),au.email),
      'email',au.email,
      'phone',coalesce(nullif(trim(p.phone),''),au.phone),
      'is_owner',cm.is_owner,
      'status',cm.status,
      'roles',(
        select string_agg(distinct r.name, ', ')
        from public.user_roles ur
        join public.roles r on r.id=ur.role_id
        where ur.company_id=cm.company_id and ur.user_id=cm.user_id
      )
    ) as x
    from public.company_memberships cm
    left join public.profiles p on p.id=cm.user_id
    left join auth.users au on au.id=cm.user_id
    where cm.company_id=p_company_id
    order by cm.is_owner desc
    limit 100
  ) q;

  return jsonb_build_object(
    'company',v_company,
    'subscription',(
      select jsonb_build_object(
        'plan_code',p.code,'plan_name',p.name,'monthly_price',p.monthly_price,
        'status',s.status,'starts_at',s.starts_at,
        'current_period_start',s.current_period_start,'current_period_end',s.current_period_end,
        'trial_ends_at',s.trial_ends_at,'grace_ends_at',s.grace_ends_at,'cancelled_at',s.cancelled_at
      )
      from public.subscriptions s left join public.plans p on p.id=s.plan_id
      where s.company_id=p_company_id
    ),
    'plan',(
      select jsonb_build_object('code',p.code,'name',p.name,'limits',p.limits,'features',p.features)
      from public.subscriptions s join public.plans p on p.id=s.plan_id
      where s.company_id=p_company_id
    ),
    'counts',jsonb_build_object(
      'products',(select count(*) from public.products pr where pr.company_id=p_company_id and pr.status is distinct from 'archived'),
      'employees',(select count(*) from public.employees e where e.company_id=p_company_id and e.active),
      'warehouses',(select count(*) from public.warehouses w where w.company_id=p_company_id and w.active),
      'devices',(select count(*) from public.devices d where d.company_id=p_company_id and d.active)
    ),
    'owner',v_owner,
    'members',v_members,
    'note',(
      select jsonb_build_object(
        'text',n.note,'updated_at',n.updated_at,
        'updated_by',(select au.email from auth.users au where au.id=n.updated_by)
      )
      from public.platform_company_notes n where n.company_id=p_company_id
    )
  );
end $$;
revoke all on function public.get_platform_company_console(uuid) from public,anon;
grant execute on function public.get_platform_company_console(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Editable company profile
-- ---------------------------------------------------------------------------
create or replace function public.update_platform_company_profile(
  p_company_id uuid,p_name text,p_slug text,p_currency text
) returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
  v_name text:=nullif(trim(p_name),'');
  v_slug text:=lower(nullif(trim(p_slug),''));
  v_currency text:=upper(nullif(trim(p_currency),''));
  v_old public.companies%rowtype;
begin
  perform private.assert_platform_admin();
  if v_name is null or char_length(v_name)<2 or char_length(v_name)>120 then
    raise exception 'invalid_company_name';
  end if;
  if v_slug is null or v_slug !~ '^[a-z0-9][a-z0-9-]{1,60}$' then
    raise exception 'invalid_company_slug';
  end if;
  if v_currency is null or v_currency not in ('CUP','USD','MLC','EUR') then
    raise exception 'invalid_currency';
  end if;
  select * into v_old from public.companies where id=p_company_id for update;
  if not found then raise exception 'company_not_found'; end if;
  if exists(select 1 from public.companies where slug=v_slug and id<>p_company_id) then
    raise exception 'company_slug_taken';
  end if;
  update public.companies
     set name=v_name,slug=v_slug,default_currency_code=v_currency::bpchar,updated_at=timezone('utc',now())
   where id=p_company_id;
  perform private.log_platform_admin_action(
    'company.profile_updated',p_company_id,null,
    jsonb_build_object(
      'name',jsonb_build_object('from',v_old.name,'to',v_name),
      'slug',jsonb_build_object('from',v_old.slug,'to',v_slug),
      'currency',jsonb_build_object('from',trim(v_old.default_currency_code),'to',v_currency)
    )
  );
  return jsonb_build_object('ok',true,'company_id',p_company_id,'name',v_name,'slug',v_slug,'currency',v_currency);
end $$;
revoke all on function public.update_platform_company_profile(uuid,text,text,text) from public,anon;
grant execute on function public.update_platform_company_profile(uuid,text,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Internal note
-- ---------------------------------------------------------------------------
create or replace function public.set_platform_company_note(p_company_id uuid,p_note text)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid; v_note text:=left(coalesce(trim(p_note),''),2000);
begin
  v_user:=private.assert_platform_admin();
  if not exists(select 1 from public.companies where id=p_company_id) then
    raise exception 'company_not_found';
  end if;
  insert into public.platform_company_notes(company_id,note,updated_by,updated_at)
  values(p_company_id,v_note,v_user,timezone('utc',now()))
  on conflict(company_id) do update
    set note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
  perform private.log_platform_admin_action(
    'company.note_updated',p_company_id,null,jsonb_build_object('length',char_length(v_note))
  );
  return jsonb_build_object('ok',true,'note',v_note);
end $$;
revoke all on function public.set_platform_company_note(uuid,text) from public,anon;
grant execute on function public.set_platform_company_note(uuid,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Subscription dates and status (trial, period end, grace)
-- ---------------------------------------------------------------------------
create or replace function public.set_platform_company_subscription_dates(
  p_company_id uuid,
  p_status text default null,
  p_trial_ends_at timestamptz default null,
  p_current_period_end timestamptz default null,
  p_grace_ends_at timestamptz default null,
  p_note text default null
) returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
  v_sub public.subscriptions%rowtype;
  v_plan public.plans%rowtype;
  v_status text:=nullif(lower(trim(p_status)),'');
  v_now timestamptz:=timezone('utc',now());
  v_trial timestamptz;
  v_period timestamptz;
  v_grace timestamptz;
begin
  perform private.assert_platform_admin();
  select * into v_sub from public.subscriptions where company_id=p_company_id for update;
  if not found then raise exception 'subscription_not_found'; end if;
  select * into v_plan from public.plans where id=v_sub.plan_id;
  if v_plan.id is null then raise exception 'plan_not_available'; end if;
  if v_status is null then v_status:=v_sub.status; end if;
  if v_status not in ('active','trialing','past_due','cancelled','expired') then
    raise exception 'invalid_subscription_status';
  end if;

  if v_plan.code='free' then
    v_trial:=null; v_period:=null; v_grace:=null;
  else
    v_trial:=p_trial_ends_at; v_period:=p_current_period_end; v_grace:=p_grace_ends_at;
    if v_status='trialing' and v_trial is null then raise exception 'trial_end_required'; end if;
    if v_status='active' and v_period is null then raise exception 'period_end_required'; end if;
    if v_trial is not null and v_period is not null and v_trial>v_period then
      raise exception 'invalid_subscription_dates';
    end if;
    if v_grace is not null and v_period is not null and v_grace<v_period then
      raise exception 'invalid_grace_date';
    end if;
  end if;

  update public.subscriptions
     set status=v_status,trial_ends_at=v_trial,current_period_end=v_period,
         grace_ends_at=v_grace,updated_at=v_now
   where company_id=p_company_id;

  if v_status in ('active','trialing') then
    update public.companies
       set active=true,
           account_status=case when account_status='suspended' then account_status else 'active' end,
           updated_at=v_now
     where id=p_company_id;
  elsif v_status in ('cancelled','expired') then
    update public.companies
       set account_status='pending_payment',updated_at=v_now
     where id=p_company_id and account_status<>'suspended';
  end if;

  perform private.log_platform_admin_action(
    'company.subscription_dates_updated',p_company_id,null,
    jsonb_build_object(
      'status',jsonb_build_object('from',v_sub.status,'to',v_status),
      'trial_ends_at',v_trial,'current_period_end',v_period,'grace_ends_at',v_grace,
      'note',left(nullif(trim(p_note),''),500)
    )
  );
  return jsonb_build_object(
    'ok',true,'company_id',p_company_id,'status',v_status,
    'trial_ends_at',v_trial,'current_period_end',v_period,'grace_ends_at',v_grace
  );
end $$;
revoke all on function public.set_platform_company_subscription_dates(uuid,text,timestamptz,timestamptz,timestamptz,text) from public,anon;
grant execute on function public.set_platform_company_subscription_dates(uuid,text,timestamptz,timestamptz,timestamptz,text) to authenticated;

commit;
