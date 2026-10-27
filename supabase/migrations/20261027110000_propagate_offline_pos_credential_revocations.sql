begin;

-- Explicit tombstones allow a connected POS to learn that a cached offline
-- credential was invalidated. Missing verifier rows in a snapshot are not
-- treated as revocations, so incomplete sync does not break offline access.
create table if not exists private.employee_pos_offline_credential_revocations (
  company_id uuid not null,
  subject_id uuid not null,
  revoked_at timestamptz not null default timezone('utc', now()),
  primary key (company_id, subject_id)
);
revoke all on table private.employee_pos_offline_credential_revocations from public, anon, authenticated;

-- A newly provisioned verifier replaces a prior tombstone for that identity.
create or replace function private.clear_employee_offline_pos_revocation()
returns trigger
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
begin
  delete from private.employee_pos_offline_credential_revocations
  where company_id = new.company_id and subject_id = new.subject_id;
  return new;
end;
$function$;

drop trigger if exists clear_employee_offline_pos_revocation
  on private.employee_pos_offline_verifiers;
create trigger clear_employee_offline_pos_revocation
after insert or update on private.employee_pos_offline_verifiers
for each row execute function private.clear_employee_offline_pos_revocation();

create or replace function private.invalidate_employee_offline_pos_verifier()
returns trigger
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
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
    insert into private.employee_pos_offline_credential_revocations(company_id, subject_id, revoked_at)
    values (v_employee.company_id, v_employee.id, timezone('utc', now()))
    on conflict (company_id, subject_id) do update set revoked_at = excluded.revoked_at;
    if v_employee.user_id is not null then
      insert into private.employee_pos_offline_credential_revocations(company_id, subject_id, revoked_at)
      values (v_employee.company_id, v_employee.user_id, timezone('utc', now()))
      on conflict (company_id, subject_id) do update set revoked_at = excluded.revoked_at;
    end if;

    delete from private.employee_pos_offline_verifiers
    where company_id = v_employee.company_id
      and subject_id in (v_employee.id, v_employee.user_id);
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

create or replace function private.invalidate_auth_user_offline_pos_verifiers()
returns trigger
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
begin
  if old.encrypted_password is distinct from new.encrypted_password then
    insert into private.employee_pos_offline_credential_revocations(company_id, subject_id, revoked_at)
    select scoped.company_id, scoped.subject_id, timezone('utc', now())
    from (
      select e.company_id, e.id as subject_id
      from public.employees e where e.user_id = new.id
      union
      select e.company_id, e.user_id as subject_id
      from public.employees e where e.user_id = new.id
      union
      select cm.company_id, cm.user_id as subject_id
      from public.company_memberships cm
      where cm.user_id = new.id and cm.is_owner = true
    ) scoped
    where scoped.subject_id is not null
    on conflict (company_id, subject_id) do update set revoked_at = excluded.revoked_at;

    delete from private.employee_pos_offline_verifiers v
    where v.subject_id = new.id
       or exists (
         select 1 from public.employees e
         where e.company_id = v.company_id and e.user_id = new.id
           and v.subject_id in (e.id, e.user_id)
       )
       or exists (
         select 1 from public.company_memberships cm
         where cm.company_id = v.company_id and cm.user_id = new.id
           and cm.is_owner = true
       );
  end if;
  return new;
end;
$function$;

