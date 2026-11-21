-- Plan renewal unfreeze + full platform admin console backend.
-- Additive: new table, new functions, one function redefinition, audit triggers.
-- Existing rows are only ever updated by the RPCs at runtime, never by this file.
begin;

-- ---------------------------------------------------------------------------
-- 1. Administrative audit trail
-- ---------------------------------------------------------------------------
create table if not exists public.platform_admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  target_company_id uuid,
  target_request_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc',now())
);

create index if not exists platform_admin_audit_created_idx
  on public.platform_admin_audit(created_at desc);
create index if not exists platform_admin_audit_company_idx
  on public.platform_admin_audit(target_company_id, created_at desc);

alter table public.platform_admin_audit enable row level security;
revoke all on table public.platform_admin_audit from public, anon, authenticated;

create or replace function private.log_platform_admin_action(
  p_action text,
  p_target_company_id uuid default null,
  p_target_request_id uuid default null,
  p_detail jsonb default '{}'::jsonb
) returns void language sql security definer set search_path=public,private,pg_temp as $$
  insert into public.platform_admin_audit(actor_id,action,target_company_id,target_request_id,detail)
  values(auth.uid(),left(coalesce(p_action,'unknown'),80),p_target_company_id,p_target_request_id,coalesce(p_detail,'{}'::jsonb));
$$;
revoke all on function private.log_platform_admin_action(text,uuid,uuid,jsonb) from public,anon,authenticated;

-- Audit plan request status changes (approve, reject, owner cancel, supersede).
create or replace function private.audit_plan_request_change()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
begin
  if tg_op='INSERT' then
    insert into public.platform_admin_audit(actor_id,action,target_company_id,target_request_id,detail)
    values(new.requested_by,'plan_request.created',new.company_id,new.id,
      jsonb_build_object('plan_id',new.requested_plan_id,'payment_method',new.payment_method,
        'billing_months',new.billing_months,'quoted_amount',new.quoted_amount));
    return new;
  end if;
  if old.status is distinct from new.status then
    insert into public.platform_admin_audit(actor_id,action,target_company_id,target_request_id,detail)
    values(coalesce(auth.uid(),new.approved_by),'plan_request.'||new.status,new.company_id,new.id,
      jsonb_build_object('from',old.status,'to',new.status,'note',new.note,
        'plan_id',new.requested_plan_id,'billing_months',new.billing_months));
  end if;
  return new;
end $$;
revoke all on function private.audit_plan_request_change() from public,anon,authenticated;

drop trigger if exists trg_audit_plan_request_ins on public.plan_requests;
create trigger trg_audit_plan_request_ins
  after insert on public.plan_requests
  for each row execute function private.audit_plan_request_change();

drop trigger if exists trg_audit_plan_request_upd on public.plan_requests;
create trigger trg_audit_plan_request_upd
  after update on public.plan_requests
  for each row execute function private.audit_plan_request_change();

-- Audit company account status changes.
create or replace function private.audit_company_status_change()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
begin
  if old.account_status is distinct from new.account_status then
    insert into public.platform_admin_audit(actor_id,action,target_company_id,detail)
    values(auth.uid(),'company.status_changed',new.id,
      jsonb_build_object('from',old.account_status,'to',new.account_status,'active',new.active));
  end if;
  return new;
end $$;
revoke all on function private.audit_company_status_change() from public,anon,authenticated;

drop trigger if exists trg_audit_company_status on public.companies;
create trigger trg_audit_company_status
  after update on public.companies
  for each row execute function private.audit_company_status_change();

-- Audit plan/subscription movements.
create or replace function private.audit_subscription_change()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
begin
  if tg_op='INSERT' then
    insert into public.platform_admin_audit(actor_id,action,target_company_id,detail)
    values(auth.uid(),'subscription.created',new.company_id,
      jsonb_build_object('plan_id',new.plan_id,'status',new.status,'period_end',new.current_period_end));
    return new;
  end if;
  if old.plan_id is distinct from new.plan_id or old.status is distinct from new.status
     or old.current_period_end is distinct from new.current_period_end then
    insert into public.platform_admin_audit(actor_id,action,target_company_id,detail)
    values(auth.uid(),'subscription.updated',new.company_id,
      jsonb_build_object('from_plan',old.plan_id,'to_plan',new.plan_id,
        'from_status',old.status,'to_status',new.status,
        'from_period_end',old.current_period_end,'to_period_end',new.current_period_end));
  end if;
  return new;
