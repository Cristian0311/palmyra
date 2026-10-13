begin;

-- Offline PIN material is a purpose-derived PBKDF2 verifier, never a password
-- or the existing bcrypt hash. Rows are scoped to one company and one employee
-- or linked user identity. The private schema is not directly exposed via REST.
create table if not exists private.employee_pos_offline_verifiers (
  company_id uuid not null,
  subject_id uuid not null,
  salt text not null check (salt ~ '^(?:[0-9a-f]{2}){16}$'),
  verifier text not null check (verifier ~ '^(?:[0-9a-f]{2}){32}$'),
  iterations integer not null check (iterations between 100000 and 1000000),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (company_id, subject_id)
);

revoke all on table private.employee_pos_offline_verifiers from public, anon, authenticated;

create or replace function public.palmyra_store_offline_pos_verifier(
  p_company_id uuid,
  p_subject_id uuid,
  p_password text,
  p_salt text,
  p_verifier text,
  p_iterations integer default 310000
) returns jsonb
language plpgsql
security definer
set search_path to 'public','private','extensions','pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_employee public.employees%rowtype;
  v_hash text;
  v_valid boolean := false;
  v_is_manager boolean := false;
begin
  if v_actor is null then raise exception 'authentication_required'; end if;
  if p_company_id is null or p_subject_id is null then raise exception 'offline_credential_scope_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  v_is_manager := private.has_permission(p_company_id, 'employees.manage');
  if not v_is_manager and not exists (
    select 1 from public.company_memberships cm
    where cm.company_id=p_company_id and cm.user_id=v_actor
      and cm.is_owner=true and cm.status='active' and p_subject_id=v_actor
  ) and not exists (
    select 1 from public.employees e
    where e.company_id=p_company_id and e.active=true and e.user_id=v_actor
      and (p_subject_id=e.user_id or p_subject_id=e.id)
  ) then
    raise exception 'permission_denied';
  end if;

  if p_password is null or trim(p_password)='' then raise exception 'invalid_offline_credential'; end if;
  if p_salt !~ '^(?:[0-9a-f]{2}){16}$' or p_verifier !~ '^(?:[0-9a-f]{2}){32}$'
     or p_iterations < 100000 or p_iterations > 1000000 then
    raise exception 'invalid_offline_verifier_format';
  end if;

  -- Validate the plaintext supplied transiently by the just-authenticated client
  -- against the current server credential before accepting its PBKDF2 verifier.
  select cm.pos_password_hash into v_hash
  from public.company_memberships cm
  where cm.company_id=p_company_id and cm.user_id=p_subject_id
    and cm.is_owner=true and cm.status='active';
  if v_hash is not null then
    v_valid := v_hash = extensions.crypt(trim(p_password), v_hash);
  else
    select e.* into v_employee
    from public.employees e
    where e.company_id=p_company_id and e.active=true
      and (e.id=p_subject_id or e.user_id=p_subject_id)
    order by (e.id=p_subject_id) desc
    limit 1;

    if found and v_employee.user_id is not null then
      select u.encrypted_password into v_hash
      from auth.users u where u.id=v_employee.user_id;
      if v_hash is not null then
        v_valid := v_hash = extensions.crypt(trim(p_password), v_hash);
      end if;
    elsif found then
      select c.password_hash into v_hash
      from private.employee_pos_credentials c
      where c.employee_id=v_employee.id;
      if v_hash is not null then
        v_valid := v_hash = extensions.crypt(trim(p_password), v_hash);
      end if;
    end if;
  end if;

  if not coalesce(v_valid,false) then raise exception 'offline_credential_does_not_match_server'; end if;

  insert into private.employee_pos_offline_verifiers(company_id,subject_id,salt,verifier,iterations,updated_at)
  values(p_company_id,p_subject_id,lower(p_salt),lower(p_verifier),p_iterations,timezone('utc',now()))
  on conflict(company_id,subject_id) do update
    set salt=excluded.salt, verifier=excluded.verifier, iterations=excluded.iterations,
        updated_at=excluded.updated_at;

  return jsonb_build_object('success',true);
