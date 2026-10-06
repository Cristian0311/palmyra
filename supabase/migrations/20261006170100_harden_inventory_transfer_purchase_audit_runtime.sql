-- Canonical runtime hardening for inventory transfers, purchase receipt and audits.
create or replace function public.palmyra_transfer_inventory(
 p_operation_id uuid,p_company_id uuid,p_from_warehouse_id uuid,p_to_warehouse_id uuid,
 p_product_id uuid,p_variant_id uuid,p_quantity numeric,p_notes text
) returns jsonb language plpgsql security definer
set search_path=public,private,pg_temp as $function$
declare v_auth uuid:=auth.uid(); v_source_qty numeric; v_existing boolean;
begin
 if v_auth is null then raise exception 'authentication_required'; end if;
 if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
 if not private.has_permission(p_company_id,'inventory.transfer') then raise exception 'permission_denied'; end if;
 if p_operation_id is null then raise exception 'operation_id_required'; end if;
 if p_from_warehouse_id=p_to_warehouse_id or p_quantity is null or p_quantity<=0 then raise exception 'invalid_transfer'; end if;
 if not exists(select 1 from public.warehouses where id=p_from_warehouse_id and company_id=p_company_id and active)
    or not exists(select 1 from public.warehouses where id=p_to_warehouse_id and company_id=p_company_id and active)
 then raise exception 'invalid_warehouse'; end if;
 if not exists(select 1 from public.products where id=p_product_id and company_id=p_company_id)
 then raise exception 'invalid_product'; end if;
 if p_variant_id is not null and not exists(select 1 from public.product_variants where id=p_variant_id and company_id=p_company_id and product_id=p_product_id and active)
 then raise exception 'invalid_variant'; end if;
 select exists(select 1 from public.transfer_items where transfer_id=p_operation_id and product_id=p_product_id
   and coalesce(variant_id,'00000000-0000-0000-0000-000000000000')=coalesce(p_variant_id,'00000000-0000-0000-0000-000000000000')) into v_existing;
 if v_existing then return jsonb_build_object('success',true,'id',p_operation_id,'already_existed',true); end if;
 perform pg_advisory_xact_lock(hashtextextended(concat_ws(':',p_company_id::text,p_from_warehouse_id::text,p_to_warehouse_id::text,p_product_id::text,coalesce(p_variant_id::text,'base')),0));
 select exists(select 1 from public.transfer_items where transfer_id=p_operation_id and product_id=p_product_id
   and coalesce(variant_id,'00000000-0000-0000-0000-000000000000')=coalesce(p_variant_id,'00000000-0000-0000-0000-000000000000')) into v_existing;
 if v_existing then return jsonb_build_object('success',true,'id',p_operation_id,'already_existed',true); end if;
 if p_variant_id is null then
   select quantity into v_source_qty from public.stock_balances where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id and variant_id is null for update;
   if not found or coalesce(v_source_qty,0)<p_quantity then raise exception 'insufficient_stock'; end if;
   update public.stock_balances set quantity=quantity-p_quantity,updated_at=timezone('utc',now()) where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id and variant_id is null;
   insert into public.stock_balances(company_id,warehouse_id,product_id,quantity,updated_at,variant_id)
   values(p_company_id,p_to_warehouse_id,p_product_id,p_quantity,timezone('utc',now()),null)
   on conflict(warehouse_id,product_id) do update set quantity=public.stock_balances.quantity+excluded.quantity,updated_at=excluded.updated_at;
 else
   select quantity into v_source_qty from public.variant_stock_balances where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id and variant_id=p_variant_id for update;
   if not found or coalesce(v_source_qty,0)<p_quantity then raise exception 'insufficient_stock'; end if;
   update public.variant_stock_balances set quantity=quantity-p_quantity,updated_at=timezone('utc',now()) where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id and variant_id=p_variant_id;
   insert into public.variant_stock_balances(company_id,warehouse_id,product_id,variant_id,quantity,updated_at)
   values(p_company_id,p_to_warehouse_id,p_product_id,p_variant_id,p_quantity,timezone('utc',now()))
   on conflict(company_id,warehouse_id,product_id,variant_id) do update set quantity=public.variant_stock_balances.quantity+excluded.quantity,updated_at=excluded.updated_at;
 end if;
 insert into public.transfers(id,company_id,origin_warehouse_id,destination_warehouse_id,status,notes,created_by)
 values(p_operation_id,p_company_id,p_from_warehouse_id,p_to_warehouse_id,'posted',p_notes,v_auth) on conflict(id) do nothing;
 insert into public.transfer_items(id,transfer_id,product_id,quantity,variant_id) values(gen_random_uuid(),p_operation_id,p_product_id,p_quantity,p_variant_id);
 insert into public.stock_movements(id,company_id,warehouse_id,product_id,movement_type,quantity,reference_type,reference_id,created_by,occurred_at,variant_id,note)
 values
 (gen_random_uuid(),p_company_id,p_from_warehouse_id,p_product_id,'transfer_out',-p_quantity,'transfer',p_operation_id,v_auth,timezone('utc',now()),p_variant_id,p_notes),
 (gen_random_uuid(),p_company_id,p_to_warehouse_id,p_product_id,'transfer_in',p_quantity,'transfer',p_operation_id,v_auth,timezone('utc',now()),p_variant_id,p_notes);
 return jsonb_build_object('success',true,'id',p_operation_id,'already_existed',false);
end;$function$;