end $$;
revoke all on function private.audit_subscription_change() from public,anon,authenticated;

drop trigger if exists trg_audit_subscription_ins on public.subscriptions;
create trigger trg_audit_subscription_ins
  after insert on public.subscriptions
  for each row execute function private.audit_subscription_change();

drop trigger if exists trg_audit_subscription_upd on public.subscriptions;
create trigger trg_audit_subscription_upd
  after update on public.subscriptions
  for each row execute function private.audit_subscription_change();

-- Audit support triage.
create or replace function private.audit_support_status_change()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
begin
  if old.status is distinct from new.status then
    insert into public.platform_admin_audit(actor_id,action,target_company_id,detail)
    values(auth.uid(),'support.status_changed',new.company_id,
      jsonb_build_object('from',old.status,'to',new.status,'subject',new.subject));
  end if;
  return new;
end $$;
revoke all on function private.audit_support_status_change() from public,anon,authenticated;

drop trigger if exists trg_audit_support_status on public.support_requests;
create trigger trg_audit_support_status
  after update on public.support_requests
  for each row execute function private.audit_support_status_change();

-- ---------------------------------------------------------------------------
-- 2. Plan request renewal no longer deadlocks on a stale pending row
-- ---------------------------------------------------------------------------
create or replace function public.request_company_plan_v3(
  p_company_id uuid,p_plan_id uuid,p_payment_method text,p_months integer default 1,p_payer_abroad boolean default false
) returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_plan public.plans%rowtype; v_req public.plan_requests%rowtype; v_now timestamptz:=now();
begin
  if v_user is null then raise exception 'authentication_required'; end if;
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
    -- El dueño cambió de plan/método o quedó una solicitud legacy atascada.
    -- Se cierra como cancelada (y se anula su factura abierta) en lugar de
    -- bloquear para siempre la renovación con pending_plan_request_exists.
    update public.plan_requests
       set status='cancelled',
           note=left(concat_ws(' · ',nullif(note,''),'Reemplazada por una nueva solicitud'),500)
     where id=v_req.id;
    update public.billing_invoices set status='void',updated_at=v_now
     where plan_request_id=v_req.id and status='open';
  end if;
  insert into public.plan_requests(company_id,requested_plan_id,requested_by,whatsapp_phone,status,requested_at,payment_method,payment_provider,billing_months,payer_abroad,quoted_amount,quoted_currency,terms_version)
  values(p_company_id,p_plan_id,v_user,'','pending',v_now,p_payment_method,'manual',p_months,coalesce(p_payer_abroad,false),v_plan.monthly_price*p_months,'USD',3)
  returning * into v_req;
  insert into public.billing_invoices(company_id,plan_request_id,invoice_number,period_start,period_end,due_at,amount,currency_code,status,external_reference)
  values(p_company_id,v_req.id,'PAL-'||v_req.id::text,v_now,(v_now at time zone 'UTC'+make_interval(months=>p_months)) at time zone 'UTC',v_now,v_req.quoted_amount,'USD','open','manual:plan_request:'||v_req.id);
  return jsonb_build_object('status','pending_payment','request_id',v_req.id,'billing_months',p_months,'quoted_amount',v_req.quoted_amount,'quoted_currency','USD');
end $$;
revoke all on function public.request_company_plan_v3(uuid,uuid,text,integer,boolean) from public,anon;
grant execute on function public.request_company_plan_v3(uuid,uuid,text,integer,boolean) to authenticated;

