begin;
do $migration$
declare
  v_definition text;
  v_fixed text;
begin
  v_definition := pg_get_functiondef(
    'public.palmyra_transfer_inventory(uuid,uuid,uuid,uuid,uuid,uuid,numeric,text)'::regprocedure
  );
  v_fixed := replace(
    v_definition,
    'where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id for update;\n    if v_source_qty<p_quantity then raise exception ''insufficient_stock''; end if;',
    'where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id for update;\n    if not found then raise exception ''stock_record_missing''; end if;\n    if v_source_qty<p_quantity then raise exception ''insufficient_stock''; end if;'
  );
  v_fixed := replace(
    v_fixed,
    'where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id and variant_id=p_variant_id for update;\n    if v_source_qty<p_quantity then raise exception ''insufficient_stock''; end if;',
    'where company_id=p_company_id and warehouse_id=p_from_warehouse_id and product_id=p_product_id and variant_id=p_variant_id for update;\n    if not found then raise exception ''variant_stock_record_missing''; end if;\n    if v_source_qty<p_quantity then raise exception ''insufficient_stock''; end if;'
  );
  if v_fixed = v_definition then
    if position('stock_record_missing' in v_definition) = 0 or position('variant_stock_record_missing' in v_definition) = 0 then
      raise exception 'Could not harden missing source stock checks; function definition did not match expected contract.';
    end if;
  else
    execute v_fixed;
  end if;
end;
$migration$;
commit;