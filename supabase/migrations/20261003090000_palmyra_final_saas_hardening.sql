-- PALMYRA final SaaS hardening
-- One account -> one company; warehouses/products honor the selected plan even while payment is pending.
-- Public store/catalog is intentionally absent from the runtime.

create unique index if not exists company_memberships_one_company_per_user_uidx
  on public.company_memberships(user_id);

revoke all on table public.company_fiscal_reservations from anon,authenticated;
revoke all on table public.company_fiscal_sequences from anon,authenticated;

update public.plans set active=false where code='trial';

create or replace function public.create_open_invoice_for_plan_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_user uuid:=auth.uid();
  v_req public.plan_requests%rowtype;
  v_plan public.plans%rowtype;
  v_now timestamptz:=timezone('utc',now());
  v_invoice text;
  v_id uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  select * into v_req
  from public.plan_requests
  where id=p_request_id
    and exists(
      select 1 from public.company_memberships cm
      where cm.company_id=plan_requests.company_id
        and cm.user_id=v_user
        and cm.status='active'
        and cm.is_owner=true
    )
  for update;
  if not found then raise exception 'owner_required'; end if;
  if v_req.status<>'pending' then raise exception 'plan_request_not_pending'; end if;
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
    ) values(
      v_req.company_id,v_req.id,v_invoice,v_now,v_now+interval '30 days',v_now,
      v_plan.monthly_price,coalesce(v_plan.billing_currency_code,'USD'),'open',
      'manual_cash:plan_request:'||v_req.id
    ) returning id into v_id;
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

