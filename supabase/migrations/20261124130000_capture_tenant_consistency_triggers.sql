-- Captura de deriva: las comprobaciones de consistencia multiempresa ya viven
-- en producción pero no estaban versionadas. Sin esto, un entorno recreado
-- desde migraciones aceptaría referencias cruzadas entre empresas.

create or replace function private.enforce_company_consistency()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_table_name='user_locations' then
    if new.warehouse_id is not null
       and not exists(select 1 from public.warehouses w where w.id=new.warehouse_id and w.company_id=new.company_id)
    then raise exception 'cross_company_reference: user_locations.warehouse_id'; end if;
  elsif tg_table_name='devices' then
    if new.warehouse_id is not null
       and not exists(select 1 from public.warehouses w where w.id=new.warehouse_id and w.company_id=new.company_id)
    then raise exception 'cross_company_reference: devices.warehouse_id'; end if;
  elsif tg_table_name='categories' then
    if new.parent_id is not null
       and not exists(select 1 from public.categories c where c.id=new.parent_id and c.company_id=new.company_id)
    then raise exception 'cross_company_reference: categories.parent_id'; end if;
  elsif tg_table_name='products' then
    if new.category_id is not null
       and not exists(select 1 from public.categories c where c.id=new.category_id and c.company_id=new.company_id)
    then raise exception 'cross_company_reference: products.category_id'; end if;
    if new.brand_id is not null
       and not exists(select 1 from public.brands b where b.id=new.brand_id and b.company_id=new.company_id)
    then raise exception 'cross_company_reference: products.brand_id'; end if;
  elsif tg_table_name='product_variants' then
    if not exists(select 1 from public.products p where p.id=new.product_id and p.company_id=new.company_id)
    then raise exception 'cross_company_reference: product_variants.product_id'; end if;
  elsif tg_table_name='product_barcodes' then
    if not exists(select 1 from public.products p where p.id=new.product_id and p.company_id=new.company_id)
    then raise exception 'cross_company_reference: product_barcodes.product_id'; end if;
    if new.variant_id is not null
       and not exists(select 1 from public.product_variants v where v.id=new.variant_id and v.company_id=new.company_id and v.product_id=new.product_id)
    then raise exception 'cross_company_reference: product_barcodes.variant_id'; end if;
  elsif tg_table_name='product_prices' then
    if not exists(select 1 from public.products p where p.id=new.product_id and p.company_id=new.company_id)
    then raise exception 'cross_company_reference: product_prices.product_id'; end if;
  elsif tg_table_name='stock_balances' then
    if not exists(select 1 from public.warehouses w where w.id=new.warehouse_id and w.company_id=new.company_id)
    then raise exception 'cross_company_reference: stock_balances.warehouse_id'; end if;
    if not exists(select 1 from public.products p where p.id=new.product_id and p.company_id=new.company_id)
    then raise exception 'cross_company_reference: stock_balances.product_id'; end if;
  elsif tg_table_name='stock_movements' then
    if not exists(select 1 from public.warehouses w where w.id=new.warehouse_id and w.company_id=new.company_id)
    then raise exception 'cross_company_reference: stock_movements.warehouse_id'; end if;
    if not exists(select 1 from public.products p where p.id=new.product_id and p.company_id=new.company_id)
    then raise exception 'cross_company_reference: stock_movements.product_id'; end if;
  elsif tg_table_name='transfers' then
    if not exists(select 1 from public.warehouses w where w.id=new.origin_warehouse_id and w.company_id=new.company_id)
    then raise exception 'cross_company_reference: transfers.origin_warehouse_id'; end if;
    if not exists(select 1 from public.warehouses w where w.id=new.destination_warehouse_id and w.company_id=new.company_id)
    then raise exception 'cross_company_reference: transfers.destination_warehouse_id'; end if;
  elsif tg_table_name='transfer_items' then
    if not exists(
      select 1 from public.transfers t
      join public.products p on p.id=new.product_id
      where t.id=new.transfer_id and p.company_id=t.company_id
    ) then raise exception 'cross_company_reference: transfer_items.product_id'; end if;
  elsif tg_table_name='salary_rules' then
    if not exists(select 1 from public.employees e where e.id=new.employee_id and e.company_id=new.company_id)
    then raise exception 'cross_company_reference: salary_rules.employee_id'; end if;
    if new.product_id is not null
       and not exists(select 1 from public.products p where p.id=new.product_id and p.company_id=new.company_id)
    then raise exception 'cross_company_reference: salary_rules.product_id'; end if;
  elsif tg_table_name='cash_registers' then
    if new.warehouse_id is not null
       and not exists(select 1 from public.warehouses w where w.id=new.warehouse_id and w.company_id=new.company_id)
    then raise exception 'cross_company_reference: cash_registers.warehouse_id'; end if;
  elsif tg_table_name='cash_sessions' then
    if not exists(select 1 from public.cash_registers r where r.id=new.cash_register_id and r.company_id=new.company_id)
    then raise exception 'cross_company_reference: cash_sessions.cash_register_id'; end if;
    if new.employee_id is not null
       and not exists(select 1 from public.employees e where e.id=new.employee_id and e.company_id=new.company_id)
    then raise exception 'cross_company_reference: cash_sessions.employee_id'; end if;
  elsif tg_table_name='cash_movements' then
    if not exists(select 1 from public.cash_sessions s where s.id=new.cash_session_id and s.company_id=new.company_id)
    then raise exception 'cross_company_reference: cash_movements.cash_session_id'; end if;
  elsif tg_table_name='sales' then
    if new.customer_id is not null
       and not exists(select 1 from public.customers c where c.id=new.customer_id and c.company_id=new.company_id)
    then raise exception 'cross_company_reference: sales.customer_id'; end if;
    if new.warehouse_id is not null
       and not exists(select 1 from public.warehouses w where w.id=new.warehouse_id and w.company_id=new.company_id)
    then raise exception 'cross_company_reference: sales.warehouse_id'; end if;
    if new.cash_session_id is not null
       and not exists(select 1 from public.cash_sessions s where s.id=new.cash_session_id and s.company_id=new.company_id)
    then raise exception 'cross_company_reference: sales.cash_session_id'; end if;
    if new.employee_id is not null
       and not exists(select 1 from public.employees e where e.id=new.employee_id and e.company_id=new.company_id)
    then raise exception 'cross_company_reference: sales.employee_id'; end if;
    if new.seller_user_id is not null
       and not exists(select 1 from public.company_memberships cm where cm.company_id=new.company_id and cm.user_id=new.seller_user_id and cm.status='active')
    then raise exception 'cross_company_reference: sales.seller_user_id'; end if;
  elsif tg_table_name='sale_items' then
    if not exists(
      select 1 from public.sales s join public.products p on p.id=new.product_id
      where s.id=new.sale_id and p.company_id=s.company_id
    ) then raise exception 'cross_company_reference: sale_items.product_id'; end if;
    if new.variant_id is not null
       and not exists(
         select 1 from public.product_variants v join public.sales s on s.id=new.sale_id
         where v.id=new.variant_id and v.company_id=s.company_id
       )
    then raise exception 'cross_company_reference: sale_items.variant_id'; end if;
  elsif tg_table_name='payments' then
    if not exists(select 1 from public.sales s where s.id=new.sale_id and s.company_id=new.company_id)
    then raise exception 'cross_company_reference: payments.sale_id'; end if;
  elsif tg_table_name='purchase_orders' then
    if new.supplier_id is not null
       and not exists(select 1 from public.suppliers s where s.id=new.supplier_id and s.company_id=new.company_id)
    then raise exception 'cross_company_reference: purchase_orders.supplier_id'; end if;
    if new.warehouse_id is not null
       and not exists(select 1 from public.warehouses w where w.id=new.warehouse_id and w.company_id=new.company_id)
    then raise exception 'cross_company_reference: purchase_orders.warehouse_id'; end if;
  elsif tg_table_name='purchase_items' then
    if not exists(
      select 1 from public.purchase_orders po join public.products p on p.id=new.product_id
      where po.id=new.purchase_order_id and p.company_id=po.company_id
    ) then raise exception 'cross_company_reference: purchase_items.product_id'; end if;
  elsif tg_table_name='commissions' then
    if not exists(select 1 from public.employees e where e.id=new.employee_id and e.company_id=new.company_id)
    then raise exception 'cross_company_reference: commissions.employee_id'; end if;
  elsif tg_table_name='payroll_items' then
    if not exists(select 1 from public.payroll_runs pr where pr.id=new.payroll_run_id and pr.company_id=new.company_id)
    then raise exception 'cross_company_reference: payroll_items.payroll_run_id'; end if;
    if not exists(select 1 from public.employees e where e.id=new.employee_id and e.company_id=new.company_id)
    then raise exception 'cross_company_reference: payroll_items.employee_id'; end if;
  elsif tg_table_name='printers' then
    if new.warehouse_id is not null
       and not exists(select 1 from public.warehouses w where w.id=new.warehouse_id and w.company_id=new.company_id)
    then raise exception 'cross_company_reference: printers.warehouse_id'; end if;
  end if;
  return new;
