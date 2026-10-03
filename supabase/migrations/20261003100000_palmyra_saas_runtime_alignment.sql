-- PALMYRA final SaaS runtime alignment
-- One account owns exactly one company. A company may own multiple warehouses
-- within the limits of its active plan.

create unique index if not exists company_memberships_one_company_per_user_uidx
  on public.company_memberships(user_id);

create or replace function private.enforce_plan_limit()
returns trigger
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_limit integer;
  v_count integer;
  v_kind text;
  v_company_id uuid;
  v_will_count boolean:=false;
  v_account_status text;
begin
  if TG_OP='DELETE' then return old; end if;
  v_company_id:=new.company_id;
  if v_company_id is null then raise exception 'company_required'; end if;

  if TG_TABLE_NAME='products' then
    v_kind:='products';
    v_will_count:=new.status is distinct from 'archived';
    if TG_OP='UPDATE' and old.status is distinct from 'archived' then v_will_count:=false; end if;
  elsif TG_TABLE_NAME='warehouses' then
    v_kind:='warehouses';
    v_will_count:=coalesce(new.active,true);
    if TG_OP='UPDATE' and coalesce(old.active,true) then v_will_count:=false; end if;

    select account_status into v_account_status from public.companies where id=v_company_id;
    -- create_company() provisions the first warehouse before the selected
    -- subscription exists. That bootstrap warehouse is always allowed once.
    if TG_OP='INSERT'
       and v_account_status='setup'
       and not exists(select 1 from public.warehouses where company_id=v_company_id)
    then
      return new;
    end if;
  elsif TG_TABLE_NAME='employees' then
    v_kind:='employees';
    v_will_count:=coalesce(new.active,true);
    if TG_OP='UPDATE' and coalesce(old.active,true) then v_will_count:=false; end if;
  else
    return new;
  end if;

  if not v_will_count then return new; end if;

  select coalesce((p.limits->>v_kind)::int,999999) into v_limit
  from public.subscriptions s
  join public.plans p on p.id=s.plan_id
  where s.company_id=v_company_id
    and s.status in ('active','trialing','past_due')
  order by s.updated_at desc nulls last
  limit 1;

  v_limit:=coalesce(v_limit,0);

  if TG_TABLE_NAME='products' then
    select count(*) into v_count from public.products where company_id=v_company_id and status is distinct from 'archived';
  elsif TG_TABLE_NAME='warehouses' then
    select count(*) into v_count from public.warehouses where company_id=v_company_id and active;
  else
    select count(*) into v_count from public.employees where company_id=v_company_id and active;
  end if;

  if v_count>=v_limit then
    raise exception 'plan_%_limit',v_kind using errcode='P0001';
  end if;
  return new;
end;
$function$;

create table if not exists public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  plan_request_id uuid references public.plan_requests(id) on delete set null,
  invoice_number text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  due_at timestamptz not null,
  amount numeric not null check(amount>=0),
  currency_code bpchar not null,
  status text not null default 'open' check(status in ('open','paid','void')),
  paid_at timestamptz,
  external_reference text,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now()),
  unique(company_id,invoice_number)
);

alter table public.billing_invoices enable row level security;
drop policy if exists billing_invoices_owner_read on public.billing_invoices;
create policy billing_invoices_owner_read
  on public.billing_invoices
  for select to authenticated
  using (exists(
    select 1 from public.company_memberships cm
    where cm.company_id=billing_invoices.company_id
      and cm.user_id=auth.uid()
      and cm.status='active'
      and cm.is_owner=true
  ));
revoke all on public.billing_invoices from anon;
grant select on public.billing_invoices to authenticated;

create or replace function public.get_my_billing_invoices(p_company_id uuid)
returns setof public.billing_invoices
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
begin
  if auth.uid() is null or not exists(
    select 1 from public.company_memberships cm
    where cm.company_id=p_company_id
      and cm.user_id=auth.uid()
      and cm.status='active'
      and cm.is_owner=true
  ) then raise exception 'owner_required'; end if;
  return query
    select * from public.billing_invoices
    where company_id=p_company_id
    order by created_at desc limit 50;
end;
$$;
revoke all on function public.get_my_billing_invoices(uuid) from public,anon;
grant execute on function public.get_my_billing_invoices(uuid) to authenticated;

create or replace function public.get_invitation_for_email_send(p_invitation_id uuid,p_token text)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
declare v jsonb; v_hash text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if p_token is null or length(trim(p_token))<16 then raise exception 'invitation_token_required'; end if;
  v_hash:=encode(digest(trim(p_token),'sha256'),'hex');
  select jsonb_build_object(
    'id',i.id,'company_id',i.company_id,'employee_id',i.employee_id,'email',i.email,
    'status',i.status,'expires_at',i.expires_at,'company_name',c.name,
    'employee_name',coalesce(e.full_name,'Trabajador'),'role_name',coalesce(r.name,'Empleado')
  ) into v
  from public.company_invitations i
  join public.companies c on c.id=i.company_id
  left join public.employees e on e.id=i.employee_id
  left join public.roles r on r.id=i.role_id
  where i.id=p_invitation_id and i.token_hash=v_hash and i.status='pending'
    and i.expires_at>timezone('utc',now())
    and private.has_permission(i.company_id,'employees.manage');
  if v is null then raise exception 'invitation_not_found_or_forbidden'; end if;
  return v;
end;
$$;
revoke all on function public.get_invitation_for_email_send(uuid) from public,anon,authenticated;
revoke all on function public.get_invitation_for_email_send(uuid,text) from public,anon;
grant execute on function public.get_invitation_for_email_send(uuid,text) to authenticated;

-- International billing is provider-neutral for now. Cuba uses manual cash.
alter table public.plan_requests
  add column if not exists payment_method text,
  add column if not exists payment_provider text;

