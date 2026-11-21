-- Idempotent void of a sale and of a whole cash shift.
--
-- Problem: palmyra_void_sale restored every sale_item quantity. When part of
-- the sale had already been refunded (palmyra_complete_return already added the
-- units back), voiding the sale returned the same merchandise twice.
-- palmyra_cancel_cash_session only marked the shift as voided and left its
-- sales, stock and payments untouched, so the client had no confirmed list of
-- voided sales and could not reconcile local inventory safely.
--
-- This migration:
--   1. Restores only (sold - already completed returns) units per product and
--      variant, keeping the void itself idempotent by sale status.
--   2. Voids every open sale of a cancelled shift through the same routine and
--      returns `voided_sale_ids` so the device restores exactly that set once.

begin;

create index if not exists sales_returns_company_sale_status_idx
  on public.sales_returns (company_id, sale_id, status);

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

  -- Replaying a confirmed void must never restore stock again.
  if v_sale.status in ('voided', 'refunded') then
    return jsonb_build_object('success', true, 'already_refunded', true, 'restored_units', 0);
  end if;

  for it in
    select product_id, variant_id, quantity
    from public.sale_items
    where sale_id = p_sale_id
  loop
    -- Units already credited back by a completed return are excluded, so the
    -- same blouse is not returned by both the return and the void.
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
    return jsonb_build_object('success', true, 'already_cancelled', true, 'voided_sale_ids', v_voided);
  end if;
  if v_row.status <> 'open' then
    raise exception 'cash_session_not_open';
  end if;

  -- Void every sale that is still open in this shift. The nested call is
  -- idempotent and only restores units not already returned.
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

commit;
