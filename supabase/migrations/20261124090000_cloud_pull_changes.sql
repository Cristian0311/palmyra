-- PENDIENTE DE APLICAR — no ejecutar sin autorización.
--
-- Descarga incremental de la nube hacia el dispositivo.
--
-- Complementa `ingest_local_changes` (subida por cursor de journal). Aquí el
-- cliente pide la ventana de cambios posterior a su cursor de tiempo y la nube
-- responde con filas ya materializadas, listas para el aplicador LWW local:
--
--   { changes: [{table, row_id, op, row, updated_at}], nextCursor, hasMore }
--
-- Reglas:
--  - SECURITY DEFINER con `search_path` fijo; valida sesión y acceso a la
--    empresa con `private.has_company_access` (mismo patrón que el resto de RPC).
--  - Solo tablas de negocio cuyo destino local está declarado en
--    src/services/cloudSync/materializeMapping.ts. La lista de candidatas es
--    cerrada y, además, se comprueba en `information_schema` que la tabla exista
--    y tenga `id`, `company_id` y `updated_at`: una tabla que no cumpla la forma
--    simplemente no participa (nada de SQL adivinado).
--  - `p_limit` se acota a 1..1000 y `p_since` nunca se remonta más de 7 días:
--    no se reconstruye historial completo en segundo plano.
--  - `op` es 'delete' solo cuando la fila trae `deleted_at`; las tablas con
--    desactivación lógica (`active = false`, `status = 'archived'`) viajan como
--    upsert para que el dispositivo aplique su propia regla.
--  - `nextCursor` es la marca del último cambio devuelto (o el inicio de la
--    ventana si no hubo filas): avanzar siempre es seguro porque la ventana se
--    pidió con `>` estricto.
--  - Nadie concede acceso directo a las tablas por esta vía: solo lectura de la
--    empresa propia y solo a través de la función. Como el resto de RPC
--    `security definer`, debe quedar propiedad del rol administrador de las
--    tablas (postgres) para leer sin RLS con la empresa ya validada.
begin;

create or replace function public.pull_cloud_changes(
  p_company_id uuid,
  p_since timestamptz,
  p_limit int
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_horizon timestamptz := now() - interval '7 days';
  v_since timestamptz;
  v_candidates text[] := array[
    'warehouses',
    'products',
    'product_variants',
    'sales',
    'sale_items',
    'payments',
    'cash_sessions',
    'cash_movements',
    'stock_movements',
    'customers',
    'suppliers',
    'purchase_orders',
    'purchase_items',
    'transfers',
    'transfer_items',
    'sales_returns',
    'sales_return_items',
    'quotes',
    'quote_items',
    'bank_accounts',
    'bank_transactions',
    'inventory_audits',
    'inventory_audit_items',
    'company_settings'
  ];
  v_tables text[];
  v_union text;
  v_rows jsonb;
  v_changes jsonb;
  v_next timestamptz;
  v_has_more boolean;
begin
  if v_auth is null then
    raise exception 'authentication_required';
  end if;

  if p_company_id is null or not private.has_company_access(p_company_id) then
    raise exception 'company_access_denied';
  end if;

  -- Ventana: nunca antes del horizonte permitido, nunca nula.
  v_since := greatest(coalesce(p_since, v_horizon), v_horizon);

  -- Solo tablas con la forma mínima del contrato local.
  select coalesce(array_agg(c.table_name order by c.table_name), '{}'::text[])
    into v_tables
  from unnest(v_candidates) as c(table_name)
  where exists (
          select 1 from information_schema.columns col
          where col.table_schema = 'public'
            and col.table_name = c.table_name
            and col.column_name = 'id'
        )
    and exists (
          select 1 from information_schema.columns col
          where col.table_schema = 'public'
            and col.table_name = c.table_name
            and col.column_name = 'company_id'
        )
    and exists (
          select 1 from information_schema.columns col
          where col.table_schema = 'public'
            and col.table_name = c.table_name
            and col.column_name = 'updated_at'
        );

  if cardinality(v_tables) = 0 then
    return jsonb_build_object(
      'changes', '[]'::jsonb,
      'nextCursor', to_char(v_since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'hasMore', false
    );
  end if;

  -- Unión de la ventana de cada tabla; nombres de tabla entre comillas dobles.
  select string_agg(
           format(
             'select %L::text as table_name, t.id::text as row_id, t.updated_at, to_jsonb(t) as row
                from public.%I t
               where t.company_id = $1 and t.updated_at > $2',
             tbl.table_name,
             tbl.table_name
           ),
           ' union all ' order by tbl.table_name
         )
    into v_union
  from unnest(v_tables) as tbl(table_name);

  -- Se pide un elemento de más para saber si quedan páginas.
  execute format(
    'select coalesce(jsonb_agg(x order by x.updated_at, x.table_name, x.row_id), ''[]''::jsonb)
       from (
         select u.*
           from (%s) u
          order by u.updated_at asc, u.table_name asc, u.row_id asc
          limit $3
       ) x',
    v_union
  )
  into v_rows
  using p_company_id, v_since, v_limit + 1;

  v_has_more := jsonb_array_length(v_rows) > v_limit;
  if v_has_more then
    select coalesce(jsonb_agg(e.item order by e.ord), '[]'::jsonb)
      into v_rows
    from jsonb_array_elements(v_rows) with ordinality as e(item, ord)
    where e.ord <= v_limit;
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'table', e.item ->> 'table_name',
               'row_id', e.item ->> 'row_id',
               'op',
                 case
                   when nullif(btrim(coalesce(e.item -> 'row' ->> 'deleted_at', '')), '') is null
                     then 'upsert'
                   else 'delete'
                 end,
               'row', e.item -> 'row',
               'updated_at', e.item ->> 'updated_at'
             )
             order by e.ord
           ),
           '[]'::jsonb
         )
    into v_changes
  from jsonb_array_elements(v_rows) with ordinality as e(item, ord);

  select max((e.item ->> 'updated_at')::timestamptz)
    into v_next
  from jsonb_array_elements(v_rows) as e(item);

  v_next := coalesce(v_next, v_since);

  return jsonb_build_object(
    'changes', v_changes,
    'nextCursor', to_char(v_next at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'hasMore', v_has_more
  );
end;
$function$;

revoke all on function public.pull_cloud_changes(uuid, timestamptz, int) from public, anon;

grant execute on function public.pull_cloud_changes(uuid, timestamptz, int) to authenticated;

commit;
