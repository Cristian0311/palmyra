-- APPLIED 2026-11-20 to production. Preserved 3 companies / 3 subscriptions /
-- 1 plan request / 1 invoice / 1 payment; only catalog and RPCs changed.
-- Original review note: fail closed on missing prerequisites below.
-- Account/auth metadata may remain remote. This migration does NOT implement
-- isolation of Gratis commercial persistence/sync; that integration is separate.
begin;
set local timezone = 'UTC';

do $$
begin
  if to_regprocedure('public.create_company_authenticated(text,text,character,character,text,text)') is null
     or to_regprocedure('private.normalize_permission_key(text)') is null
     or to_regclass('public.plan_requests') is null
     or to_regclass('public.billing_payments') is null then
    raise exception 'missing_saas_baseline_review_schema_before_deploy';
  end if;
end $$;

-- Catalog changes only: never rewrite existing subscriptions or trial dates.
alter table public.plans drop constraint if exists plans_runtime_entitlements_check;
alter table public.plans drop constraint if exists plans_trial_days_policy_check;
update public.plans set trial_days=0 where code='starter';
-- plans.code is not proven unique in the deployed baseline (existing functions use
-- "where code=... limit 1"), so seed without ON CONFLICT and then normalize the row.
insert into public.plans(code,name,monthly_price,billing_currency_code,trial_days,limits,features,active)
select 'free','Gratis',0,'USD',0,
  '{"warehouses":1,"employees":1,"products":25,"reports":"basic","support":"self_service"}'::jsonb,
  '{"description":"Gratis permanente. Operación local; sin respaldo comercial en la nube.","storage_mode":"local_only","cloud_backup":false,"features":["Punto de venta básico","Caja en efectivo","Inventario básico","Reportes básicos","Solo almacenamiento local"],"feature_keys":["pos","cash","inventory","offline","basic_reports"]}'::jsonb,true
where not exists(select 1 from public.plans where code='free');
update public.plans set name='Gratis',monthly_price=0,billing_currency_code='USD',trial_days=0,
  limits='{"warehouses":1,"employees":1,"products":25,"reports":"basic","support":"self_service"}'::jsonb,
  features='{"description":"Gratis permanente. Operación local; sin respaldo comercial en la nube.","storage_mode":"local_only","cloud_backup":false,"features":["Punto de venta básico","Caja en efectivo","Inventario básico","Reportes básicos","Solo almacenamiento local"],"feature_keys":["pos","cash","inventory","offline","basic_reports"]}'::jsonb,
  active=true
where code='free';
update public.plans set features=coalesce(features,'{}'::jsonb) || jsonb_build_object(
  'storage_mode','cloud_backup','cloud_backup',true,
  'features',coalesce(features->'features','[]'::jsonb) || '["Equipo con roles","Respaldo comercial en la nube"]'::jsonb,
  'feature_keys',coalesce(features->'feature_keys','[]'::jsonb) || '["cash","custom_roles","cloud_backup"]'::jsonb)
where code='starter';
update public.plans set features=coalesce(features,'{}'::jsonb) || jsonb_build_object(
  'storage_mode','cloud_backup','cloud_backup',true,
  'features',coalesce(features->'features','[]'::jsonb) || '["Respaldo comercial en la nube"]'::jsonb,
  'feature_keys',coalesce(features->'feature_keys','[]'::jsonb) || '["cash","cloud_backup"]'::jsonb)
where code in ('growth','pro');
alter table public.plans add constraint plans_trial_days_policy_check check (trial_days=0);
alter table public.plans add constraint plans_runtime_entitlements_check check (
  (code='free' and active and monthly_price=0 and trial_days=0 and billing_currency_code='USD'
    and (limits->>'warehouses')::int=1 and (limits->>'employees')::int=1 and (limits->>'products')::int=25
    and features->>'storage_mode'='local_only' and features->>'cloud_backup'='false')
  or (code='starter' and active and monthly_price=10 and trial_days=0
    and (limits->>'warehouses')::int=1 and (limits->>'employees')::int=2 and (limits->>'products')::int=50
    and (features->'feature_keys') ? 'custom_roles')
  or (code='growth' and active and monthly_price=15 and trial_days=0
    and (limits->>'warehouses')::int=3 and (limits->>'employees')::int=4 and (limits->>'products')::int=150)
  or (code='pro' and active and monthly_price=25 and trial_days=0
    and (limits->>'warehouses')::int=7 and (limits->>'employees')::int=10 and (limits->>'products')::int=300)
  or (code='trial' and not active and monthly_price=0 and trial_days=0)
);

