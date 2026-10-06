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

  if not private.has_permission(p_company_id,'pos.access') then
    raise exception 'permission_denied';
  end if;

  select e.*
    into v_employee
  from public.employees e
  where e.company_id = p_company_id
    and e.active = true
    and (e.id = p_employee_id or e.user_id = p_employee_id)
  order by (e.id = p_employee_id) desc
  limit 1;

  if not found then return false; end if;

  if v_employee.user_id is not null then
    select u.encrypted_password
      into v_auth_hash
    from auth.users u
    where u.id = v_employee.user_id;

    if v_auth_hash is null then return false; end if;
    return v_auth_hash = extensions.crypt(trim(p_password), v_auth_hash);
  end if;

  select c.password_hash
    into v_hash
  from private.employee_pos_credentials c
  where c.employee_id = v_employee.id;

  if v_hash is null then return false; end if;
  return v_hash = extensions.crypt(trim(p_password), v_hash);
end;
$function$;

revoke all on function public.verify_employee_pos_password(uuid,uuid,text) from public, anon;
grant execute on function public.verify_employee_pos_password(uuid,uuid,text) to authenticated;