end;
$$;

create or replace function public.palmyra_get_offline_pos_verifiers(
  p_company_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id,'employees.manage') then
    raise exception 'permission_denied';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'subject_id',v.subject_id,
    'salt',v.salt,
    'verifier',v.verifier,
    'iterations',v.iterations,
    'updated_at',v.updated_at
  ) order by v.subject_id), '[]'::jsonb)
  into v_result
  from private.employee_pos_offline_verifiers v
  where v.company_id=p_company_id
    and (
      exists (
        select 1 from public.employees e
        where e.company_id=p_company_id and e.active=true
          and (e.id=v.subject_id or e.user_id=v.subject_id)
      )
      or exists (
        select 1 from public.company_memberships cm
        where cm.company_id=p_company_id and cm.user_id=v.subject_id
          and cm.is_owner=true and cm.status='active'
      )
    );

  return v_result;
end;
$$;

-- Invalidate synchronized offline credentials immediately when a stored POS
-- PIN or owner POS password is changed. The client then provisions the new
-- verifier only after validating the new credential successfully.
create or replace function private.invalidate_employee_offline_pos_verifier()
returns trigger
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $
declare
  v_employee_id uuid;
  v_employee public.employees%rowtype;
begin
  if tg_op = 'DELETE' then
    v_employee_id := old.employee_id;
  else
    v_employee_id := new.employee_id;
  end if;

  select * into v_employee
  from public.employees
  where id = v_employee_id;

  if found then
    delete from private.employee_pos_offline_verifiers
    where company_id=v_employee.company_id
      and subject_id in (v_employee.id, v_employee.user_id);
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$;

drop trigger if exists invalidate_employee_offline_pos_verifier
  on private.employee_pos_credentials;
create trigger invalidate_employee_offline_pos_verifier
after insert or update of password_hash or delete
on private.employee_pos_credentials
for each row execute function private.invalidate_employee_offline_pos_verifier();

create or replace function private.invalidate_owner_offline_pos_verifier()
returns trigger
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $
begin
  if old.pos_password_hash is distinct from new.pos_password_hash then
    delete from private.employee_pos_offline_verifiers
    where company_id=new.company_id and subject_id=new.user_id;
  end if;
  return new;
end;
$;

drop trigger if exists invalidate_owner_offline_pos_verifier
  on public.company_memberships;
create trigger invalidate_owner_offline_pos_verifier
after update of pos_password_hash on public.company_memberships
for each row execute function private.invalidate_owner_offline_pos_verifier();

create or replace function private.invalidate_employee_offline_pos_access()
returns trigger
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $
begin
  if tg_op = 'DELETE' then
    delete from private.employee_pos_offline_verifiers
    where company_id=old.company_id
      and subject_id in (old.id, old.user_id);
    return old;
  end if;

  if old.active is distinct from new.active or old.user_id is distinct from new.user_id then
    delete from private.employee_pos_offline_verifiers
    where company_id=old.company_id
      and subject_id in (old.id, old.user_id, new.id, new.user_id);
  end if;
  return new;
end;
$;

drop trigger if exists invalidate_employee_offline_pos_access
  on public.employees;
create trigger invalidate_employee_offline_pos_access
after update of active, user_id or delete on public.employees
for each row execute function private.invalidate_employee_offline_pos_access();

revoke all on function public.palmyra_store_offline_pos_verifier(uuid,uuid,text,text,text,integer) from public, anon;
revoke all on function public.palmyra_get_offline_pos_verifiers(uuid) from public, anon;
grant execute on function public.palmyra_store_offline_pos_verifier(uuid,uuid,text,text,text,integer) to authenticated;
grant execute on function public.palmyra_get_offline_pos_verifiers(uuid) to authenticated;

commit;