create or replace function public.enforce_subscription_trial_policy()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_code text;
begin
  select code into v_code from public.plans where id=new.plan_id;
  if v_code is null then raise exception 'invalid_plan'; end if;
  if v_code='free' and (new.trial_ends_at is not null or new.current_period_end is not null or new.grace_ends_at is not null or new.status='trialing') then
    raise exception 'free_plan_has_no_expiry';
  end if;
  if new.status='trialing' or new.trial_ends_at is not null then
    -- Legacy records can expire naturally, but cannot receive a new/extended trial.
    if TG_OP='INSERT' then raise exception 'new_trials_not_available'; end if;
    if new.plan_id is distinct from old.plan_id
       or new.starts_at is distinct from old.starts_at
       or new.trial_ends_at is distinct from old.trial_ends_at
       or new.current_period_end is distinct from old.current_period_end
       or (new.status='trialing' and old.status<>'trialing') then
      raise exception 'existing_trial_dates_immutable';
    end if;
  end if;
  return new;
end $$;
-- Ensure the policy is attached even on baselines with a differently named trigger.
drop trigger if exists cuba_subscription_terms_guard on public.subscriptions;
create trigger cuba_subscription_terms_guard before insert or update on public.subscriptions
for each row execute function public.enforce_subscription_trial_policy();
revoke all on function public.enforce_subscription_trial_policy() from public,anon,authenticated;

alter table public.plan_requests
  add column if not exists billing_months integer not null default 1 check (billing_months in (1,3,6,12)),
  add column if not exists payer_abroad boolean not null default false,
  add column if not exists quoted_amount numeric check (quoted_amount>=0),
  add column if not exists quoted_currency text,
  add column if not exists terms_version integer,
  add column if not exists approval_result jsonb;
-- Preserve historical payment enums; only v3 accepts the three explicit methods.
-- 'paypal_abroad' stays allowed here for legacy rows only; no v3 path produces or accepts it.
alter table public.plan_requests drop constraint if exists plan_requests_payment_method_check;
alter table public.plan_requests drop constraint if exists plan_requests_payment_provider_check;
alter table public.plan_requests add constraint plan_requests_payment_method_check check (
  payment_method in ('manual_cash','manual_bank_transfer','bank_transfer','card','online','cup_cash','cup_bank_transfer','usd_cash','paypal_abroad'));
alter table public.plan_requests add constraint plan_requests_payment_provider_check check (
  payment_provider in ('manual_cash','manual_bank_transfer','stripe','paypal','mercadopago','bank_transfer','manual'));
alter table public.plan_requests drop constraint if exists plan_requests_v3_terms_check;
alter table public.plan_requests add constraint plan_requests_v3_terms_check check (
  terms_version is null or (terms_version=3 and quoted_amount is not null and quoted_currency='USD'
    and payment_method in ('cup_cash','cup_bank_transfer','usd_cash')));
alter table public.billing_payments drop constraint if exists billing_payments_payment_method_check;
alter table public.billing_payments add constraint billing_payments_payment_method_check check (
  payment_method in ('manual_cash','manual_bank_transfer','card','bank_transfer','other','cup_cash','cup_bank_transfer','usd_cash'));
alter table public.billing_payments drop constraint if exists billing_payments_payment_provider_check;
alter table public.billing_payments add constraint billing_payments_payment_provider_check check (
  payment_provider in ('manual_cash','manual_bank_transfer','stripe','paypal','other','manual'));
