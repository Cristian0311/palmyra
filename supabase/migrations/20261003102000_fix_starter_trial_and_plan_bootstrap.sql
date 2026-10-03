-- PALMYRA fix Starter trial and warehouse bootstrap plan limits

alter table public.plans
  drop constraint if exists plans_trial_days_policy_check;

update public.plans
set trial_days=90
where code='starter' and active;

update public.plans
set trial_days=0
where code='trial';

alter table public.plans
  add constraint plans_trial_days_policy_check
  check (
    (code='starter' and trial_days=90)
    or (code<>'starter' and trial_days=0)
  );

create or replace function public.enforce_subscription_trial_policy()
returns trigger
language plpgsql
set search_path to 'public','pg_temp'
as $function$
declare
  v_code text;
  v_previous_subscription boolean;
begin
  select p.code into v_code
  from public.plans p
  where p.id=new.plan_id;

  if v_code is null then raise exception 'invalid_plan'; end if;

  if v_code='starter' then
    select exists(
      select 1 from public.subscriptions s
      where s.company_id=new.company_id and s.id<>new.id
    ) into v_previous_subscription;

    if new.status='trialing' then
      if v_previous_subscription then raise exception 'starter_trial_already_used'; end if;
      new.starts_at:=coalesce(new.starts_at,timezone('utc',now()));
      new.trial_ends_at:=least(
        coalesce(new.trial_ends_at,new.starts_at+interval '90 days'),
        new.starts_at+interval '90 days'
      );
      new.current_period_start:=coalesce(new.current_period_start,new.starts_at);
      new.current_period_end:=coalesce(new.current_period_end,new.trial_ends_at);
    elsif new.trial_ends_at is not null then
      raise exception 'starter_nontrial_cannot_have_trial_end';
    end if;
  else
    if new.status='trialing' or new.trial_ends_at is not null then
      raise exception 'nonstarter_cannot_have_trial';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists enforce_warehouse_plan_limit on public.warehouses;
drop trigger if exists trg_plan_limits_warehouses on public.warehouses;
drop trigger if exists trg_plan_limits_products on public.products;
drop trigger if exists trg_plan_limits_employees on public.employees;

create or replace function private.enforce_plan_limit()
returns trigger
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_limit integer;
  v_count integer;
  v_kind text;
  v_company_id uuid;
  v_will_count boolean:=false;
  v_account_status text;
begin
  if TG_OP='DELETE' then return old; end if;
  v_company_id:=new.company_id;
  if v_company_id is null then raise exception 'company_required'; end if;

  if TG_TABLE_NAME='products' then
    v_kind:='products';
    v_will_count:=new.status is distinct from 'archived';
    if TG_OP='UPDATE' and old.status is distinct from 'archived' then v_will_count:=false; end if;
  elsif TG_TABLE_NAME='warehouses' then
    v_kind:='warehouses';
    v_will_count:=coalesce(new.active,true);
    if TG_OP='UPDATE' and coalesce(old.active,true) then v_will_count:=false; end if;

    select account_status into v_account_status from public.companies where id=v_company_id;

    if TG_OP='INSERT'
       and v_account_status='setup'
       and not exists(select 1 from public.warehouses where company_id=v_company_id)
    then
      return new;
    end if;
  elsif TG_TABLE_NAME='employees' then
    v_kind:='employees';
    v_will_count:=coalesce(new.active,true);
    if TG_OP='UPDATE' and coalesce(old.active,true) then v_will_count:=false; end if;
  else
    return new;
  end if;

  if not v_will_count then return new; end if;

  select coalesce((p.limits->>v_kind)::int,999999) into v_limit
  from public.subscriptions s
  join public.plans p on p.id=s.plan_id
  where s.company_id=v_company_id
    and s.status in ('active','trialing','past_due')
  order by s.updated_at desc nulls last
  limit 1;

  v_limit:=coalesce(v_limit,0);

  if TG_TABLE_NAME='products' then
    select count(*) into v_count from public.products where company_id=v_company_id and status is distinct from 'archived';
  elsif TG_TABLE_NAME='warehouses' then
    select count(*) into v_count from public.warehouses where company_id=v_company_id and active;
  else
    select count(*) into v_count from public.employees where company_id=v_company_id and active;
  end if;

  if v_count>=v_limit then
    raise exception 'plan_%_limit',v_kind using errcode='P0001';
  end if;
  return new;
end;
$function$;
