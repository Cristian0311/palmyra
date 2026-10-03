-- PALMYRA one-company-per-account runtime reconciliation
create unique index if not exists company_memberships_one_company_per_user_uidx on public.company_memberships(user_id);
revoke all on function public.create_company_authenticated(text,text,bpchar,bpchar,text,text) from public,anon,authenticated;
grant execute on function public.create_company_authenticated(text,text,bpchar,bpchar,text,text) to service_role;

create or replace function public.palmyra_onboard_company(
  p_name text,p_slug text,p_country_code bpchar default 'PR',p_default_currency_code bpchar default 'USD',
  p_timezone text default 'America/Puerto_Rico',p_warehouse_name text default 'Almacén principal',
  p_plan_code text default 'starter',p_employee_name text default null,p_employee_code text default null
) returns jsonb language plpgsql security definer set search_path to 'public','private','pg_temp' as $$
declare v_user uuid:=auth.uid();v_company_id uuid;v_warehouse_id uuid;v_employee_id uuid;v_employee_role_id uuid;
v_plan public.plans%rowtype;v_subscription_id uuid;v_trial_ends timestamptz;v_now timestamptz:=timezone('utc',now());v_plan_code text:=lower(trim(coalesce(p_plan_code,'starter')));
begin
 if v_user is null then raise exception 'authentication_required'; end if;
 if exists(select 1 from public.company_memberships where user_id=v_user) then raise exception 'company_already_exists'; end if;
 if length(trim(coalesce(p_name,'')))<2 or length(trim(p_name))>160 then raise exception 'invalid_company_name'; end if;
 if lower(trim(coalesce(p_slug,''))) !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then raise exception 'invalid_company_slug'; end if;
 if not exists(select 1 from public.currencies where code=upper(trim(coalesce(p_default_currency_code,'USD'))) and active) then raise exception 'invalid_company_currency'; end if;
 if length(trim(coalesce(p_warehouse_name,'')))<2 or length(trim(p_warehouse_name))>120 then raise exception 'invalid_warehouse_name'; end if;
 if v_plan_code not in ('starter','growth','pro') then raise exception 'invalid_plan'; end if;
 select * into v_plan from public.plans where code=v_plan_code and active limit 1;
 if not found then raise exception 'plan_not_available'; end if;
 select (public.create_company_authenticated(trim(p_name),lower(trim(p_slug)),upper(p_country_code),upper(p_default_currency_code),trim(p_timezone),trim(p_warehouse_name))->>'company_id')::uuid into v_company_id;
 select id into v_warehouse_id from public.warehouses where company_id=v_company_id and code='ALM-01' order by created_at asc limit 1;
 if v_plan.code='starter' then
   v_trial_ends:=v_now+interval '90 days';
   insert into public.subscriptions(company_id,plan_id,status,starts_at,trial_ends_at,current_period_start,current_period_end,cancelled_at,updated_at)
   values(v_company_id,v_plan.id,'trialing',v_now,v_trial_ends,v_now,v_trial_ends,null,v_now) returning id into v_subscription_id;
   update public.companies set account_status='active',active=true,updated_at=v_now where id=v_company_id;
 else
   insert into public.plan_requests(company_id,requested_plan_id,requested_by,whatsapp_phone,status,requested_at)
   values(v_company_id,v_plan.id,v_user,'55581669','pending',v_now);
   update public.companies set account_status='pending_payment',active=true,updated_at=v_now where id=v_company_id;
 end if;
 if nullif(trim(coalesce(p_employee_name,'')),'') is not null then
   select id into v_employee_role_id from public.roles where company_id is null and key='employee' and is_system limit 1;
   select (public.create_employee_secure(v_company_id,coalesce(nullif(trim(p_employee_code),''),'EMP-001'),trim(p_employee_name),0,v_employee_role_id,array[v_warehouse_id]::uuid[])->>'id')::uuid into v_employee_id;
 end if;
 return jsonb_build_object('company_id',v_company_id,'warehouse_id',v_warehouse_id,'employee_id',v_employee_id,'subscription_id',v_subscription_id,'plan_code',v_plan.code,'account_status',case when v_plan.code='starter' then 'active' else 'pending_payment' end,'trial_ends_at',v_trial_ends);
end; $$;
revoke all on function public.palmyra_onboard_company(text,text,bpchar,bpchar,text,text,text,text,text) from public,anon;
grant execute on function public.palmyra_onboard_company(text,text,bpchar,bpchar,text,text,text,text,text) to authenticated;

create or replace function public.accept_company_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public','private','pg_temp' as $$
declare v_user uuid:=auth.uid();v_hash text;v public.company_invitations%rowtype;wid uuid;
begin
 if v_user is null then raise exception 'authentication_required'; end if;
 v_hash:=encode(digest(trim(p_token),'sha256'),'hex');
 select * into v from public.company_invitations where token_hash=v_hash and status='pending' and expires_at>timezone('utc',now()) for update;
 if not found then raise exception 'invitation_invalid_or_expired'; end if;
 if lower(coalesce(auth.jwt()->>'email',''))<>lower(v.email) then raise exception 'invitation_email_mismatch'; end if;
 if exists(select 1 from public.company_memberships where user_id=v_user) then raise exception 'company_membership_exists'; end if;
 if v.employee_id is not null and exists(select 1 from public.employees e where e.id=v.employee_id and e.company_id=v.company_id and e.user_id is not null and e.user_id<>v_user) then raise exception 'employee_already_linked'; end if;
 insert into public.company_memberships(company_id,user_id,status,is_owner) values(v.company_id,v_user,'active',false);
 insert into public.user_roles(user_id,company_id,role_id) values(v_user,v.company_id,v.role_id) on conflict(user_id,company_id,role_id) do nothing;
 delete from public.user_locations where user_id=v_user and company_id=v.company_id;
 for wid in select unnest(v.warehouse_ids) loop insert into public.user_locations(user_id,company_id,warehouse_id,is_default) values(v_user,v.company_id,wid,wid=v.warehouse_ids[1]); end loop;
 update public.profiles set active_company_id=v.company_id where id=v_user;
 if v.employee_id is not null then update public.employees set user_id=v_user,login_email=lower(auth.jwt()->>'email'),active=true,role_id=v.role_id,updated_at=timezone('utc',now()) where id=v.employee_id and company_id=v.company_id; end if;
 update public.company_invitations set status='accepted',accepted_by=v_user,accepted_at=timezone('utc',now()),updated_at=timezone('utc',now()) where id=v.id;
 return jsonb_build_object('company_id',v.company_id,'employee_id',v.employee_id);
end; $$;
revoke all on function public.accept_company_invitation(text) from public,anon;
grant execute on function public.accept_company_invitation(text) to authenticated;
