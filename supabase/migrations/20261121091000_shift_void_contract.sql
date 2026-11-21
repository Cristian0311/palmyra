-- Contrato de anulación de turno.
--
-- El cliente exige `voided_sale_ids` en la respuesta; la definición desplegada
-- en producción era anterior a 20261118150000 y provocaba «Se requiere
-- actualizar el RPC de anulación de turnos». Además, borrar un turno desde
-- Reportes debe funcionar también cuando la caja ya está cerrada.
--
-- Esta migración:
--   1. Elimina la sobrecarga antigua de 3 argumentos para que PostgREST no la
--      resuelva por error.
--   2. Recrea palmyra_cancel_cash_session aceptando turnos 'open' y 'closed'.
--   3. Devuelve siempre `voided_sale_ids` (también al reintentar un turno ya
--      anulado) para que el dispositivo purgue exactamente esas ventas.

begin;

drop function if exists public.palmyra_cancel_cash_session(uuid, uuid, text);

create or replace function public.palmyra_void_sale(p_sale_id uuid, p_company_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_sale public.sales%rowtype;
  it record;
  v_returned numeric;
  v_net numeric;
  v_restored numeric := 0;
  v_reason text := left(nullif(trim(coalesce(p_reason, '')), ''), 500);
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id, 'sales.refund') then raise exception 'permission_denied'; end if;

  select * into v_sale
  from public.sales
  where id = p_sale_id and company_id = p_company_id
  for update;
  if not found then raise exception 'sale_not_found'; end if;

  if v_sale.status in ('voided', 'refunded') then
    return jsonb_build_object('success', true, 'already_refunded', true, 'restored_units', 0);
  end if;

  for it in
    select product_id, variant_id, quantity
    from public.sale_items
    where sale_id = p_sale_id
  loop
    select coalesce(sum(ri.quantity), 0)
      into v_returned
    from public.sales_return_items ri
    join public.sales_returns r on r.id = ri.return_id
    where r.company_id = p_company_id
      and r.sale_id = p_sale_id
      and r.status = 'completed'
      and ri.product_id = it.product_id
      and coalesce(ri.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(it.variant_id, '00000000-0000-0000-0000-000000000000'::uuid);

    v_net := coalesce(it.quantity, 0) - coalesce(v_returned, 0);
    continue when v_net <= 0;

    if it.variant_id is null then
      insert into public.stock_balances(company_id, warehouse_id, product_id, quantity, updated_at, variant_id)
      values (p_company_id, v_sale.warehouse_id, it.product_id, v_net, timezone('utc', now()), null)
      on conflict (warehouse_id, product_id) do update
        set quantity = public.stock_balances.quantity + excluded.quantity,
            updated_at = excluded.updated_at;
    else
      insert into public.variant_stock_balances(company_id, warehouse_id, product_id, variant_id, quantity, updated_at)
      values (p_company_id, v_sale.warehouse_id, it.product_id, it.variant_id, v_net, timezone('utc', now()))
      on conflict (company_id, warehouse_id, variant_id) do update
        set quantity = public.variant_stock_balances.quantity + excluded.quantity,
            updated_at = excluded.updated_at;
    end if;

    insert into public.stock_movements(
      id, company_id, warehouse_id, product_id, movement_type, quantity,
      reference_type, reference_id, created_by, occurred_at, variant_id, note
    ) values (
      gen_random_uuid(), p_company_id, v_sale.warehouse_id, it.product_id, 'sale_refund', v_net,
      'sale_void', p_sale_id, v_auth, timezone('utc', now()), it.variant_id,
      coalesce(v_reason, 'Anulación')
    );

    v_restored := v_restored + v_net;
  end loop;

  update public.sales
     set status = 'voided',
         notes = concat_ws(E'\n', nullif(notes, ''), coalesce(v_reason, 'Anulación'))
   where id = p_sale_id and company_id = p_company_id;

  return jsonb_build_object('success', true, 'already_refunded', false, 'restored_units', v_restored);
end;
$function$;

create or replace function public.palmyra_cancel_cash_session(
  p_session_id uuid,
  p_company_id uuid,
  p_reason text,
  p_password text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_row public.cash_sessions%rowtype;
  v_reason text := left(coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Anulación de turno'), 500);
  v_sale_id uuid;
  v_voided jsonb := '[]'::jsonb;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id, 'cash.close') then raise exception 'permission_denied'; end if;

  select *
    into v_row
  from public.cash_sessions
  where id = p_session_id and company_id = p_company_id
  for update;

  if not found then raise exception 'cash_session_not_found'; end if;

  if v_row.status = 'voided' then
    -- Reintento: devolvemos las ventas que ya quedaron anuladas para que el
    -- cliente pueda purgar exactamente ese conjunto.
    select coalesce(jsonb_agg(id order by id), '[]'::jsonb)
      into v_voided
    from public.sales
    where company_id = p_company_id
      and cash_session_id = p_session_id
      and status = 'voided';
    return jsonb_build_object('success', true, 'already_cancelled', true, 'voided_sale_ids', v_voided);
  end if;

  if v_row.status not in ('open', 'closed') then
    raise exception 'cash_session_not_open';
  end if;

  for v_sale_id in
    select id
    from public.sales
    where company_id = p_company_id
      and cash_session_id = p_session_id
      and status not in ('voided', 'refunded')
    order by id
  loop
    perform public.palmyra_void_sale(v_sale_id, p_company_id, v_reason);
    v_voided := v_voided || to_jsonb(v_sale_id);
  end loop;

  update public.cash_sessions
     set status = 'voided',
         closed_at = timezone('utc', now()),
         closed_by = v_auth,
         difference = 0,
         delete_reason = v_reason
   where id = p_session_id and company_id = p_company_id;

  return jsonb_build_object(
    'success', true,
    'already_cancelled', false,
    'employee_id', v_row.employee_id,
    'voided_sale_ids', v_voided
  );
end;
$function$;

grant execute on function public.palmyra_void_sale(uuid, uuid, text) to authenticated;
grant execute on function public.palmyra_cancel_cash_session(uuid, uuid, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
