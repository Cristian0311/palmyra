-- Harden inventory transfer idempotency: serialize before checking existing transfer item.
create or replace function public.palmyra_transfer_inventory(p_operation_id uuid,p_company_id uuid,p_from_warehouse_id uuid,p_to_warehouse_id uuid,p_product_id uuid,p_variant_id uuid,p_quantity numeric,p_notes text) returns jsonb language plpgsql security definer set search_path to public, private, pg_temp as $function$
declare v_auth uuid:=auth.uid(); v_source_qty numeric; v_existing boolean;
begin
 if v_auth is null then raise exception 'authentication_required'; end if;
 if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
 if not private.has_permission(p_company_id,'inventory.transfer') then raise exception 'permission_denied'; end if;
 if p_operation_id is null then raise exception 'operation_id_required'; end if;
 if p_from_warehouse_id=p_to_warehouse_id or p_quantity is null or p_quantity<=0 then raise exception 'invalid_transfer'; end if;
 if not exists(select 1 from public.warehouses where id=p_from_warehouse_id and company_id=p_company_id and active) or not exists(select 1 from public.warehouses where id=p_to_warehouse_id and company_id=p_company_id and active) then raise exception 'invalid_warehouse'; end if;
 if not private.user_can_access_warehouse(v_auth,p_company_id,p_from_warehouse_id) or not private.user_can_access_warehouse(v_auth,p_company_id,p_to_warehouse_id) then raise exception 'location_access_denied'; end if;
 if not exists(select 1 from public.products where id=p_product_id and company_id=p_company_id) then raise exception 'invalid_product'; end if;
 if p_variant_id is not null and not exists(select 1 from public.product_variants where id=p_variant_id and company_id=p_company_id and product_id=p_product_id and active) then raise exception 'invalid_variant'; end if;
 perform pg_advisory_xact_lock(hashtextextended(concat_ws(':',p_company_id::text,p_from_warehouse_id::text,p_to_warehouse_id::text,p_product_id::text,coalesce(p_variant_id::text,'base')),0));
 select exists(select 1 from public.transfer_items where transfer_id=p_operation_id and product_id=p_product_id and coalesce(variant_id,'00000000-0000-0000-0000-000000000000')=coalesce(p_variant_id,'00000000-0000-0000-0000-000000000000')) into v_existing;
 if v_existing then return jsonb_build_object('success',true,'id',p_operation_id,'already_existed',true); end if;
 if p_variant_id is null then
  select coalesce(quantity,0) into v_source_qty from public.stock_balances where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id for update;
  if v_source_qty<p_quantity then raise exception 'insufficient_stock'; end if;
  update public.stock_balances set quantity=quantity-p_quantity,updated_at=timezone('utc',now()) where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id;
  insert into public.stock_balances(company_id,warehouse_id,product_id,quantity) values(p_company_id,p_to_warehouse_id,p_product_id,p_quantity) on conflict(company_id,warehouse_id,product_id) do update set quantity=public.stock_balances.quantity+excluded.quantity,updated_at=timezone('utc',now());
 else
  select coalesce(quantity,0) into v_source_qty from public.variant_stock_balances where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id and variant_id=p_variant_id for update;
  if v_source_qty<p_quantity then raise exception 'insufficient_stock'; end if;
  update public.variant_stock_balances set quantity=quantity-p_quantity,updated_at=timezone('utc',now()) where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id and variant_id=p_variant_id;
  insert into public.variant_stock_balances(company_id,warehouse_id,product_id,variant_id,quantity) values(p_company_id,p_to_warehouse_id,p_product_id,p_variant_id,p_quantity) on conflict(company_id,warehouse_id,variant_id) do update set quantity=public.variant_stock_balances.quantity+excluded.quantity,updated_at=excluded.updated_at;
 end if;
 insert into public.transfers(id,company_id,origin_warehouse_id,destination_warehouse_id,status,notes,created_by) values(p_operation_id,p_company_id,p_from_warehouse_id,p_to_warehouse_id,'posted',p_notes,v_auth) on conflict(id) do nothing;
 insert into public.transfer_items(id,transfer_id,product_id,quantity,variant_id) values(gen_random_uuid(),p_operation_id,p_product_id,p_quantity,p_variant_id);
 insert into public.stock_movements(id,company_id,warehouse_id,product_id,movement_type,quantity,reference_type,reference_id,created_by,occurred_at,variant_id,note) values(gen_random_uuid(),p_company_id,p_from_warehouse_id,p_product_id,'transfer_out',p_quantity,'transfer',p_operation_id,v_auth,timezone('utc',now()),p_variant_id,p_notes),(gen_random_uuid(),p_company_id,p_to_warehouse_id,p_product_id,'transfer_in',p_quantity,'transfer',p_operation_id,v_auth,timezone('utc',now()),p_variant_id,p_notes);
 return jsonb_build_object('success',true,'id',p_operation_id,'already_existed',false);
end;$function$;