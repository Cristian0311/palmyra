begin;

CREATE OR REPLACE FUNCTION public.create_employee_pos_secure(
  p_company_id uuid,
  p_employee_id uuid,
  p_employee_code text,
  p_full_name text,
  p_base_salary numeric,
  p_role_id uuid,
  p_warehouse_ids uuid[],
  p_pos_password text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions', 'pg_temp'
AS $function$
declare
  v_user uuid := auth.uid();
  v_id uuid := coalesce(p_employee_id, gen_random_uuid());
  v_limit integer;
  v_role_key text;
  v_role_system boolean;
  v_linked_user uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'employees.manage') then raise exception 'permission_denied'; end if;
  if length(trim(p_full_name)) < 2 or length(trim(p_full_name)) > 160 then raise exception 'invalid_employee_name'; end if;
  if length(trim(p_employee_code)) < 1 or length(trim(p_employee_code)) > 50 then raise exception 'invalid_employee_code'; end if;
  if p_base_salary is null or p_base_salary < 0 then raise exception 'invalid_salary'; end if;
  if p_warehouse_ids is null or cardinality(p_warehouse_ids) = 0 then raise exception 'warehouse_required'; end if;

  if p_employee_id is not null then
    select e.user_id
      into v_linked_user
    from public.employees e
    where e.id = p_employee_id and e.company_id = p_company_id
    for update;
    if not found then
      -- Allow a client-generated UUID for a newly created offline employee.
      -- Never hijack an ID that already exists in another company.
      if exists (select 1 from public.employees e where e.id = p_employee_id) then
        raise exception 'employee_not_found';
      end if;
      v_linked_user := null;
    end if;
    if p_pos_password is not null and trim(p_pos_password) <> ''
       and v_linked_user is not null
       and exists (
         select 1 from public.company_memberships cm
         where cm.company_id = p_company_id
           and cm.user_id = v_linked_user
           and cm.is_owner = true
       ) then
      raise exception 'employee_web_access_owner_cannot_be_disabled';
    end if;
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

  if p_pos_password is not null and trim(p_pos_password) <> ''
     and (length(trim(p_pos_password)) < 6 or length(trim(p_pos_password)) > 128) then
    raise exception 'pos_password_required';
  end if;

  if p_employee_id is null and (
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

    -- "Solo POS" revokes pending invitations and detaches a linked web identity,
    -- preserving the employee row and its historical sales/payroll.
    update public.company_invitations
       set status = 'revoked', updated_at = timezone('utc',now())
     where employee_id = v_id
       and company_id = p_company_id
       and status = 'pending';

    if v_linked_user is not null then
      delete from public.devices
       where company_id = p_company_id and user_id = v_linked_user;
      delete from public.user_roles
       where company_id = p_company_id and user_id = v_linked_user;
      delete from public.user_locations
       where company_id = p_company_id and user_id = v_linked_user;
      delete from public.company_memberships
       where company_id = p_company_id and user_id = v_linked_user and is_owner = false;
      update public.profiles
         set active_company_id = null
       where id = v_linked_user and active_company_id = p_company_id;
      update public.employees
         set user_id = null, updated_at = timezone('utc',now())
       where id = v_id and company_id = p_company_id and user_id = v_linked_user;
    end if;
  end if;

  return jsonb_build_object('id',v_id);
exception when unique_violation then
  raise exception 'employee_code_taken';
end;
$function$;

CREATE OR REPLACE FUNCTION public.palmyra_cancel_cash_session(
  p_session_id uuid,
  p_company_id uuid,
  p_reason text,
  p_password text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions', 'pg_temp'
AS $function$
declare
  v_auth uuid := auth.uid();
  v_row public.cash_sessions%rowtype;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id,'cash.close') then raise exception 'permission_denied'; end if;

  select *
    into v_row
  from public.cash_sessions
  where id = p_session_id and company_id = p_company_id
  for update;

  if not found then raise exception 'cash_session_not_found'; end if;
  if v_row.status = 'voided' then
    return jsonb_build_object('success',true,'already_cancelled',true);
  end if;
  if v_row.status <> 'open' then
    raise exception 'cash_session_not_open';
  end if;

  update public.cash_sessions
     set status = 'voided',
         closed_at = timezone('utc',now()),
         closed_by = v_auth,
         difference = 0,
         delete_reason = left(nullif(trim(coalesce(p_reason,'')),''),500)
   where id = p_session_id and company_id = p_company_id;

  return jsonb_build_object(
    'success',true,
    'already_cancelled',false,
    'employee_id',v_row.employee_id
  );
end;
$function$;

commit;
