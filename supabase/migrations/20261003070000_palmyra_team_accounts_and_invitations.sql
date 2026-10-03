-- PALMYRA SaaS team accounts, employee access and invitations
-- Applied to production before committing this source-of-truth migration.

alter table public.employees
  add column if not exists login_email text;

alter table public.company_invitations
  add column if not exists employee_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname='company_invitations_employee_id_fkey'
  ) then
    alter table public.company_invitations
      add constraint company_invitations_employee_id_fkey
      foreign key (employee_id) references public.employees(id) on delete set null;
  end if;
end $$;

create index if not exists company_invitations_employee_idx
  on public.company_invitations(company_id, employee_id, status);

create index if not exists employees_company_active_idx
  on public.employees(company_id, active, created_at desc);

create or replace function public.create_company_invitation(
  p_company_id uuid, p_employee_id uuid, p_email text, p_role_id uuid, p_warehouse_ids uuid[]
) returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_email text := lower(trim(p_email));
  v_token text := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  v_hash text; v_id uuid; v_employee record; v_existing uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'roles.manage') then raise exception 'permission_denied'; end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'invalid_email'; end if;

  select e.id,e.user_id,e.active,e.company_id into v_employee
  from public.employees e
  where e.id=p_employee_id and e.company_id=p_company_id;

  if v_employee.id is null then raise exception 'employee_not_found'; end if;
  if not v_employee.active then raise exception 'employee_inactive'; end if;
  if v_employee.user_id is not null then raise exception 'employee_already_linked'; end if;

  if not exists(
    select 1 from public.roles r
    where r.id=p_role_id and (r.company_id is null or r.company_id=p_company_id) and r.key<>'admin'
  ) then raise exception 'invalid_role'; end if;

  if p_warehouse_ids is null or cardinality(p_warehouse_ids)=0 then raise exception 'warehouse_required'; end if;

  if exists(
    select 1 from unnest(p_warehouse_ids) x(wid)
    where not exists(
      select 1 from public.warehouses w where w.id=x.wid and w.company_id=p_company_id and w.active
    )
  ) then raise exception 'invalid_warehouse'; end if;

  select id into v_existing
  from public.company_invitations
  where company_id=p_company_id and lower(email)=v_email and status='pending'
  order by created_at desc limit 1;

  if v_existing is not null then
    update public.company_invitations
      set status='revoked', updated_at=timezone('utc',now())
    where id=v_existing;
  end if;

  v_hash:=encode(digest(v_token,'sha256'),'hex');

  insert into public.company_invitations(
    company_id,employee_id,email,role_id,warehouse_ids,token_hash,status,expires_at,created_by
  )
  values(
    p_company_id,p_employee_id,v_email,p_role_id,p_warehouse_ids,v_hash,'pending',
    timezone('utc',now())+interval '7 days',auth.uid()
  )
  returning id into v_id;

  return jsonb_build_object(
    'id',v_id,'employee_id',p_employee_id,'token',v_token,
    'expires_at',timezone('utc',now())+interval '7 days','email',v_email
  );
end;
$$;

create or replace function public.create_employee_secure(
  p_company_id uuid, p_employee_code text, p_full_name text, p_base_salary numeric,
  p_role_id uuid, p_warehouse_ids uuid[]
) returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_user uuid:=auth.uid(); v_id uuid; v_limit integer;
  v_role_key text; v_role_system boolean; v_warehouse_count integer;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'employees.manage') then raise exception 'permission_denied'; end if;
  if length(trim(p_full_name))<2 or length(trim(p_full_name))>160 then raise exception 'invalid_employee_name'; end if;
  if length(trim(p_employee_code))<1 or length(trim(p_employee_code))>50 then raise exception 'invalid_employee_code'; end if;
  if p_base_salary is null or p_base_salary<0 then raise exception 'invalid_salary'; end if;
  if p_warehouse_ids is null or cardinality(p_warehouse_ids)=0 then raise exception 'warehouse_required'; end if;

  select r.key,r.is_system into v_role_key,v_role_system
  from public.roles r
  where r.id=p_role_id and (r.company_id is null or r.company_id=p_company_id);

  if v_role_key is null or v_role_key='admin' then raise exception 'invalid_role'; end if;
  if not v_role_system and not private.has_permission(p_company_id,'roles.manage') then
    raise exception 'role_management_required';
  end if;

  select count(*)::int into v_warehouse_count
  from public.warehouses w
  where w.id=any(p_warehouse_ids) and w.company_id=p_company_id and w.active;
  if v_warehouse_count<>cardinality(p_warehouse_ids) then raise exception 'invalid_warehouse'; end if;

  select coalesce((p.limits->>'employees')::int,999999) into v_limit
  from public.subscriptions s join public.plans p on p.id=s.plan_id
  where s.company_id=p_company_id and s.status in ('active','trialing','past_due')
  order by s.updated_at desc nulls last limit 1;

  if v_limit is null then
    select coalesce((p.limits->>'employees')::int,999999) into v_limit
    from public.plan_requests pr join public.plans p on p.id=pr.requested_plan_id
    where pr.company_id=p_company_id and pr.status='pending'
    order by pr.requested_at desc limit 1;
  end if;

  if (select count(*) from public.employees e where e.company_id=p_company_id and e.active)>=coalesce(v_limit,999999) then
    raise exception 'plan_employee_limit';
  end if;

  insert into public.employees(company_id,employee_code,full_name,base_salary,active,role_id)
  values(p_company_id,upper(trim(p_employee_code)),trim(p_full_name),p_base_salary,true,p_role_id)
  returning id into v_id;

  insert into public.employee_warehouse_access(company_id,employee_id,warehouse_id,is_default)
  select p_company_id,v_id,wid,(row_number() over(order by wid))=1
  from unnest(p_warehouse_ids) as wid;

  return jsonb_build_object('id',v_id);
