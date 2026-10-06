-- PALMYRA runtime plan entitlements + stock movement sign hardening
-- Caravana: customers/suppliers + visual style
-- Ciudadela: Excel exports + Dashboard AI + warranties/returns + ABC + labels

alter table public.plans drop constraint if exists plans_runtime_entitlements_check;
alter table public.plans add constraint plans_runtime_entitlements_check check (
  (code='starter' and active=true and monthly_price=10 and trial_days=90
   and coalesce((limits->>'warehouses')::integer,0)=1
   and coalesce((limits->>'employees')::integer,0)=2
   and coalesce((limits->>'products')::integer,0)=50
   and coalesce(limits->>'reports','')='basic'
   and coalesce(limits->>'support','')='standard'
   and jsonb_typeof(features)='object'
   and jsonb_typeof(features->'features')='array'
   and (features->'features') @> jsonb_build_array('Punto de venta','Inventario y caja','Reportes básicos','Modo offline'))
  or
  (code='growth' and active=true and monthly_price=15 and trial_days=0
   and coalesce((limits->>'warehouses')::integer,0)=3
   and coalesce((limits->>'employees')::integer,0)=4
   and coalesce((limits->>'products')::integer,0)=150
   and coalesce(limits->>'reports','')='advanced'
   and coalesce(limits->>'support','')='standard'
   and jsonb_typeof(features)='object'
   and jsonb_typeof(features->'features')='array'
   and (features->'features') @> jsonb_build_array('Punto de venta','Inventario y caja','Clientes y proveedores','Modo offline','Compras y recepción','Transferencias entre almacenes','Reportes avanzados','Equipo con roles','Operación multi-almacén'))
  or
  (code='pro' and active=true and monthly_price=25 and trial_days=0
   and coalesce((limits->>'warehouses')::integer,0)=7
   and coalesce((limits->>'employees')::integer,0)=10
   and coalesce((limits->>'products')::integer,0)=300
   and coalesce(limits->>'reports','')='advanced_plus'
   and coalesce(limits->>'support','')='priority'
   and jsonb_typeof(features)='object'
   and jsonb_typeof(features->'features')='array'
   and (features->'features') @> jsonb_build_array('Punto de venta','Inventario y caja','Clientes y proveedores','Modo offline','Compras y recepción','Transferencias entre almacenes','Reportes avanzados','Equipo con roles','Operación multi-almacén','Analítica avanzada','Soporte prioritario'))
  or
  (code='trial' and active=false and monthly_price=0 and trial_days=0
   and coalesce((limits->>'warehouses')::integer,0)=1
   and coalesce((limits->>'employees')::integer,0)=2
   and coalesce((limits->>'products')::integer,0)=50)
);

update public.plans
set features =
  jsonb_set(
    jsonb_set(
      coalesce(features,'{}'::jsonb),
      '{features}',
      case
        when code='starter' then to_jsonb(array[
          'Punto de venta','Inventario y caja','Reportes básicos','Modo offline'
        ]::text[])
        when code='growth' then to_jsonb(array[
          'Punto de venta','Inventario y caja','Clientes y proveedores','Modo offline',
          'Compras y recepción','Transferencias entre almacenes','Reportes avanzados',
          'Equipo con roles','Operación multi-almacén','Estilo visual'
        ]::text[])
        when code='pro' then to_jsonb(array[
          'Punto de venta','Inventario y caja','Clientes y proveedores','Modo offline',
          'Compras y recepción','Transferencias entre almacenes','Reportes avanzados',
          'Equipo con roles','Operación multi-almacén','Analítica avanzada',
          'Soporte prioritario','Descargas Excel','IA en Dashboard','Garantías y devoluciones',
          'Análisis ABC','Etiquetas'
        ]::text[])
        else features->'features'
      end
    ),
    '{feature_keys}',
    case
      when code='starter' then to_jsonb(array['pos','inventory','offline','basic_reports']::text[])
      when code='growth' then to_jsonb(array[
        'pos','inventory','offline','basic_reports','customers_suppliers','purchases',
        'transfers','advanced_reports','custom_roles','banking','multi_warehouse','visual_style'
      ]::text[])
      when code='pro' then to_jsonb(array[
        'pos','inventory','offline','basic_reports','customers_suppliers','purchases',
        'transfers','advanced_reports','custom_roles','banking','multi_warehouse','visual_style',
        'excel_exports','ai_dashboard','warranty_returns','abc_analysis','labels','advanced_analytics'
      ]::text[])
      else coalesce(features->'feature_keys','[]'::jsonb)
    end
  )
