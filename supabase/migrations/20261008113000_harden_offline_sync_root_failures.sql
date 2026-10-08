-- Harden offline sync root failures: compensation access, transfer idempotency,
-- inventory movement validation, and plan helper execution privileges.

grant execute on function private.plan_entity_limit_ok(uuid,text,uuid) to authenticated;
grant execute on function private.plan_entity_limit_ok(uuid,text,uuid) to postgres;

create or replace function public.palmyra_get_compensation_settings(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_user uuid := auth.uid();
  v_row record;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not (private.has_permission(p_company_id,'cash.close') or private.has_permission(p_company_id,'payroll.manage')) then
    raise exception 'permission_denied';
  end if;
  select mode, percent_rate, active into v_row
  from public.compensation_settings
  where company_id=p_company_id
  order by updated_at desc nulls last limit 1;
  return jsonb_build_object(
    'mode',coalesce(v_row.mode,'fixed_product'),
    'percent_rate',coalesce(v_row.percent_rate,0),
    'active',coalesce(v_row.active,true)
  );
end;
$$;
revoke execute on function public.palmyra_get_compensation_settings(uuid) from public;
revoke execute on function public.palmyra_get_compensation_settings(uuid) from anon;
grant execute on function public.palmyra_get_compensation_settings(uuid) to authenticated;

-- The transfer function is already serialized by an advisory lock. The unique
-- functional index is also made conflict-safe for replayed offline operations.
create or replace function public.palmyra_transfer_inventory(
  p_operation_id uuid,p_company_id uuid,p_from_warehouse_id uuid,p_to_warehouse_id uuid,
  p_product_id uuid,p_variant_id uuid,p_quantity numeric,p_notes text
) returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare v_auth uuid:=auth.uid(); v_source_qty numeric; v_existing boolean;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id,'inventory.transfer') then raise exception 'permission_denied'; end if;
  if p_operation_id is null then raise exception 'operation_id_required'; end if;
  if p_from_warehouse_id=p_to_warehouse_id or p_quantity is null or p_quantity<=0 then raise exception 'invalid_transfer'; end if;
  if not exists(select 1 from public.warehouses where id=p_from_warehouse_id and company_id=p_company_id and active)
     or not exists(select 1 from public.warehouses where id=p_to_warehouse_id and company_id=p_company_id and active) then raise exception 'invalid_warehouse'; end if;
  if not private.user_can_access_warehouse(v_auth,p_company_id,p_from_warehouse_id)
     or not private.user_can_access_warehouse(v_auth,p_company_id,p_to_warehouse_id) then raise exception 'location_access_denied'; end if;
  if not exists(select 1 from public.products where id=p_product_id and company_id=p_company_id) then raise exception 'invalid_product'; end if;
  if p_variant_id is not null and not exists(select 1 from public.product_variants where id=p_variant_id and company_id=p_company_id and product_id=p_product_id and active) then raise exception 'invalid_variant'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    concat_ws(':',p_company_id::text,p_from_warehouse_id::text,p_to_warehouse_id::text,p_product_id::text,coalesce(p_variant_id::text,'base')),0));

  select exists(select 1 from public.transfer_items
    where transfer_id=p_operation_id and product_id=p_product_id
      and coalesce(variant_id,'00000000-0000-0000-0000-000000000000'::uuid)
        =coalesce(p_variant_id,'00000000-0000-0000-0000-000000000000'::uuid)) into v_existing;
  if v_existing then return jsonb_build_object('success',true,'id',p_operation_id,'already_existed',true); end if;

  if p_variant_id is null then
    select coalesce(quantity,0) into v_source_qty from public.stock_balances
      where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id for update;
    if not found then raise exception 'stock_record_missing'; end if;
    if v_source_qty<p_quantity then raise exception 'insufficient_stock'; end if;
    update public.stock_balances set quantity=quantity-p_quantity,updated_at=timezone('utc',now())
      where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id;
    insert into public.stock_balances(company_id,warehouse_id,product_id,quantity)
      values(p_company_id,p_to_warehouse_id,p_product_id,p_quantity)
      on conflict(company_id,warehouse_id,product_id)
      do update set quantity=public.stock_balances.quantity+excluded.quantity,updated_at=timezone('utc',now());
  else
    select coalesce(quantity,0) into v_source_qty from public.variant_stock_balances
      where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id and variant_id=p_variant_id for update;
    if not found then raise exception 'variant_stock_record_missing'; end if;
    if v_source_qty<p_quantity then raise exception 'insufficient_stock'; end if;
    update public.variant_stock_balances set quantity=quantity-p_quantity,updated_at=timezone('utc',now())
      where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id and variant_id=p_variant_id;
    insert into public.variant_stock_balances(company_id,warehouse_id,product_id,variant_id,quantity)
      values(p_company_id,p_to_warehouse_id,p_product_id,p_variant_id,p_quantity)
      on conflict(company_id,warehouse_id,product_id,variant_id)
      do update set quantity=public.variant_stock_balances.quantity+excluded.quantity,updated_at=timezone('utc',now());
  end if;

  insert into public.transfers(id,company_id,origin_warehouse_id,destination_warehouse_id,status,notes,created_by)
    values(p_operation_id,p_company_id,p_from_warehouse_id,p_to_warehouse_id,'posted',p_notes,v_auth)
    on conflict(id) do nothing;

  insert into public.transfer_items(id,transfer_id,product_id,quantity,variant_id)
    values(gen_random_uuid(),p_operation_id,p_product_id,p_quantity,p_variant_id)
    on conflict (transfer_id,product_id,(coalesce(variant_id,'00000000-0000-0000-0000-000000000000'::uuid))) do nothing;

  insert into public.stock_movements(id,company_id,warehouse_id,product_id,movement_type,quantity,reference_type,reference_id,created_by,occurred_at,variant_id,note)
  values
    (gen_random_uuid(),p_company_id,p_from_warehouse_id,p_product_id,'transfer_out',p_quantity,'transfer',p_operation_id,v_auth,timezone('utc',now()),p_variant_id,p_notes),
    (gen_random_uuid(),p_company_id,p_to_warehouse_id,p_product_id,'transfer_in',p_quantity,'transfer',p_operation_id,v_auth,timezone('utc',now()),p_variant_id,p_notes);
  return jsonb_build_object('success',true,'id',p_operation_id,'already_existed',false);