exception when unique_violation then
  raise exception 'employee_code_taken';
end;
$$;

create or replace function public.create_employee_secure(
  p_company_id uuid, p_employee_id uuid, p_employee_code text, p_full_name text,
  p_base_salary numeric, p_role_id uuid, p_warehouse_ids uuid[]
) returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_user uuid:=auth.uid(); v_id uuid:=coalesce(p_employee_id,gen_random_uuid());
  v_limit integer; v_role_key text; v_role_system boolean;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'employees.manage') then raise exception 'permission_denied'; end if;
  if length(trim(p_full_name))<2 or length(trim(p_full_name))>160 then raise exception 'invalid_employee_name'; end if;
  if length(trim(p_employee_code))<1 or length(trim(p_employee_code))>50 then raise exception 'invalid_employee_code'; end if;
  if p_base_salary is null or p_base_salary<0 then raise exception 'invalid_salary'; end if;
  if p_warehouse_ids is null or cardinality(p_warehouse_ids)=0 then raise exception 'warehouse_required'; end if;
  if exists(select 1 from public.employees e where e.id=v_id and e.company_id<>p_company_id) then raise exception 'employee_id_conflict'; end if;

  select r.key,r.is_system into v_role_key,v_role_system
  from public.roles r where r.id=p_role_id and (r.company_id is null or r.company_id=p_company_id);

  if v_role_key is null or v_role_key='admin' then raise exception 'invalid_role'; end if;
  if not v_role_system and not private.has_permission(p_company_id,'roles.manage') then raise exception 'role_management_required'; end if;

  if (select count(*) from public.warehouses w where w.id=any(p_warehouse_ids) and w.company_id=p_company_id and w.active)<>cardinality(p_warehouse_ids) then
    raise exception 'invalid_warehouse';
  end if;

  select coalesce((p.limits->>'employees')::int,999999) into v_limit
  from public.subscriptions s join public.plans p on p.id=s.plan_id
  where s.company_id=p_company_id and s.status in ('active','trialing','past_due')
  order by s.updated_at desc nulls last limit 1;

  if v_limit is null then
    select coalesce((p.limits->>'employees')::int,999999) into v_limit
    from public.plan_requests pr join public.plans p on p.id=pr.requested_plan_id
    where pr.company_id=p_company_id and pr.status='pending'
    order by pr.requested_at desc limit 1;
  end if;

  if not exists(select 1 from public.employees e where e.id=v_id)
     and (select count(*) from public.employees e where e.company_id=p_company_id and e.active)>=coalesce(v_limit,0) then
    raise exception 'plan_employee_limit' using errcode='P0001';
  end if;

  insert into public.employees(id,company_id,employee_code,full_name,base_salary,active,role_id)
  values(v_id,p_company_id,upper(trim(p_employee_code)),trim(p_full_name),p_base_salary,true,p_role_id)
  on conflict(id) do update set
    employee_code=excluded.employee_code,full_name=excluded.full_name,base_salary=excluded.base_salary,
    active=true,role_id=excluded.role_id,updated_at=timezone('utc',now());

  delete from public.employee_warehouse_access where employee_id=v_id and company_id=p_company_id;

  insert into public.employee_warehouse_access(company_id,employee_id,warehouse_id,is_default)
  select p_company_id,v_id,wid,(row_number() over(order by wid))=1
  from unnest(p_warehouse_ids) as wid;

  return jsonb_build_object('id',v_id);
exception when unique_violation then
  raise exception 'employee_code_taken';
end;
$$;

