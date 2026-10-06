-- Securely return currently open cash sessions for the active company.
-- Company owners can see all branches; other POS users only see assigned warehouses.
create or replace function public.palmyra_list_open_cash_sessions(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_auth uuid:=auth.uid();
  v_is_owner boolean:=false;
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
      'user_id',coalesce(e.user_id,cs.opened_by),
      'worker_name',coalesce(nullif(cs.metadata->>'workerName',''),e.full_name,p.full_name,'Administrador'),
      'working_employee_ids',coalesce(cs.metadata->'workingEmployeeIds',case when e.user_id is not null then jsonb_build_array(e.user_id) when cs.opened_by is not null then jsonb_build_array(cs.opened_by) else '[]'::jsonb end),
      'branch_id',cr.warehouse_id,
      'warehouse_name',w.name,
      'expected_cash',cs.expected_cash
    ) order by cs.opened_at desc)
    from public.cash_sessions cs
    left join public.cash_registers cr on cr.id=cs.cash_register_id
    left join public.warehouses w on w.id=cr.warehouse_id
    left join public.employees e on e.id=cs.employee_id
    left join public.profiles p on p.id=cs.opened_by
    where cs.company_id=p_company_id
      and cs.status='open'
      and (v_is_owner or exists (
        select 1 from public.user_locations ul
        where ul.company_id=p_company_id and ul.user_id=v_auth and ul.warehouse_id=cr.warehouse_id
      ))
  ),'[]'::jsonb);
end;
$function$;

revoke all on function public.palmyra_list_open_cash_sessions(uuid) from public, anon;
grant execute on function public.palmyra_list_open_cash_sessions(uuid) to authenticated;
