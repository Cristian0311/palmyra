-- POS cash opening/recovery compatibility
-- The Administrator role currently grants pos.access. cash.open is not part of
-- the platform permission catalog, so the RPC rejected valid POS openings.

create or replace function public.palmyra_open_cash_session(p_session_id uuid, p_company_id uuid, p_warehouse_id uuid, p_user_id uuid, p_opening_amount numeric, p_opened_at timestamp with time zone)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid:=auth.uid(); v_employee uuid; v_register uuid; v_turn bigint; v_row public.cash_sessions%rowtype;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not (private.has_permission(p_company_id,'pos.access') or private.has_permission(p_company_id,'cash.open')) then
    raise exception 'permission_denied';
  end if;
  if not exists(select 1 from public.warehouses where id=p_warehouse_id and company_id=p_company_id and active) then raise exception 'invalid_warehouse'; end if;
  select e.id into v_employee from public.employees e where e.company_id=p_company_id and e.active and (e.id=p_user_id or e.user_id=p_user_id) order by (e.id=p_user_id) desc limit 1;
  select id into v_register from public.cash_registers where company_id=p_company_id and warehouse_id=p_warehouse_id and active order by id limit 1;
  if v_register is null then
    insert into public.cash_registers(id,company_id,warehouse_id,code,name,active)
    values(gen_random_uuid(),p_company_id,p_warehouse_id,'CAJA-'||upper(left(p_warehouse_id::text,6)),'Caja principal',true)
    returning id into v_register;
  end if;
  select * into v_row from public.cash_sessions where id=p_session_id and company_id=p_company_id limit 1;
  if found then
    if v_row.status='open' then
      return jsonb_build_object('success',true,'already_existed',true,'id',v_row.id,'turn_number',v_row.turn_number,'opened_at',v_row.opened_at,'opening_amount',v_row.opening_amount,'employee_id',v_row.employee_id);
    end if;
    raise exception 'cash_session_reopen_blocked';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_company_id::text));
  if exists(select 1 from public.cash_sessions where cash_register_id=v_register and status='open') then raise exception 'cash_register_already_open'; end if;
  select coalesce(max(turn_number),0)+1 into v_turn from public.cash_sessions where company_id=p_company_id;
  insert into public.cash_sessions(id,company_id,cash_register_id,employee_id,opened_by,status,opened_at,opening_amount,turn_number)
  values(p_session_id,p_company_id,v_register,v_employee,v_auth,'open',coalesce(p_opened_at,timezone('utc',now())),greatest(coalesce(p_opening_amount,0),0),v_turn)
  returning * into v_row;
  return jsonb_build_object('success',true,'id',v_row.id,'turn_number',v_row.turn_number,'opened_at',v_row.opened_at,'opening_amount',v_row.opening_amount,'employee_id',v_row.employee_id);
end;
$function$;