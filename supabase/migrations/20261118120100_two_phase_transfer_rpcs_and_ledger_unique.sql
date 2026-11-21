-- Two-phase inventory transfers (dispatch + reception) and stock-ledger
-- uniqueness. Additive: no existing row is modified. The unique index aborts
-- if historical duplicates exist instead of deleting audit data.

do $guard$
begin
  if exists (
    select 1
    from public.stock_movements
    where reference_type = 'transfer' and reference_id is not null
    group by reference_id, movement_type, warehouse_id, product_id,
             coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
    having count(*) > 1
  ) then
    raise exception 'stock_movements contiene movimientos de traslado duplicados; resuélvelos antes de aplicar la unicidad';
  end if;
end
$guard$;

create unique index if not exists stock_movements_transfer_reference_unique
  on public.stock_movements (
    reference_id,
    movement_type,
    warehouse_id,
    product_id,
    coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where reference_type = 'transfer' and reference_id is not null;

-- Fase 1: el origen despacha y el stock queda "en tránsito".
create or replace function public.palmyra_dispatch_transfer(
  p_operation_id uuid,
  p_batch_id uuid,
  p_company_id uuid,
  p_origin_warehouse_id uuid,
  p_destination_warehouse_id uuid,
  p_items jsonb,
  p_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_existing public.transfers%rowtype;
  v_item record;
  v_source_qty numeric;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if p_operation_id is null then raise exception 'operation_id_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id, 'inventory.transfer') then raise exception 'permission_denied'; end if;
  if p_origin_warehouse_id is null or p_destination_warehouse_id is null
     or p_origin_warehouse_id = p_destination_warehouse_id then
    raise exception 'invalid_transfer';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'transfer_items_required';
  end if;

  if not exists (
    select 1 from public.warehouses
    where id = p_origin_warehouse_id and company_id = p_company_id and active
  ) or not exists (
    select 1 from public.warehouses
    where id = p_destination_warehouse_id and company_id = p_company_id and active
  ) then
    raise exception 'invalid_warehouse';
  end if;

  if not private.user_can_access_warehouse(v_auth, p_company_id, p_origin_warehouse_id) then
    raise exception 'location_access_denied';
  end if;

  select * into v_existing from public.transfers where id = p_operation_id for update;
  if found then
    if v_existing.company_id <> p_company_id then
      raise exception 'operation_already_used';
    end if;
    return jsonb_build_object(
      'success', true,
      'id', v_existing.id,
      'status', v_existing.status::text,
      'already_existed', true
    );
  end if;

  -- Valida y normaliza los artículos antes de tocar stock.
  begin
    perform (x->>'product_id')::uuid,
            nullif(x->>'variant_id', '')::uuid,
            (x->>'quantity')::numeric
    from jsonb_array_elements(p_items) x;
  exception when others then
    raise exception 'invalid_transfer_item';
  end;

  insert into public.transfers(
    id, company_id, origin_warehouse_id, destination_warehouse_id,
    status, notes, created_by, batch_id
  )
  values (
    p_operation_id, p_company_id, p_origin_warehouse_id, p_destination_warehouse_id,
    'in_transit', left(nullif(trim(p_notes), ''), 500), v_auth, p_batch_id
  );

  for v_item in
    select (x->>'product_id')::uuid as product_id,
           nullif(x->>'variant_id', '')::uuid as variant_id,
           sum((x->>'quantity')::numeric) as quantity
    from jsonb_array_elements(p_items) x
    group by 1, 2
  loop
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'invalid_transfer_quantity';
    end if;
    if not exists (
      select 1 from public.products
      where id = v_item.product_id and company_id = p_company_id
        and status = 'active' and track_stock
    ) then
      raise exception 'invalid_stock_product';
    end if;
    if v_item.variant_id is not null and not exists (
      select 1 from public.product_variants
      where id = v_item.variant_id and company_id = p_company_id
        and product_id = v_item.product_id and active
    ) then
      raise exception 'invalid_variant';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
      concat_ws(':', p_company_id::text, p_origin_warehouse_id::text,
                v_item.product_id::text, coalesce(v_item.variant_id::text, 'base')),
      0
    ));

    if v_item.variant_id is null then
      select quantity into v_source_qty
      from public.stock_balances
      where warehouse_id = p_origin_warehouse_id and product_id = v_item.product_id
      for update;
      if not found then raise exception 'stock_record_missing'; end if;
      if v_source_qty < v_item.quantity then raise exception 'insufficient_stock'; end if;

      update public.stock_balances
      set quantity = quantity - v_item.quantity, updated_at = timezone('utc', now())
      where warehouse_id = p_origin_warehouse_id and product_id = v_item.product_id;
    else
      select quantity into v_source_qty
      from public.variant_stock_balances
      where company_id = p_company_id and warehouse_id = p_origin_warehouse_id
        and product_id = v_item.product_id and variant_id = v_item.variant_id
      for update;
      if not found then raise exception 'variant_stock_record_missing'; end if;
      if v_source_qty < v_item.quantity then raise exception 'insufficient_stock'; end if;

      update public.variant_stock_balances
      set quantity = quantity - v_item.quantity, updated_at = timezone('utc', now())
      where company_id = p_company_id and warehouse_id = p_origin_warehouse_id
        and product_id = v_item.product_id and variant_id = v_item.variant_id;
    end if;

    insert into public.transfer_items(transfer_id, product_id, variant_id, quantity)
    values (p_operation_id, v_item.product_id, v_item.variant_id, v_item.quantity);

    insert into public.stock_movements(
      company_id, warehouse_id, product_id, variant_id, movement_type, quantity,
      reference_type, reference_id, created_by, note
    )
    values (
      p_company_id, p_origin_warehouse_id, v_item.product_id, v_item.variant_id,
      'transfer_out', v_item.quantity, 'transfer', p_operation_id, v_auth,
      left(nullif(trim(p_notes), ''), 500)
    );
  end loop;

  return jsonb_build_object(
    'success', true,
    'id', p_operation_id,
    'status', 'in_transit',
    'already_existed', false
  );
