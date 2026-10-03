-- PALMYRA SaaS security hardening for actor identity

create or replace function public.adjust_stock_internal(
  p_user_id uuid, p_company_id uuid, p_warehouse_id uuid, p_product_id uuid,
  p_delta numeric, p_note text default null
) returns public.stock_balances
language plpgsql security definer set search_path to 'public','private','pg_temp'
as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if p_user_id is null or p_user_id<>auth.uid() then raise exception 'user_identity_mismatch'; end if;
  return private.adjust_stock_for_user(p_user_id,p_company_id,p_warehouse_id,p_product_id,p_delta,p_note);
end;
$$;

create or replace function public.create_sale_transaction(
  p_company_id uuid, p_warehouse_id uuid, p_cash_session_id uuid, p_employee_id uuid,
  p_seller_user_id uuid, p_customer_id uuid, p_currency_code character, p_total numeric,
  p_client_name text, p_notes text, p_items jsonb, p_payments jsonb,
  p_source_operation_id uuid default null
) returns uuid
language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
 v_user uuid:=auth.uid();
 v_sale_id uuid; v_existing_sale uuid; v_item jsonb; v_payment jsonb;
 v_product public.products; v_balance public.stock_balances; v_variant_balance public.variant_stock_balances;
 v_component public.product_kit_components; v_component_product public.products; v_component_qty numeric;
 v_qty numeric; v_unit_price numeric; v_discount numeric; v_tax numeric; v_line_total numeric;
 v_calc_total numeric:=0; v_paid_total numeric:=0; v_payment_amount numeric;
 v_commission numeric; v_fixed numeric; v_rate numeric; v_has_cash boolean:=false; v_variant_id uuid; v_sale_item_id uuid; v_serial_number text;
