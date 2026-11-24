begin;

-- ============================================================================
-- El rol de sistema "Empleado" debe poder editarse (nombre, descripción y
-- permisos) sin tocar a las demás empresas.
--
-- Cómo se guardan hoy los roles de sistema:
--   public.roles tiene `company_id = null` e `is_system = true` para las
--   plantillas globales (`admin`, `employee`). Lo confirman el onboarding y
--   la resolución de permisos, que buscan el rol con
--   `company_id is null and key='employee' and is_system`.
--
-- Estrategia elegida (la menos invasiva posible manteniendo el aislamiento):
--   * `admin` (y cualquier otro rol de sistema distinto de `employee`) sigue
--     bloqueado con `system_role_locked`.
--   * La primera vez que se edita el `employee` global se clona en un rol
--     propio de la empresa (`company_id = p_company_id`, misma key
--     `employee`, `is_system = true` para que siga siendo asignable sin
--     exigir `roles.manage`). La plantilla global NO se modifica.
--   * Las ediciones siguientes actualizan ese clon de la empresa.
--   * El clon se convierte en el rol operativo de la empresa: se reasignan
--     únicamente filas de ESA empresa (employees, user_roles e invitaciones
--     pendientes) que apuntaban a la plantilla global. Sin esta reasignación
--     el cambio de permisos sería cosmético para los empleados existentes.
--   * `company_id` e `is_system` nunca se actualizan; la key es inmutable
--     para roles existentes.
--
-- Se conservan intactas la guarda de escalada de privilegios, la comprobación
-- de plan y los grants/revokes de la versión anterior.
-- ============================================================================

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
  v_target_id uuid := v_role_id;
  v_key text := lower(trim(p_key));
  v_name text := trim(p_name);
  v_existing_company uuid;
  v_existing_key text;
  v_existing_is_system boolean := false;
  v_role_exists boolean := false;
  v_clone_from_global boolean := false;
  v_is_privileged boolean := false;
  v_requested_keys text[];
  v_denied_keys text[] := '{}'::text[];
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'roles.manage') then raise exception 'permission_denied'; end if;
  if not private.company_has_plan_feature(p_company_id,'roles') then raise exception 'plan_feature_required'; end if;

  -- --------------------------------------------------------------------------
  -- Resolver el rol existente (si viene id) y validar su pertenencia.
  -- --------------------------------------------------------------------------
  if p_role_id is not null then
    select r.company_id, r.key, r.is_system
      into v_existing_company, v_existing_key, v_existing_is_system
    from public.roles r
    where r.id = p_role_id;

    v_role_exists := found;
    if not v_role_exists then raise exception 'role_not_found_or_system'; end if;
    if v_existing_company is not null and v_existing_company <> p_company_id then
      raise exception 'role_not_found_or_system';
    end if;
    -- Un rol no-sistema no puede ser global.
    if v_existing_company is null and not v_existing_is_system then
      raise exception 'role_not_found_or_system';
    end if;
  end if;

  -- --------------------------------------------------------------------------
  -- La key es inmutable en roles existentes. Solo `employee` conserva su
  -- excepción de edición; `admin`, `owner` y cualquier otro rol de sistema
  -- quedan bloqueados.
  -- --------------------------------------------------------------------------
  if v_role_exists then
    if v_key <> v_existing_key then
      if v_existing_is_system then raise exception 'system_role_locked'; end if;
      raise exception 'role_key_immutable';
    end if;
  else
    if length(v_key)<2 or length(v_key)>60 or v_key !~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$' then
      raise exception 'invalid_role_key';
    end if;
    if v_key='admin' or v_key='employee' or v_key='owner' then
      raise exception 'reserved_role_key';
    end if;
  end if;
  if length(v_name)<2 or length(v_name)>100 then raise exception 'invalid_role_name'; end if;

  if v_role_exists and v_existing_is_system and v_existing_key <> 'employee' then
    raise exception 'system_role_locked';
  end if;

  -- --------------------------------------------------------------------------
  -- Primera edición del employee global: clonar en un rol de la empresa.
  -- Si ya existe el clon de la empresa, se reutiliza (idempotente).
  -- --------------------------------------------------------------------------
  if v_role_exists and v_existing_is_system and v_existing_company is null then
    select r.id
      into v_target_id
    from public.roles r
    where r.company_id = p_company_id
      and r.key = 'employee'
    order by r.is_system desc
    limit 1;

    if v_target_id is null then
      v_target_id := gen_random_uuid();
      v_clone_from_global := true;
    end if;
  end if;

  if exists(
    select 1 from public.roles r
    where r.company_id=p_company_id and r.key=v_key and r.id<>v_target_id
  ) then
    raise exception 'role_key_taken';
  end if;
  if exists(
    select 1 from public.roles r
    where r.company_id=p_company_id and lower(r.name)=lower(v_name) and r.id<>v_target_id
  ) then
    raise exception 'role_name_taken';
  end if;

  if exists(
    select 1
    from unnest(coalesce(p_permission_keys,'{}'::text[])) k
    where not exists(select 1 from public.permissions p where p.key=private.normalize_permission_key(k))
  ) then
    raise exception 'invalid_permission';
  end if;

  -- --------------------------------------------------------------------------
  -- Guarda de escalada (sin cambios): el set resultante no puede contener
  -- permisos que el llamador no posea. Se calcula antes de escribir.
  -- --------------------------------------------------------------------------
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

  -- --------------------------------------------------------------------------
  -- Escritura. Nunca se modifican company_id ni is_system.
  -- --------------------------------------------------------------------------
  if v_clone_from_global then
    insert into public.roles(id,company_id,key,name,description,is_system)
    values(v_target_id,p_company_id,v_key,v_name,nullif(trim(p_description),''),true);
  elsif not v_role_exists then
    insert into public.roles(id,company_id,key,name,description,is_system)
    values(v_target_id,p_company_id,v_key,v_name,nullif(trim(p_description),''),false);
  else
    update public.roles
       set name=v_name,
           description=nullif(trim(p_description),'')
     where id=v_target_id
       and company_id=p_company_id
       and (is_system=false or key='employee');
    if not found then raise exception 'system_role_locked'; end if;
    delete from public.role_permissions where role_id=v_target_id;
  end if;

  insert into public.role_permissions(role_id,permission_id)
  select v_target_id,p.id
  from public.permissions p
  where p.key=any(
    coalesce(
      array(select private.normalize_permission_key(x) from unnest(coalesce(p_permission_keys,'{}'::text[])) x),
      '{}'::text[]
    )
  );

  -- --------------------------------------------------------------------------
  -- El clon pasa a ser el rol operativo de la empresa. Solo se reasignan
  -- referencias de ESTA empresa a la plantilla global; otras empresas no se
  -- tocan (la plantilla global permanece intacta).
  -- --------------------------------------------------------------------------
  if v_clone_from_global then
    update public.employees e
       set role_id = v_target_id,
           updated_at = timezone('utc',now())
     where e.company_id = p_company_id
       and e.role_id = p_role_id;

    insert into public.user_roles(user_id,company_id,role_id)
    select ur.user_id, ur.company_id, v_target_id
    from public.user_roles ur
    where ur.company_id = p_company_id
      and ur.role_id = p_role_id
    on conflict do nothing;

    delete from public.user_roles ur
     where ur.company_id = p_company_id
       and ur.role_id = p_role_id;

    update public.company_invitations ci
       set role_id = v_target_id,
           updated_at = timezone('utc',now())
     where ci.company_id = p_company_id
       and ci.role_id = p_role_id
       and ci.status = 'pending';
  end if;

  return jsonb_build_object('id',v_target_id,'key',v_key,'name',v_name);
exception when unique_violation then
  raise exception 'role_already_exists';
end;
$function$;

revoke all on function public.upsert_company_role(uuid,uuid,text,text,text,text[]) from public, anon;
grant execute on function public.upsert_company_role(uuid,uuid,text,text,text,text[]) to authenticated;

commit;