create unique index if not exists plan_requests_one_pending_v3 on public.plan_requests(company_id)
where status='pending' and terms_version=3;

-- Existing RLS SELECT policies remain. Client-supplied updates must never approve
-- requests or mint subscriptions/invoices/payments (including column grants).
revoke insert,update,delete on public.plans,public.subscriptions,public.plan_requests,public.billing_invoices,public.billing_payments from public,anon,authenticated;
do $$
declare t text; cols text;
begin
  foreach t in array array['plans','subscriptions','plan_requests','billing_invoices','billing_payments'] loop
    select string_agg(quote_ident(attname),',') into cols from pg_attribute
    where attrelid=('public.'||t)::regclass and attnum>0 and not attisdropped;
    execute format('revoke insert (%s), update (%s) on public.%I from public,anon,authenticated',cols,cols,t);
  end loop;
end $$;

create or replace function private.assert_plan_capacity(p_company_id uuid,p_plan_id uuid)
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_limits jsonb;
begin
  select limits into v_limits from public.plans where id=p_plan_id;
  if v_limits is null then raise exception 'invalid_plan'; end if;
  if (select count(*) from public.warehouses where company_id=p_company_id and active)>(v_limits->>'warehouses')::int then raise exception 'plan_warehouse_limit'; end if;
  if (select count(*) from public.products where company_id=p_company_id and status is distinct from 'archived')>(v_limits->>'products')::int then raise exception 'plan_product_limit'; end if;
  if (select count(*) from public.employees e where e.company_id=p_company_id and e.active and not exists(
    select 1 from public.company_memberships m where m.company_id=e.company_id and m.user_id=e.user_id and m.is_owner and m.status='active'
  ))>(v_limits->>'employees')::int then raise exception 'plan_employee_limit'; end if;
end $$;
revoke all on function private.assert_plan_capacity(uuid,uuid) from public,anon,authenticated;

create or replace function public.request_company_plan_v3(
  p_company_id uuid,p_plan_id uuid,p_payment_method text,p_months integer default 1,p_payer_abroad boolean default false
) returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_plan public.plans%rowtype; v_req public.plan_requests%rowtype; v_now timestamptz:=now();
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  -- Membership, not created_by or UI state, is the authority for the current owner.
  if not exists(select 1 from public.company_memberships where company_id=p_company_id and user_id=v_user and is_owner and status='active') then raise exception 'owner_required'; end if;
  perform 1 from public.companies where id=p_company_id and active and account_status<>'suspended' for update;
  if not found then raise exception 'company_access_denied'; end if;
  if p_months is null or p_months not in (1,3,6,12) then raise exception 'invalid_billing_months'; end if;
  if p_payment_method is null or p_payment_method not in ('cup_cash','cup_bank_transfer','usd_cash') then raise exception 'invalid_payment_method'; end if;
  select * into v_plan from public.plans where id=p_plan_id and active and code in ('starter','growth','pro');
  if not found then raise exception 'invalid_paid_plan'; end if;
  perform private.assert_plan_capacity(p_company_id,p_plan_id);
  select * into v_req from public.plan_requests where company_id=p_company_id and status='pending' order by requested_at desc limit 1 for update;
  if found then
    if v_req.terms_version=3 and v_req.requested_plan_id=p_plan_id and v_req.payment_method=p_payment_method and v_req.billing_months=p_months and v_req.requested_by=v_user then
      return jsonb_build_object('status','pending_payment','request_id',v_req.id,'already_requested',true);
    end if;
    raise exception 'pending_plan_request_exists';
  end if;
  insert into public.plan_requests(company_id,requested_plan_id,requested_by,whatsapp_phone,status,requested_at,payment_method,payment_provider,billing_months,payer_abroad,quoted_amount,quoted_currency,terms_version)
  values(p_company_id,p_plan_id,v_user,'','pending',v_now,p_payment_method,'manual',p_months,coalesce(p_payer_abroad,false),v_plan.monthly_price*p_months,'USD',3)
  returning * into v_req;
  insert into public.billing_invoices(company_id,plan_request_id,invoice_number,period_start,period_end,due_at,amount,currency_code,status,external_reference)
  values(p_company_id,v_req.id,'PAL-'||v_req.id::text,v_now,(v_now at time zone 'UTC'+make_interval(months=>p_months)) at time zone 'UTC',v_now,v_req.quoted_amount,'USD','open','manual:plan_request:'||v_req.id);
  -- Deliberately no UPDATE/INSERT of subscriptions or company account status.
  return jsonb_build_object('status','pending_payment','request_id',v_req.id,'billing_months',p_months,'quoted_amount',v_req.quoted_amount,'quoted_currency','USD');
