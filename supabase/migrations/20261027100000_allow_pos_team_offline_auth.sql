begin;

-- Allow any authenticated POS operator to prepare this device for team-wide
-- offline login. Only verifier material (PBKDF2 salt/hash/iterations) is returned,
-- never the employee PIN or the canonical server password hash.
--
-- Security trade-off: a device with team-wide offline login holds verifier
-- records for active staff. PBKDF2's high work factor and client-side lockout
-- make guessing harder, but cannot provide the same protection as server-side
-- rate limiting while the device is disconnected. Keep POS devices physically
-- controlled and use non-trivial employee PINs/passwords.
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

  -- Return only each original subject ID. Do not synthesize alias rows: the
  -- verifier is derived with that exact ID as part of its domain separator, so
  -- copying it to another ID would make offline validation fail.
  select coalesce(jsonb_agg(jsonb_build_object(
    'subject_id', v.subject_id,
    'salt', v.salt,
    'verifier', v.verifier,
    'iterations', v.iterations,
    'updated_at', v.updated_at
  ) order by v.subject_id), '[]'::jsonb)
  into v_result
  from private.employee_pos_offline_verifiers v
  where v.company_id = p_company_id
    and (
      exists (
        select 1
        from public.employees e
        where e.company_id = p_company_id
          and e.active = true
          and (e.id = v.subject_id or e.user_id = v.subject_id)
      )
      or exists (
        select 1
        from public.company_memberships cm
        where cm.company_id = p_company_id
          and cm.user_id = v.subject_id
          and cm.status = 'active'
          and (
            cm.is_owner = true
            or exists (
              select 1
              from public.user_roles ur
              join public.roles r on r.id = ur.role_id
              where ur.company_id = cm.company_id
                and ur.user_id = cm.user_id
                and r.key = 'admin'
            )
          )
      )
    );

  return v_result;
end;
$function$;

revoke all on function public.palmyra_get_offline_pos_verifiers(uuid) from public, anon;
grant execute on function public.palmyra_get_offline_pos_verifiers(uuid) to authenticated;

commit;