create or replace function public.get_my_plan_request(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_user uuid:=auth.uid();
  v jsonb;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not exists(
    select 1 from public.company_memberships cm
    where cm.company_id=p_company_id
      and cm.user_id=v_user
      and cm.status='active'
      and cm.is_owner=true
  ) then raise exception 'owner_required'; end if;
  select jsonb_build_object(
    'id',pr.id,'status',pr.status,'requested_plan_id',pr.requested_plan_id,
    'requested_at',pr.requested_at,'approved_at',pr.approved_at,'note',pr.note,
    'plan_name',p.name,'plan_code',p.code,
    'payment_method',pr.payment_method,'payment_provider',pr.payment_provider,
    'whatsapp_phone',pr.whatsapp_phone
  ) into v
  from public.plan_requests pr
  join public.plans p on p.id=pr.requested_plan_id
  where pr.company_id=p_company_id
  order by pr.requested_at desc
  limit 1;
  return coalesce(v,'null'::jsonb);
end;
$$;

revoke all on function public.get_my_plan_request(uuid) from public,anon;
grant execute on function public.get_my_plan_request(uuid) to authenticated;

create or replace function public.create_warehouse_secure(p_company_id uuid,p_code text,p_name text)
returns jsonb language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare
 v_user uuid:=auth.uid(); v_limit integer; v_count integer; v_id uuid;
begin
 if v_user is null or not private.has_permission(p_company_id,'settings.manage') then raise exception 'permission_denied'; end if;
 if length(trim(p_name))<2 or length(trim(p_name))>120 then raise exception 'invalid_warehouse_name'; end if;
 if length(trim(p_code))<1 or length(trim(p_code))>40 then raise exception 'invalid_warehouse_code'; end if;

 select coalesce((p.limits->>'warehouses')::int,999999) into v_limit
 from public.subscriptions s join public.plans p on p.id=s.plan_id
 where s.company_id=p_company_id and s.status in ('trialing','active','past_due')
 order by s.updated_at desc nulls last limit 1;

 if v_limit is null then
   select coalesce((p.limits->>'warehouses')::int,999999) into v_limit
   from public.plan_requests r join public.plans p on p.id=r.requested_plan_id
   where r.company_id=p_company_id and r.status='pending'
   order by r.requested_at desc limit 1;
 end if;

 if v_limit is null then
   select coalesce((limits->>'warehouses')::int,999999) into v_limit
   from plans where code='starter' and active limit 1;
 end if;

 select count(*)::int into v_count from public.warehouses where company_id=p_company_id and active;
 if v_count>=coalesce(v_limit,999999) then raise exception 'plan_warehouse_limit'; end if;

 insert into public.warehouses(company_id,code,name,active)
 values(p_company_id,upper(trim(p_code)),trim(p_name),true)
 returning id into v_id;

 insert into public.cash_registers(company_id,warehouse_id,code,name,active)
 values(
   p_company_id,v_id,
   'CAJA-'||lpad((select count(*)+1 from public.cash_registers where company_id=p_company_id)::text,2,'0'),
   'Caja principal',true
 );

 return jsonb_build_object('id',v_id,'code',upper(trim(p_code)),'name',trim(p_name),'active',true);
exception when unique_violation then raise exception 'warehouse_code_taken';
end;
$$;

create or replace function public.create_product_secure(
 p_company_id uuid,p_category_id uuid,p_brand_id uuid,p_sku text,p_name text,p_description text,
 p_base_unit text,p_cost numeric,p_price numeric,p_commission_fixed numeric,p_commission_percent numeric,
 p_track_stock boolean,p_minimum_stock numeric,p_barcode text default null
) returns jsonb language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare v_user uuid:=auth.uid();v_limit integer;v_count integer;v_id uuid;
begin
 if v_user is null or not private.has_permission(p_company_id,'products.manage') then raise exception 'permission_denied'; end if;
 if length(trim(p_sku))<1 or length(trim(p_sku))>80 then raise exception 'invalid_product_sku'; end if;
 if length(trim(p_name))<2 or length(trim(p_name))>160 then raise exception 'invalid_product_name'; end if;
 if p_cost<0 or p_price<0 or p_minimum_stock<0 or p_commission_fixed<0 or p_commission_percent<0 or p_commission_percent>100 then raise exception 'invalid_product_values'; end if;

 select coalesce((p.limits->>'products')::int,999999) into v_limit
 from public.subscriptions s join public.plans p on p.id=s.plan_id
 where s.company_id=p_company_id and s.status in ('trialing','active','past_due')
 order by s.updated_at desc nulls last limit 1;

 if v_limit is null then
   select coalesce((p.limits->>'products')::int,999999) into v_limit
   from public.plan_requests r join public.plans p on p.id=r.requested_plan_id
   where r.company_id=p_company_id and r.status='pending'
   order by r.requested_at desc limit 1;
 end if;

 if v_limit is null then
   select coalesce((limits->>'products')::int,999999) into v_limit
   from plans where code='starter' and active limit 1;
 end if;

 select count(*)::int into v_count from public.products where company_id=p_company_id and status<>'archived';
 if v_count>=coalesce(v_limit,999999) then raise exception 'plan_product_limit'; end if;
 if p_category_id is not null and not exists(select 1 from public.categories where id=p_category_id and company_id=p_company_id and active) then raise exception 'invalid_category'; end if;
 if p_brand_id is not null and not exists(select 1 from public.brands where id=p_brand_id and company_id=p_company_id and active) then raise exception 'invalid_brand'; end if;

 insert into public.products(
   company_id,category_id,brand_id,sku,name,description,base_unit,cost,commission_fixed,
   commission_percent,track_stock,minimum_stock,status
 ) values(
   p_company_id,p_category_id,p_brand_id,upper(trim(p_sku)),trim(p_name),
   nullif(trim(p_description),''),coalesce(nullif(trim(p_base_unit),''),'unit'),
   p_cost,p_commission_fixed,p_commission_percent,p_track_stock,p_minimum_stock,'active'
 ) returning id into v_id;

 perform public.set_product_price(
   p_company_id,v_id,(select default_currency_code from public.companies where id=p_company_id),p_price
 );

 if nullif(trim(coalesce(p_barcode,'')),'') is not null then
   insert into public.product_barcodes(company_id,product_id,barcode,active)
   values(p_company_id,v_id,trim(p_barcode),true);
 end if;

 return jsonb_build_object(
   'id',v_id,'sku',upper(trim(p_sku)),'name',trim(p_name),'price',p_price,
   'barcode',nullif(trim(coalesce(p_barcode,'')),'')
 );
exception when unique_violation then raise exception 'product_duplicate';
end;
$$;

revoke all on function public.create_warehouse_secure(uuid,text,text) from public,anon;
grant execute on function public.create_warehouse_secure(uuid,text,text) to authenticated;

revoke all on function public.create_product_secure(uuid,uuid,uuid,text,text,text,text,numeric,numeric,numeric,numeric,boolean,numeric,text) from public,anon;
grant execute on function public.create_product_secure(uuid,uuid,uuid,text,text,text,text,numeric,numeric,numeric,numeric,boolean,numeric,text) to authenticated;