end $$;
revoke all on function public.request_company_plan_v3(uuid,uuid,text,integer,boolean) from public,anon;
grant execute on function public.request_company_plan_v3(uuid,uuid,text,integer,boolean) to authenticated;

create or replace function public.approve_plan_request_v3(
  p_request_id uuid,p_received_amount numeric,p_received_currency text,p_reference text,p_payer_abroad_confirmed boolean default false
) returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
  v_user uuid:=auth.uid(); v_now timestamptz; v_company uuid;
  v_req public.plan_requests%rowtype; v_plan public.plans%rowtype; v_sub public.subscriptions%rowtype;
  v_start timestamptz; v_end timestamptz; v_invoice public.billing_invoices%rowtype;
  v_payment uuid; v_currency text:=upper(trim(p_received_currency)); v_quote numeric; v_result jsonb;
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then raise exception 'permission_denied'; end if;
  select company_id into v_company from public.plan_requests where id=p_request_id;
  if not found then raise exception 'plan_request_not_found'; end if;
  -- Consistent company -> request -> subscription lock order serializes renewals.
  perform 1 from public.companies where id=v_company for update;
  select * into v_req from public.plan_requests where id=p_request_id for update;
  if v_req.status='approved' then
    return coalesce(v_req.approval_result,jsonb_build_object('ok',true,'request_id',v_req.id,'company_id',v_company)) || jsonb_build_object('already_approved',true);
  end if;
  if v_req.status<>'pending' then raise exception 'plan_request_not_pending'; end if;
  if not exists(select 1 from public.companies where id=v_company and active and account_status<>'suspended') then raise exception 'company_access_denied'; end if;
  if not exists(select 1 from public.company_memberships where company_id=v_company and user_id=v_req.requested_by and is_owner and status='active') then raise exception 'request_owner_no_longer_active'; end if;
  if p_received_amount is null or p_received_amount<=0 or p_received_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'received_amount_required'; end if;
  if v_currency is null or v_currency not in ('CUP','USD') then raise exception 'invalid_received_currency'; end if;
  if nullif(trim(p_reference),'') is null then raise exception 'manual_confirmation_reference_required'; end if;
  if v_req.payment_method in ('cup_cash','cup_bank_transfer') and v_currency<>'CUP' then raise exception 'payment_currency_mismatch'; end if;
  if v_req.payment_method='usd_cash' and v_currency<>'USD' then raise exception 'payment_currency_mismatch'; end if;
  if v_req.payment_method not in ('cup_cash','cup_bank_transfer','usd_cash') then raise exception 'legacy_payment_method_requires_review'; end if;
  select * into v_plan from public.plans where id=v_req.requested_plan_id and active and code in ('starter','growth','pro');
  if not found then raise exception 'invalid_paid_plan'; end if;
  perform private.assert_plan_capacity(v_company,v_plan.id);
  select * into v_sub from public.subscriptions where company_id=v_company for update;
  v_now:=clock_timestamp();
  v_start:=v_now;
  if v_sub.plan_id=v_plan.id then
    v_start:=greatest(v_now,case when v_sub.status='trialing' then v_sub.trial_ends_at else v_sub.current_period_end end);
  end if;
  -- UTC calendar months: Jan 31 + 1 month = Feb 28/29, never a fixed 30 days.
  v_end:=((v_start at time zone 'UTC')+make_interval(months=>v_req.billing_months)) at time zone 'UTC';
  v_quote:=coalesce(v_req.quoted_amount,v_plan.monthly_price*v_req.billing_months);
  if v_currency='USD' and p_received_amount<v_quote then raise exception 'payment_amount_below_quote'; end if;
  insert into public.subscriptions(company_id,plan_id,status,starts_at,trial_ends_at,current_period_start,current_period_end,grace_ends_at,cancelled_at,updated_at)
  values(v_company,v_plan.id,'active',coalesce(v_sub.starts_at,v_now),null,v_start,v_end,null,null,v_now)
  on conflict(company_id) do update set plan_id=excluded.plan_id,status='active',trial_ends_at=null,
    current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,grace_ends_at=null,cancelled_at=null,updated_at=excluded.updated_at
  returning * into v_sub;
  select * into v_invoice from public.billing_invoices where plan_request_id=v_req.id and status='open' order by created_at limit 1 for update;
  if not found then
    insert into public.billing_invoices(company_id,subscription_id,plan_request_id,invoice_number,period_start,period_end,due_at,amount,currency_code,status,paid_at,external_reference)
    values(v_company,v_sub.id,v_req.id,'PAL-'||v_req.id::text,v_start,v_end,v_now,v_quote,'USD','paid',v_now,'manual:plan_request:'||v_req.id)
    returning * into v_invoice;
  else
    update public.billing_invoices set subscription_id=v_sub.id,period_start=v_start,period_end=v_end,amount=v_quote,currency_code='USD',status='paid',paid_at=v_now,updated_at=v_now,
      external_reference='manual:plan_request:'||v_req.id where id=v_invoice.id returning * into v_invoice;
  end if;
  update public.billing_invoices set status='void',updated_at=v_now where plan_request_id=v_req.id and status='open' and id<>v_invoice.id;
  insert into public.billing_payments(company_id,subscription_id,amount,currency_code,status,external_reference,paid_at,payment_method,payment_provider,metadata)
  values(v_company,v_sub.id,p_received_amount,v_currency,'paid','manual:plan_request:'||v_req.id,v_now,v_req.payment_method,'manual',
    jsonb_build_object('plan_request_id',v_req.id,'approved_by',v_user,'manual_reference',left(trim(p_reference),500),'billing_months',v_req.billing_months,'quoted_amount',v_quote,'quoted_currency','USD'))
  returning id into v_payment;
  v_result:=jsonb_build_object('ok',true,'request_id',v_req.id,'company_id',v_company,'plan_code',v_plan.code,'plan_name',v_plan.name,'invoice_number',v_invoice.invoice_number,'payment_id',v_payment,'period_start',v_start,'current_period_end',v_end,'payment_method',v_req.payment_method,'currency_code',v_currency);
  update public.plan_requests set status='approved',approved_at=v_now,approved_by=v_user,approval_result=v_result where id=v_req.id;
  update public.companies set account_status='active',updated_at=v_now where id=v_company;
  return v_result;
