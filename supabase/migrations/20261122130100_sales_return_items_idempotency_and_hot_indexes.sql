begin;

-- PROPUESTA (no aplicada): idempotencia de líneas de devolución e índices de
-- camino caliente.
--
-- Contexto: palmyra_create_return inserta las líneas con
-- gen_random_uuid() y un `on conflict do nothing` sin destino (20261003040000),
-- por lo que un replay de la misma devolución duplica líneas y, con ellas, el
-- stock devuelto y el importe reembolsado. El índice único de abajo convierte ese
-- replay en un conflicto real (el RPC debe pasar a usar
-- `on conflict (return_id, sale_item_id) do update` o `do nothing` con destino).

-- 1) Falla cerrado si ya existen duplicados históricos: el índice no se crea y la
--    migración aborta con un mensaje accionable (mismo estilo que
--    20261118120100_two_phase_transfer_rpcs_and_ledger_unique.sql).
do $$
declare v_dups integer;
begin
  select count(*) into v_dups
  from (
    select return_id, sale_item_id
    from public.sales_return_items
    where sale_item_id is not null
    group by return_id, sale_item_id
    having count(*) > 1
  ) t;

  if v_dups > 0 then
    raise exception
      'sales_return_items tiene % pares (return_id, sale_item_id) duplicados; deduplicar antes de crear el índice único',
      v_dups;
  end if;
end $$;

create unique index if not exists sales_return_items_return_sale_item_unique
  on public.sales_return_items (return_id, sale_item_id)
  where sale_item_id is not null;

-- 2) Índices de camino caliente. Varias consultas del cliente y de los RPC
--    filtran por company_id/warehouse_id/padres de línea sin índice declarado en
--    el repo (la línea base no está versionada). Cada uno se crea solo si no hay
--    ya un índice que cubra esas columnas, para no duplicar los de producción.
do $$
declare
  v_specs constant text[][] := array[
    array['sale_items',        'sale_id',                          'sale_items_sale_id_idx'],
    array['payments',          'sale_id',                          'payments_sale_id_idx'],
    array['sales_return_items','return_id',                        'sales_return_items_return_id_idx'],
    array['transfer_items',    'transfer_id',                      'transfer_items_transfer_id_idx'],
    array['cash_movements',    'cash_session_id',                  'cash_movements_session_idx'],
    array['stock_movements',   'company_id, occurred_at',          'stock_movements_company_occurred_idx'],
    array['sales',             'company_id, created_at',           'sales_company_created_idx']
  ];
  v_table text;
  v_cols  text;
  v_name  text;
  v_col0  text;
  v_col1  text;
begin
  for i in 1 .. array_length(v_specs, 1) loop
    v_table := v_specs[i][1];
    v_cols  := v_specs[i][2];
    v_name  := v_specs[i][3];
    v_col0  := split_part(v_cols, ',', 1);
    v_col1  := nullif(trim(split_part(v_cols, ',', 2)), '');

    if not exists (
      select 1
      from pg_indexes
      where schemaname = 'public'
        and tablename = v_table
        and indexdef ilike '%(' || v_col0 || '%'
        and (v_col1 is null or indexdef ilike '%' || v_col1 || '%')
    ) then
      execute format('create index if not exists %I on public.%I (%s)',
                     v_name, v_table, v_cols);
    end if;
  end loop;
end $$;

commit;