create or replace function public.palmyra_receive_purchase(p_order_id uuid,p_company_id uuid)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $function$
declare v_auth uuid:=auth.uid(); v_order public.purchase_orders%rowtype; it record;
begin
 if v_auth is null then raise exception 'authentication_required'; end if;
 if not private.has_company_access(p_company_id) or not private.has_permission(p_company_id,'purchases.manage') then raise exception 'permission_denied'; end if;
 select * into v_order from public.purchase_orders where id=p_order_id and company_id=p_company_id for update;
 if not found then raise exception 'purchase_order_not_found'; end if;
 if v_order.status='received' then return jsonb_build_object('success',true,'already_received',true); end if;
 if v_order.status='cancelled' then raise exception 'purchase_cancelled'; end if;
 if not exists(select 1 from public.warehouses where id=v_order.warehouse_id and company_id=p_company_id and active) then raise exception 'invalid_warehouse'; end if;
 if v_order.supplier_id is not null and not exists(select 1 from public.suppliers where id=v_order.supplier_id and company_id=p_company_id and active) then raise exception 'invalid_supplier'; end if;
 for it in select product_id,quantity from public.purchase_items where purchase_order_id=p_order_id loop
   if it.quantity is null or it.quantity<=0 then raise exception 'invalid_purchase_quantity'; end if;
   if not exists(select 1 from public.products where id=it.product_id and company_id=p_company_id) then raise exception 'invalid_product'; end if;
   insert into public.stock_balances(company_id,warehouse_id,product_id,quantity,updated_at,variant_id)
   values(p_company_id,v_order.warehouse_id,it.product_id,it.quantity,timezone('utc',now()),null)
   on conflict(warehouse_id,product_id) do update set quantity=public.stock_balances.quantity+excluded.quantity,updated_at=excluded.updated_at;
   insert into public.stock_movements(id,company_id,warehouse_id,product_id,movement_type,quantity,reference_type,reference_id,created_by,occurred_at,note)
   values(gen_random_uuid(),p_company_id,v_order.warehouse_id,it.product_id,'purchase',it.quantity,'purchase_order',p_order_id,v_auth,timezone('utc',now()),'Recepción de compra');
 end loop;
 update public.purchase_orders set status='received',updated_at=timezone('utc',now()) where id=p_order_id and company_id=p_company_id;
 return jsonb_build_object('success',true,'already_received',false);
end;$function$;

create or replace function public.palmyra_complete_audit(p_audit_id uuid,p_company_id uuid,p_warehouse_id uuid,p_items jsonb,p_notes text)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $function$
declare v_auth uuid:=auth.uid(); v_audit public.inventory_audits%rowtype; it jsonb; pid uuid; qty numeric; current_qty numeric; diff numeric;
begin
 if v_auth is null then raise exception 'authentication_required'; end if;
 if not private.has_company_access(p_company_id) or not private.has_permission(p_company_id,'inventory.manage') then raise exception 'permission_denied'; end if;
 select * into v_audit from public.inventory_audits where id=p_audit_id and company_id=p_company_id for update;
 if not found then raise exception 'audit_not_found'; end if;
 if v_audit.status='approved' then return jsonb_build_object('success',true,'already_approved',true,'id',p_audit_id); end if;
 if v_audit.warehouse_id<>p_warehouse_id then raise exception 'invalid_warehouse'; end if;
 if not exists(select 1 from public.warehouses where id=p_warehouse_id and company_id=p_company_id and active) then raise exception 'invalid_warehouse'; end if;
 for it in select * from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
   pid:=nullif(it->>'product_id','')::uuid;
   if pid is null then raise exception 'invalid_product'; end if;
   qty:=greatest(coalesce((it->>'counted')::numeric,(it->>'counted_quantity')::numeric,0),0);
   if not exists(select 1 from public.products where id=pid and company_id=p_company_id) then raise exception 'invalid_product'; end if;
   select coalesce(quantity,0) into current_qty from public.stock_balances where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=pid and variant_id is null for update;
   if not found then current_qty:=0; end if;
   diff:=qty-current_qty;
   insert into public.inventory_audit_items(id,audit_id,product_id,expected_quantity,counted_quantity,difference,notes)
   values(gen_random_uuid(),p_audit_id,pid,current_qty,qty,diff,nullif(it->>'notes',''))
   on conflict(audit_id,product_id) do update set expected_quantity=excluded.expected_quantity,counted_quantity=excluded.counted_quantity,difference=excluded.difference,notes=excluded.notes;
   if diff<>0 then
     insert into public.stock_balances(company_id,warehouse_id,product_id,quantity,updated_at,variant_id)
     values(p_company_id,p_warehouse_id,pid,qty,timezone('utc',now()),null)
     on conflict(warehouse_id,product_id) do update set quantity=excluded.quantity,updated_at=excluded.updated_at;
     insert into public.stock_movements(id,company_id,warehouse_id,product_id,movement_type,quantity,reference_type,reference_id,created_by,occurred_at,note)
     values(gen_random_uuid(),p_company_id,p_warehouse_id,pid,'adjustment',diff,'inventory_audit',p_audit_id,v_auth,timezone('utc',now()),coalesce(p_notes,'Ajuste por auditoría'));
   end if;
 end loop;
 update public.inventory_audits set status='approved',submitted_at=coalesce(submitted_at,timezone('utc',now())),reviewed_by=v_auth,reviewed_at=timezone('utc',now()),notes=concat_ws(' | ',notes,nullif(p_notes,'')),updated_at=timezone('utc',now()) where id=p_audit_id and company_id=p_company_id;
 return jsonb_build_object('success',true,'id',p_audit_id);
end;$function$;

grant execute on function public.palmyra_transfer_inventory(uuid,uuid,uuid,uuid,uuid,uuid,numeric,text) to authenticated;
grant execute on function public.palmyra_receive_purchase(uuid,uuid) to authenticated;
grant execute on function public.palmyra_complete_audit(uuid,uuid,uuid,jsonb,text) to authenticated;