end $$;
revoke all on function public.approve_plan_request_v3(uuid,numeric,text,text,boolean) from public,anon;
grant execute on function public.approve_plan_request_v3(uuid,numeric,text,text,boolean) to authenticated;
-- No silent cash/USD assumptions for old admin clients. Approved retries remain safe.
create or replace function public.approve_plan_request(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
begin
  return public.approve_plan_request_v3(p_request_id,null,null,null,false);
end $$;
revoke all on function public.approve_plan_request(uuid) from public,anon;
grant execute on function public.approve_plan_request(uuid) to authenticated;

create or replace function public.reject_plan_request(p_request_id uuid,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_company uuid; v_req public.plan_requests%rowtype;
begin
  if auth.uid() is null or not exists(select 1 from public.platform_admins where user_id=auth.uid()) then raise exception 'permission_denied'; end if;
  select company_id into v_company from public.plan_requests where id=p_request_id;
  if not found then raise exception 'plan_request_not_found'; end if;
  perform 1 from public.companies where id=v_company for update;
  select * into v_req from public.plan_requests where id=p_request_id for update;
  if v_req.status='rejected' then return jsonb_build_object('ok',true,'already_rejected',true); end if;
  if v_req.status<>'pending' then raise exception 'plan_request_not_pending'; end if;
  update public.plan_requests set status='rejected',approved_at=now(),approved_by=auth.uid(),note=left(nullif(trim(p_note),''),500) where id=p_request_id;
  update public.billing_invoices set status='void',updated_at=now() where plan_request_id=p_request_id and status='open';
  -- Rejection must not revive an expired/suspended company either.
  return jsonb_build_object('ok',true,'company_id',v_company);
end $$;

create or replace function public.get_my_plan_request(p_company_id uuid)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v jsonb;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not exists(select 1 from public.company_memberships where company_id=p_company_id and user_id=auth.uid() and is_owner and status='active') then raise exception 'owner_required'; end if;
  select jsonb_build_object('id',r.id,'status',r.status,'requested_plan_id',r.requested_plan_id,'requested_at',r.requested_at,'approved_at',r.approved_at,'note',r.note,'plan_name',p.name,'plan_code',p.code,'payment_method',r.payment_method,'payment_provider',r.payment_provider,'billing_months',r.billing_months,'quoted_amount',r.quoted_amount,'quoted_currency',r.quoted_currency,'payer_abroad',r.payer_abroad)
  into v from public.plan_requests r join public.plans p on p.id=r.requested_plan_id where r.company_id=p_company_id
  order by (r.status='pending') desc,r.requested_at desc limit 1;
  return v;
end $$;

-- A single Cuba-only onboarding entry point. All new accounts start on Gratis;
-- paid selections are pending requests and cannot grant paid entitlements.
create or replace function public.palmyra_onboard_company_v3(
  p_name text,p_slug text,p_warehouse_name text default 'Almacén principal',p_plan_code text default 'free',
  p_payment_method text default 'cup_cash',p_months integer default 1,p_payer_abroad boolean default false
) returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_company uuid; v_warehouse uuid; v_free uuid; v_paid uuid; v_sub uuid; v_request jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,713));
  if exists(select 1 from public.company_memberships where user_id=v_user) then raise exception 'company_already_exists'; end if;
  if length(trim(coalesce(p_name,''))) not between 2 and 160 then raise exception 'invalid_company_name'; end if;
  if length(trim(coalesce(p_warehouse_name,''))) not between 2 and 120 then raise exception 'invalid_warehouse_name'; end if;
  if coalesce(p_slug,'') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'invalid_company_slug'; end if;
  if p_plan_code is null or p_plan_code not in ('free','starter','growth','pro') then raise exception 'invalid_plan'; end if;
  select id into v_free from public.plans where code='free' and active;
  if not found then raise exception 'free_plan_not_deployed'; end if;
  select (public.create_company_authenticated(trim(p_name),lower(trim(p_slug)),'CU','CUP','America/Havana',trim(p_warehouse_name))->>'company_id')::uuid into v_company;
  select id into v_warehouse from public.warehouses where company_id=v_company and active order by created_at limit 1;
  if v_company is null or v_warehouse is null then raise exception 'company_bootstrap_failed'; end if;
  insert into public.subscriptions(company_id,plan_id,status,starts_at,current_period_start,current_period_end,trial_ends_at,grace_ends_at,updated_at)
  values(v_company,v_free,'active',now(),now(),null,null,null,now()) returning id into v_sub;
  update public.companies set account_status='active',active=true,updated_at=now() where id=v_company;
  if p_plan_code<>'free' then
    select id into v_paid from public.plans where code=p_plan_code and active;
    v_request:=public.request_company_plan_v3(v_company,v_paid,p_payment_method,p_months,p_payer_abroad);
  end if;
  return jsonb_build_object('company_id',v_company,'warehouse_id',v_warehouse,'subscription_id',v_sub,'plan_code','free','account_status','active','request_id',v_request->>'request_id');