end;
$function$;

create or replace function private.enforce_variant_consistency()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_table_name='stock_balances' then
    if new.variant_id is not null and not exists(
      select 1 from public.product_variants v
      where v.id=new.variant_id and v.company_id=new.company_id and v.product_id=new.product_id and v.active
    ) then raise exception 'cross_company_reference: stock_balances.variant_id'; end if;
  elsif tg_table_name='stock_movements' then
    if new.variant_id is not null and not exists(
      select 1 from public.product_variants v
      where v.id=new.variant_id and v.company_id=new.company_id and v.product_id=new.product_id
    ) then raise exception 'cross_company_reference: stock_movements.variant_id'; end if;
  elsif tg_table_name='transfer_items' then
    if new.variant_id is not null and not exists(
      select 1
      from public.transfers t
      join public.product_variants v on v.id=new.variant_id
      where t.id=new.transfer_id and v.company_id=t.company_id and v.product_id=new.product_id
    ) then raise exception 'cross_company_reference: transfer_items.variant_id'; end if;
  elsif tg_table_name='sales_return_items' then
    if new.variant_id is not null and not exists(
      select 1
      from public.sales_returns r
      join public.sales s on s.id=r.sale_id
      join public.product_variants v on v.id=new.variant_id
      where r.id=new.return_id and s.company_id=r.company_id and v.company_id=r.company_id and v.product_id=new.product_id
    ) then raise exception 'cross_company_reference: sales_return_items.variant_id'; end if;
  end if;
  return new;
