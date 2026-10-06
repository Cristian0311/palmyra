create table if not exists private.employee_pos_credentials (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  password_hash text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table private.employee_pos_credentials enable row level security;

create or replace function public.create_employee_pos_secure(
  p_company_id uuid,
  p_employee_id uuid,
  p_employee_code text,
  p_full_name text,
  p_base_salary numeric,
  p_role_id uuid,
  p_warehouse_ids uuid[],
  p_pos_password text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','extensions','pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_id uuid := coalesce(p_employee_id, gen_random_uuid());
  v_limit integer;
  v_role_key text;
  v_role_system boolean;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'employees.manage') then raise exception 'permission_denied'; end if;
  if length(trim(p_full_name)) < 2 or length(trim(p_full_name)) > 160 then raise exception 'invalid_employee_name'; end if;
  if length(trim(p_employee_code)) < 1 or length(trim(p_employee_code)) > 50 then raise exception 'invalid_employee_code'; end if;
  if p_base_salary is null or p_base_salary < 0 then raise exception 'invalid_salary'; end if;
  if p_warehouse_ids is null or cardinality(p_warehouse_ids) = 0 then raise exception 'warehouse_required'; end if;

  if p_employee_id is not null and not exists (
    select 1 from public.employees e
    where e.id = p_employee_id and e.company_id = p_company_id
  ) then
    raise exception 'employee_not_found';
  end if;

  select r.key, r.is_system
    into v_role_key, v_role_system
  from public.roles r
  where r.id = p_role_id
    and (r.company_id is null or r.company_id = p_company_id);

  if v_role_key is null or v_role_key = 'admin' then raise exception 'invalid_role'; end if;
  if not v_role_system and not private.has_permission(p_company_id,'roles.manage') then
    raise exception 'role_management_required';
  end if;

  if (
    select count(*)
    from public.warehouses w
    where w.id = any(p_warehouse_ids)
      and w.company_id = p_company_id
      and w.active
  ) <> cardinality(p_warehouse_ids) then
    raise exception 'invalid_warehouse';
  end if;

  select coalesce((p.limits->>'employees')::int,999999)
    into v_limit
  from public.subscriptions s
  join public.plans p on p.id = s.plan_id
  where s.company_id = p_company_id
    and s.status in ('active','trialing','past_due')
  order by s.updated_at desc nulls last
  limit 1;

  if v_limit is null then
    select coalesce((p.limits->>'employees')::int,999999)
      into v_limit
    from public.plan_requests pr
    join public.plans p on p.id = pr.requested_plan_id
    where pr.company_id = p_company_id
      and pr.status = 'pending'
    order by pr.requested_at desc
    limit 1;
  end if;

  if p_employee_id is null
     and (
       p_pos_password is null
       or length(trim(p_pos_password)) < 6
       or length(trim(p_pos_password)) > 128
     ) then
    raise exception 'pos_password_required';
  end if;

  if not exists(select 1 from public.employees e where e.id = v_id)
     and (select count(*) from public.employees e where e.company_id = p_company_id and e.active) >= coalesce(v_limit,0) then
    raise exception 'plan_employee_limit';
  end if;

  insert into public.employees(
    id, company_id, employee_code, full_name, base_salary, active, role_id
  )
  values(
    v_id, p_company_id, upper(trim(p_employee_code)), trim(p_full_name), p_base_salary, true, p_role_id
  )
  on conflict(id) do update set
    employee_code = excluded.employee_code,
    full_name = excluded.full_name,
    base_salary = excluded.base_salary,
    active = true,
    role_id = excluded.role_id,
    updated_at = timezone('utc',now());

  delete from public.employee_warehouse_access
  where employee_id = v_id and company_id = p_company_id;

  insert into public.employee_warehouse_access(
    company_id, employee_id, warehouse_id, is_default
  )
  select p_company_id, v_id, wid, (row_number() over(order by wid)) = 1
  from unnest(p_warehouse_ids) as wid;

  if p_pos_password is not null and trim(p_pos_password) <> '' then
    insert into private.employee_pos_credentials(employee_id,password_hash,updated_at)
    values(v_id, extensions.crypt(trim(p_pos_password), extensions.gen_salt('bf')), timezone('utc',now()))
    on conflict(employee_id) do update set
      password_hash = excluded.password_hash,
      updated_at = timezone('utc',now());
  end if;

  return jsonb_build_object('id',v_id);
exception when unique_violation then
  raise exception 'employee_code_taken';
end;
$function$;

create or replace function public.palmyra_reserve_ncf_range(
  p_company_id uuid,
  p_fiscal_type text,
  p_device_id uuid,
  p_block_size integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_prefix text;
  v_limit bigint;
  v_next bigint;
  v_start bigint;
  v_end bigint;
  v_res uuid;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id)
     or not private.has_permission(p_company_id,'pos.access') then
    raise exception 'permission_denied';
  end if;

  select coalesce(x->>'prefix',p_fiscal_type),
         coalesce((x->>'limit')::bigint,99999999)
    into v_prefix,v_limit
  from (
    select jsonb_array_elements(
      coalesce(
        (
          select cs.settings->'storeConfig'->'fiscalConfigs'
          from public.company_settings cs
          where cs.company_id = p_company_id
        ),
        '[]'::jsonb
      )
    ) x
  ) q
  where x->>'type' = p_fiscal_type
  limit 1;

  v_prefix := coalesce(v_prefix,p_fiscal_type);
  v_limit := coalesce(v_limit,99999999);

  perform pg_advisory_xact_lock(hashtext(p_company_id::text||':'||p_fiscal_type));

  insert into public.company_fiscal_sequences(
    company_id,fiscal_type,prefix,next_number,limit_number
  )
  values(
    p_company_id,p_fiscal_type,v_prefix,1,v_limit
  )
  on conflict(company_id,fiscal_type) do nothing;

  select next_number,limit_number,prefix
    into v_next,v_limit,v_prefix
  from public.company_fiscal_sequences
  where company_id = p_company_id
    and fiscal_type = p_fiscal_type
  for update;

  if v_next > v_limit then raise exception 'ncf_range_exhausted'; end if;

  v_start := v_next;
  v_end := least(v_limit,v_start+greatest(coalesce(p_block_size,100),1)-1);

  update public.company_fiscal_sequences
  set next_number = v_end + 1,
      updated_at = timezone('utc',now()),
      prefix = v_prefix,
      limit_number = v_limit
  where company_id = p_company_id
    and fiscal_type = p_fiscal_type;

  insert into public.company_fiscal_reservations(
    company_id,fiscal_type,device_id,start_number,end_number,created_by
  )
  values(
    p_company_id,p_fiscal_type,p_device_id,v_start,v_end,v_auth
  )
  returning id into v_res;

  return jsonb_build_object(
    'success',true,'range_id',v_res,'prefix',v_prefix,
    'start_number',v_start,'end_number',v_end
  );
end;
$function$;

revoke all on function public.create_employee_pos_secure(uuid,uuid,text,text,numeric,uuid,uuid[],text) from public, anon;
grant execute on function public.create_employee_pos_secure(uuid,uuid,text,text,numeric,uuid,uuid[],text) to authenticated;

revoke all on function public.palmyra_reserve_ncf_range(uuid,text,uuid,integer) from public, anon;
grant execute on function public.palmyra_reserve_ncf_range(uuid,text,uuid,integer) to authenticated;


create or replace function public.verify_employee_pos_password(
  p_company_id uuid,
  p_employee_id uuid,
  p_password text
)
returns boolean
language plpgsql
security definer
set search_path to 'public','private','extensions','pg_temp'
as $function$
declare
  v_actor uuid := auth.uid();
  v_employee public.employees%rowtype;
  v_hash text;
  v_auth_hash text;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  if p_password is null or trim(p_password) = '' then return false; end if;
  if not private.has_permission(p_company_id,'pos.access') then raise exception 'permission_denied'; end if;

  select e.* into v_employee
  from public.employees e
  where e.id=p_employee_id
    and e.company_id=p_company_id
    and e.active=true;

  if not found then return false; end if;

  if v_employee.user_id is not null then
    select u.encrypted_password into v_auth_hash
    from auth.users u
    where u.id=v_employee.user_id;
    if v_auth_hash is null then return false; end if;
    return v_auth_hash = extensions.crypt(trim(p_password),v_auth_hash);
  end if;

  select c.password_hash into v_hash
  from private.employee_pos_credentials c
  where c.employee_id=v_employee.id;

  if v_hash is null then return false; end if;
  return v_hash = extensions.crypt(trim(p_password),v_hash);
end;
$function$;

revoke all on function public.verify_employee_pos_password(uuid,uuid,text) from public,anon;
grant execute on function public.verify_employee_pos_password(uuid,uuid,text) to authenticated;

create or replace function private.company_has_plan_feature(p_company_id uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path to 'public','pg_temp'
as $function$
  select exists(
    select 1
    from public.subscriptions s
    join public.plans p on p.id=s.plan_id
    where s.company_id=p_company_id
      and p.active
      and (
        s.status='active'
        or (
          s.status='trialing'
          and (s.trial_ends_at is null or s.trial_ends_at>timezone('utc',now()))
          and (s.current_period_end is null or s.current_period_end>timezone('utc',now()))
        )
      )
      and (
        lower(p_feature)='pos'
        or (
          jsonb_typeof(p.features)='array'
          and (
            p.features ? p_feature
            or (
              lower(p_feature)='pos'
              and exists (
                select 1 from jsonb_array_elements_text(p.features) f(value)
                where lower(value) in ('pos','punto de venta')
              )
            )
          )
        )
        or (
          jsonb_typeof(p.features)='object'
          and jsonb_typeof(p.features->'features')='array'
          and exists (
            select 1
            from jsonb_array_elements_text(p.features->'features') f(value)
            where
              lower(value)=lower(p_feature)
              or (lower(p_feature)='pos' and lower(value) in ('pos','punto de venta'))
              or (lower(p_feature)='purchases' and lower(value) in ('compras','compras y recepción'))
              or (lower(p_feature)='payroll' and lower(value) in ('nómina','nomina','nómina y compensaciones'))
          )
        )
      )
  );
$function$;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='palmyra_record_sale'
    and pg_get_function_identity_arguments(p.oid) =
      'p_sale_id uuid, p_company_id uuid, p_warehouse_id uuid, p_cash_session_id uuid, p_user_id uuid, p_total numeric, p_currency_code text, p_notes text, p_customer_id uuid, p_items jsonb, p_payments jsonb';

  if v_def is not null then
    v_def := replace(v_def, '-v_component_qty,''sale''', 'v_component_qty,''sale''');
    v_def := replace(v_def, '-v_qty,''sale''', 'v_qty,''sale''');
    execute v_def;
  end if;
end $$;
