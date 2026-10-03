-- PALMYRA secure device registration

create unique index if not exists devices_company_user_fingerprint_uidx
on public.devices(company_id,user_id,fingerprint)
where user_id is not null and fingerprint is not null;

create or replace function public.register_current_device(
  p_company_id uuid,p_warehouse_id uuid,p_name text,p_fingerprint text
) returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare v_user uuid:=auth.uid(); v_id uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.user_can_access_warehouse(v_user,p_company_id,p_warehouse_id) then raise exception 'location_access_denied'; end if;
  if p_fingerprint is null or length(trim(p_fingerprint))<16 or length(trim(p_fingerprint))>200 then raise exception 'invalid_device_fingerprint'; end if;

  insert into public.devices(company_id,user_id,warehouse_id,name,fingerprint,last_seen_at,active)
  values(
    p_company_id,v_user,p_warehouse_id,left(coalesce(nullif(trim(p_name),''),'Dispositivo'),120),
    trim(p_fingerprint),timezone('utc',now()),true
  )
  on conflict(company_id,user_id,fingerprint) where user_id is not null and fingerprint is not null
  do update set
    warehouse_id=excluded.warehouse_id,
    name=excluded.name,
    last_seen_at=excluded.last_seen_at,
    active=true
  returning id into v_id;

  return jsonb_build_object('device_id',v_id);
end;
$$;

revoke all on function public.register_current_device(uuid,uuid,text,text) from public,anon;
grant execute on function public.register_current_device(uuid,uuid,text,text) to authenticated;