end $$;
revoke all on function public.palmyra_onboard_company_v3(text,text,text,text,text,integer,boolean) from public,anon;
grant execute on function public.palmyra_onboard_company_v3(text,text,text,text,text,integer,boolean) to authenticated;
-- Old routes are not allowed to bypass payment terms or issue promotional trials.
revoke execute on function public.palmyra_onboard_company(text,text,character,character,text,text,text,text,text) from public,anon,authenticated;
revoke execute on function public.palmyra_onboard_company_with_payment(text,text,character,character,text,text,text,text,text,text) from public,anon,authenticated;
revoke execute on function public.palmyra_onboard_company_with_payment_v2(text,text,character,character,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke execute on function public.select_company_plan(uuid,uuid) from public,anon,authenticated;
revoke execute on function public.select_company_plan_with_payment(uuid,uuid,text) from public,anon,authenticated;
revoke execute on function public.set_manual_cash_payment(uuid,text,text) from public,anon,authenticated;
revoke execute on function public.create_open_invoice_for_plan_request(uuid) from public,anon,authenticated;
revoke execute on function public.set_platform_company_plan(uuid,uuid) from public,anon,authenticated;

-- Backend entitlement helper: checks actual paid/trial/grace dates, never requests.
create or replace function private.company_has_plan_feature(p_company_id uuid,p_feature text)
returns boolean language sql stable security definer set search_path=public,private,pg_temp as $$
  select exists(select 1 from public.subscriptions s join public.plans p on p.id=s.plan_id
    join public.companies c on c.id=s.company_id
    where s.company_id=p_company_id and c.active and c.account_status<>'suspended'
    and (p.active or p.code='trial')
    and ((s.status='active' and (s.current_period_end is null or s.current_period_end>now()))
      or (s.status='trialing' and coalesce(s.trial_ends_at,s.current_period_end)>now())
      or (s.status in ('active','trialing','past_due') and coalesce(s.grace_ends_at,coalesce(s.trial_ends_at,s.current_period_end)+interval '2 days')>now()))
    and case lower(trim(p_feature))
      when 'roles' then p.code in ('starter','growth','pro','trial')
      when 'custom_roles' then p.code in ('starter','growth','pro','trial')
      when 'payroll' then p.code in ('growth','pro')
      when 'cloud_backup' then p.code in ('starter','growth','pro','trial')
      when 'pos' then true
      when 'cash' then true
      when 'inventory' then true
      when 'offline' then true
      when 'basic_reports' then true
      else (coalesce(p.features->'feature_keys','[]'::jsonb) ? lower(trim(p_feature)))
        or exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p.features)='array' then p.features else coalesce(p.features->'features','[]'::jsonb) end) f(value) where lower(trim(f.value))=lower(trim(p_feature)))
    end);
