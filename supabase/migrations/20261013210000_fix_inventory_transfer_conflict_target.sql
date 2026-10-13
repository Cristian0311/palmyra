begin;

-- Fix the actual unique-key mismatch in base inventory transfers.
-- stock_balances is keyed by (warehouse_id, product_id); company_id is a
-- validated tenant column but is not part of that table's primary key.
do $$
declare
  v_definition text;
  v_fixed text;
begin
  v_definition := pg_get_functiondef(
    'public.palmyra_transfer_inventory(uuid,uuid,uuid,uuid,uuid,uuid,numeric,text)'::regprocedure
  );
  v_fixed := replace(
    v_definition,
    'on conflict(company_id,warehouse_id,product_id)',
    'on conflict(warehouse_id,product_id)'
  );
  if v_fixed = v_definition then
    if position('on conflict(warehouse_id,product_id)' in v_definition) = 0 then
      raise exception 'Expected stock_balances conflict target was not found in palmyra_transfer_inventory';
    end if;
  else
    execute v_fixed;
  end if;
end;
$$;

commit;