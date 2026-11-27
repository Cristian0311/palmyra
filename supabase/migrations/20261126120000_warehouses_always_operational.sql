-- PALMYRA: un almacén registrado por la empresa está operativo.
--
-- No existe el estado «inactivo» para el personal: si el negocio dio de alta un
-- almacén, puede asignarle trabajadores y emitir enlaces de acceso. La columna
-- `warehouses.active` deja de filtrar la asignación de empleados.
--
-- 1) Reparación de datos: los almacenes marcados inactivos vuelven a estar
--    operativos. Sólo MARE tiene filas en ese estado (6 almacenes, límite del
--    plan pro: 7), así que el trigger de límite no se excede.
-- 2) create_employee_pos_secure: valida pertenencia a la empresa, no `active`.
-- 3) create_device_access_invite: incluye todos los almacenes asignados, no
--    sólo los activos.
--
-- Reversa: restaurar la definición de 20261122160000 (RPC de empleado) y
-- 20261125000000 (invitación); la reparación de datos no se revierte.

begin;

update public.warehouses
   set active = true
 where active = false;

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
  v_is_owner boolean := false;
  v_out_of_scope uuid[];
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

  -- Todo almacén registrado en la empresa es asignable: `active` no se exige.
  if (
    select count(*)
    from public.warehouses w
    where w.id = any(p_warehouse_ids)
      and w.company_id = p_company_id
  ) <> cardinality(p_warehouse_ids) then
    raise exception 'invalid_warehouse';
  end if;

  -- Un supervisor solo puede asignar el empleado a almacenes que él mismo
  -- opera. Si algún id cae fuera de su alcance se aborta la operación entera
  -- (fail closed) y se listan los ids ofensores para poder diagnosticarlo.
  select (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = p_company_id and cm.user_id = v_user
        and cm.status = 'active' and cm.is_owner = true
    )
    or exists (
      select 1 from public.companies c
      where c.id = p_company_id and c.created_by = v_user
    )
  ) into v_is_owner;

  if not v_is_owner then
    select array_agg(distinct wid order by wid)
      into v_out_of_scope
    from unnest(p_warehouse_ids) as wid
    where not exists (
      select 1 from public.user_locations ul
      where ul.company_id = p_company_id
        and ul.user_id = v_user
        and ul.warehouse_id = wid
    );
    if coalesce(cardinality(v_out_of_scope),0) > 0 then
      raise exception 'warehouse_out_of_scope: almacenes fuera de tu alcance: %', array_to_string(v_out_of_scope, ', ');
    end if;
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

revoke all on function public.create_employee_pos_secure(uuid,uuid,text,text,numeric,uuid,uuid[],text) from public, anon;
grant execute on function public.create_employee_pos_secure(uuid,uuid,text,text,numeric,uuid,uuid[],text) to authenticated;

create or replace function public.create_device_access_invite(
  p_employee_id uuid,
  p_expires_in_days integer default 7
) returns text
language plpgsql security definer
set search_path to 'public', 'private', 'extensions', 'pg_temp'
as $$
declare
  v_user uuid := auth.uid();
  v_employee record;
  v_role_id uuid;
  v_warehouse_ids uuid[];
  v_days integer := least(greatest(coalesce(p_expires_in_days, 7), 1), 90);
  v_expires_at timestamptz;
  v_token text;
begin
  if v_user is null then raise exception 'authentication_required'; end if;

  select e.id, e.company_id, e.active, e.role_id
    into v_employee
  from public.employees e
  where e.id = p_employee_id;

  if not found then raise exception 'employee_not_found'; end if;

  if not exists (
    select 1 from public.company_memberships cm
    where cm.company_id = v_employee.company_id
      and cm.user_id = v_user
      and cm.status = 'active'
      and cm.is_owner
  ) and not private.has_permission(v_employee.company_id, 'employees.manage') then
    raise exception 'permission_denied';
  end if;

  if not v_employee.active then raise exception 'employee_inactive'; end if;
  if v_employee.role_id is null then raise exception 'employee_role_required'; end if;

  v_role_id := v_employee.role_id;

  -- Todos los almacenes asignados de la empresa, sin filtrar por `active`.
  select array_agg(a.warehouse_id order by a.is_default desc, a.warehouse_id)
    into v_warehouse_ids
  from public.employee_warehouse_access a
  join public.warehouses w
    on w.id = a.warehouse_id
   and w.company_id = v_employee.company_id
  where a.employee_id = v_employee.id
    and a.company_id = v_employee.company_id;

  if v_warehouse_ids is null or cardinality(v_warehouse_ids) = 0 then
    raise exception 'warehouse_required';
  end if;

  update public.device_access_invites
     set expires_at = timezone('utc', now())
   where employee_id = v_employee.id
     and used_at is null
     and expires_at > timezone('utc', now());

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  -- 0 o negativo: enlace sin caducidad (tiempo indefinido).
  if coalesce(p_expires_in_days, 7) <= 0 then
    v_expires_at := 'infinity'::timestamptz;
  else
    v_expires_at := timezone('utc', now()) + make_interval(days => v_days);
  end if;

  insert into public.device_access_invites(
    company_id, employee_id, token_hash, role_id, warehouse_ids,
    expires_at, created_by
  ) values (
    v_employee.company_id,
    v_employee.id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_role_id,
    v_warehouse_ids,
    v_expires_at,
    v_user
  );

  return v_token;
end;
$$;

revoke all on function public.create_device_access_invite(uuid, integer) from public, anon;
grant execute on function public.create_device_access_invite(uuid, integer) to authenticated;

commit;
