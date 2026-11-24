-- PALMYRA device access: caducidad configurable del enlace
--
-- create_device_access_invite gana la opción "sin caducidad": con
-- p_expires_in_days <= 0 el enlace no caduca (expires_at = infinity,
-- que las comparaciones exists_at > now() respetan). Sin el parámetro
-- sigue el valor anterior (7 días). La firma (uuid, integer) no cambia,
-- así que el grant existente se conserva.
--
-- Reversa: volver a crear la función con la definición de
-- 20261124160000_device_access_invites.sql.

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

  select array_agg(a.warehouse_id order by a.is_default desc, a.warehouse_id)
    into v_warehouse_ids
  from public.employee_warehouse_access a
  join public.warehouses w
    on w.id = a.warehouse_id
   and w.company_id = v_employee.company_id
   and w.active
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
