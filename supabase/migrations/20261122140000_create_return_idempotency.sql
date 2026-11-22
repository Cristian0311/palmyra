begin;

-- palmyra_create_return insertaba la cabecera con `on conflict (id) do nothing`
-- pero SIEMPRE volvía a insertar la línea con gen_random_uuid(). Un reintento
-- del POS (replay offline o doble toque) encontraba la cabecera existente, no
-- insertaba nada allí, y aun así añadía otra línea; al completar la devolución
-- el stock se reponía dos veces.
--
-- Se corrige de dos formas:
--  1) Si la cabecera ya existía, se devuelve éxito sin tocar líneas.
--  2) La línea usa `on conflict (return_id, sale_item_id) do nothing`, que se
--     apoya en el índice único sales_return_items_return_id_sale_item_id_key.
create or replace function public.palmyra_create_return(
  p_return_id uuid,
  p_company_id uuid,
  p_sale_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_reason text,
  p_amount numeric,
  p_type text
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_inserted uuid;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id, 'sales.refund') then raise exception 'permission_denied'; end if;

  select * into v_sale from public.sales where id = p_sale_id and company_id = p_company_id limit 1;
  if not found then raise exception 'sale_not_found'; end if;

  insert into public.sales_returns(id, company_id, sale_id, status, reason, total, created_by, return_type, refund_status, refund_amount)
  values (p_return_id, p_company_id, p_sale_id, 'pending', coalesce(p_reason, ''), coalesce(p_amount, 0), v_auth, coalesce(p_type, 'refund'), 'pending', coalesce(p_amount, 0))
  on conflict (id) do nothing
  returning id into v_inserted;

  if v_inserted is null then
    return jsonb_build_object('success', true, 'id', p_return_id, 'already_exists', true);
  end if;

  insert into public.sales_return_items(id, return_id, sale_item_id, product_id, quantity, unit_price, line_total, variant_id)
  select gen_random_uuid(), p_return_id, si.id, si.product_id, least(p_quantity, si.quantity), si.unit_price,
         least(p_quantity, si.quantity) * si.unit_price, si.variant_id
  from public.sale_items si
  where si.sale_id = p_sale_id and si.product_id = p_product_id
  order by si.id
  limit 1
  on conflict (return_id, sale_item_id) do nothing;

  return jsonb_build_object('success', true, 'id', p_return_id, 'already_exists', false);
end;
$function$;

revoke all on function public.palmyra_create_return(uuid, uuid, uuid, uuid, numeric, text, numeric, text) from public, anon;
grant execute on function public.palmyra_create_return(uuid, uuid, uuid, uuid, numeric, text, numeric, text) to authenticated;

commit;