$$;

-- Keep the current role-resolution branches, with explicit free-plan gates.
-- Does NOT authorize cloud writes for Gratis: transport/persistence isolation is
-- intentionally outside this migration and must ship before exposing Gratis.
create or replace function private.has_permission(p_company_id uuid,p_permission_key text)
returns boolean language sql stable security definer set search_path=public,private,pg_temp as $$
  select auth.uid() is not null
    and exists(select 1 from public.company_memberships m join public.companies c on c.id=m.company_id
      where m.company_id=p_company_id and m.user_id=auth.uid() and m.status='active' and c.active and c.account_status<>'suspended')
    and (not exists(select 1 from public.subscriptions s join public.plans p on p.id=s.plan_id where s.company_id=p_company_id and p.code='free')
      or private.normalize_permission_key(p_permission_key) in ('pos.access','cash.open','cash.close','inventory.manage','products.manage','reports.view','employees.manage','settings.manage'))
    and (private.normalize_permission_key(p_permission_key)<>'roles.manage' or private.company_has_plan_feature(p_company_id,'roles'))
    and (exists(select 1 from public.user_roles ur join public.roles r on r.id=ur.role_id join public.role_permissions rp on rp.role_id=r.id join public.permissions p on p.id=rp.permission_id
      where ur.company_id=p_company_id and ur.user_id=auth.uid() and p.key=private.normalize_permission_key(p_permission_key) and (r.is_system or r.company_id=p_company_id))
    or exists(select 1 from public.employees e join public.roles r on r.id=e.role_id join public.role_permissions rp on rp.role_id=r.id join public.permissions p on p.id=rp.permission_id
      where e.company_id=p_company_id and e.user_id=auth.uid() and e.active and p.key=private.normalize_permission_key(p_permission_key) and (r.is_system or r.company_id=p_company_id)));
