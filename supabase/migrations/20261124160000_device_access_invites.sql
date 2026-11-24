-- PALMYRA device access invites
-- El propietario/admin genera un enlace de un solo uso; el PC/APK que lo abre
-- queda vinculado al empleado sin registro por correo. El token en claro nunca
-- se guarda: solo su digest sha256, igual que company_invitations.
--
-- Acceso: la tabla queda con RLS activo y SIN políticas (ni grants de cliente).
-- Solo la RPC (security definer) y la edge function con service-role la tocan.

create table if not exists public.device_access_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  token_hash text not null unique,
  role_id uuid references public.roles(id),
  warehouse_ids uuid[] not null default '{}'::uuid[],
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_device text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists device_access_invites_employee_idx
  on public.device_access_invites(employee_id, used_at, expires_at desc);

create index if not exists device_access_invites_company_idx
  on public.device_access_invites(company_id, created_at desc);

alter table public.device_access_invites enable row level security;

-- Sin políticas no hay acceso por RLS; se retiran además los grants heredados
-- de los privilegios por defecto de Supabase para clientes anon/authenticated.
revoke all on table public.device_access_invites from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- create_device_access_invite
--   Devuelve el token en claro UNA sola vez; caduca las invitaciones previas
--   no usadas del mismo empleado y copia rol + almacenes asignados.
-- ----------------------------------------------------------------------------
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
  v_token text;
begin
  if v_user is null then raise exception 'authentication_required'; end if;

  select e.id, e.company_id, e.active, e.role_id
    into v_employee
  from public.employees e
  where e.id = p_employee_id;

  if not found then raise exception 'employee_not_found'; end if;

  -- Mismo patrón de permisos del repo: propietario o `employees.manage`
  -- (que ya resuelve roles de sistema, roles de empresa y gates de plan).
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

  -- Copia el alcance real del empleado (misma fuente que create_employee_pos_secure).
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

  -- Un enlace nuevo invalida cualquier enlace anterior aún pendiente.
  update public.device_access_invites
     set expires_at = timezone('utc', now())
   where employee_id = v_employee.id
     and used_at is null
     and expires_at > timezone('utc', now());

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.device_access_invites(
    company_id, employee_id, token_hash, role_id, warehouse_ids,
    expires_at, created_by
  ) values (
    v_employee.company_id,
    v_employee.id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_role_id,
    v_warehouse_ids,
    timezone('utc', now()) + make_interval(days => v_days),
    v_user
  );

  return v_token;
end;
$$;

revoke all on function public.create_device_access_invite(uuid, integer) from public, anon;
grant execute on function public.create_device_access_invite(uuid, integer) to authenticated;
