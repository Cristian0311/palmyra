begin;

-- Offline POS credential sync:
-- managers may prefetch every active employee's PBKDF2 verifier;
-- ordinary POS users may prefetch only their own employee verifier.
-- No plaintext passwords or server-side password hashes are exposed.
create or replace function public.palmyra_get_offline_pos_verifiers(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_actor uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
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
    'subject_id', aliases.subject_id,
    'salt', v.salt,
    'verifier', v.verifier,
    'iterations', v.iterations,
    'updated_at', v.updated_at
  ) order by aliases.subject_id), '[]'::jsonb)
  into v_result
  from private.employee_pos_offline_verifiers v
  cross join lateral (
    select v.subject_id as subject_id
    union
    select e.user_id
    from public.employees e
    where e.company_id = p_company_id
      and e.active = true
      and e.id = v.subject_id
      and e.user_id is not null
    union
    select e.id
    from public.employees e
    where e.company_id = p_company_id
      and e.active = true
      and e.user_id = v.subject_id
  ) aliases
  where v.company_id = p_company_id
    and (
      -- Employee managers can provision the shared offline employee directory.
      coalesce(v_can_manage,false)
      -- An ordinary POS user receives only their own linked employee verifier
      -- (matched by stable auth user id or employee login email).
      or v.subject_id = v_actor
      or exists (
        select 1
        from public.employees e
        where e.company_id = p_company_id
          and e.active = true
          and (e.user_id = v_actor or
               (v_email <> '' and lower(coalesce(e.login_email,'')) = v_email))
          and v.subject_id in (e.id, e.user_id)
      )
      or exists (
        select 1
        from public.company_memberships cm
        where cm.company_id = p_company_id
          and cm.user_id = v_actor
          and cm.is_owner = true
          and cm.status = 'active'
      )
    )
    and (
      coalesce(v_can_manage,false)
      or exists (
        select 1
        from public.employees e
        where e.company_id = p_company_id
          and e.active = true
          and (e.user_id = v_actor or
               (v_email <> '' and lower(coalesce(e.login_email,'')) = v_email))
          and v.subject_id in (e.id, e.user_id)
      )
      or v.subject_id = v_actor
    );

  return v_result;
end;
$function$;

revoke all on function public.palmyra_get_offline_pos_verifiers(uuid) from public, anon;
grant execute on function public.palmyra_get_offline_pos_verifiers(uuid) to authenticated;

commit;
