alter table public.devices
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references auth.users(id),
  add column if not exists revocation_reason text;

create or replace function public.register_current_device(
  p_company_id uuid,
  p_warehouse_id uuid,
  p_name text,
  p_fingerprint text
) returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_user uuid:=auth.uid();
  v_session uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
  v_id uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.user_can_access_warehouse(v_user,p_company_id,p_warehouse_id) then raise exception 'location_access_denied'; end if;
  if p_fingerprint is null or length(trim(p_fingerprint))<16 or length(trim(p_fingerprint))>200 then
    raise exception 'invalid_device_fingerprint';
  end if;
  insert into public.devices(
    company_id,user_id,warehouse_id,name,fingerprint,session_id,last_seen_at,active,revoked_at,revoked_by,revocation_reason
  )
  values(
    p_company_id,v_user,p_warehouse_id,left(coalesce(nullif(trim(p_name),''),'Dispositivo'),120),
    trim(p_fingerprint),v_session,timezone('utc',now()),true,null,null,null
  )
  on conflict(company_id,user_id,fingerprint) where user_id is not null and fingerprint is not null
  do update set
    warehouse_id=excluded.warehouse_id,name=excluded.name,session_id=excluded.session_id,
    last_seen_at=excluded.last_seen_at,active=true,revoked_at=null,revoked_by=null,revocation_reason=null
  returning id into v_id;
  return jsonb_build_object('device_id',v_id);
end;
$function$;

create or replace function public.revoke_my_device(
  p_device_id uuid,
  p_company_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare v_user uuid:=auth.uid();v_id uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  update public.devices
  set active=false,revoked_at=timezone('utc',now()),revoked_by=v_user,revocation_reason='user_revoked'
  where id=p_device_id and company_id=p_company_id and user_id=v_user
  returning id into v_id;
  if v_id is null then raise exception 'device_not_found'; end if;
  insert into public.audit_logs(company_id,user_id,device_id,action,entity_type,entity_id,metadata)
  values(p_company_id,v_user,v_id,'security.device_revoked','device',v_id,jsonb_build_object('reason','user_revoked'));
  return jsonb_build_object('device_id',v_id);
end;
$function$;

create or replace function public.revoke_other_devices(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_user uuid:=auth.uid();
  v_session uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
  v_count integer:=0;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if v_session is null then raise exception 'session_id_required'; end if;
  update public.devices
  set active=false,revoked_at=timezone('utc',now()),revoked_by=v_user,revocation_reason='other_sessions_closed'
  where company_id=p_company_id and user_id=v_user and active=true and (session_id is distinct from v_session);
  get diagnostics v_count = row_count;
  insert into public.audit_logs(company_id,user_id,action,entity_type,metadata)
  values(p_company_id,v_user,'security.other_devices_revoked','device',jsonb_build_object('revoked_count',v_count,'reason','other_sessions_closed'));
  return jsonb_build_object('ok',true,'revoked_count',v_count);
end;
$function$;

revoke execute on function public.revoke_other_devices(uuid) from public;
grant execute on function public.revoke_other_devices(uuid) to authenticated, service_role;
