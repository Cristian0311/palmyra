begin;

-- Provide legacy POS-only PIN hashes to an authorized company manager's offline
-- cache. These are one-way bcrypt hashes, not cleartext passwords and never
-- auth.users hashes. Newer provisioned PBKDF2 verifiers take precedence.
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

  select coalesce(jsonb_agg(items.entry order by items.subject_id), '[]'::jsonb)
  into v_result
  from (
    select jsonb_build_object(
      'kind','pbkdf2',
      'subject_id',v.subject_id,
      'salt',v.salt,
      'verifier',v.verifier,
      'iterations',v.iterations,
      'updated_at',v.updated_at
    ) as entry, v.subject_id
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
      )

    union all

    select jsonb_build_object(
      'kind','bcrypt',
      'subject_id',e.id,
      'bcrypt_hash',c.password_hash,
      'updated_at',c.updated_at
    ) as entry, e.id as subject_id
    from public.employees e
    join private.employee_pos_credentials c on c.employee_id=e.id
    where e.company_id=p_company_id
      and e.active=true
      and e.user_id is null
      and not exists (
        select 1
        from private.employee_pos_offline_verifiers v
        where v.company_id=p_company_id and v.subject_id=e.id
      )
  ) as items;

  return v_result;
end;
$$;

revoke all on function public.palmyra_get_offline_pos_verifiers(uuid) from public, anon;
grant execute on function public.palmyra_get_offline_pos_verifiers(uuid) to authenticated;

commit;