-- Owner can withdraw a pending request and start over.
create or replace function public.cancel_my_plan_request(p_company_id uuid)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_req public.plan_requests%rowtype; v_now timestamptz:=now();
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not exists(select 1 from public.company_memberships where company_id=p_company_id and user_id=v_user and is_owner and status='active') then raise exception 'owner_required'; end if;
  select * into v_req from public.plan_requests where company_id=p_company_id and status='pending' order by requested_at desc limit 1 for update;
  if not found then return jsonb_build_object('ok',true,'cancelled',false,'reason','no_pending_request'); end if;
  update public.plan_requests
     set status='cancelled',
         note=left(concat_ws(' · ',nullif(note,''),'Cancelada por el dueño'),500)
   where id=v_req.id;
  update public.billing_invoices set status='void',updated_at=v_now
   where plan_request_id=v_req.id and status='open';
  return jsonb_build_object('ok',true,'cancelled',true,'request_id',v_req.id);
end $$;
revoke all on function public.cancel_my_plan_request(uuid) from public,anon;
grant execute on function public.cancel_my_plan_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Admin console queries
-- ---------------------------------------------------------------------------
create or replace function public.get_platform_overview()
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  return jsonb_build_object(
    'companies_total',(select count(*) from public.companies),
    'companies_active',(select count(*) from public.companies where active and account_status='active'),
    'companies_suspended',(select count(*) from public.companies where account_status='suspended'),
    'companies_setup',(select count(*) from public.companies where account_status='setup'),
    'companies_pending_payment',(select count(*) from public.companies where account_status='pending_payment'),
    'companies_new_30d',(select count(*) from public.companies where created_at>now()-interval '30 days'),
    'pending_plan_requests',(select count(*) from public.plan_requests where status='pending'),
    'mrr_usd',(select coalesce(sum(p.monthly_price),0) from public.subscriptions s
      join public.plans p on p.id=s.plan_id
      where s.status in ('active','trialing') and p.code in ('starter','growth','pro')
        and (s.current_period_end is null or s.current_period_end>now())),
    'expiring_7d',(select count(*) from public.subscriptions s
      join public.plans p on p.id=s.plan_id
      where p.code in ('starter','growth','pro')
        and s.current_period_end between now() and now()+interval '7 days'),
    'open_invoices',(select count(*) from public.billing_invoices where status='open'),
    'open_invoice_amount',(select coalesce(sum(amount),0) from public.billing_invoices where status='open'),
    'payments_30d_amount',(select coalesce(sum(amount),0) from public.billing_payments
      where status='paid' and paid_at>now()-interval '30 days'),
    'payments_30d_count',(select count(*) from public.billing_payments
      where status='paid' and paid_at>now()-interval '30 days'),
    'support_open',(select count(*) from public.support_requests where status='open'),
    'support_in_progress',(select count(*) from public.support_requests where status='in_progress'),
    'users_total',(select count(*) from public.profiles)
  );
end $$;
revoke all on function public.get_platform_overview() from public,anon;
grant execute on function public.get_platform_overview() to authenticated;

create or replace function public.get_platform_plans()
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',p.id,'code',p.code,'name',p.name,'monthly_price',p.monthly_price,
      'currency',trim(p.billing_currency_code),'limits',p.limits,'features',p.features,'active',p.active
    ) order by p.monthly_price)
    from public.plans p where p.active
  ),'[]'::jsonb);
end $$;
revoke all on function public.get_platform_plans() from public,anon;
grant execute on function public.get_platform_plans() to authenticated;

