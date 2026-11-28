-- PALMYRA: UN solo enlace de acceso vivo por trabajador, sin enlaces muertos en pantalla.
--
-- El dueño genera un enlace en un móvil y en el otro ve «otro enlace con otra
-- caducidad». La causa eran dos cosas: la preferencia vivía solo en estado de React
-- (cada dispositivo arrancaba en 7 días) y `create_device_access_invite` expiraba
-- TODAS las pendientes del empleado al crear la siguiente, sin avisar. Además la app
-- no podía comprobar nada: la tabla está con RLS y sin políticas.
--
-- Reglas que deja esta migración (decisión del dueño, 2026-11-28):
-- 1) UN enlace vivo por trabajador. Si ya hay uno, la RPC responde
--    `device_link_exists` y el UI obliga a revocarlo antes de generar otro.
-- 2) Revocar = ELIMINAR la fila del enlace pendiente. Un enlace muerto no debe
--    quedar ni a la vista ni en la base.
-- 3) Los enlaces caducados y nunca usados se borran (purga) al listar, al crear y al
--    revocar, así que Equipo solo muestra enlaces activos.
-- 4) `0 -> 'infinity'` sigue siendo «sin caducidad».
-- 5) `list_device_access_links` devuelve el estado real (creación y caducidad) sin
--    revelar jamás el token ni su hash.
--
-- El canje no cambia: `verify_device_access_invite` busca por `token_hash` y responde
-- `device_link_expired` mientras la fila exista (si ya fue purgada, responde
-- `device_link_invalid`). En los dos casos el dispositivo recibe un motivo real.
--
-- Reversible: `drop function` de las dos nuevas y restaurar
-- create_device_access_invite desde 20261126120000.

begin;

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
  v_live integer := 0;
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

  -- Purga: un enlace vencido que nadie usó ya no sirve para nada.
  delete from public.device_access_invites
   where employee_id = v_employee.id
     and company_id = v_employee.company_id
     and used_at is null
     and expires_at <= timezone('utc', now());

  -- Un solo enlace vivo: el anterior se revoca (se elimina) antes de crear otro.
  select count(*)
    into v_live
  from public.device_access_invites i
  where i.employee_id = v_employee.id
    and i.company_id = v_employee.company_id
    and i.used_at is null
    and i.expires_at > timezone('utc', now());

  if v_live >= 1 then raise exception 'device_link_exists'; end if;

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

-- ----------------------------------------------------------------------------
-- list_device_access_links
--   Solo los enlaces ACTIVOS del trabajador, con su caducidad real. Primero purga
--   los vencidos nunca usados (por eso desaparecen de la lista sin borrarlos a
--   mano) y nunca devuelve el token ni su hash: el secreto solo se ve al crearlo.
-- ----------------------------------------------------------------------------
create or replace function public.list_device_access_links(p_employee_id uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'private', 'extensions', 'pg_temp'
as $$
declare
  v_user uuid := auth.uid();
  v_employee record;
  v_links jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;

  select e.id, e.company_id
    into v_employee
  from public.employees e
  where e.id = p_employee_id;

  if not found then raise exception 'employee_not_found'; end if;

  -- Mismo candado que create_device_access_invite. La empresa sale del empleado,
  -- nunca de un parámetro del cliente.
  if not exists (
    select 1 from public.company_memberships cm
    where cm.company_id = v_employee.company_id
      and cm.user_id = v_user
      and cm.status = 'active'
      and cm.is_owner
  ) and not private.has_permission(v_employee.company_id, 'employees.manage') then
    raise exception 'permission_denied';
  end if;

  delete from public.device_access_invites
   where employee_id = v_employee.id
     and company_id = v_employee.company_id
     and used_at is null
     and expires_at <= timezone('utc', now());

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id,
           'created_at', l.created_at,
           'expires_at', l.expires_at,
           'used_at', l.used_at,
           'used_by_device', l.used_by_device
         ) order by l.created_at desc), '[]'::jsonb)
    into v_links
  from (
    select i.id, i.created_at, i.expires_at, i.used_at, i.used_by_device
      from public.device_access_invites i
     where i.employee_id = v_employee.id
       and i.company_id = v_employee.company_id
       -- En pantalla solo cuentan los vivos: el usado ya dejó de ser un enlace
       -- útil y el vencido se purgó arriba.
       and i.used_at is null
       and i.expires_at > timezone('utc', now())
     order by i.created_at desc
     limit 20
  ) l;

  return v_links;
end;
$$;

revoke all on function public.list_device_access_links(uuid) from public, anon;
grant execute on function public.list_device_access_links(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- revoke_device_access_links
--   Elimina los enlaces pendientes indicados del empleado. Solo filas de la
--   empresa derivada del empleado; un id de otra empresa se ignora sin revelar
--   nada. Un enlace ya canjeado NO se borra: es el rastro de qué dispositivo se
--   activó con él.
-- ----------------------------------------------------------------------------
create or replace function public.revoke_device_access_links(
  p_employee_id uuid,
  p_ids uuid[]
) returns integer
language plpgsql security definer
set search_path to 'public', 'private', 'extensions', 'pg_temp'
as $$
declare
  v_user uuid := auth.uid();
  v_employee record;
  v_revoked integer;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;

  select e.id, e.company_id
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

  -- Revocar = eliminar: el enlace deja de existir y su token no canjea nunca más.
  delete from public.device_access_invites
   where employee_id = v_employee.id
     and company_id = v_employee.company_id
     and id = any (p_ids)
     and used_at is null;

  get diagnostics v_revoked = row_count;

  delete from public.device_access_invites
   where employee_id = v_employee.id
     and company_id = v_employee.company_id
     and used_at is null
     and expires_at <= timezone('utc', now());

  return v_revoked;
end;
$$;

revoke all on function public.revoke_device_access_links(uuid, uuid[]) from public, anon;
grant execute on function public.revoke_device_access_links(uuid, uuid[]) to authenticated;

commit;
