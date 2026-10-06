-- PALMYRA SaaS plan-entitlement hardening
-- Locks the published plan catalog and serializes plan-limited writes.

alter table public.plans
  drop constraint if exists plans_runtime_entitlements_check;

alter table public.plans
  add constraint plans_runtime_entitlements_check
  check (
    (
      code='starter' and active=true and monthly_price=10 and trial_days=90
      and coalesce((limits->>'warehouses')::int,0)=1
      and coalesce((limits->>'employees')::int,0)=2
      and coalesce((limits->>'products')::int,0)=50
      and coalesce(limits->>'reports','')='basic'
      and coalesce(limits->>'support','')='standard'
      and jsonb_typeof(features)='object'
      and jsonb_typeof(features->'features')='array'
      and jsonb_array_length(features->'features')=5
      and features->'features' @> jsonb_build_array(
        'Punto de venta','Inventario y caja','Clientes y proveedores','Reportes básicos','Modo offline'
      )
    )
    or (
      code='growth' and active=true and monthly_price=15 and trial_days=0
      and coalesce((limits->>'warehouses')::int,0)=3
      and coalesce((limits->>'employees')::int,0)=4
      and coalesce((limits->>'products')::int,0)=150
      and coalesce(limits->>'reports','')='advanced'
      and coalesce(limits->>'support','')='standard'
      and jsonb_typeof(features)='object'
      and jsonb_typeof(features->'features')='array'
      and jsonb_array_length(features->'features')=9
      and features->'features' @> jsonb_build_array(
        'Punto de venta','Inventario y caja','Clientes y proveedores','Modo offline',
        'Compras y recepción','Transferencias entre almacenes','Reportes avanzados',
        'Equipo con roles','Operación multi-almacén'
      )
    )
    or (
      code='pro' and active=true and monthly_price=25 and trial_days=0
      and coalesce((limits->>'warehouses')::int,0)=7
      and coalesce((limits->>'employees')::int,0)=10
      and coalesce((limits->>'products')::int,0)=300
      and coalesce(limits->>'reports','')='advanced_plus'
      and coalesce(limits->>'support','')='priority'
      and jsonb_typeof(features)='object'
      and jsonb_typeof(features->'features')='array'
      and jsonb_array_length(features->'features')=11
      and features->'features' @> jsonb_build_array(
        'Punto de venta','Inventario y caja','Clientes y proveedores','Modo offline',
        'Compras y recepción','Transferencias entre almacenes','Reportes avanzados',
        'Equipo con roles','Operación multi-almacén','Analítica avanzada','Soporte prioritario'
      )
    )
    or (
      code='trial' and active=false and monthly_price=0 and trial_days=0
      and coalesce((limits->>'warehouses')::int,0)=1
      and coalesce((limits->>'employees')::int,0)=2
      and coalesce((limits->>'products')::int,0)=50
    )
  );

create or replace function private.enforce_plan_limit()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_limit integer;
  v_count integer;
  v_kind text;
  v_company_id uuid;
  v_new_counted boolean := false;
  v_old_counted boolean := false;
  v_account_status text;