begin
 if v_user is null then raise exception 'authentication_required'; end if;
 if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
 if not private.has_permission(p_company_id,'pos.use') then raise exception 'permission_denied'; end if;
 if p_total is null or p_total<0 then raise exception 'invalid_total'; end if;
 if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'items_required'; end if;
 if p_payments is null or jsonb_typeof(p_payments)<>'array' or jsonb_array_length(p_payments)=0 then raise exception 'payments_required'; end if;

 if p_source_operation_id is not null then
   select id into v_existing_sale from public.sales where company_id=p_company_id and source_operation_id=p_source_operation_id limit 1;
   if v_existing_sale is not null then return v_existing_sale; end if;
 end if;

 if not exists(select 1 from public.warehouses where id=p_warehouse_id and company_id=p_company_id and active) then raise exception 'invalid_warehouse'; end if;
 if not private.user_can_access_warehouse(v_user,p_company_id,p_warehouse_id) then raise exception 'location_access_denied'; end if;

 if p_seller_user_id is not null then
   if not exists(select 1 from public.company_memberships cm where cm.company_id=p_company_id and cm.user_id=p_seller_user_id and cm.status='active') then
     raise exception 'invalid_seller_user';
   end if;
   if p_seller_user_id<>v_user and (p_employee_id is null or not exists(
     select 1 from public.employees e where e.id=p_employee_id and e.company_id=p_company_id and e.user_id=p_seller_user_id and e.active
   )) then
     raise exception 'seller_identity_mismatch';
   end if;
 end if;

 if p_cash_session_id is not null and not exists(
   select 1 from public.cash_sessions cs join public.cash_registers cr on cr.id=cs.cash_register_id
   where cs.id=p_cash_session_id and cs.company_id=p_company_id and cs.status='open' and cr.warehouse_id=p_warehouse_id
 ) then raise exception 'invalid_cash_session'; end if;
 if p_employee_id is not null and not exists(select 1 from public.employees where id=p_employee_id and company_id=p_company_id and active) then raise exception 'invalid_employee'; end if;
 if p_employee_id is not null and not exists(select 1 from public.employee_warehouse_access where company_id=p_company_id and employee_id=p_employee_id and warehouse_id=p_warehouse_id) then raise exception 'employee_warehouse_access_required'; end if;
 if p_customer_id is not null and not exists(select 1 from public.customers where id=p_customer_id and company_id=p_company_id and active) then raise exception 'invalid_customer'; end if;

 for v_item in select value from jsonb_array_elements(p_items) loop
   begin
     v_qty:=(v_item->>'quantity')::numeric; v_unit_price:=(v_item->>'unit_price')::numeric;
     v_discount:=coalesce((v_item->>'discount')::numeric,0); v_tax:=coalesce((v_item->>'tax')::numeric,0);
     v_variant_id:=nullif(v_item->>'variant_id','')::uuid; v_serial_number:=nullif(trim(v_item->>'serial_number'),'');
   exception when others then raise exception 'invalid_sale_item'; end;
   if v_qty<=0 or v_unit_price<0 or v_discount<0 or v_tax<0 then raise exception 'invalid_item_values'; end if;
   select * into v_product from public.products where id=(v_item->>'product_id')::uuid and company_id=p_company_id and status='active' for share;
   if not found then raise exception 'invalid_product'; end if;
   if v_variant_id is not null and not exists(select 1 from public.product_variants where id=v_variant_id and company_id=p_company_id and product_id=v_product.id and active) then raise exception 'invalid_variant'; end if;
   if v_product.track_serial then
     if v_qty<>1 or v_serial_number is null or length(v_serial_number)>160 then raise exception 'serial_required'; end if;
     if exists(select 1 from public.product_serials where company_id=p_company_id and product_id=v_product.id and serial_number=v_serial_number and status in ('sold','available')) then raise exception 'serial_already_used'; end if;
   elsif v_serial_number is not null then raise exception 'serial_not_allowed'; end if;

   v_line_total:=round((v_qty*v_unit_price)-v_discount+v_tax,6);
   if v_line_total<0 then raise exception 'invalid_line_total'; end if;
   v_calc_total:=v_calc_total+v_line_total;

   if v_product.is_kit then
     if not exists(select 1 from public.product_kit_components where company_id=p_company_id and kit_product_id=v_product.id) then raise exception 'kit_has_no_components'; end if;
     for v_component in select * from public.product_kit_components where company_id=p_company_id and kit_product_id=v_product.id loop
       v_component_qty:=v_component.quantity*v_qty;
       select * into v_component_product from public.products where id=v_component.component_product_id and company_id=p_company_id and status='active' for share;
       if not found then raise exception 'invalid_kit_component'; end if;
       if v_component_product.track_serial then raise exception 'kit_serial_component_unsupported'; end if;
       if v_component_product.track_stock then
         if v_component.component_variant_id is null then
           select * into v_balance from public.stock_balances where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_component_product.id for update;
           if not found or v_balance.quantity<v_component_qty then raise exception 'insufficient_component_stock'; end if;
         else
           select * into v_variant_balance from public.variant_stock_balances where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_component_product.id and variant_id=v_component.component_variant_id for update;
           if not found or v_variant_balance.quantity<v_component_qty then raise exception 'insufficient_component_stock'; end if;
         end if;
       end if;
     end loop;
   elsif v_product.track_stock then
     if v_variant_id is null then
       select * into v_balance from public.stock_balances where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_product.id for update;
       if not found or v_balance.quantity<v_qty then raise exception 'insufficient_stock'; end if;
     else
       select * into v_variant_balance from public.variant_stock_balances where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_product.id and variant_id=v_variant_id for update;
       if not found or v_variant_balance.quantity<v_qty then raise exception 'insufficient_stock'; end if;
     end if;
   end if;
 end loop;

 if abs(v_calc_total-p_total)>0.000001 then raise exception 'total_mismatch'; end if;

 for v_payment in select value from jsonb_array_elements(p_payments) loop
   begin v_payment_amount:=(v_payment->>'amount')::numeric; exception when others then raise exception 'invalid_payment_amount'; end;
   if v_payment_amount<=0 then raise exception 'invalid_payment_amount'; end if;
   if coalesce(upper(trim(v_payment->>'currency_code')),upper(trim(p_currency_code)))<>upper(trim(p_currency_code)) then raise exception 'payment_currency_mismatch'; end if;
   if coalesce(v_payment->>'method','')='cash' then v_has_cash:=true; end if;
   v_paid_total:=v_paid_total+v_payment_amount;
 end loop;
 if abs(v_paid_total-p_total)>0.000001 then raise exception 'payment_total_mismatch'; end if;
 if v_has_cash and p_cash_session_id is null then raise exception 'cash_session_required'; end if;

 insert into public.sales(company_id,warehouse_id,cash_session_id,employee_id,seller_user_id,customer_id,status,total,currency_code,client_name,notes,source_operation_id)
 values(p_company_id,p_warehouse_id,p_cash_session_id,p_employee_id,coalesce(p_seller_user_id,v_user),p_customer_id,'completed',round(p_total,6),p_currency_code,left(nullif(trim(p_client_name),''),160),left(nullif(trim(p_notes),''),1000),p_source_operation_id)
 returning id into v_sale_id;

 for v_item in select value from jsonb_array_elements(p_items) loop
   v_qty:=(v_item->>'quantity')::numeric; v_unit_price:=(v_item->>'unit_price')::numeric;
   v_discount:=coalesce((v_item->>'discount')::numeric,0); v_tax:=coalesce((v_item->>'tax')::numeric,0);
   v_variant_id:=nullif(v_item->>'variant_id','')::uuid; v_serial_number:=nullif(trim(v_item->>'serial_number'),'');
   v_line_total:=round((v_qty*v_unit_price)-v_discount+v_tax,6);
   insert into public.sale_items(sale_id,product_id,variant_id,serial_number,quantity,unit_price,discount,tax,line_total)
   values(v_sale_id,(v_item->>'product_id')::uuid,v_variant_id,v_serial_number,v_qty,v_unit_price,v_discount,v_tax,v_line_total)
   returning id into v_sale_item_id;
   if v_serial_number is not null then
     insert into public.product_serials(company_id,product_id,variant_id,serial_number,status,sale_item_id)
     values(p_company_id,(v_item->>'product_id')::uuid,v_variant_id,v_serial_number,'sold',v_sale_item_id);
   end if;
   if p_employee_id is not null then
     select sr.fixed_amount into v_fixed from public.salary_rules sr
     where sr.company_id=p_company_id and sr.employee_id=p_employee_id and sr.rule_type='product_fixed' and sr.product_id=(v_item->>'product_id')::uuid and sr.active
     order by sr.created_at desc limit 1;
     if v_fixed is not null then v_commission:=v_fixed*v_qty;
     else
       select coalesce(v_product.commission_fixed,0)+((v_product.commission_percent/100)*v_line_total) into v_commission
       from public.products v_product where v_product.id=(v_item->>'product_id')::uuid;
     end if;
     if coalesce(v_commission,0)>0 then
       insert into public.commissions(company_id,employee_id,sale_id,sale_item_id,amount,currency_code,rule_snapshot)
       values(p_company_id,p_employee_id,v_sale_id,v_sale_item_id,v_commission,p_currency_code,
              jsonb_build_object('source',case when v_fixed is not null then 'salary_rule_product_fixed' else 'product_default' end,'product_id',(v_item->>'product_id')::uuid,'variant_id',v_variant_id));
     end if;
   end if;
   if v_product.is_kit then
     for v_component in select * from public.product_kit_components where company_id=p_company_id and kit_product_id=v_product.id loop
       v_component_qty:=v_component.quantity*v_qty;
       select * into v_component_product from public.products where id=v_component.component_product_id and company_id=p_company_id and status='active';
       if v_component_product.track_stock then
         if v_component.component_variant_id is null then
           update public.stock_balances set quantity=quantity-v_component_qty,updated_at=timezone('utc',now())
           where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_component_product.id;
         else
           update public.variant_stock_balances set quantity=quantity-v_component_qty,updated_at=timezone('utc',now())
           where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_component_product.id and variant_id=v_component.component_variant_id;
         end if;
         insert into public.stock_movements(company_id,warehouse_id,product_id,variant_id,movement_type,quantity,reference_type,reference_id,created_by,note,occurred_at)
         values(p_company_id,p_warehouse_id,v_component_product.id,v_component.component_variant_id,'sale',v_component_qty,'kit_sale',v_sale_id,v_user,'Consumo de componente por kit',timezone('utc',now()));
       end if;
     end loop;
   elsif v_product.track_stock then
     if v_variant_id is null then
       update public.stock_balances set quantity=quantity-v_qty,updated_at=timezone('utc',now()) where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_product.id;
     else
       update public.variant_stock_balances set quantity=quantity-v_qty,updated_at=timezone('utc',now()) where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=v_product.id and variant_id=v_variant_id;
     end if;
     insert into public.stock_movements(company_id,warehouse_id,product_id,variant_id,movement_type,quantity,reference_type,reference_id,created_by,occurred_at)
     values(p_company_id,p_warehouse_id,v_product.id,v_variant_id,'sale',v_qty,'sale',v_sale_id,v_user,timezone('utc',now()));
   end if;
 end loop;

 if p_employee_id is not null then
   select sr.percent_rate into v_rate from public.salary_rules sr
   where sr.company_id=p_company_id and sr.employee_id=p_employee_id and sr.rule_type='sales_percent' and sr.active
   order by sr.created_at desc limit 1;
   if coalesce(v_rate,0)>0 then
     insert into public.commissions(company_id,employee_id,sale_id,amount,currency_code,rule_snapshot)
     values(p_company_id,p_employee_id,v_sale_id,round(p_total*v_rate/100,6),p_currency_code,jsonb_build_object('source','salary_rule_sales_percent','rate',v_rate));
   end if;
 end if;

 for v_payment in select value from jsonb_array_elements(p_payments) loop
   v_payment_amount:=(v_payment->>'amount')::numeric;
   insert into public.payments(company_id,sale_id,method,currency_code,amount,exchange_rate,reference,created_by)
   values(p_company_id,v_sale_id,(v_payment->>'method')::public.payment_method,p_currency_code,v_payment_amount,nullif(v_payment->>'exchange_rate','')::numeric,left(nullif(trim(v_payment->>'reference'),''),200),v_user);
   if (v_payment->>'method')='cash' then
     insert into public.cash_movements(company_id,cash_session_id,movement_type,amount,currency_code,reference_id,created_by)
     values(p_company_id,p_cash_session_id,'sale',v_payment_amount,p_currency_code,v_sale_id,v_user);
   end if;
 end loop;

 insert into public.audit_logs(company_id,user_id,action,entity_type,entity_id,metadata,created_at)
 values(p_company_id,v_user,'sale.completed','sale',v_sale_id,jsonb_build_object('total',p_total,'currency_code',p_currency_code),timezone('utc',now()));
 return v_sale_id;
end;
$$;

revoke all on function public.create_sale_transaction(uuid,uuid,uuid,uuid,uuid,uuid,bpchar,numeric,text,text,jsonb,jsonb,uuid) from public,anon;
grant execute on function public.create_sale_transaction(uuid,uuid,uuid,uuid,uuid,uuid,bpchar,numeric,text,text,jsonb,jsonb,uuid) to authenticated;
