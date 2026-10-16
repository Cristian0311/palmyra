-- Preserve employee credential aliases and the actual worker identity in offline POS snapshots.
create or replace function public.palmyra_get_offline_pos_verifiers(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id,'employees.manage') then raise exception 'permission_denied'; end if;

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
    select case when e.id = v.subject_id then e.user_id else e.id end
    from public.employees e
    where e.company_id = p_company_id and e.active = true
      and (e.id = v.subject_id or e.user_id = v.subject_id)
      and (e.id = v.subject_id or e.user_id is not null)
  ) aliases
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
          and cm.is_owner = true and cm.status = 'active'
      )
    );
  return v_result;
end;
$function$;

create or replace function public.palmyra_list_open_cash_sessions(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare v_auth uuid := auth.uid(); v_is_owner boolean;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  select coalesce(cm.is_owner,false) into v_is_owner
  from public.company_memberships cm
  where cm.company_id=p_company_id and cm.user_id=v_auth and cm.status='active'
  limit 1;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',cs.id,
      'turn_number',cs.turn_number,
      'opened_at',cs.opened_at,
      'opening_amount',cs.opening_amount,
      'status',cs.status,
      'opened_by',cs.opened_by,
      'employee_id',cs.employee_id,
      'user_id',coalesce(e.user_id,e.id,cs.opened_by),
      'worker_name',coalesce(nullif(cs.metadata->>'workerName',''),e.full_name,p.full_name,'Administrador'),
      'working_employee_ids',coalesce(
        cs.metadata->'workingEmployeeIds',
        case when coalesce(e.user_id,e.id) is not null
          then jsonb_build_array(coalesce(e.user_id,e.id))
          when cs.opened_by is not null then jsonb_build_array(cs.opened_by)
          else '[]'::jsonb end
      ),
      'branch_id',cr.warehouse_id,
      'warehouse_name',w.name,
      'expected_cash',cs.expected_cash
    ))
    from public.cash_sessions cs
    left join public.cash_registers cr on cr.id=cs.cash_register_id
    left join public.warehouses w on w.id=cr.warehouse_id
    left join public.employees e on e.id=cs.employee_id
    left join public.profiles p on p.id=cs.opened_by
    where cs.company_id=p_company_id and cs.status='open'
      and (v_is_owner or exists(
        select 1 from public.user_locations ul
        where ul.company_id=p_company_id and ul.user_id=v_auth
          and ul.warehouse_id=cr.warehouse_id
      ))
  ),'[]'::jsonb);
end;
$function$;