$$;

-- Limit trigger excludes the owner; shared company lock makes create/reactivate
-- and approval/downgrade capacity checks race-safe.
create or replace function private.enforce_plan_limit()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_kind text; v_limit integer; v_count integer; v_counted boolean; v_owner boolean;
begin
  if TG_OP='DELETE' then return old; end if;
  if new.company_id is null then raise exception 'company_required'; end if;
  if TG_OP='UPDATE' and new.company_id is distinct from old.company_id then raise exception 'company_id_immutable'; end if;
  perform 1 from public.companies where id=new.company_id for update;
  if not found then raise exception 'company_not_found'; end if;
  v_kind:=TG_TABLE_NAME;
  if v_kind='products' then
    v_counted:=new.status is distinct from 'archived';
  elsif v_kind in ('warehouses','employees') then v_counted:=coalesce(new.active,true);
  else return new; end if;
  if not v_counted then return new; end if;
  if v_kind='employees' then
    select exists(select 1 from public.company_memberships where company_id=new.company_id and user_id=new.user_id and is_owner and status='active') into v_owner;
    if v_owner then return new; end if;
  end if;
  if v_kind='warehouses' and TG_OP='INSERT' and exists(select 1 from public.companies where id=new.company_id and account_status='setup')
    and not exists(select 1 from public.warehouses where company_id=new.company_id) then return new; end if;
  select (p.limits->>v_kind)::int into v_limit from public.subscriptions s join public.plans p on p.id=s.plan_id
    where s.company_id=new.company_id order by s.updated_at desc limit 1;
  v_limit:=coalesce(v_limit,0);
  if v_kind='products' then select count(*) into v_count from public.products where company_id=new.company_id and status is distinct from 'archived' and id<>new.id;
  elsif v_kind='warehouses' then select count(*) into v_count from public.warehouses where company_id=new.company_id and active and id<>new.id;
  else select count(*) into v_count from public.employees e where company_id=new.company_id and active and id<>new.id and not exists(
    select 1 from public.company_memberships m where m.company_id=e.company_id and m.user_id=e.user_id and m.is_owner and m.status='active'); end if;
  if v_count>=v_limit then raise exception 'plan_%_limit',v_kind; end if;
  return new;
end $$;
revoke all on function private.enforce_plan_limit() from public,anon,authenticated;

-- Null expiry is permanent; pending payment requests never bypass this job.
create or replace function public.process_subscription_expirations()
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_now timestamptz:=now(); v_started integer; v_expired integer;
begin
  update public.subscriptions s set status='past_due',grace_ends_at=coalesce(s.grace_ends_at,coalesce(s.trial_ends_at,s.current_period_end)+interval '2 days'),updated_at=v_now
  where s.status in ('active','trialing') and coalesce(s.trial_ends_at,s.current_period_end)<=v_now;
  get diagnostics v_started=row_count;
  update public.subscriptions s set status='expired',updated_at=v_now
  where s.status='past_due' and coalesce(s.grace_ends_at,coalesce(s.trial_ends_at,s.current_period_end)+interval '2 days')<=v_now;
  get diagnostics v_expired=row_count;
  update public.companies c set account_status='pending_payment',updated_at=v_now where c.account_status='active'
    and exists(select 1 from public.subscriptions s where s.company_id=c.id and s.status='expired');
  return jsonb_build_object('ok',true,'grace_started',v_started,'expired',v_expired);
end $$;
revoke all on function public.process_subscription_expirations() from public,anon,authenticated;
grant execute on function public.process_subscription_expirations() to service_role;
commit;