create or replace function private.invalidate_employee_offline_pos_access()
returns trigger
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
begin
  if tg_op = 'DELETE' then
    insert into private.employee_pos_offline_credential_revocations(company_id, subject_id, revoked_at)
    select old.company_id, ids.subject_id, timezone('utc', now())
    from (
      select old.id as subject_id
      union select old.user_id
    ) ids
    where ids.subject_id is not null
    on conflict (company_id, subject_id) do update set revoked_at = excluded.revoked_at;

    delete from private.employee_pos_offline_verifiers
    where company_id = old.company_id
      and subject_id in (old.id, old.user_id);
    return old;
  end if;

  if old.active is distinct from new.active or old.user_id is distinct from new.user_id then
    insert into private.employee_pos_offline_credential_revocations(company_id, subject_id, revoked_at)
    select new.company_id, ids.subject_id, timezone('utc', now())
    from (
      select old.id as subject_id
      union select old.user_id
      union select new.id
      union select new.user_id
    ) ids
    where ids.subject_id is not null
    on conflict (company_id, subject_id) do update set revoked_at = excluded.revoked_at;

    delete from private.employee_pos_offline_verifiers
    where company_id = old.company_id
      and subject_id in (old.id, old.user_id, new.id, new.user_id);
  end if;
  return new;
end;
$function$;

-- Expose active verifier records and explicit revocation tombstones to an
-- authorized POS operator. The verifier remains bound to its original subject
-- ID; synthesizing aliases breaks the PBKDF2 domain separator.
create or replace function public.palmyra_get_offline_pos_verifiers(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_actor uuid := auth.uid();
  v_can_manage boolean;
  v_can_pos boolean;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'authentication_required';
  end if;
  if p_company_id is null or not private.has_company_access(p_company_id) then
    raise exception 'company_access_denied';
  end if;

  v_can_manage := private.has_permission(p_company_id, 'employees.manage');
  v_can_pos := private.has_permission(p_company_id, 'pos.access');
  if not coalesce(v_can_manage,false) and not coalesce(v_can_pos,false) then
    raise exception 'permission_denied';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'subject_id', q.subject_id,
    'salt', q.salt,
    'verifier', q.verifier,
    'iterations', q.iterations,
    'updated_at', q.updated_at,
    'revoked', q.revoked
  ) order by q.subject_id), '[]'::jsonb)
  into v_result
  from (
    select v.subject_id, v.salt, v.verifier, v.iterations, v.updated_at, false as revoked
    from private.employee_pos_offline_verifiers v
    where v.company_id = p_company_id
      and (
        exists (
          select 1 from public.employees e
          where e.company_id = p_company_id and e.active = true
            and (e.id = v.subject_id or e.user_id = v.subject_id)
        )
        or exists (
          select 1 from public.company_memberships cm
          where cm.company_id = p_company_id and cm.user_id = v.subject_id
            and cm.status = 'active'
            and (
              cm.is_owner = true
              or exists (
                select 1 from public.user_roles ur
                join public.roles r on r.id = ur.role_id
                where ur.company_id = cm.company_id
                  and ur.user_id = cm.user_id
                  and r.key = 'admin'
              )
            )
        )
      )
    union all
    select r.subject_id, null::text as salt, null::text as verifier,
      null::integer as iterations, r.revoked_at as updated_at, true as revoked
    from private.employee_pos_offline_credential_revocations r
    where r.company_id = p_company_id
      and not exists (
        select 1 from private.employee_pos_offline_verifiers v
        where v.company_id = r.company_id and v.subject_id = r.subject_id
          and (
            exists (
              select 1 from public.employees e
              where e.company_id = r.company_id and e.active = true
                and (e.id = v.subject_id or e.user_id = v.subject_id)
            )
            or exists (
              select 1 from public.company_memberships cm
              where cm.company_id = r.company_id and cm.user_id = v.subject_id
                and cm.status = 'active'
                and (cm.is_owner = true or exists (
                  select 1 from public.user_roles ur
                  join public.roles ro on ro.id = ur.role_id
                  where ur.company_id = cm.company_id and ur.user_id = cm.user_id
                    and ro.key = 'admin'
                ))
            )
          )
      )
  ) q;

  return v_result;
end;
$function$;

revoke all on function public.palmyra_get_offline_pos_verifiers(uuid) from public, anon;
grant execute on function public.palmyra_get_offline_pos_verifiers(uuid) to authenticated;

commit;