create or replace function public.create_employee_with_invitation(
  p_company_id uuid, p_employee_code text, p_full_name text, p_base_salary numeric,
  p_role_id uuid, p_warehouse_ids uuid[], p_email text
) returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_employee jsonb; v_employee_id uuid; v_email text:=lower(trim(p_email));
  v_token text:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  v_hash text; v_invitation_id uuid; v_existing_pending uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'employees.manage') then raise exception 'permission_denied'; end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'invalid_email'; end if;

  v_employee:=public.create_employee_secure(p_company_id,p_employee_code,p_full_name,p_base_salary,p_role_id,p_warehouse_ids);
  v_employee_id:=(v_employee->>'id')::uuid;

  select id into v_existing_pending
  from public.company_invitations
  where company_id=p_company_id and lower(email)=v_email and status='pending'
  order by created_at desc limit 1;

  if v_existing_pending is not null then
    update public.company_invitations set status='revoked',updated_at=timezone('utc',now())
    where id=v_existing_pending;
  end if;

  v_hash:=encode(digest(v_token,'sha256'),'hex');

  insert into public.company_invitations(
    company_id,employee_id,email,role_id,warehouse_ids,token_hash,status,expires_at,created_by
  ) values(
    p_company_id,v_employee_id,v_email,p_role_id,p_warehouse_ids,v_hash,'pending',
    timezone('utc',now())+interval '7 days',auth.uid()
  ) returning id into v_invitation_id;

  return jsonb_build_object(
    'employee_id',v_employee_id,'invitation_id',v_invitation_id,'token',v_token,
    'expires_at',timezone('utc',now())+interval '7 days','email',v_email
  );
end;
$$;

create or replace function public.accept_company_invitation(p_token text)
returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare v_user uuid:=auth.uid(); v_hash text; v company_invitations%rowtype; wid uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  v_hash:=encode(digest(trim(p_token),'sha256'),'hex');

  select * into v from public.company_invitations
  where token_hash=v_hash and status='pending' and expires_at>timezone('utc',now()) for update;

  if not found then raise exception 'invitation_invalid_or_expired'; end if;
  if lower(coalesce(auth.jwt()->>'email',''))<>lower(v.email) then raise exception 'invitation_email_mismatch'; end if;

  if exists(select 1 from public.company_memberships cm where cm.company_id=v.company_id and cm.user_id=v_user and cm.status='active') then
    raise exception 'already_company_member';
  end if;

  if v.employee_id is not null and exists(
    select 1 from public.employees e
    where e.id=v.employee_id and e.company_id=v.company_id and e.user_id is not null and e.user_id<>v_user
  ) then raise exception 'employee_already_linked'; end if;

  insert into public.company_memberships(company_id,user_id,status,is_owner)
  values(v.company_id,v_user,'active',false)
  on conflict(company_id,user_id) do update set status='active';

  insert into public.user_roles(user_id,company_id,role_id)
  values(v_user,v.company_id,v.role_id)
  on conflict(user_id,company_id,role_id) do nothing;

  delete from public.user_locations where user_id=v_user and company_id=v.company_id;
  for wid in select unnest(v.warehouse_ids) loop
    insert into public.user_locations(user_id,company_id,warehouse_id,is_default)
    values(v_user,v.company_id,wid,wid=v.warehouse_ids[1]);
  end loop;

  update public.profiles set active_company_id=v.company_id where id=v_user;

  if v.employee_id is not null then
    update public.employees
    set user_id=v_user,login_email=lower(auth.jwt()->>'email'),active=true,role_id=v.role_id,updated_at=timezone('utc',now())
    where id=v.employee_id and company_id=v.company_id;
  end if;

  update public.company_invitations
  set status='accepted',accepted_by=v_user,accepted_at=timezone('utc',now()),updated_at=timezone('utc',now())
  where id=v.id;

  return jsonb_build_object('company_id',v.company_id,'employee_id',v.employee_id);
end;
$$;

create or replace function public.set_company_employee_status(
  p_employee_id uuid, p_active boolean
) returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare v_company_id uuid; v_user_id uuid;
begin
  select company_id,user_id into v_company_id,v_user_id from public.employees where id=p_employee_id;
  if v_company_id is null then raise exception 'employee_not_found'; end if;
  if auth.uid() is null or not private.has_permission(v_company_id,'employees.manage') then raise exception 'permission_denied'; end if;

  update public.employees set active=p_active,updated_at=timezone('utc',now()) where id=p_employee_id;

  if v_user_id is not null then
    update public.company_memberships
      set status=case when p_active then 'active'::membership_status else 'suspended'::membership_status end
      where company_id=v_company_id and user_id=v_user_id;
    update public.devices set active=p_active where company_id=v_company_id and user_id=v_user_id;
  end if;

  return jsonb_build_object('employee_id',p_employee_id,'active',p_active);
end;
$$;

revoke all on function public.create_company_invitation(uuid,uuid,text,uuid,uuid[]) from public,anon;
grant execute on function public.create_company_invitation(uuid,uuid,text,uuid,uuid[]) to authenticated;
revoke all on function public.create_employee_with_invitation(uuid,text,text,numeric,uuid,uuid[],text) from public,anon;
grant execute on function public.create_employee_with_invitation(uuid,text,text,numeric,uuid,uuid[],text) to authenticated;
revoke all on function public.accept_company_invitation(text) from public,anon;
grant execute on function public.accept_company_invitation(text) to authenticated;
revoke all on function public.set_company_employee_status(uuid,boolean) from public,anon;
grant execute on function public.set_company_employee_status(uuid,boolean) to authenticated;