create or replace function public.get_pending_plan_requests(p_status text default 'pending',p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_status text; v_limit integer;
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  v_status:=nullif(lower(trim(coalesce(p_status,'pending'))),'');
  if v_status='all' then v_status:=null; end if;
  if v_status is not null and v_status not in ('pending','approved','rejected','cancelled') then
    raise exception 'invalid_request_status';
  end if;
  v_limit:=least(greatest(coalesce(p_limit,200),1),500);
  return coalesce((
    select jsonb_agg(x order by (x->>'requested_at') desc)
    from (
      select jsonb_build_object(
        'id',r.id,
        'status',r.status,
        'company_id',r.company_id,
        'company_name',coalesce(c.name,'Empresa sin nombre'),
        'company_status',c.account_status,
        'plan_code',p.code,
        'plan_name',coalesce(p.name,'Plan'),
        'monthly_price',p.monthly_price,
        'billing_months',r.billing_months,
        'quoted_amount',coalesce(r.quoted_amount,case when p.monthly_price is not null then p.monthly_price*coalesce(r.billing_months,1) end),
        'quoted_currency',coalesce(r.quoted_currency,'USD'),
        'payment_method',r.payment_method,
        'payment_provider',r.payment_provider,
        'payer_abroad',r.payer_abroad,
        'terms_version',r.terms_version,
        'requested_at',r.requested_at,
        'approved_at',r.approved_at,
        'note',r.note,
        'contact_phone',coalesce(
          nullif(trim(r.whatsapp_phone),''),
          nullif(trim((select pr.phone from public.profiles pr where pr.id=r.requested_by)),'')
        ),
        'owner_email',(select au.email from auth.users au where au.id=r.requested_by)
      ) as x
      from public.plan_requests r
      left join public.companies c on c.id=r.company_id
      left join public.plans p on p.id=r.requested_plan_id
      where v_status is null or r.status=v_status
      order by r.requested_at desc
      limit v_limit
    ) q
  ),'[]'::jsonb);
end $$;
revoke all on function public.get_pending_plan_requests(text,integer) from public,anon;
grant execute on function public.get_pending_plan_requests(text,integer) to authenticated;

-- Production still carried a zero-argument overload; delegate it so both call
-- shapes return the same enriched payload (PostgREST picks this one for rpc()
-- without arguments).
create or replace function public.get_pending_plan_requests()
returns jsonb language sql security definer set search_path=public,private,pg_temp as $$
  select public.get_pending_plan_requests('pending',200);
$$;
revoke all on function public.get_pending_plan_requests() from public,anon;
grant execute on function public.get_pending_plan_requests() to authenticated;

create or replace function public.get_platform_billing_payments(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_limit integer;
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  v_limit:=least(greatest(coalesce(p_limit,100),1),500);
  return coalesce((
    select jsonb_agg(x order by (x->>'created_at') desc)
    from (
      select jsonb_build_object(
        'id',bp.id,
        'company_id',bp.company_id,
        'company_name',coalesce(c.name,'Empresa'),
        'amount',bp.amount,
        'currency',trim(bp.currency_code),
        'status',bp.status,
        'payment_method',bp.payment_method,
        'payment_provider',bp.payment_provider,
        'reference',bp.external_reference,
        'paid_at',bp.paid_at,
        'created_at',bp.created_at,
        'plan_code',p.code,
        'manual_reference',bp.metadata->>'manual_reference'
      ) as x
      from public.billing_payments bp
      left join public.companies c on c.id=bp.company_id
      left join public.subscriptions s on s.id=bp.subscription_id
      left join public.plans p on p.id=s.plan_id
      order by bp.created_at desc
      limit v_limit
    ) q
  ),'[]'::jsonb);
end $$;
revoke all on function public.get_platform_billing_payments(integer) from public,anon;
grant execute on function public.get_platform_billing_payments(integer) to authenticated;

create or replace function public.get_platform_admin_audit(p_limit integer default 100,p_company_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_limit integer;
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  v_limit:=least(greatest(coalesce(p_limit,100),1),500);
  return coalesce((
    select jsonb_agg(x order by (x->>'created_at') desc)
    from (
      select jsonb_build_object(
        'id',a.id,
        'actor_id',a.actor_id,
        'actor_email',(select au.email from auth.users au where au.id=a.actor_id),
        'action',a.action,
        'target_company_id',a.target_company_id,
        'company_name',(select c.name from public.companies c where c.id=a.target_company_id),
        'target_request_id',a.target_request_id,
        'detail',a.detail,
        'created_at',a.created_at
      ) as x
      from public.platform_admin_audit a
      where p_company_id is null or a.target_company_id=p_company_id
      order by a.created_at desc
      limit v_limit
    ) q
  ),'[]'::jsonb);
end $$;
revoke all on function public.get_platform_admin_audit(integer,uuid) from public,anon;
grant execute on function public.get_platform_admin_audit(integer,uuid) to authenticated;

create or replace function public.get_platform_company_detail(p_company_id uuid)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_company jsonb;
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  select jsonb_build_object(
    'id',c.id,'name',c.name,'slug',c.slug,'account_status',c.account_status,
    'active',c.active,'created_at',c.created_at,'currency',trim(c.default_currency_code)
  ) into v_company
  from public.companies c where c.id=p_company_id;
  if v_company is null then raise exception 'company_not_found'; end if;
  return jsonb_build_object(
    'company',v_company,
    'subscription',(
      select jsonb_build_object(
        'plan_code',p.code,'plan_name',p.name,'monthly_price',p.monthly_price,
        'status',s.status,'starts_at',s.starts_at,
        'current_period_start',s.current_period_start,'current_period_end',s.current_period_end,
        'trial_ends_at',s.trial_ends_at,'grace_ends_at',s.grace_ends_at,'cancelled_at',s.cancelled_at
      )
      from public.subscriptions s left join public.plans p on p.id=s.plan_id
      where s.company_id=p_company_id
    ),
    'counts',jsonb_build_object(
      'products',(select count(*) from public.products pr where pr.company_id=p_company_id and pr.status is distinct from 'archived'),
      'employees',(select count(*) from public.employees e where e.company_id=p_company_id and e.active),
      'warehouses',(select count(*) from public.warehouses w where w.company_id=p_company_id and w.active)
    ),
    'requests',coalesce((
      select jsonb_agg(x order by (x->>'requested_at') desc)
      from (
        select jsonb_build_object(
          'id',r.id,'status',r.status,'plan_code',p.code,'plan_name',coalesce(p.name,'Plan'),
          'billing_months',r.billing_months,'quoted_amount',r.quoted_amount,
          'quoted_currency',r.quoted_currency,'payment_method',r.payment_method,
          'requested_at',r.requested_at,'approved_at',r.approved_at,'note',r.note
        ) as x
        from public.plan_requests r left join public.plans p on p.id=r.requested_plan_id
        where r.company_id=p_company_id order by r.requested_at desc limit 20
      ) q
    ),'[]'::jsonb),
    'invoices',coalesce((
      select jsonb_agg(x order by (x->>'created_at') desc)
      from (
        select jsonb_build_object(
          'invoice_number',i.invoice_number,'amount',i.amount,'currency',trim(i.currency_code),
          'status',i.status,'period_start',i.period_start,'period_end',i.period_end,
          'paid_at',i.paid_at,'created_at',i.created_at
        ) as x
        from public.billing_invoices i where i.company_id=p_company_id
        order by i.created_at desc limit 20
      ) q
    ),'[]'::jsonb),
    'payments',coalesce((
      select jsonb_agg(x order by (x->>'created_at') desc)
      from (
        select jsonb_build_object(
          'id',bp.id,'amount',bp.amount,'currency',trim(bp.currency_code),'status',bp.status,
          'payment_method',bp.payment_method,'reference',bp.external_reference,
          'paid_at',bp.paid_at,'created_at',bp.created_at
        ) as x
        from public.billing_payments bp where bp.company_id=p_company_id
        order by bp.created_at desc limit 20
      ) q
    ),'[]'::jsonb)
  );
end $$;
revoke all on function public.get_platform_company_detail(uuid) from public,anon;
grant execute on function public.get_platform_company_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Manual plan assignment / extension from the admin console
-- ---------------------------------------------------------------------------
create or replace function public.set_platform_company_plan_v2(
  p_company_id uuid,p_plan_code text,p_months integer default 1,p_note text default null
) returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
  v_user uuid:=auth.uid(); v_plan public.plans%rowtype; v_sub public.subscriptions%rowtype;
  v_now timestamptz:=clock_timestamp(); v_start timestamptz; v_end timestamptz; v_months integer;
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  if p_plan_code is null or p_plan_code not in ('free','starter','growth','pro') then
    raise exception 'invalid_plan';
  end if;
  v_months:=case when p_plan_code='free' then 0 else coalesce(p_months,1) end;
  if p_plan_code<>'free' and v_months not in (1,3,6,12) then raise exception 'invalid_billing_months'; end if;
  select * into v_plan from public.plans where code=p_plan_code and active;
  if not found then raise exception 'plan_not_available'; end if;
  perform 1 from public.companies where id=p_company_id for update;
  if not found then raise exception 'company_not_found'; end if;
  if p_plan_code<>'free' then perform private.assert_plan_capacity(p_company_id,v_plan.id); end if;
  select * into v_sub from public.subscriptions where company_id=p_company_id for update;
  if p_plan_code='free' then
    v_start:=v_now; v_end:=null;
  else
    v_start:=v_now;
    if v_sub.id is not null and v_sub.plan_id=v_plan.id and v_sub.current_period_end>v_now then
      v_start:=v_sub.current_period_end;
    end if;
    v_end:=((v_start at time zone 'UTC')+make_interval(months=>v_months)) at time zone 'UTC';
  end if;
  insert into public.subscriptions(company_id,plan_id,status,starts_at,trial_ends_at,current_period_start,current_period_end,grace_ends_at,cancelled_at,updated_at)
  values(p_company_id,v_plan.id,'active',coalesce(v_sub.starts_at,v_now),null,v_now,v_end,null,null,v_now)
  on conflict(company_id) do update set
    plan_id=excluded.plan_id,status='active',trial_ends_at=null,
    current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,
    grace_ends_at=null,cancelled_at=null,updated_at=excluded.updated_at
  returning * into v_sub;
  -- Manual assignment supersedes any request still waiting for approval.
  update public.plan_requests
     set status='cancelled',
         note=left(concat_ws(' · ',nullif(note,''),'Sustituida por asignación manual del administrador'),500)
   where company_id=p_company_id and status='pending';
  update public.billing_invoices set status='void',updated_at=v_now
   where company_id=p_company_id and status='open';
  update public.companies set account_status='active',active=true,updated_at=v_now where id=p_company_id;
  perform private.log_platform_admin_action(
    'company.plan_assigned',p_company_id,null,
    jsonb_build_object('plan_code',p_plan_code,'months',v_months,'period_end',v_end,'note',left(nullif(trim(p_note),''),500))
  );
  return jsonb_build_object('ok',true,'company_id',p_company_id,'plan_code',v_plan.code,
    'plan_name',v_plan.name,'months',v_months,'current_period_end',v_end);
end $$;
revoke all on function public.set_platform_company_plan_v2(uuid,text,integer,text) from public,anon;
grant execute on function public.set_platform_company_plan_v2(uuid,text,integer,text) to authenticated;

-- Room for grow on the back-office screen.
create or replace function public.get_platform_support_requests(p_status text default 'open',p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_status text; v_limit integer;
begin
  if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then
    raise exception 'permission_denied';
  end if;
  v_status:=nullif(lower(trim(coalesce(p_status,'open'))),'');
  if v_status='all' then v_status:=null; end if;
  if v_status is not null and v_status not in ('open','in_progress','resolved','closed') then
    raise exception 'invalid_support_status';
  end if;
  v_limit:=least(greatest(coalesce(p_limit,200),1),500);
  return coalesce((
    select jsonb_agg(x order by (x->>'created_at') desc)
    from (
      select jsonb_build_object(
        'id',s.id,'company_id',s.company_id,
        'company_name',coalesce(s.company_name,c.name,'Empresa'),
        'request_type',s.request_type,'subject',s.subject,'message',s.message,
        'contact_phone',s.contact_phone,'status',s.status,
        'created_at',s.created_at,'updated_at',s.updated_at,
        'owner_email',(select au.email from auth.users au where au.id=s.user_id)
      ) as x
      from public.support_requests s
      left join public.companies c on c.id=s.company_id
      where v_status is null or s.status=v_status
      order by s.created_at desc
      limit v_limit
    ) q
  ),'[]'::jsonb);
end $$;
revoke all on function public.get_platform_support_requests(text,integer) from public,anon;
grant execute on function public.get_platform_support_requests(text,integer) to authenticated;

commit;
