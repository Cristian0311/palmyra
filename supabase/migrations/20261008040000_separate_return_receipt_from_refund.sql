-- Keep physical return completion separate from monetary refund settlement.
-- Receiving the item restores stock; a cash/bank refund is recorded by its own
-- explicit workflow and must not be marked paid automatically.
CREATE OR REPLACE FUNCTION public.palmyra_complete_return(p_return_id uuid, p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
declare
  v_auth uuid:=auth.uid();
  r public.sales_returns%rowtype;
  it record;
  sale_warehouse uuid;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id,'sales.refund') then raise exception 'permission_denied'; end if;
  select * into r from public.sales_returns where id=p_return_id and company_id=p_company_id for update;
  if not found then raise exception 'return_not_found'; end if;
  if r.status='completed' then return jsonb_build_object('success',true,'already_completed',true); end if;
  select warehouse_id into sale_warehouse from public.sales where id=r.sale_id and company_id=p_company_id;

  for it in select product_id,variant_id,quantity from public.sales_return_items where return_id=p_return_id loop
    if it.variant_id is null then
      insert into public.stock_balances(company_id,warehouse_id,product_id,quantity,updated_at,variant_id)
      values(p_company_id,sale_warehouse,it.product_id,it.quantity,timezone('utc',now()),null)
      on conflict(warehouse_id,product_id) do update
        set quantity=public.stock_balances.quantity+excluded.quantity,updated_at=excluded.updated_at;
    else
      insert into public.variant_stock_balances(company_id,warehouse_id,product_id,variant_id,quantity,updated_at)
      values(p_company_id,sale_warehouse,it.product_id,it.variant_id,it.quantity,timezone('utc',now()))
      on conflict(company_id,warehouse_id,variant_id) do update
        set quantity=public.variant_stock_balances.quantity+excluded.quantity,updated_at=excluded.updated_at;
    end if;

    insert into public.stock_movements(
      id,company_id,warehouse_id,product_id,movement_type,quantity,reference_type,
      reference_id,created_by,occurred_at,variant_id,note
    )
    values(
      gen_random_uuid(),p_company_id,sale_warehouse,it.product_id,'sale_refund',
      it.quantity,'return',p_return_id,v_auth,timezone('utc',now()),it.variant_id,'Devolución'
    );
  end loop;

  update public.sales_returns
  set status='completed',
      updated_at=timezone('utc',now())
  where id=p_return_id and company_id=p_company_id;

  return jsonb_build_object('success',true,'already_completed',false);
end;
$function$;