update public.plan_requests
set payment_method=coalesce(payment_method,'manual_cash'),
    payment_provider=coalesce(payment_provider,'manual_cash')
where payment_method is null or payment_provider is null;

alter table public.plan_requests
  drop constraint if exists plan_requests_payment_method_check;
alter table public.plan_requests
  add constraint plan_requests_payment_method_check
  check (payment_method is null or payment_method in ('manual_cash','bank_transfer','card','online'));

alter table public.plan_requests
  drop constraint if exists plan_requests_payment_provider_check;
alter table public.plan_requests
  add constraint plan_requests_payment_provider_check
  check (payment_provider is null or payment_provider in ('manual_cash','stripe','paypal','mercadopago','bank_transfer'));

create or replace function public.select_company_plan(p_company_id uuid,p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_user uuid:=auth.uid();
  v_plan public.plans%rowtype;
  v_company public.companies%rowtype;
  v_sub public.subscriptions%rowtype;
  v_request public.plan_requests%rowtype;
  v_is_owner boolean:=false;
  v_employee_count integer;
  v_warehouse_count integer;
  v_product_count integer;
  v_product_limit integer;
  v_employee_limit integer;
  v_warehouse_limit integer;
  v_has_subscription boolean;
  v_now timestamptz:=timezone('utc',now());
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  select c.* into v_company from public.companies c
    where c.id=p_company_id and c.active and private.has_company_access(c.id) limit 1;
  if not found then raise exception 'company_access_denied'; end if;

  select exists(
    select 1 from public.company_memberships cm
    where cm.company_id=p_company_id and cm.user_id=v_user and cm.status='active' and cm.is_owner=true
  ) or v_company.created_by=v_user into v_is_owner;
  if not v_is_owner then raise exception 'owner_required'; end if;

  select * into v_plan from public.plans where id=p_plan_id and active limit 1;
  if not found or v_plan.code='trial' then raise exception 'invalid_plan'; end if;

  select count(*)::int into v_employee_count from public.employees e where e.company_id=p_company_id and e.active;
  select count(*)::int into v_warehouse_count from public.warehouses w where w.company_id=p_company_id and w.active;
  select count(*)::int into v_product_count from public.products p where p.company_id=p_company_id and p.status<>'archived';

  v_employee_limit:=coalesce((v_plan.limits->>'employees')::int,999999);
  v_warehouse_limit:=coalesce((v_plan.limits->>'warehouses')::int,999999);
  v_product_limit:=coalesce((v_plan.limits->>'products')::int,999999);

  if v_warehouse_count>v_warehouse_limit then raise exception 'plan_warehouse_limit'; end if;
  if v_employee_count>v_employee_limit then raise exception 'plan_employee_limit'; end if;
  if v_product_count>v_product_limit then raise exception 'plan_product_limit'; end if;

  select * into v_sub from public.subscriptions where company_id=p_company_id order by updated_at desc limit 1;
  v_has_subscription:=v_sub.id is not null;

  if v_plan.code='starter' and not v_has_subscription then
    insert into public.subscriptions(company_id,plan_id,status,starts_at,trial_ends_at,current_period_start,current_period_end,cancelled_at,updated_at)
    values(p_company_id,v_plan.id,'trialing',v_now,v_now+interval '90 days',v_now,v_now+interval '90 days',null,v_now)
    on conflict(company_id) do update set plan_id=excluded.plan_id,status='trialing',starts_at=excluded.starts_at,trial_ends_at=excluded.trial_ends_at,
      current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,cancelled_at=null,updated_at=excluded.updated_at;
    update public.companies set account_status='active',active=true,updated_at=v_now where id=p_company_id;
    return jsonb_build_object('status','active','plan_code','starter','trial_ends_at',v_now+interval '90 days');
  end if;

  if v_plan.code='starter' and v_has_subscription then
    insert into public.plan_requests(company_id,requested_plan_id,requested_by,status,requested_at,note,payment_method,payment_provider)
    values(p_company_id,v_plan.id,v_user,'pending',v_now,'Cambio a Starter; sin nueva prueba gratuita.','manual_cash','manual_cash');
    update public.companies set account_status='pending_payment',active=true,updated_at=v_now where id=p_company_id;
    return jsonb_build_object('status','pending_payment','plan_code','starter');
  end if;

  select * into v_request from public.plan_requests pr where pr.company_id=p_company_id and pr.status='pending' order by pr.requested_at desc limit 1;

  if v_request.id is null then
    insert into public.plan_requests(company_id,requested_plan_id,requested_by,whatsapp_phone,status,requested_at,payment_method,payment_provider)
    values(p_company_id,v_plan.id,v_user,'55581669','pending',v_now,'manual_cash','manual_cash') returning * into v_request;
  else
    update public.plan_requests set requested_plan_id=v_plan.id,requested_by=v_user,requested_at=v_now,status='pending',note=null,approved_at=null,approved_by=null,payment_method='manual_cash',payment_provider='manual_cash'
    where id=v_request.id returning * into v_request;
  end if;

  update public.plan_requests set status='cancelled',note='Solicitud sustituida por otra selección de plan.'
  where company_id=p_company_id and status='pending' and id<>v_request.id;

  update public.companies set account_status='pending_payment',active=true,updated_at=v_now where id=p_company_id;
  return jsonb_build_object('status','pending_payment','plan_code',v_plan.code,'plan_name',v_plan.name,'request_id',v_request.id,'payment_method','manual_cash','payment_provider','manual_cash');
end;
$$;
revoke all on function public.select_company_plan(uuid,uuid) from public,anon;
grant execute on function public.select_company_plan(uuid,uuid) to authenticated;
