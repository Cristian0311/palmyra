-- PALMYRA POS cash-flow hardening.
-- Cash movements are separate durable operations. Session snapshots never delete/reinsert
-- the complete movement ledger, preventing races between consecutive offline shifts.

create or replace function public.palmyra_record_cash_movement(
  p_movement_id uuid,p_company_id uuid,p_cash_session_id uuid,
  p_movement_type text,p_amount numeric,p_currency_code text,p_note text default null
)
returns jsonb language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_type text;
  v_existing public.cash_movements%rowtype;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not (private.has_permission(p_company_id,'pos.use') or private.has_permission(p_company_id,'cash.manage')) then
    raise exception 'permission_denied';
  end if;
  if p_movement_id is null then raise exception 'invalid_movement_id'; end if;
  if coalesce(p_amount,0)<=0 then raise exception 'invalid_movement_amount'; end if;
  if not exists(select 1 from public.cash_sessions where id=p_cash_session_id and company_id=p_company_id and status='open') then
    raise exception 'invalid_cash_session';
  end if;

  v_type:=case lower(trim(coalesce(p_movement_type,'')))
    when 'income' then 'cash_in' when 'ingreso' then 'cash_in' when 'entrada' then 'cash_in'
    when 'deposit' then 'cash_in' when 'cash_in' then 'cash_in'
    when 'expense' then 'cash_out' when 'egreso' then 'cash_out' when 'egress' then 'cash_out'
    when 'withdrawal' then 'cash_out' when 'salida' then 'cash_out' when 'cash_out' then 'cash_out'
    else null end;
  if v_type is null then raise exception 'invalid_movement_type'; end if;
  if not exists(select 1 from public.currencies where code=upper(trim(p_currency_code))) then
    raise exception 'invalid_currency';
  end if;

  select * into v_existing from public.cash_movements where id=p_movement_id and company_id=p_company_id limit 1;
  if found then return jsonb_build_object('success',true,'id',v_existing.id,'already_exists',true); end if;

  insert into public.cash_movements(
    id,company_id,cash_session_id,movement_type,amount,currency_code,reference_id,note,created_by
  ) values(
    p_movement_id,p_company_id,p_cash_session_id,v_type,p_amount,upper(trim(p_currency_code)),null,p_note,v_user
  );

  return jsonb_build_object('success',true,'id',p_movement_id,'already_exists',false);
end;
$$;

create or replace function public.palmyra_delete_cash_movement(
  p_movement_id uuid,p_company_id uuid,p_cash_session_id uuid
)
returns jsonb language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare v_user uuid:=auth.uid(); v_deleted uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id,'settings.manage') then raise exception 'permission_denied'; end if;
  delete from public.cash_movements
  where id=p_movement_id and company_id=p_company_id and cash_session_id=p_cash_session_id
  returning id into v_deleted;
  return jsonb_build_object('success',true,'id',p_movement_id,'deleted',v_deleted is not null);
end;
$$;

create or replace function public.palmyra_update_cash_session_metadata(
  p_session_id uuid,p_company_id uuid,p_metadata jsonb
)
returns jsonb language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare v_user uuid:=auth.uid(); v_id uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id,'cash.close') then raise exception 'permission_denied'; end if;
  if p_metadata is null or jsonb_typeof(p_metadata)<>'object' then raise exception 'invalid_cash_session_metadata'; end if;
  update public.cash_sessions set metadata=p_metadata where id=p_session_id and company_id=p_company_id returning id into v_id;
  if v_id is null then raise exception 'cash_session_not_found'; end if;
  return jsonb_build_object('success',true,'id',v_id);
end;
$$;

revoke execute on function public.palmyra_record_cash_movement(uuid,uuid,uuid,text,numeric,text,text) from public,anon;
grant execute on function public.palmyra_record_cash_movement(uuid,uuid,uuid,text,numeric,text,text) to authenticated;
revoke execute on function public.palmyra_delete_cash_movement(uuid,uuid,uuid) from public,anon;
grant execute on function public.palmyra_delete_cash_movement(uuid,uuid,uuid) to authenticated;
revoke execute on function public.palmyra_update_cash_session_metadata(uuid,uuid,jsonb) from public,anon;
grant execute on function public.palmyra_update_cash_session_metadata(uuid,uuid,jsonb) to authenticated;
