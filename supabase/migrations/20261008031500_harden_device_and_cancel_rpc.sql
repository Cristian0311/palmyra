begin;

-- Require company membership before exposing current-device state.
create or replace function public.is_current_device_active(p_company_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_session uuid := nullif(auth.jwt()->>'session_id','')::uuid;
  v_seen boolean;
  v_has boolean;
begin
  if v_user is null then return false; end if;
  if not private.has_company_access(p_company_id) then
    raise exception 'company_access_denied';
  end if;
  if v_session is null then return true; end if;

  select exists(
    select 1 from public.devices d
    where d.company_id=p_company_id
      and d.user_id=v_user
      and d.session_id=v_session
  ) into v_has;

  if not v_has then return true; end if;

  select d.active into v_seen
  from public.devices d
  where d.company_id=p_company_id
    and d.user_id=v_user
    and d.session_id=v_session
  order by d.last_seen_at desc
  limit 1;

  return coalesce(v_seen,true);
end;
$function$;

revoke execute on function public.palmyra_cancel_cash_session(uuid,uuid,text,text) from public;
grant execute on function public.palmyra_cancel_cash_session(uuid,uuid,text,text) to authenticated;

commit;