end;
$$;

create or replace function public.palmyra_adjust_inventory(
  p_operation_id uuid,p_company_id uuid,p_warehouse_id uuid,p_product_id uuid,p_variant_id uuid,
  p_delta numeric,p_expected_quantity numeric default null,p_min_quantity numeric default 0,p_notes text default null
) returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_auth uuid:=auth.uid(); v_current numeric:=0; v_next numeric:=0;
  v_existing public.sync_applied_operations%rowtype; v_variant_product_id uuid; v_reference_type text;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if p_operation_id is null then raise exception 'operation_id_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id,'inventory.manage') then raise exception 'permission_denied'; end if;
  if p_delta is null or p_delta::text='NaN' then raise exception 'invalid_delta'; end if;
  if p_expected_quantity is not null and (p_expected_quantity<0 or p_expected_quantity::text='NaN') then raise exception 'invalid_expected_quantity'; end if;
  if p_min_quantity is null or p_min_quantity<0 or p_min_quantity::text='NaN' then raise exception 'invalid_min_quantity'; end if;

  select * into v_existing from public.sync_applied_operations where operation_id=p_operation_id and company_id=p_company_id limit 1;
  if found then
    if p_variant_id is null then
      select coalesce(quantity,0) into v_current from public.stock_balances where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=p_product_id and variant_id is null;
    else
      select coalesce(quantity,0) into v_current from public.variant_stock_balances where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=p_product_id and variant_id=p_variant_id;
    end if;
    return jsonb_build_object('success',true,'already_applied',true,'quantity',coalesce(v_current,0));
  end if;

  perform pg_advisory_xact_lock(hashtextextended(concat_ws(':',p_company_id::text,p_warehouse_id::text,p_product_id::text,coalesce(p_variant_id::text,'base')),0));
  select * into v_existing from public.sync_applied_operations where operation_id=p_operation_id and company_id=p_company_id limit 1;
  if found then return jsonb_build_object('success',true,'already_applied',true,'quantity',coalesce(v_current,0)); end if;

  if not exists(select 1 from public.warehouses where id=p_warehouse_id and company_id=p_company_id and active) then raise exception 'invalid_warehouse'; end if;
  if not exists(select 1 from public.products where id=p_product_id and company_id=p_company_id) then raise exception 'invalid_product'; end if;
  if p_variant_id is not null then
    select pv.product_id into v_variant_product_id from public.product_variants pv where pv.id=p_variant_id and pv.company_id=p_company_id and pv.product_id=p_product_id and pv.active limit 1;
    if v_variant_product_id is null then raise exception 'invalid_variant'; end if;
  end if;

  if p_variant_id is null then
    select coalesce(quantity,0) into v_current from public.stock_balances where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=p_product_id and variant_id is null;
  else
    select coalesce(quantity,0) into v_current from public.variant_stock_balances where company_id=p_company_id and warehouse_id=p_warehouse_id and product_id=p_product_id and variant_id=p_variant_id;
  end if;
  v_current:=coalesce(v_current,0);

  if p_expected_quantity is not null and v_current<>p_expected_quantity then
    return jsonb_build_object('success',false,'conflict',true,'quantity',v_current,'error','El inventario cambió en el servidor; se requiere reconciliación.');
  end if;

  v_next:=greatest(p_min_quantity,v_current+p_delta);
  v_reference_type:=case when p_expected_quantity is null then 'inventory_adjustment' else 'inventory_reconciliation' end;

  if p_variant_id is null then
    insert into public.stock_balances(company_id,warehouse_id,product_id,variant_id,quantity,updated_at)
      values(p_company_id,p_warehouse_id,p_product_id,null,v_next,timezone('utc',now()))
      on conflict(warehouse_id,product_id) do update set quantity=excluded.quantity,updated_at=excluded.updated_at;
  else
    insert into public.variant_stock_balances(company_id,warehouse_id,product_id,variant_id,quantity,updated_at)
      values(p_company_id,p_warehouse_id,p_product_id,p_variant_id,v_next,timezone('utc',now()))
      on conflict(company_id,warehouse_id,product_id,variant_id)
      do update set quantity=excluded.quantity,updated_at=excluded.updated_at;
  end if;

  if p_delta<>0 then
    insert into public.stock_movements(id,company_id,warehouse_id,product_id,variant_id,movement_type,quantity,reference_type,reference_id,created_by,occurred_at,note)
      values(gen_random_uuid(),p_company_id,p_warehouse_id,p_product_id,p_variant_id,'adjustment'::public.stock_movement_type,abs(p_delta),v_reference_type,p_operation_id,v_auth,timezone('utc',now()),p_notes);
  end if;

  insert into public.sync_applied_operations(operation_id,company_id,entity_type,entity_id)
    values(p_operation_id,p_company_id,v_reference_type,p_product_id);
  return jsonb_build_object('success',true,'already_applied',false,'quantity',v_next);
end;
$$;