end;
$function$;

-- Fase 2: el destino confirma la recepción y el stock entra al almacén.
create or replace function public.palmyra_receive_transfer(
  p_operation_id uuid,
  p_company_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_transfer public.transfers%rowtype;
  v_item record;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if p_operation_id is null then raise exception 'operation_id_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id, 'inventory.transfer') then raise exception 'permission_denied'; end if;

  select * into v_transfer
  from public.transfers
  where id = p_operation_id and company_id = p_company_id
  for update;
  if not found then raise exception 'transfer_not_found'; end if;

  if v_transfer.status = 'received' then
    return jsonb_build_object('success', true, 'id', p_operation_id, 'status', 'received', 'already_existed', true);
  end if;
  if v_transfer.status = 'cancelled' then
    raise exception 'transfer_cancelled';
  end if;
  if v_transfer.status = 'posted' then
    -- Traslado de una sola fase ya aplicado: no vuelve a mover stock.
    return jsonb_build_object('success', true, 'id', p_operation_id, 'status', 'posted', 'already_existed', true);
  end if;
  if v_transfer.status <> 'in_transit' then
    raise exception 'transfer_not_in_transit';
  end if;

  if not private.user_can_access_warehouse(v_auth, p_company_id, v_transfer.destination_warehouse_id) then
    raise exception 'location_access_denied';
  end if;

  for v_item in
    select product_id, variant_id, sum(quantity) as quantity
    from public.transfer_items
    where transfer_id = p_operation_id
    group by 1, 2
  loop
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'invalid_transfer_quantity';
    end if;

    if v_item.variant_id is null then
      insert into public.stock_balances(company_id, warehouse_id, product_id, quantity)
      values (p_company_id, v_transfer.destination_warehouse_id, v_item.product_id, v_item.quantity)
      on conflict (warehouse_id, product_id)
      do update set quantity = public.stock_balances.quantity + excluded.quantity,
                    updated_at = timezone('utc', now());
    else
      insert into public.variant_stock_balances(company_id, warehouse_id, product_id, variant_id, quantity)
      values (p_company_id, v_transfer.destination_warehouse_id, v_item.product_id, v_item.variant_id, v_item.quantity)
      on conflict (company_id, warehouse_id, product_id, variant_id)
      do update set quantity = public.variant_stock_balances.quantity + excluded.quantity,
                    updated_at = timezone('utc', now());
    end if;

    insert into public.stock_movements(
      company_id, warehouse_id, product_id, variant_id, movement_type, quantity,
      reference_type, reference_id, created_by, note
    )
    values (
      p_company_id, v_transfer.destination_warehouse_id, v_item.product_id, v_item.variant_id,
      'transfer_in', v_item.quantity, 'transfer', p_operation_id, v_auth,
      'Recepción de traslado'
    )
    on conflict do nothing;
  end loop;

  update public.transfers
  set status = 'received', received_at = timezone('utc', now()), received_by = v_auth
  where id = p_operation_id;

  return jsonb_build_object('success', true, 'id', p_operation_id, 'status', 'received', 'already_existed', false);
end;
$function$;

-- Cancelar un traslado todavía en tránsito devuelve la mercancía al origen.
create or replace function public.palmyra_cancel_transfer(
  p_operation_id uuid,
  p_company_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_transfer public.transfers%rowtype;
  v_item record;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if p_operation_id is null then raise exception 'operation_id_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id, 'inventory.transfer') then raise exception 'permission_denied'; end if;

  select * into v_transfer
  from public.transfers
  where id = p_operation_id and company_id = p_company_id
  for update;
  if not found then raise exception 'transfer_not_found'; end if;

  if v_transfer.status = 'cancelled' then
    return jsonb_build_object('success', true, 'id', p_operation_id, 'status', 'cancelled', 'already_existed', true);
  end if;
  if v_transfer.status <> 'in_transit' then
    raise exception 'transfer_not_in_transit';
  end if;

  if not private.user_can_access_warehouse(v_auth, p_company_id, v_transfer.origin_warehouse_id) then
    raise exception 'location_access_denied';
  end if;

  for v_item in
    select product_id, variant_id, sum(quantity) as quantity
    from public.transfer_items
    where transfer_id = p_operation_id
    group by 1, 2
  loop
    if v_item.variant_id is null then
      insert into public.stock_balances(company_id, warehouse_id, product_id, quantity)
      values (p_company_id, v_transfer.origin_warehouse_id, v_item.product_id, v_item.quantity)
      on conflict (warehouse_id, product_id)
      do update set quantity = public.stock_balances.quantity + excluded.quantity,
                    updated_at = timezone('utc', now());
    else
      insert into public.variant_stock_balances(company_id, warehouse_id, product_id, variant_id, quantity)
      values (p_company_id, v_transfer.origin_warehouse_id, v_item.product_id, v_item.variant_id, v_item.quantity)
      on conflict (company_id, warehouse_id, product_id, variant_id)
      do update set quantity = public.variant_stock_balances.quantity + excluded.quantity,
                    updated_at = timezone('utc', now());
    end if;

    insert into public.stock_movements(
      company_id, warehouse_id, product_id, variant_id, movement_type, quantity,
      reference_type, reference_id, created_by, note
    )
    values (
      p_company_id, v_transfer.origin_warehouse_id, v_item.product_id, v_item.variant_id,
      'transfer_in', v_item.quantity, 'transfer', p_operation_id, v_auth,
      'Devolución al origen por traslado cancelado'
    )
    on conflict do nothing;
  end loop;

  update public.transfers
  set status = 'cancelled'
  where id = p_operation_id;

  return jsonb_build_object('success', true, 'id', p_operation_id, 'status', 'cancelled', 'already_existed', false);
end;
$function$;

revoke execute on function public.palmyra_dispatch_transfer(uuid, uuid, uuid, uuid, uuid, jsonb, text) from public, anon;
revoke execute on function public.palmyra_receive_transfer(uuid, uuid) from public, anon;
revoke execute on function public.palmyra_cancel_transfer(uuid, uuid) from public, anon;
grant execute on function public.palmyra_dispatch_transfer(uuid, uuid, uuid, uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.palmyra_receive_transfer(uuid, uuid) to authenticated;
grant execute on function public.palmyra_cancel_transfer(uuid, uuid) to authenticated;
