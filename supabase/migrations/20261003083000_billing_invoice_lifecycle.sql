-- PALMYRA billing invoice lifecycle
create table if not exists public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  plan_request_id uuid references public.plan_requests(id) on delete set null,
  invoice_number text not null,period_start timestamptz not null,period_end timestamptz not null,due_at timestamptz not null,
  amount numeric not null check(amount>=0),currency_code bpchar not null,
  status text not null default 'open' check(status in ('open','paid','void')),paid_at timestamptz,external_reference text,
  created_at timestamptz not null default timezone('utc',now()),updated_at timestamptz not null default timezone('utc',now()),
  unique(company_id,invoice_number)
);
alter table public.billing_invoices enable row level security;
drop policy if exists billing_invoices_owner_read on public.billing_invoices;
create policy billing_invoices_owner_read on public.billing_invoices for select to authenticated using (exists(select 1 from public.company_memberships cm where cm.company_id=billing_invoices.company_id and cm.user_id=auth.uid() and cm.status='active' and cm.is_owner=true));
revoke all on public.billing_invoices from anon; grant select on public.billing_invoices to authenticated;

create or replace function public.get_my_billing_invoices(p_company_id uuid)
returns setof public.billing_invoices language plpgsql security definer set search_path to 'public','private','pg_temp' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.company_memberships cm where cm.company_id=p_company_id and cm.user_id=auth.uid() and cm.status='active' and cm.is_owner=true) then raise exception 'owner_required'; end if;
 return query select * from public.billing_invoices where company_id=p_company_id order by created_at desc limit 50;
end; $$;
revoke all on function public.get_my_billing_invoices(uuid) from public,anon; grant execute on function public.get_my_billing_invoices(uuid) to authenticated;

