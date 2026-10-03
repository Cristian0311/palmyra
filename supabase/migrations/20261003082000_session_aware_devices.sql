-- PALMYRA session-aware device management
alter table public.devices add column if not exists session_id uuid;
create index if not exists devices_company_user_active_idx on public.devices(company_id,user_id,active,last_seen_at desc);
create index if not exists devices_session_idx on public.devices(session_id);
create unique index if not exists devices_company_user_fingerprint_uidx on public.devices(company_id,user_id,fingerprint) where user_id is not null and fingerprint is not null;

create or replace function public.register_current_device(p_company_id uuid,p_warehouse_id uuid,p_name text,p_fingerprint text)
returns jsonb language plpgsql security definer set search_path to 'public','private','pg_temp' as $$
declare v_user uuid:=auth.uid();v_session uuid:=nullif(auth.jwt()->>'session_id','')::uuid;v_id uuid;
begin
 if v_user is null then raise exception 'authentication_required'; end if;
 if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
 if not private.user_can_access_warehouse(v_user,p_company_id,p_warehouse_id) then raise exception 'location_access_denied'; end if;
 if p_fingerprint is null or length(trim(p_fingerprint))<16 or length(trim(p_fingerprint))>200 then raise exception 'invalid_device_fingerprint'; end if;
 insert into public.devices(company_id,user_id,warehouse_id,name,fingerprint,session_id,last_seen_at,active)
 values(p_company_id,v_user,p_warehouse_id,left(coalesce(nullif(trim(p_name),''),'Dispositivo'),120),trim(p_fingerprint),v_session,timezone('utc',now()),true)
 on conflict(company_id,user_id,fingerprint) where user_id is not null and fingerprint is not null do update set warehouse_id=excluded.warehouse_id,name=excluded.name,session_id=excluded.session_id,last_seen_at=excluded.last_seen_at,active=true
 returning id into v_id;
 return jsonb_build_object('device_id',v_id);
end; $$;
revoke all on function public.register_current_device(uuid,uuid,text,text) from public,anon; grant execute on function public.register_current_device(uuid,uuid,text,text) to authenticated;

create or replace function public.get_my_devices(p_company_id uuid)
returns table(id uuid,name text,fingerprint text,warehouse_id uuid,session_id uuid,last_seen_at timestamptz,active boolean,is_current boolean)
language plpgsql security definer set search_path to 'public','private','pg_temp' as $$
declare v_user uuid:=auth.uid();v_session uuid:=nullif(auth.jwt()->>'session_id','')::uuid;
begin
 if v_user is null then raise exception 'authentication_required'; end if;
 if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
 return query select d.id,d.name,d.fingerprint,d.warehouse_id,d.session_id,d.last_seen_at,d.active,(d.session_id is not null and d.session_id=v_session)
 from public.devices d where d.company_id=p_company_id and d.user_id=v_user order by d.active desc,d.last_seen_at desc nulls last;
end; $$;
revoke all on function public.get_my_devices(uuid) from public,anon; grant execute on function public.get_my_devices(uuid) to authenticated;

create or replace function public.revoke_my_device(p_device_id uuid,p_company_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public','private','pg_temp' as $$
declare v_user uuid:=auth.uid();v_id uuid;
begin
 if v_user is null then raise exception 'authentication_required'; end if;
 if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
 update public.devices set active=false where id=p_device_id and company_id=p_company_id and user_id=v_user returning id into v_id;
 if v_id is null then raise exception 'device_not_found'; end if;
 return jsonb_build_object('device_id',v_id);
end; $$;
revoke all on function public.revoke_my_device(uuid,uuid) from public,anon; grant execute on function public.revoke_my_device(uuid,uuid) to authenticated;

create or replace function public.is_current_device_active(p_company_id uuid)
returns boolean language plpgsql security definer set search_path to 'public','private','pg_temp' as $$
declare v_user uuid:=auth.uid();v_session uuid:=nullif(auth.jwt()->>'session_id','')::uuid;v_seen boolean;v_has boolean;
begin
 if v_user is null then return false; end if;
 if v_session is null then return true; end if;
 select exists(select 1 from public.devices d where d.company_id=p_company_id and d.user_id=v_user and d.session_id=v_session) into v_has;
 if not v_has then return true; end if;
 select d.active into v_seen from public.devices d where d.company_id=p_company_id and d.user_id=v_user and d.session_id=v_session order by d.last_seen_at desc limit 1;
 return coalesce(v_seen,true);
end; $$;
revoke all on function public.is_current_device_active(uuid) from public,anon; grant execute on function public.is_current_device_active(uuid) to authenticated;