begin
  if TG_OP='DELETE' then return old; end if;

  v_company_id := new.company_id;
  if v_company_id is null then raise exception 'company_required'; end if;

  perform 1 from public.companies where id=v_company_id for update;
  if not found then raise exception 'company_not_found'; end if;

  if TG_TABLE_NAME='products' then
    v_kind := 'products';
    v_new_counted := new.status is distinct from 'archived';
    if TG_OP='UPDATE' then v_old_counted := old.status is distinct from 'archived'; end if;
  elsif TG_TABLE_NAME='warehouses' then
    v_kind := 'warehouses';
    v_new_counted := coalesce(new.active,true);
    if TG_OP='UPDATE' then v_old_counted := coalesce(old.active,true); end if;

    select account_status into v_account_status from public.companies where id=v_company_id;
    if TG_OP='INSERT'
       and v_account_status='setup'
       and not exists(select 1 from public.warehouses where company_id=v_company_id)
    then
      return new;
    end if;
  elsif TG_TABLE_NAME='employees' then
    v_kind := 'employees';
    v_new_counted := coalesce(new.active,true);
    if TG_OP='UPDATE' then v_old_counted := coalesce(old.active,true); end if;
  else
    return new;
  end if;

  if not v_new_counted or v_old_counted then return new; end if;

  select coalesce((p.limits->>v_kind)::int,999999)
    into v_limit
  from public.subscriptions s
  join public.plans p on p.id=s.plan_id
  where s.company_id=v_company_id
    and p.active
    and (
      (s.status='active' and (s.current_period_end is null or s.current_period_end>timezone('utc',now())))
      or
      (s.status='trialing'
        and (s.trial_ends_at is null or s.trial_ends_at>timezone('utc',now()))
        and (s.current_period_end is null or s.current_period_end>timezone('utc',now())))
      or
      (s.status='past_due' and (s.current_period_end is null or s.current_period_end>timezone('utc',now())))
    )
  order by s.updated_at desc nulls last
  limit 1;

  v_limit := coalesce(v_limit,0);

  if TG_TABLE_NAME='products' then
    select count(*)::int into v_count
    from public.products
    where company_id=v_company_id and status is distinct from 'archived';
  elsif TG_TABLE_NAME='warehouses' then
    select count(*)::int into v_count
    from public.warehouses
    where company_id=v_company_id and active;
  else
    select count(*)::int into v_count
    from public.employees
    where company_id=v_company_id and active;
  end if;

  if v_count>=v_limit then
    raise exception 'plan_%_limit',v_kind using errcode='P0001';
  end if;
  return new;
end;
$function$;

create or replace function private.company_has_plan_feature(p_company_id uuid,p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select exists(
    select 1
    from public.subscriptions s
    join public.plans p on p.id=s.plan_id
    where s.company_id=p_company_id
      and p.active
      and (
        (s.status='active' and (s.current_period_end is null or s.current_period_end>timezone('utc',now())))
        or
        (s.status='trialing'
          and (s.trial_ends_at is null or s.trial_ends_at>timezone('utc',now()))
          and (s.current_period_end is null or s.current_period_end>timezone('utc',now())))
        or
        (s.status='past_due' and (s.current_period_end is null or s.current_period_end>timezone('utc',now())))
      )
      and exists(
        select 1
        from jsonb_array_elements_text(
          case
            when jsonb_typeof(p.features)='array' then p.features
            when jsonb_typeof(p.features)='object' and jsonb_typeof(p.features->'features')='array'
              then p.features->'features'
            else '[]'::jsonb
          end
        ) f(value)
        where lower(trim(f.value))=lower(trim(p_feature))
           or (lower(trim(p_feature))='pos' and lower(trim(f.value)) in ('pos','punto de venta'))
           or (lower(trim(p_feature))='purchases' and lower(trim(f.value)) in ('compras','compras y recepción','compras y recepcion'))
           or (lower(trim(p_feature))='transfers' and lower(trim(f.value)) in ('transferencias entre almacenes','transferencias'))
           or (lower(trim(p_feature))='roles' and lower(trim(f.value)) in ('equipo con roles','roles'))
           or (lower(trim(p_feature))='multi_warehouse' and lower(trim(f.value)) in ('operación multi-almacén','operacion multi-almacen','3 almacenes','7 almacenes'))
           or (lower(trim(p_feature))='advanced_analytics' and lower(trim(f.value))='analítica avanzada')
           or (lower(trim(p_feature))='priority_support' and lower(trim(f.value))='soporte prioritario')
           or (lower(trim(p_feature))='offline' and lower(trim(f.value))='modo offline')
      )
  );
$function$;

create or replace function private.company_plan_limit(p_company_id uuid,p_key text)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select coalesce((p.limits->>p_key)::integer,2147483647)
  from public.subscriptions s
  join public.plans p on p.id=s.plan_id
  where s.company_id=p_company_id
    and p.active
    and (
      (s.status='active' and (s.current_period_end is null or s.current_period_end>timezone('utc',now())))
      or
      (s.status='trialing'
        and (s.trial_ends_at is null or s.trial_ends_at>timezone('utc',now()))
        and (s.current_period_end is null or s.current_period_end>timezone('utc',now())))
      or
      (s.status='past_due' and (s.current_period_end is null or s.current_period_end>timezone('utc',now())))
    )
  order by s.updated_at desc
  limit 1
$function$;

revoke insert, update, delete on public.plans from authenticated, anon;