create or replace function public.approve_plan_request(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public','private','pg_temp' as $$
declare v_now timestamptz:=timezone('utc',now());v_req public.plan_requests%rowtype;v_user uuid:=auth.uid();v_plan public.plans%rowtype;v_sub public.subscriptions%rowtype;v_invoice text;v_company_currency bpchar;v_payment_id uuid;
begin
 if v_user is null or not exists(select 1 from public.platform_admins where user_id=v_user) then raise exception 'permission_denied'; end if;
 select * into v_req from public.plan_requests where id=p_request_id and status='pending' for update;
 if not found then raise exception 'plan_request_not_found'; end if;
 select * into v_plan from public.plans where id=v_req.requested_plan_id and active;
 if not found or v_plan.code='trial' then raise exception 'invalid_paid_plan'; end if;
 select default_currency_code into v_company_currency from public.companies where id=v_req.company_id;
 insert into public.subscriptions(company_id,plan_id,status,starts_at,trial_ends_at,current_period_start,current_period_end,cancelled_at,updated_at)
 values(v_req.company_id,v_plan.id,'active',v_now,null,v_now,v_now+interval '30 days',null,v_now)
 on conflict(company_id) do update set plan_id=excluded.plan_id,status=excluded.status,starts_at=excluded.starts_at,trial_ends_at=null,current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,cancelled_at=null,updated_at=excluded.updated_at returning * into v_sub;
 v_invoice:='PAL-'||to_char(v_now,'YYYYMM')||'-'||lpad((select count(*)+1 from public.billing_invoices where company_id=v_req.company_id)::text,5,'0');
 insert into public.billing_invoices(company_id,subscription_id,plan_request_id,invoice_number,period_start,period_end,due_at,amount,currency_code,status,paid_at,external_reference)
 values(v_req.company_id,v_sub.id,v_req.id,v_invoice,v_now,v_now+interval '30 days',v_now,v_plan.monthly_price,coalesce(v_plan.billing_currency_code,'USD'),'paid',v_now,'manual_cash:plan_request:'||v_req.id) on conflict(company_id,invoice_number) do nothing;
 insert into public.billing_payments(company_id,subscription_id,amount,currency_code,status,external_reference,paid_at)
 values(v_req.company_id,v_sub.id,v_plan.monthly_price,coalesce(v_plan.billing_currency_code,'USD'),'paid','manual_cash:plan_request:'||v_req.id,v_now)
 returning id into v_payment_id;
 update public.plan_requests set status='approved',approved_at=v_now,approved_by=v_user where id=v_req.id;
 update public.companies set account_status='active',active=true,updated_at=v_now where id=v_req.company_id;
 return jsonb_build_object('ok',true,'company_id',v_req.company_id,'plan_code',v_plan.code,'plan_name',v_plan.name,'invoice_number',v_invoice,'payment_id',v_payment_id);
end; $$;
revoke all on function public.approve_plan_request(uuid) from public,anon; grant execute on function public.approve_plan_request(uuid) to authenticated;

-- Payment abstraction: manual cash is active for Cuba; online providers are reserved for future international checkout.
alter table public.plans add column if not exists billing_currency_code bpchar not null default 'USD';
update public.plans set billing_currency_code='USD' where billing_currency_code is null;

alter table public.plan_requests add column if not exists payment_method text not null default 'manual_cash';
alter table public.plan_requests add column if not exists payment_provider text not null default 'manual_cash';
alter table public.billing_payments add column if not exists payment_method text not null default 'manual_cash';
alter table public.billing_payments add column if not exists payment_provider text not null default 'manual_cash';
alter table public.billing_payments add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.plan_requests drop constraint if exists plan_requests_payment_method_check;
alter table public.plan_requests add constraint plan_requests_payment_method_check check (payment_method in ('manual_cash','online'));
alter table public.plan_requests drop constraint if exists plan_requests_payment_provider_check;
alter table public.plan_requests add constraint plan_requests_payment_provider_check check (payment_provider in ('manual_cash','stripe','paypal'));

alter table public.billing_payments drop constraint if exists billing_payments_payment_method_check;
alter table public.billing_payments add constraint billing_payments_payment_method_check check (payment_method in ('manual_cash','card','bank_transfer','other'));
alter table public.billing_payments drop constraint if exists billing_payments_payment_provider_check;
alter table public.billing_payments add constraint billing_payments_payment_provider_check check (payment_provider in ('manual_cash','stripe','paypal','other'));

create index if not exists plan_requests_company_status_idx on public.plan_requests(company_id,status,requested_at desc);
create index if not exists billing_payments_company_created_idx on public.billing_payments(company_id,created_at desc);

create or replace function public.set_manual_cash_payment(
  p_request_id uuid,
  p_reference text default null,
  p_note text default null
) returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_user uuid:=auth.uid();
  v_req public.plan_requests%rowtype;
  v_plan public.plans%rowtype;
  v_company_currency bpchar;
begin
  if v_user is null or not exists(
    select 1 from public.platform_admins where user_id=v_user
  ) then raise exception 'permission_denied'; end if;

  select * into v_req from public.plan_requests where id=p_request_id for update;
  if not found then raise exception 'plan_request_not_found'; end if;
  if v_req.status<>'pending' then raise exception 'plan_request_not_pending'; end if;

  select * into v_plan from public.plans where id=v_req.requested_plan_id and active;
  if not found then raise exception 'invalid_plan'; end if;

  select default_currency_code into v_company_currency
  from public.companies where id=v_req.company_id;

  update public.plan_requests
    set payment_method='manual_cash',
        payment_provider='manual_cash',
        note=coalesce(p_note,note)
  where id=v_req.id;

  return jsonb_build_object(
    'ok',true,
    'request_id',v_req.id,
    'plan_code',v_plan.code,
    'amount',v_plan.monthly_price,
    'currency_code',coalesce(v_plan.billing_currency_code,'USD'),
    'company_currency_code',v_company_currency,
    'payment_method','manual_cash'
  );
end;
$$;

revoke all on function public.set_manual_cash_payment(uuid,text,text) from public,anon;
grant execute on function public.set_manual_cash_payment(uuid,text,text) to authenticated;


create or replace function public.create_open_invoice_for_plan_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_req public.plan_requests%rowtype;
  v_plan public.plans%rowtype;
  v_now timestamptz:=timezone('utc',now());
  v_invoice text;
  v_id uuid;
begin
  select * into v_req from public.plan_requests where id=p_request_id for update;
  if not found then raise exception 'plan_request_not_found'; end if;

  select * into v_plan from public.plans where id=v_req.requested_plan_id and active;
  if not found or v_plan.code='trial' then raise exception 'invalid_paid_plan'; end if;

  select id into v_id from public.billing_invoices
  where plan_request_id=v_req.id and status='open'
  order by created_at desc limit 1;

  if v_id is null then
    v_invoice:='PAL-'||to_char(v_now,'YYYYMMDD')||'-'||substr(replace(gen_random_uuid()::text,'-',''),1,10);
    insert into public.billing_invoices(
      company_id,plan_request_id,invoice_number,period_start,period_end,due_at,
      amount,currency_code,status,external_reference
    )
    values(
      v_req.company_id,v_req.id,v_invoice,v_now,v_now+interval '30 days',v_now,
      v_plan.monthly_price,coalesce(v_plan.billing_currency_code,'USD'),'open',
      'manual_cash:plan_request:'||v_req.id
    )
    returning id into v_id;
  end if;

  return jsonb_build_object(
    'invoice_id',v_id,
    'invoice_number',(select invoice_number from public.billing_invoices where id=v_id),
    'amount',(select amount from public.billing_invoices where id=v_id),
    'currency_code',(select currency_code from public.billing_invoices where id=v_id)
  );
end;
$$;

revoke all on function public.create_open_invoice_for_plan_request(uuid) from public,anon;
grant execute on function public.create_open_invoice_for_plan_request(uuid) to authenticated;
