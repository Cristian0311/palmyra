begin;

drop function if exists public.palmyra_cancel_cash_session(uuid,uuid,text);

create or replace function public.palmyra_cancel_cash_session(
  p_session_id uuid,
  p_company_id uuid,
  p_reason text,
  p_password text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public','private','extensions','pg_temp'
as $function$
declare
  v_auth uuid:=auth.uid();
  v_row public.cash_sessions%rowtype;
  v_valid boolean;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id,'cash.close') then raise exception 'permission_denied'; end if;

  select * into v_row
  from public.cash_sessions
  where id=p_session_id and company_id=p_company_id
  for update;
  if not found then raise exception 'cash_session_not_found'; end if;

  if v_row.status='voided' then
    return jsonb_build_object('success',true,'already_cancelled',true);
  end if;

  if v_row.employee_id is null then raise exception 'session_employee_required'; end if;
  if p_password is null or trim(p_password)='' then raise exception 'employee_password_required'; end if;

  select public.verify_employee_pos_password(p_company_id,v_row.employee_id,p_password)
    into v_valid;
  if not coalesce(v_valid,false) then raise exception 'employee_password_invalid'; end if;

  update public.cash_sessions
     set status='voided',
         closed_at=timezone('utc',now()),
         closed_by=v_auth,
         difference=0,
         delete_reason=left(nullif(trim(coalesce(p_reason,'')),''),500)
   where id=p_session_id and company_id=p_company_id;

  return jsonb_build_object('success',true,'already_cancelled',false,'employee_id',v_row.employee_id);
end;
$function$;

grant execute on function public.palmyra_cancel_cash_session(uuid,uuid,text,text) to authenticated;

commit;