end;
$function$;

do $triggers$
declare
  t record;
begin
  for t in
    select * from (values
      ('public','user_locations','user_locations_company_consistency','enforce_company_consistency'),
      ('public','devices','devices_company_consistency','enforce_company_consistency'),
      ('public','warehouses','warehouses_company_consistency','enforce_company_consistency'),
      ('public','categories','categories_company_consistency','enforce_company_consistency'),
      ('public','products','products_company_consistency','enforce_company_consistency'),
      ('public','product_variants','variants_company_consistency','enforce_company_consistency'),
      ('public','product_barcodes','barcodes_company_consistency','enforce_company_consistency'),
      ('public','product_prices','prices_company_consistency','enforce_company_consistency'),
      ('public','stock_balances','stock_balances_company_consistency','enforce_company_consistency'),
      ('public','stock_movements','stock_movements_company_consistency','enforce_company_consistency'),
      ('public','transfers','transfers_company_consistency','enforce_company_consistency'),
      ('public','transfer_items','transfer_items_company_consistency','enforce_company_consistency'),
      ('public','salary_rules','salary_rules_company_consistency','enforce_company_consistency'),
      ('public','cash_registers','cash_registers_company_consistency','enforce_company_consistency'),
      ('public','cash_sessions','cash_sessions_company_consistency','enforce_company_consistency'),
      ('public','cash_movements','cash_movements_company_consistency','enforce_company_consistency'),
      ('public','customers','customers_company_consistency','enforce_company_consistency'),
      ('public','sales','sales_company_consistency','enforce_company_consistency'),
      ('public','sale_items','sale_items_company_consistency','enforce_company_consistency'),
      ('public','payments','payments_company_consistency','enforce_company_consistency'),
      ('public','purchase_orders','purchase_orders_company_consistency','enforce_company_consistency'),
      ('public','purchase_items','purchase_items_company_consistency','enforce_company_consistency'),
      ('public','commissions','commissions_company_consistency','enforce_company_consistency'),
      ('public','payroll_items','payroll_items_company_consistency','enforce_company_consistency'),
      ('public','printers','printers_company_consistency','enforce_company_consistency')
    ) as v(schema_name, table_name, trigger_name, function_name)
  loop
    execute format('drop trigger if exists %I on %I.%I', t.trigger_name, t.schema_name, t.table_name);
    execute format(
      'create trigger %I before insert or update on %I.%I for each row execute function private.%I()',
      t.trigger_name, t.schema_name, t.table_name, t.function_name
    );
  end loop;
end;
$triggers$;

drop trigger if exists trg_enforce_variant_consistency_stock_balances on public.stock_balances;
create trigger trg_enforce_variant_consistency_stock_balances
  before insert or update of variant_id, product_id, company_id on public.stock_balances
  for each row execute function private.enforce_variant_consistency();

drop trigger if exists trg_enforce_variant_consistency_stock_movements on public.stock_movements;
create trigger trg_enforce_variant_consistency_stock_movements
  before insert or update of variant_id, product_id, company_id on public.stock_movements
  for each row execute function private.enforce_variant_consistency();

drop trigger if exists trg_enforce_variant_consistency_transfer_items on public.transfer_items;
create trigger trg_enforce_variant_consistency_transfer_items
  before insert or update of variant_id, product_id, transfer_id on public.transfer_items
  for each row execute function private.enforce_variant_consistency();

drop trigger if exists trg_enforce_variant_consistency_return_items on public.sales_return_items;
create trigger trg_enforce_variant_consistency_return_items
  before insert or update of variant_id, product_id, return_id on public.sales_return_items
  for each row execute function private.enforce_variant_consistency();