where code in ('starter','growth','pro');

-- stock_movements.quantity is the absolute amount moved. Direction is encoded by movement_type.
-- The old sale RPC inserted -quantity, violating stock_movements_quantity_check.
create or replace function public.palmyra_record_sale(
 p_sale_id uuid,p_company_id uuid,p_warehouse_id uuid,p_cash_session_id uuid,p_user_id uuid,
 p_total numeric,p_currency_code text,p_notes text,p_customer_id uuid,p_items jsonb,p_payments jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public,private,pg_temp
as $$
declare
 v_user uuid:=auth.uid(); v_existing public.sales%rowtype; v_sale public.sales%rowtype; v_item jsonb;
 v_product_id uuid; v_variant_id uuid; v_qty numeric; v_price numeric; v_discount numeric; v_tax numeric; v_line_total numeric; v_stock numeric;
 v_employee_id uuid; v_default_currency text; v_register_company uuid;
begin
 if v_user is null then raise exception 'authentication_required'; end if;
 if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
 if not private.has_permission(p_company_id,'pos.access') then raise exception 'permission_denied'; end if;
 if not exists(select 1 from public.warehouses where id=p_warehouse_id and company_id=p_company_id and active) then raise exception 'invalid_warehouse'; end if;
 if p_cash_session_id is not null then
   select cr.company_id into v_register_company from public.cash_sessions cs join public.cash_registers cr on cr.id=cs.cash_register_id
   where cs.id=p_cash_session_id and cs.company_id=p_company_id and cr.warehouse_id=p_warehouse_id;
   if v_register_company is null then raise exception 'invalid_cash_session'; end if;
 end if;
 if p_user_id is not null then
   select e.id into v_employee_id from public.employees e
   where e.company_id=p_company_id and e.active and (e.id=p_user_id or e.user_id=p_user_id)
   order by (e.id=p_user_id) desc limit 1;
 end if;
 select c.default_currency_code into v_default_currency from public.companies c where c.id=p_company_id;
 select * into v_existing from public.sales where id=p_sale_id and company_id=p_company_id limit 1;
 if found then return jsonb_build_object('success',true,'id',v_existing.id,'already_existed',true); end if;
 insert into public.sales(id,company_id,warehouse_id,cash_session_id,employee_id,seller_user_id,status,total,currency_code,client_name,notes,source_operation_id,customer_id)
 values(p_sale_id,p_company_id,p_warehouse_id,p_cash_session_id,v_employee_id,v_user,'completed',coalesce(p_total,0),coalesce(nullif(p_currency_code,''),v_default_currency),null,coalesce(p_notes,''),p_sale_id,p_customer_id)
 returning * into v_sale;
 for v_item in select * from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
   v_product_id:=nullif(v_item->>'product_id','')::uuid;
   v_qty:=greatest(coalesce((v_item->>'quantity')::numeric,0),0);
   v_price:=coalesce((v_item->>'price')::numeric,0);
   v_discount:=coalesce((v_item->>'discount')::numeric,0);
   v_tax:=coalesce((v_item->>'tax')::numeric,0);
   v_line_total:=coalesce((v_item->>'total')::numeric,v_price*v_qty);
   if v_product_id is null or v_qty<=0 then raise exception 'invalid_sale_item'; end if;
   if not exists(select 1 from public.products p where p.id=v_product_id and p.company_id=p_company_id) then raise exception 'invalid_product'; end if;
   v_variant_id:=null;
   if nullif(trim(coalesce(v_item->>'variant_id',v_item->>'variantId','')),'') is not null then
     v_variant_id:=(coalesce(v_item->>'variant_id',v_item->>'variantId'))::uuid;
   elsif nullif(trim(coalesce(v_item->>'variant_label',v_item->>'variantLabel','')),'') is not null then
     select pv.id into v_variant_id from public.product_variants pv
     where pv.company_id=p_company_id and pv.product_id=v_product_id
       and pv.name=coalesce(v_item->>'variant_label',v_item->>'variantLabel') and pv.active limit 1;
     if v_variant_id is null then raise exception 'invalid_variant'; end if;
   end if;
   if v_variant_id is not null and not exists(
     select 1 from public.product_variants pv
     where pv.id=v_variant_id and pv.company_id=p_company_id and pv.product_id=v_product_id and pv.active
   ) then raise exception 'invalid_variant'; end if;
   insert into public.sale_items(id,sale_id,product_id,variant_id,quantity,unit_price,discount,tax,line_total,serial_number)
   values(coalesce(nullif(v_item->>'id','')::uuid,gen_random_uuid()),p_sale_id,v_product_id,v_variant_id,v_qty,v_price,v_discount,v_tax,v_line_total,nullif(coalesce(v_item->>'serial_number',v_item->>'serialNumber'),''));
   if coalesce((select track_stock from public.products where id=v_product_id),true) then
     if v_variant_id is null then
       select quantity into v_stock from public.stock_balances where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_product_id and variant_id is null for update;
       if not found then raise exception 'stock_record_missing'; end if;
       if v_stock<v_qty then raise exception 'insufficient_stock'; end if;
       update public.stock_balances set quantity=quantity-v_qty,updated_at=timezone('utc',now())
       where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_product_id and variant_id is null;
     else
       select quantity into v_stock from public.variant_stock_balances where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_product_id and variant_id=v_variant_id for update;
       if not found then raise exception 'variant_stock_record_missing'; end if;
       if v_stock<v_qty then raise exception 'insufficient_stock'; end if;
       update public.variant_stock_balances set quantity=quantity-v_qty,updated_at=timezone('utc',now())
       where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_product_id and variant_id=v_variant_id;
     end if;
     insert into public.stock_movements(id,company_id,warehouse_id,product_id,movement_type,quantity,reference_type,reference_id,created_by,occurred_at,variant_id)
     values(gen_random_uuid(),p_company_id,p_warehouse_id,v_product_id,'sale',v_qty,'sale',p_sale_id,v_user,timezone('utc',now()),v_variant_id);
   end if;
 end loop;
 for v_item in select * from jsonb_array_elements(coalesce(p_payments,'[]'::jsonb)) loop
   insert into public.payments(id,company_id,sale_id,method,currency_code,amount,exchange_rate,reference,created_by)
   values(coalesce(nullif(v_item->>'id','')::uuid,gen_random_uuid()),p_company_id,p_sale_id,
     coalesce(v_item->>'method','cash'),
     coalesce(v_item->>'currency_code',v_item->>'currencyCode',v_default_currency),
     coalesce((v_item->>'amount')::numeric,0),
     coalesce((v_item->>'exchange_rate')::numeric,(v_item->>'exchangeRate')::numeric,1),
     nullif(v_item->>'reference',''),v_user);
 end loop;
 return jsonb_build_object('success',true,'id',p_sale_id,'already_existed',false);
exception when unique_violation then
 select * into v_existing from public.sales where id=p_sale_id and company_id=p_company_id limit 1;
 if found then return jsonb_build_object('success',true,'id',v_existing.id,'already_existed',true); end if;
 raise;
end;
$$;

revoke all on function public.palmyra_record_sale(uuid,uuid,uuid,uuid,uuid,numeric,text,text,uuid,jsonb,jsonb) from public;
grant execute on function public.palmyra_record_sale(uuid,uuid,uuid,uuid,uuid,numeric,text,text,uuid,jsonb,jsonb) to authenticated;
