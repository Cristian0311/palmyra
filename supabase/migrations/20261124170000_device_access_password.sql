-- PALMYRA device access: verificación del enlace + contraseña POS
--
-- El propietario genera el enlace (public.create_device_access_invite) y el
-- trabajador debe escribir la contraseña POS que el administrador configuró
-- (private.employee_pos_credentials). Esta función NO consume el enlace: el
-- canje (used_at) ocurre al final, cuando la edge function ya provisionó la
-- identidad del dispositivo. Así una contraseña equivocada no quema el enlace.
--
-- Acceso: solo service_role. Ni anon ni authenticated pueden llamarla.

create or replace function public.verify_device_access_invite(
  p_token text,
  p_password text
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'extensions', 'pg_temp'
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_token text := nullif(btrim(coalesce(p_token, '')), '');
  v_password text := nullif(btrim(coalesce(p_password, '')), '');
  v_invite public.device_access_invites%rowtype;
  v_employee record;
  v_company record;
  v_hash text;
begin
  if v_token is null then
    raise exception 'device_link_invalid';
  end if;

  select i.* into v_invite
  from public.device_access_invites i
  where i.token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex');

  if not found then
    raise exception 'device_link_invalid';
  end if;

  -- El orden importa: usado > caducado > empleado/empresa > contraseña.
  if v_invite.used_at is not null then
    raise exception 'device_link_used';
  end if;

  if v_invite.expires_at is null or v_invite.expires_at <= v_now then
    raise exception 'device_link_expired';
  end if;

  select e.id, e.company_id, e.full_name, e.active, e.user_id, e.role_id
    into v_employee
  from public.employees e
  where e.id = v_invite.employee_id
    and e.company_id = v_invite.company_id;

  if not found then
    raise exception 'device_link_invalid';
  end if;

  if v_employee.active is not true then
    raise exception 'employee_inactive';
  end if;

  select c.id, c.active, c.account_status
    into v_company
  from public.companies c
  where c.id = v_invite.company_id;

  if not found
     or v_company.active is not true
     or coalesce(v_company.account_status, '') = 'suspended' then
    raise exception 'company_inactive';
  end if;

  if v_password is null then
    raise exception 'pos_password_required';
  end if;

  -- La contraseña canónica es la que configuró el administrador en el POS
  -- (private.employee_pos_credentials). Solo si esa credencial no existe se
  -- usa la cuenta auth vinculada: tras el primer canje el empleado apunta a un
  -- usuario sintético con contraseña aleatoria, que nunca debe pedirse aquí.
  select c.password_hash into v_hash
  from private.employee_pos_credentials c
  where c.employee_id = v_employee.id;

  if (v_hash is null or v_hash = '') and v_employee.user_id is not null then
    select u.encrypted_password into v_hash
    from auth.users u
    where u.id = v_employee.user_id;
  end if;

  if v_hash is null or v_hash = '' then
    raise exception 'pos_password_invalid';
  end if;

  if v_hash <> extensions.crypt(v_password, v_hash) then
    raise exception 'pos_password_invalid';
  end if;

  return jsonb_build_object(
    'invite_id', v_invite.id,
    'company_id', v_invite.company_id,
    'employee_id', v_employee.id,
    'full_name', coalesce(v_employee.full_name, 'Empleado PALMYRA'),
    'role_id', coalesce(v_invite.role_id, v_employee.role_id),
    'warehouse_ids', to_jsonb(coalesce(v_invite.warehouse_ids, '{}'::uuid[]))
  );
end;
$$;

revoke all on function public.verify_device_access_invite(text, text) from public, anon, authenticated;
grant execute on function public.verify_device_access_invite(text, text) to service_role;
