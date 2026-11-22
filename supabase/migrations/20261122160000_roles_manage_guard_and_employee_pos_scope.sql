begin;

-- ============================================================================
-- Endurecimiento de privilegios pendientes de auditoría:
--   1) `roles.manage` permitía repartir permisos que el propio llamador no
--      tenía (escalada de privilegios vía roles a medida).
--   2) `create_employee_pos_secure` permitía reasignar el alcance de almacenes
--      de un empleado a sucursales que el supervisor no opera.
-- Ambas funciones se reproducen tal cual están hoy (migración 20261013000000)
-- y solo se les añaden las guardas; no se reescribe lógica no relacionada.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 2) Alcance de almacenes del empleado contra el alcance real del llamador.
--    Un usuario con `employees.manage` podía mover a un empleado (y con él su
--    sesión POS) a cualquier almacén de la empresa. Se exige que cada almacén
--    solicitado esté en `user_locations` del llamador, que es la fuente que ya
--    usan las RPC de sucursal (p. ej. palmyra_list_open_cash_sessions). El
--    propietario conserva el bypass histórico porque el cliente le resuelve el
--    alcance por defecto cuando no tiene ubicaciones registradas.
-- ----------------------------------------------------------------------------
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

  if (
    select count(*)
    from public.warehouses w
    where w.id = any(p_warehouse_ids)
      and w.company_id = p_company_id
      and w.active
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

-- ----------------------------------------------------------------------------
-- 1) `roles.manage` sin escalada de privilegios.
--    La RPC reemplaza por completo el set de permisos del rol (delete + insert),
--    así que la comprobación se hace sobre el set resultante: cada clave debe
--    estar efectivamente en manos del llamador. Se usa private.has_permission
--    para respetar la misma resolución que el resto del backend (roles de
--    usuario, roles de empleado y gates de plan). Propietario y rol maestro
--    `admin` mantienen el bypass ya existente.
--    `roles.manage` NO se trata como owner-only: hoy es un permiso normal con
--    gate de plan (`company_has_plan_feature(...,'roles')`) y la clave `admin`
--    es la que está reservada para el rol de sistema. Por eso no se añade una
--    prohibición extra sobre él: quien ya lo posee puede delegarlo, pero quien
--    no lo posee no puede otorgárselo a nadie.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_company_role(
  p_company_id uuid,
  p_role_id uuid,
  p_key text,
  p_name text,
  p_description text,
  p_permission_keys text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
declare
  v_role_id uuid := coalesce(p_role_id, gen_random_uuid());
  v_key text := lower(trim(p_key));
  v_name text := trim(p_name);
  v_existing_company uuid;
  v_role_exists boolean := false;
  v_is_privileged boolean := false;
  v_requested_keys text[];
  v_denied_keys text[] := '{}'::text[];
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'roles.manage') then raise exception 'permission_denied'; end if;
  if not private.company_has_plan_feature(p_company_id,'roles') then raise exception 'plan_feature_required'; end if;

  if length(v_key)<2 or length(v_key)>60 or v_key !~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$' then
    raise exception 'invalid_role_key';
  end if;
  if v_key='admin' or v_key='employee' then raise exception 'reserved_role_key'; end if;
  if length(v_name)<2 or length(v_name)>100 then raise exception 'invalid_role_name'; end if;

  select r.company_id into v_existing_company from public.roles r where r.id=v_role_id;
  v_role_exists := found;
  if p_role_id is not null and v_role_exists and
     (v_existing_company is null or v_existing_company<>p_company_id) then
    raise exception 'role_not_found_or_system';
  end if;

  if exists(select 1 from public.roles r where r.company_id=p_company_id and r.key=v_key and r.id<>v_role_id) then
    raise exception 'role_key_taken';
  end if;
  if exists(select 1 from public.roles r where r.company_id=p_company_id and lower(r.name)=lower(v_name) and r.id<>v_role_id) then
    raise exception 'role_name_taken';
  end if;

  if exists(
    select 1
    from unnest(coalesce(p_permission_keys,'{}'::text[])) k
    where not exists(select 1 from public.permissions p where p.key=private.normalize_permission_key(k))
  ) then
    raise exception 'invalid_permission';
  end if;

  -- Guarda de escalada: el set resultante no puede contener permisos que el
  -- llamador no tenga. Se calcula ANTES de tocar public.role_permissions para
  -- que un fallo no deje el rol a medio actualizar (la transacción aborta).
  select (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = p_company_id and cm.user_id = auth.uid()
        and cm.status = 'active' and cm.is_owner = true
    )
    or exists (
      select 1
      from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.company_id = p_company_id and ur.user_id = auth.uid()
        and r.is_system and r.key = 'admin'
    )
    or exists (
      select 1 from public.companies c
      where c.id = p_company_id and c.created_by = auth.uid()
    )
  ) into v_is_privileged;

  v_requested_keys := array(
    select distinct private.normalize_permission_key(k)
    from unnest(coalesce(p_permission_keys,'{}'::text[])) k
  );

  if not v_is_privileged then
    v_denied_keys := array(
      select k
      from unnest(v_requested_keys) k
      where not private.has_permission(p_company_id,k)
    );
  end if;

  if cardinality(v_denied_keys) > 0 then
    raise exception 'permission_grant_denied: no puedes otorgar permisos que no posees: %', array_to_string(v_denied_keys, ', ');
  end if;

  if p_role_id is null or not v_role_exists then
    insert into public.roles(id,company_id,key,name,description,is_system)
    values(v_role_id,p_company_id,v_key,v_name,nullif(trim(p_description),''),false);
  else
    update public.roles
    set key=v_key,name=v_name,description=nullif(trim(p_description),'')
    where id=v_role_id and company_id=p_company_id and is_system=false;
    if not found then raise exception 'role_not_found_or_system'; end if;
    delete from public.role_permissions where role_id=v_role_id;
  end if;

  insert into public.role_permissions(role_id,permission_id)
  select v_role_id,p.id
  from public.permissions p
  where p.key=any(
    coalesce(
      array(select private.normalize_permission_key(x) from unnest(coalesce(p_permission_keys,'{}'::text[])) x),
      '{}'::text[]
    )
  );

  return jsonb_build_object('id',v_role_id,'key',v_key,'name',v_name);
exception when unique_violation then
  raise exception 'role_already_exists';
end;
$function$;

revoke all on function public.upsert_company_role(uuid,uuid,text,text,text,text[]) from public, anon;
grant execute on function public.upsert_company_role(uuid,uuid,text,text,text,text[]) to authenticated;

commit;
