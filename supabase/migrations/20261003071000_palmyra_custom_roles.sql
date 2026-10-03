-- PALMYRA SaaS custom role management

create or replace function public.upsert_company_role(
  p_company_id uuid,
  p_role_id uuid,
  p_key text,
  p_name text,
  p_description text,
  p_permission_keys text[]
) returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_role_id uuid := coalesce(p_role_id, gen_random_uuid());
  v_key text := lower(trim(p_key));
  v_name text := trim(p_name);
  v_existing_company uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'roles.manage') then raise exception 'permission_denied'; end if;
  if length(v_key)<2 or length(v_key)>60 or v_key !~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$' then raise exception 'invalid_role_key'; end if;
  if v_key='admin' or v_key='employee' then raise exception 'reserved_role_key'; end if;
  if length(v_name)<2 or length(v_name)>100 then raise exception 'invalid_role_name'; end if;

  select company_id into v_existing_company from public.roles where id=v_role_id;
  if p_role_id is not null and (v_existing_company is null or v_existing_company<>p_company_id) then
    raise exception 'role_not_found_or_system';
  end if;

  if exists(select 1 from public.roles r where r.company_id=p_company_id and r.key=v_key and r.id<>v_role_id) then
    raise exception 'role_key_taken';
  end if;
  if exists(select 1 from public.roles r where r.company_id=p_company_id and lower(r.name)=lower(v_name) and r.id<>v_role_id) then
    raise exception 'role_name_taken';
  end if;

  if exists(
    select 1 from unnest(coalesce(p_permission_keys,'{}'::text[])) k
    where not exists(select 1 from public.permissions p where p.key=private.normalize_permission_key(k))
  ) then raise exception 'invalid_permission'; end if;

  if p_role_id is null then
    insert into public.roles(id,company_id,key,name,description,is_system)
    values(v_role_id,p_company_id,v_key,v_name,nullif(trim(p_description),''),false);
  else
    update public.roles
      set key=v_key,name=v_name,description=nullif(trim(p_description),'')
      where id=v_role_id and company_id=p_company_id and is_system=false;
    if not found then raise exception 'role_not_found_or_system'; end if;
    delete from public.role_permissions where role_id=v_role_id;
  end if;

  insert into public.role_permissions(role_id,permission_id)
  select v_role_id,p.id
  from public.permissions p
  where p.key=any(array(select private.normalize_permission_key(x) from unnest(coalesce(p_permission_keys,'{}'::text[])) x));

  return jsonb_build_object('id',v_role_id,'key',v_key,'name',v_name);
exception when unique_violation then
  raise exception 'role_already_exists';
end;
$$;

revoke all on function public.upsert_company_role(uuid,uuid,text,text,text,text[]) from public,anon;
grant execute on function public.upsert_company_role(uuid,uuid,text,text,text,text[]) to authenticated;
