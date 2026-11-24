-- Cierre de traslados legacy 'posted' (una sola fase).
--
-- Contexto: los 77 traslados 'posted' del 23-nov ya tienen aplicados sus dos
-- movimientos de stock (transfer_out + transfer_in) en la nube. La RPC
-- palmyra_receive_transfer respondía success con status:'posted' sin cambiar
-- el estado, por lo que el cliente los mostraba para siempre como "en
-- tránsito" aunque la mercancía ya estaba contabilizada.
--
-- 1) La RPC ahora cierra el ciclo: posted -> received SIN mover stock de
--    nuevo (idempotente; si ya se recibió, devuelve el estado real).
-- 2) Los 77 traslados legacy se marcan received con un UPDATE guardado que
--    exige la existencia de AMBOS movimientos: si alguno no los tiene, no se
--    toca (lo audita un humano). No se crea ningún movimiento nuevo ni se
--    tocan balances: el stock ya estaba aplicado.

create or replace function public.palmyra_receive_transfer(p_operation_id uuid, p_company_id uuid)
 returns jsonb
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
    -- Traslado de una sola fase: el stock ya está aplicado en ambos lados.
    -- Se cierra el ciclo marcándolo recibido sin volver a mover stock.
    update public.transfers
       set status = 'received', received_at = timezone('utc', now()), received_by = v_auth
     where id = p_operation_id;
    return jsonb_build_object('success', true, 'id', p_operation_id, 'status', 'received', 'already_existed', true);
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

-- Cierre guardado de los traslados legacy 'posted': solo los que tienen sus
-- dos movimientos aplicados. Sin movimientos nuevos ni cambios de balance.
update public.transfers t
   set status = 'received', received_at = timezone('utc', now())
 where t.status = 'posted'
   and exists (
     select 1 from public.stock_movements m
      where m.reference_type = 'transfer' and m.reference_id = t.id
        and m.movement_type = 'transfer_in'
   )
   and exists (
     select 1 from public.stock_movements m
      where m.reference_type = 'transfer' and m.reference_id = t.id
        and m.movement_type = 'transfer_out'
   );
