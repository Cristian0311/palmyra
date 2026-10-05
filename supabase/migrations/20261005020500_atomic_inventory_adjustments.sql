-- PALMYRA: atomic inventory adjustment/reconciliation.
-- The operation is authenticated, tenant-scoped, warehouse-scoped and idempotent.
create or replace function public.palmyra_adjust_inventory(
  p_operation_id uuid,
  p_company_id uuid,
  p_warehouse_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_delta numeric,
  p_expected_quantity numeric default null,
  p_min_quantity numeric default 0,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_current numeric := 0;
  v_next numeric := 0;
  v_movement_type public.stock_movement_type;
  v_existing public.sync_applied_operations%rowtype;
  v_variant_product_id uuid;
begin
  if v_auth is null then
    raise exception 'authentication_required';
  end if;
  if p_operation_id is null then
    raise exception 'operation_id_required';
  end if;
  if not private.has_company_access(p_company_id) then
    raise exception 'company_access_denied';
  end if;
  if not private.has_permission(p_company_id, 'inventory.manage') then
    raise exception 'permission_denied';
  end if;
  if p_delta is null then
    raise exception 'delta_required';
  end if;
  if p_expected_quantity is not null and p_expected_quantity < 0 then
    raise exception 'invalid_expected_quantity';
  end if;
  if p_min_quantity is null or p_min_quantity < 0 then
    raise exception 'invalid_min_quantity';
  end if;

  select *
    into v_existing
  from public.sync_applied_operations
  where operation_id = p_operation_id
    and company_id = p_company_id
  limit 1;

  if found then
    select coalesce(
      case
        when p_variant_id is null then
          (select sb.quantity
             from public.stock_balances sb
            where sb.company_id = p_company_id
              and sb.warehouse_id = p_warehouse_id
              and sb.product_id = p_product_id
              and sb.variant_id is null)
        else
          (select vsb.quantity
             from public.variant_stock_balances vsb
            where vsb.company_id = p_company_id
              and vsb.warehouse_id = p_warehouse_id
              and vsb.product_id = p_product_id
              and vsb.variant_id = p_variant_id)
      end,
      0
    )
    into v_current;

    return jsonb_build_object(
      'success', true,
      'already_applied', true,
      'quantity', v_current
    );
  end if;

  if not exists (
    select 1 from public.warehouses
    where id = p_warehouse_id and company_id = p_company_id and active
  ) then
    raise exception 'invalid_warehouse';
  end if;

  select p.id
    into v_variant_product_id
  from public.product_variants pv
  join public.products p on p.id = pv.product_id
  where pv.id = p_variant_id
    and pv.company_id = p_company_id
    and pv.product_id = p_product_id
    and pv.active
    and p.company_id = p_company_id
    and p.status = 'active';

  if p_variant_id is not null and v_variant_product_id is null then
    raise exception 'invalid_variant';
  end if;

  if not exists (
    select 1
    from public.products
    where id = p_product_id
      and company_id = p_company_id
      and status = 'active'
  ) then
    raise exception 'invalid_product';
  end if;

  if p_variant_id is null then
    select coalesce(sb.quantity, 0)
      into v_current
    from (select 1) one
    left join public.stock_balances sb
      on sb.company_id = p_company_id
     and sb.warehouse_id = p_warehouse_id
     and sb.product_id = p_product_id
     and sb.variant_id is null
    for update of sb;
  else
    select coalesce(vsb.quantity, 0)
      into v_current
    from (select 1) one
    left join public.variant_stock_balances vsb
      on vsb.company_id = p_company_id
     and vsb.warehouse_id = p_warehouse_id
     and vsb.product_id = p_product_id
     and vsb.variant_id = p_variant_id
    for update of vsb;
  end if;

  if p_expected_quantity is not null and v_current <> p_expected_quantity then
    return jsonb_build_object(
      'success', false,
      'conflict', true,
      'quantity', v_current,
      'error', 'El inventario cambió en el servidor; se requiere reconciliación.'
    );
  end if;

  v_next := greatest(0, v_current + p_delta);

  if p_variant_id is null then
    insert into public.stock_balances(
      company_id, warehouse_id, product_id, variant_id, quantity, updated_at
    )
    values(
      p_company_id, p_warehouse_id, p_product_id, null, v_next, timezone('utc', now())
    )
    on conflict (warehouse_id, product_id)
    do update set quantity = excluded.quantity, updated_at = excluded.updated_at;
  else
    insert into public.variant_stock_balances(
      company_id, warehouse_id, product_id, variant_id, quantity, updated_at
    )
    values(
      p_company_id, p_warehouse_id, p_product_id, p_variant_id, v_next, timezone('utc', now())
    )
    on conflict (company_id, warehouse_id, product_id, variant_id)
    do update set quantity = excluded.quantity, updated_at = excluded.updated_at;
  end if;

  v_movement_type := 'adjustment'::public.stock_movement_type;

  insert into public.stock_movements(
    id, company_id, warehouse_id, product_id, variant_id,
    movement_type, quantity, reference_type, reference_id,
    created_by, occurred_at, note
  )
  values(
    gen_random_uuid(),
    p_company_id, p_warehouse_id, p_product_id, p_variant_id,
    v_movement_type, abs(p_delta),
    case when p_expected_quantity is null then 'inventory_adjustment' else 'inventory_reconciliation' end,
    p_operation_id,
    v_auth, timezone('utc', now()), p_notes
  );

  insert into public.sync_applied_operations(
    operation_id, company_id, entity_type, entity_id
  )
  values(
    p_operation_id, p_company_id,
    case when p_expected_quantity is null then 'inventory_adjustment' else 'inventory_reconciliation' end,
    p_product_id
  );

  return jsonb_build_object(
    'success', true,
    'already_applied', false,
    'quantity', v_next
  );
end;
$function$;

revoke all on function public.palmyra_adjust_inventory(uuid, uuid, uuid, uuid, uuid, numeric, numeric, numeric, text) from public;
revoke all on function public.palmyra_adjust_inventory(uuid, uuid, uuid, uuid, uuid, numeric, numeric, numeric, text) from anon;
grant execute on function public.palmyra_adjust_inventory(uuid, uuid, uuid, uuid, uuid, numeric, numeric, numeric, text) to authenticated;
