-- Allow POS/cash operators to remove their own cash movement rows.
-- Authorization remains tenant-scoped inside the SECURITY DEFINER function.
create or replace function public.palmyra_delete_cash_movement(
  p_movement_id uuid,
  p_company_id uuid,
  p_cash_session_id uuid
) returns jsonb
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_deleted uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not (private.has_permission(p_company_id,'pos.use') or private.has_permission(p_company_id,'cash.manage')) then
    raise exception 'permission_denied';
  end if;

  delete from public.cash_movements
  where id=p_movement_id
    and company_id=p_company_id
    and cash_session_id=p_cash_session_id
  returning id into v_deleted;

  return jsonb_build_object(
    'success',true,
    'id',p_movement_id,
    'deleted',v_deleted is not null
  );
end $$;

revoke all on function public.palmyra_delete_cash_movement(uuid,uuid,uuid) from public,anon;
grant execute on function public.palmyra_delete_cash_movement(uuid,uuid,uuid) to authenticated;
