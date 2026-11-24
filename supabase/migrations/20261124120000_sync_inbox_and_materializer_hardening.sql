-- Endurecimiento del motor de sincronización nube <-> dispositivo.
--
-- Corrige, sobre lo ya aplicado por Management API (20261123090000,
-- 20261123150000, 20261123180000 y 20261124090000):
--   1. `local_change_inbox` pasa a clave (company_id, origin_device, seq): el
--      `seq` es por dispositivo, así que dos equipos con el mismo cursor se
--      pisaban. `ingest_local_changes` lee `origin_device` del sobre.
--   2. `updated_at` en todas las tablas que participan del pull. Producción
--      confirmó que `public.sales` no la tiene y el upsert del materializador
--      fallaba con «column updated_at of relation sales does not exist».
--      Se reutiliza el trigger existente `public.set_updated_at()`.
--   3. `palmyra_void_sale` y `palmyra_set_sale_report_hidden` marcan
--      `updated_at`: sin eso, anulaciones y ocultamientos nunca viajaban por
--      pull (la ventana se pide por `updated_at`).
--   4. Permisos por tabla en la subida (`ingest_local_changes` lanza
--      `permission_denied:<tabla>`) y en la bajada (`pull_cloud_changes` filtra
--      la tabla). Las tablas no sensibles siguen igual.
--   5. `private.cloud_backup_member` exige empresa activa y no suspendida.
--   6. El materializador actualiza el estado de la bandeja por
--      (company_id, origin_device, seq), no solo por (company_id, seq).
--
-- Idempotente y reejecutable: aditiva salvo el relleno de `origin_device` y la
-- nueva columna `updated_at`. No borra filas de negocio.
begin;

-- ---------------------------------------------------------------------------
-- 1. Clave por dispositivo en la bandeja.
--    Orden obligatorio: columna -> datos -> PK -> funciones.
-- ---------------------------------------------------------------------------
alter table public.local_change_inbox
  add column if not exists origin_device text not null default '';

-- Filas históricas: no hay forma de saber el equipo, se agrupan en 'legacy'.
update public.local_change_inbox
   set origin_device = 'legacy'
 where origin_device is null or btrim(origin_device) = '';

do $origin_check$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'local_change_inbox_origin_device_check'
      and conrelid = 'public.local_change_inbox'::regclass
  ) then
    alter table public.local_change_inbox
      add constraint local_change_inbox_origin_device_check
      check (length(btrim(origin_device)) <= 120);
  end if;
end
$origin_check$;

-- Cambio de PK solo si aún no es la compuesta por dispositivo.
do $inbox_pk$
declare
  v_name text;
  v_cols text[];
begin
  select c.conname, array_agg(a.attname::text order by k.ord)
    into v_name, v_cols
  from pg_constraint c
  cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
  where c.conrelid = 'public.local_change_inbox'::regclass
    and c.contype = 'p'
  group by c.conname;

  if v_cols is distinct from array['company_id', 'origin_device', 'seq'] then
    if v_name is not null then
      execute format('alter table public.local_change_inbox drop constraint %I', v_name);
    end if;
    alter table public.local_change_inbox
      add constraint local_change_inbox_pkey
      primary key (company_id, origin_device, seq);
  end if;
end
$inbox_pk$;

-- ---------------------------------------------------------------------------
-- 2. `updated_at` en las tablas del pull (y del materializador).
--    `pull_cloud_changes` solo incluye tablas con `updated_at`; el
--    materializador la escribe en el upsert de sales/purchase_orders/... y en
--    los tombstones. Añadirla donde falte es la corrección mínima y no cambia
--    el contrato del cliente.
--
--    Al crear la columna, las filas históricas toman el valor de `created_at`
--    (nunca uno posterior a `now()`) para no reenviar todo el histórico en la
--    primera ventana del pull. Solo ocurre la primera vez: si la columna ya
--    existe no se toca ningún dato.
-- ---------------------------------------------------------------------------
do $updated_at$
declare
  v_table text;
  v_rel regclass;
  v_created_type text;
  v_tables text[] := array[
    'warehouses', 'products', 'product_variants', 'sales', 'sale_items',
    'payments', 'cash_sessions', 'cash_movements', 'stock_movements',
    'customers', 'suppliers', 'purchase_orders', 'purchase_items',
    'transfers', 'transfer_items', 'sales_returns', 'sales_return_items',
    'quotes', 'quote_items', 'bank_accounts', 'bank_transactions',
    'inventory_audits', 'inventory_audit_items'
  ];
begin
  foreach v_table in array v_tables loop
    v_rel := to_regclass(format('public.%I', v_table));
    continue when v_rel is null;

    if exists (
      select 1 from information_schema.columns col
      where col.table_schema = 'public'
        and col.table_name = v_table
        and col.column_name = 'updated_at'
    ) then
      continue;
    end if;

    execute format(
      'alter table public.%I add column updated_at timestamptz not null default now()',
      v_table
    );

    select col.data_type into v_created_type
    from information_schema.columns col
    where col.table_schema = 'public'
      and col.table_name = v_table
      and col.column_name = 'created_at';

    -- Solo con fecha real y ordenable: nada de texto legado ni casts dudosos.
    if v_created_type in (
      'timestamp with time zone', 'timestamp without time zone', 'date'
    ) then
      execute format(
        'update public.%I set updated_at = least(coalesce(created_at, now()), now())',
        v_table
      );
    end if;
  end loop;
end
$updated_at$;

-- Trigger de actualización: se reutiliza el patrón del proyecto
-- (`public.set_updated_at()`, ya existente y con EXECUTE revocado). Solo se
-- crea si el esquema no lo tuviera, para no reemplazar su cuerpo real.
do $touch_fn$
begin
  if to_regprocedure('public.set_updated_at()') is null then
    execute 'create function public.set_updated_at() returns trigger language plpgsql as $fn$ begin new.updated_at := timezone(''utc'', now()); return new; end $fn$';
    execute 'revoke execute on function public.set_updated_at() from public';
  end if;
end
$touch_fn$;

-- Un trigger por tabla, solo si no existe ya uno que use set_updated_at().
do $touch_triggers$
declare
  v_table text;
  v_rel regclass;
  v_tables text[] := array[
    'warehouses', 'products', 'product_variants', 'sales', 'sale_items',
    'payments', 'cash_sessions', 'cash_movements', 'stock_movements',
    'customers', 'suppliers', 'purchase_orders', 'purchase_items',
    'transfers', 'transfer_items', 'sales_returns', 'sales_return_items',
    'quotes', 'quote_items', 'bank_accounts', 'bank_transactions',
    'inventory_audits', 'inventory_audit_items'
  ];
begin
  foreach v_table in array v_tables loop
    v_rel := to_regclass(format('public.%I', v_table));
    continue when v_rel is null;
    if not exists (
      select 1
      from pg_trigger tg
      join pg_proc pr on pr.oid = tg.tgfoid
      where tg.tgrelid = v_rel
        and not tg.tgisinternal
        and pr.proname = 'set_updated_at'
    ) then
      execute format(
        'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
        v_table || '_set_updated_at', v_table
      );
    end if;
  end loop;
end
$touch_triggers$;

-- ---------------------------------------------------------------------------
-- 3. Permiso exigido por tabla sincronizada.
--    `null` = tabla no sensible (sigue subiendo/bajando sin permiso extra).
--    El materializador corre como service_role (sin auth.uid()), así que la
--    comprobación se hace en la subida y en la bajada, que sí son del usuario.
-- ---------------------------------------------------------------------------
create or replace function private.sync_table_permissions(p_table text)
returns text[]
language sql
immutable
as $fn$
  select case lower(btrim(coalesce(p_table, '')))
           when 'banks' then array['settings.manage']
           when 'bank_movements' then array['settings.manage']
           when 'bank_accounts' then array['settings.manage']
           when 'bank_transactions' then array['settings.manage']
           when 'suppliers' then array['suppliers.manage']
           when 'purchases' then array['suppliers.manage']
           when 'purchase_items' then array['suppliers.manage']
           when 'purchase_orders' then array['suppliers.manage']
           when 'sales' then array['pos.access']
           when 'sale_items' then array['pos.access']
           when 'sale_payments' then array['pos.access']
           when 'payments' then array['pos.access']
           when 'returns' then array['pos.access']
           when 'return_items' then array['pos.access']
           when 'sales_returns' then array['pos.access']
           when 'sales_return_items' then array['pos.access']
           when 'cash_sessions' then array['pos.access']
           when 'cash_movements' then array['pos.access']
           -- El catálogo lo necesita cualquier cajero para vender: no se puede
           -- exigir inventory.manage (el rol empleado solo tiene pos.access).
           when 'products' then array['pos.access']
           when 'product_variants' then array['pos.access']
           else null
         end;
$fn$;

comment on function private.sync_table_permissions(text) is
  'Permiso requerido para sincronizar una tabla local; NULL si no es sensible.';

revoke all on function private.sync_table_permissions(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Subida: `origin_device` + permiso por tabla.
-- ---------------------------------------------------------------------------
create or replace function public.ingest_local_changes(
  p_company_id uuid,
  p_cursor bigint,
  p_changes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_cursor bigint := least(greatest(coalesce(p_cursor, 0), 0), 1000000000000);
  v_table text;
  v_required text[];
  v_permission text;
  v_allowed boolean;
begin
  if v_auth is null then
    raise exception 'authentication_required';
  end if;

  if p_company_id is null or not private.has_company_access(p_company_id) then
    raise exception 'company_access_denied';
  end if;

  -- Gate de plan: sin plan vigente no se aceptan escrituras en la nube.
  perform public.assert_company_plan_active(p_company_id);

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'invalid_changes';
  end if;

  -- Tope de lote: el cliente empuja de 200 en 200; 1 000 deja margen.
  if jsonb_array_length(p_changes) > 1000 then
    raise exception 'changes_batch_too_large';
  end if;

  -- Permiso por tabla: solo las familias sensibles lo exigen; el resto de
  -- tablas no se ve afectado y sigue subiendo igual.
  for v_table in
    select distinct btrim(item ->> 'table')
    from jsonb_array_elements(p_changes) as item
    where nullif(btrim(coalesce(item ->> 'table', '')), '') is not null
  loop
    v_required := private.sync_table_permissions(v_table);
    if v_required is not null then
      v_allowed := false;
      foreach v_permission in array v_required loop
        if private.has_permission(p_company_id, v_permission) then
          v_allowed := true;
          exit;
        end if;
      end loop;
      if not v_allowed then
        raise exception 'permission_denied:%', v_table
          using hint = 'El rol no puede sincronizar esta tabla';
      end if;
    end if;
  end loop;

  insert into public.local_change_inbox (
    company_id, origin_device, seq, table_name, row_id, op, payload
  )
  select
    p_company_id,
    left(coalesce(nullif(btrim(item ->> 'origin_device'), ''), 'legacy'), 120),
    (item ->> 'seq')::bigint,
    btrim(item ->> 'table'),
    btrim(item ->> 'row_id'),
    item ->> 'op',
    item
  from jsonb_array_elements(p_changes) as item
  where (item ->> 'seq') ~ '^[0-9]{1,18}$'
    and (item ->> 'seq')::bigint <= v_cursor
    and nullif(btrim(coalesce(item ->> 'table', '')), '') is not null
    and nullif(btrim(coalesce(item ->> 'row_id', '')), '') is not null
    and (item ->> 'op') in ('upsert', 'delete')
  on conflict (company_id, origin_device, seq) do nothing;

  return jsonb_build_object('acceptedThrough', v_cursor);
end;
$function$;

revoke all on function public.ingest_local_changes(uuid, bigint, jsonb) from public, anon;
grant execute on function public.ingest_local_changes(uuid, bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Bajada: se filtran las tablas para las que el usuario no tiene permiso
--    (una tabla restringida deja de viajar; las no sensibles no cambian).
-- ---------------------------------------------------------------------------
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

  -- Solo tablas con la forma mínima del contrato local y con permiso del
  -- usuario para la familia a la que pertenecen.
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
        )
    and (
          private.sync_table_permissions(c.table_name) is null
          or exists (
            select 1
            from unnest(private.sync_table_permissions(c.table_name)) as k(perm_key)
            where private.has_permission(p_company_id, k.perm_key)
          )
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

-- ---------------------------------------------------------------------------
-- 6. Materializador: el estado de la bandeja se actualiza por
--    (company_id, origin_device, seq). Cuerpo copiado de
--    20261123150000_local_change_materializer.sql con ese único cambio; esta
--    definición la sustituye.
-- ---------------------------------------------------------------------------
create or replace function public.materialize_local_change_inbox(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_change record;
  v_row jsonb;
  v_cloud text;
  v_id text;
  v_mapped jsonb;
  v_company uuid;
  v_op text;
  v_status text;
  v_state text;
  v_message text;
  v_error text;
  v_attempts integer;
  v_processed integer := 0;
  v_failed integer := 0;
  v_skipped integer := 0;
  v_remaining integer := 0;
  v_warehouse text;
  v_register text;
  v_parent text;
begin
  for v_change in
    select company_id, origin_device, seq, table_name, row_id, op, payload, attempts
    from public.local_change_inbox
    where status = 'pending'
    order by received_at, company_id, seq
    limit v_limit
    for update skip locked
  loop
    v_company := v_change.company_id;
    v_op := v_change.op;
    v_attempts := coalesce(v_change.attempts, 0);
    v_status := 'processed';
    v_error := null;
    v_row := case
               when jsonb_typeof(v_change.payload -> 'row') = 'object' then v_change.payload -> 'row'
               else '{}'::jsonb
             end;

    begin
      -- Tabla destino explícita; `null` = sin destino de negocio.
      v_cloud := case v_change.table_name
        when 'warehouses' then 'warehouses'
        when 'products' then 'products'
        when 'product_variants' then 'product_variants'
        when 'sales' then 'sales'
        when 'sale_items' then 'sale_items'
        when 'sale_payments' then 'payments'
        when 'cash_sessions' then 'cash_sessions'
        when 'cash_movements' then 'cash_movements'
        when 'stock_movements' then 'stock_movements'
        when 'customers' then 'customers'
        when 'suppliers' then 'suppliers'
        when 'purchases' then 'purchase_orders'
        when 'purchase_items' then 'purchase_items'
        when 'transfers' then 'transfers'
        when 'transfer_items' then 'transfer_items'
        when 'returns' then 'sales_returns'
        when 'return_items' then 'sales_return_items'
        when 'quotes' then 'quotes'
        when 'quote_items' then 'quote_items'
        when 'banks' then 'bank_accounts'
        when 'bank_movements' then 'bank_transactions'
        when 'inventory_audits' then 'inventory_audits'
        when 'inventory_audit_items' then 'inventory_audit_items'
        else null
      end;

      if v_cloud is null then
        v_status := 'skipped';
        v_error := case v_change.table_name
          when 'companies' then 'company_master_managed_by_onboarding'
          when 'company_settings' then 'settings_json_merge_required'
          when 'product_codes' then 'natural_key_table:product_barcodes'
          when 'product_prices' then 'natural_key_table:product_prices'
          when 'stock_balances' then 'aggregate_keyed_by_warehouse_product_variant'
          when 'ncf_sequences' then 'fiscal_sequences_are_server_managed'
          when 'outbox' then 'device_local_queue'
          when 'hub_devices' then 'device_local_pairing'
          when 'hub_receipts' then 'device_local_idempotency'
          else 'unknown_local_table: no existe en el esquema local v1'
        end;
      else
        -- El id local se conserva o se deriva de forma estable según la columna.
        v_id := private.materialize_id_text(v_company, v_cloud, v_change.row_id);
        if v_id is null then
          raise exception 'invalid_row_id';
        end if;

        -- Una fila con deleted_at también es un tombstone aunque llegue como upsert.
        if v_op = 'delete' or nullif(v_row ->> 'deleted_at', '') is not null then
          if v_cloud = 'sales' then
            -- `sales.updated_at` sí está evidenciado (update de
            -- 20261003023000_saas_runtime_core.sql), pero `deleted_at` no
            -- aparece en ninguna migración: se comprueba antes y se degrada a
            -- status='voided' si no existe.
            if exists (
              select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'sales' and column_name = 'deleted_at'
            ) then
              update public.sales
                 set deleted_at = coalesce(deleted_at, timezone('utc', now())),
                     status = 'voided',
                     updated_at = timezone('utc', now())
               where id::text = v_id and company_id = v_company;
            else
              update public.sales
                 set status = 'voided',
                     updated_at = timezone('utc', now())
               where id::text = v_id and company_id = v_company;
            end if;
          elsif v_cloud = 'cash_sessions' then
            update public.cash_sessions
               set deleted_at = coalesce(deleted_at, timezone('utc', now())),
                   status = 'voided'
             where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'warehouses' then
            update public.warehouses set active = false
             where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'products' then
            update public.products set status = 'archived'
             where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'product_variants' then
            update public.product_variants set active = false
             where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'customers' then
            update public.customers set active = false
             where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'suppliers' then
            update public.suppliers set active = false
             where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'bank_accounts' then
            update public.bank_accounts set active = false, updated_at = timezone('utc', now())
             where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'purchase_orders' then
            update public.purchase_orders set status = 'cancelled', updated_at = timezone('utc', now())
             where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'transfers' then
            update public.transfers set status = 'cancelled'
             where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'payments' then
            delete from public.payments where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'cash_movements' then
            delete from public.cash_movements where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'stock_movements' then
            delete from public.stock_movements where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'sales_returns' then
            delete from public.sales_returns where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'quotes' then
            delete from public.quotes where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'bank_transactions' then
            delete from public.bank_transactions where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'inventory_audits' then
            delete from public.inventory_audits where id::text = v_id and company_id = v_company;
          elsif v_cloud = 'sale_items' then
            delete from public.sale_items si
             using public.sales s
             where si.id::text = v_id and si.sale_id = s.id and s.company_id = v_company;
          elsif v_cloud = 'purchase_items' then
            delete from public.purchase_items pi
             using public.purchase_orders po
             where pi.id::text = v_id and pi.purchase_order_id = po.id and po.company_id = v_company;
          elsif v_cloud = 'transfer_items' then
            delete from public.transfer_items ti
             using public.transfers t
             where ti.id::text = v_id and ti.transfer_id = t.id and t.company_id = v_company;
          elsif v_cloud = 'sales_return_items' then
            delete from public.sales_return_items sri
             using public.sales_returns sr
             where sri.id::text = v_id and sri.return_id = sr.id and sr.company_id = v_company;
          elsif v_cloud = 'quote_items' then
            delete from public.quote_items qi
             using public.quotes q
             where qi.id::text = v_id and qi.quote_id = q.id and q.company_id = v_company;
          elsif v_cloud = 'inventory_audit_items' then
            delete from public.inventory_audit_items iai
             using public.inventory_audits ia
             where iai.id::text = v_id and iai.audit_id = ia.id and ia.company_id = v_company;
          end if;

        elsif v_cloud = 'warehouses' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'code', coalesce(
              private.materialize_text(v_row, 'code'),
              'ALM-' || upper(left(replace(v_id, '-', ''), 8))
            ),
            'name', coalesce(private.materialize_text(v_row, 'name'), 'Sucursal'),
            'active', coalesce(private.materialize_bool(v_row, 'active', 'is_active'), true),
            'created_at', coalesce(private.materialize_ts(v_row, 'created_at', 'date'), timezone('utc', now()))
          );
          insert into public.warehouses (id, company_id, code, name, active, created_at)
          select r.id, r.company_id, r.code, r.name, coalesce(r.active, true),
                 coalesce(r.created_at, timezone('utc', now()))
          from jsonb_populate_record(null::public.warehouses, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            code = excluded.code,
            name = excluded.name,
            active = excluded.active;

        elsif v_cloud = 'products' then
          -- No se escribe `price`: el precio canónico vive en
          -- public.product_prices (company_id, product_id, currency_code,
          -- price, valid_from) y solo se modifica con set_product_price.
          -- products no recibe esa columna en ninguna migración ni RPC de este
          -- repositorio, así que escribirla aquí rompería la función entera.
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'sku', coalesce(private.materialize_text(v_row, 'sku'), upper(left(replace(v_id, '-', ''), 12))),
            'name', coalesce(private.materialize_text(v_row, 'name'), 'Producto'),
            'description', private.materialize_text(v_row, 'description'),
            'category_id', private.materialize_optional_uuid(v_row, 'category_id'),
            'brand_id', private.materialize_optional_uuid(v_row, 'brand_id'),
            'base_unit', coalesce(private.materialize_text(v_row, 'base_unit', 'unit'), 'unit'),
            'cost', coalesce(private.materialize_number(v_row, 'cost', 'cost_price'), 0),
            'commission_fixed', coalesce(private.materialize_number(v_row, 'commission_fixed'), 0),
            'commission_percent', coalesce(private.materialize_number(v_row, 'commission_percent'), 0),
            'minimum_stock', coalesce(private.materialize_number(v_row, 'minimum_stock', 'min_stock_alert'), 0),
            'track_stock', coalesce(private.materialize_bool(v_row, 'track_stock'), true),
            'track_serial', coalesce(private.materialize_bool(v_row, 'track_serial', 'has_serial'), false),
            'is_kit', coalesce(private.materialize_bool(v_row, 'is_kit'), false),
            'status', case lower(coalesce(private.materialize_text(v_row, 'status'), 'active'))
                        when 'archived' then 'archived'
                        when 'inactive' then 'archived'
                        when 'inactivo' then 'archived'
                        else 'active'
                      end,
            'image_path', private.materialize_text(v_row, 'image_path', 'image'),
            'created_at', coalesce(private.materialize_ts(v_row, 'created_at', 'date'), timezone('utc', now()))
          );
          insert into public.products (
            id, company_id, sku, name, description, category_id, brand_id, base_unit,
            cost, commission_fixed, commission_percent, minimum_stock,
            track_stock, track_serial, is_kit, status, image_path, created_at
          )
          select r.id, r.company_id, r.sku, r.name, r.description, r.category_id, r.brand_id,
                 r.base_unit, r.cost, r.commission_fixed, r.commission_percent,
                 r.minimum_stock, r.track_stock, r.track_serial, r.is_kit, r.status,
                 r.image_path, r.created_at
          from jsonb_populate_record(null::public.products, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            sku = excluded.sku,
            name = excluded.name,
            description = excluded.description,
            category_id = excluded.category_id,
            brand_id = excluded.brand_id,
            base_unit = excluded.base_unit,
            cost = excluded.cost,
            commission_fixed = excluded.commission_fixed,
            commission_percent = excluded.commission_percent,
            minimum_stock = excluded.minimum_stock,
            track_stock = excluded.track_stock,
            track_serial = excluded.track_serial,
            is_kit = excluded.is_kit,
            status = excluded.status,
            image_path = excluded.image_path;

        elsif v_cloud = 'product_variants' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'product_id', private.materialize_id_text(
              v_company, 'products', private.materialize_text(v_row, 'product_id')
            ),
            'name', coalesce(private.materialize_text(v_row, 'name'), 'Variante'),
            'attributes', coalesce(private.materialize_json(v_row, 'attributes'), '{}'::jsonb),
            'active', coalesce(private.materialize_bool(v_row, 'active', 'is_active'), true)
          );
          if v_mapped ->> 'product_id' is null then
            raise exception 'parent_not_materialized:products';
          end if;
          insert into public.product_variants (id, company_id, product_id, name, attributes, active)
          select r.id, r.company_id, r.product_id, r.name, r.attributes, coalesce(r.active, true)
          from jsonb_populate_record(null::public.product_variants, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            product_id = excluded.product_id,
            name = excluded.name,
            attributes = excluded.attributes,
            active = excluded.active;

        elsif v_cloud = 'sales' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'warehouse_id', private.materialize_id_text(
              v_company, 'warehouses', private.materialize_text(v_row, 'warehouse_id', 'branch_id')
            ),
            'cash_session_id', private.materialize_id_text(
              v_company, 'cash_sessions', private.materialize_text(v_row, 'cash_session_id', 'session_id')
            ),
            'employee_id', private.materialize_optional_uuid(v_row, 'employee_id'),
            'seller_user_id', private.materialize_optional_uuid(v_row, 'seller_user_id', 'user_id'),
            'customer_id', private.materialize_id_text(
              v_company, 'customers', private.materialize_text(v_row, 'customer_id')
            ),
            'status', case lower(coalesce(private.materialize_text(v_row, 'status'), 'completed'))
                        when 'voided' then 'voided'
                        when 'refunded' then 'refunded'
                        when 'pending' then 'pending'
                        else 'completed'
                      end,
            'total', coalesce(private.materialize_number(v_row, 'total', 'total_amount'), 0),
            'currency_code', upper(coalesce(private.materialize_text(v_row, 'currency_code', 'currency'), 'USD')),
            'client_name', private.materialize_text(v_row, 'client_name'),
            'notes', private.materialize_text(v_row, 'notes'),
            'source_operation_id', private.materialize_optional_uuid(v_row, 'source_operation_id'),
            'metadata', coalesce(private.materialize_json(v_row, 'metadata'), '{}'::jsonb),
            'created_at', coalesce(private.materialize_ts(v_row, 'created_at', 'date'), timezone('utc', now())),
            'updated_at', coalesce(private.materialize_ts(v_row, 'updated_at'), timezone('utc', now()))
          );
          if v_mapped ->> 'warehouse_id' is null then
            raise exception 'parent_not_materialized:warehouses';
          end if;
          insert into public.sales (
            id, company_id, warehouse_id, cash_session_id, employee_id, seller_user_id,
            customer_id, status, total, currency_code, client_name, notes,
            source_operation_id, metadata, created_at, updated_at
          )
          select r.id, r.company_id, r.warehouse_id, r.cash_session_id, r.employee_id,
                 r.seller_user_id, r.customer_id, r.status, r.total, r.currency_code,
                 r.client_name, r.notes, r.source_operation_id, r.metadata, r.created_at,
                 r.updated_at
          from jsonb_populate_record(null::public.sales, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            warehouse_id = excluded.warehouse_id,
            cash_session_id = excluded.cash_session_id,
            employee_id = excluded.employee_id,
            seller_user_id = excluded.seller_user_id,
            customer_id = excluded.customer_id,
            status = excluded.status,
            total = excluded.total,
            currency_code = excluded.currency_code,
            client_name = excluded.client_name,
            notes = excluded.notes,
            source_operation_id = excluded.source_operation_id,
            metadata = excluded.metadata,
            updated_at = timezone('utc', now());

        elsif v_cloud = 'sale_items' then
          v_parent := private.materialize_id_text(
            v_company, 'sales', private.materialize_text(v_row, 'sale_id')
          );
          if v_parent is null or not exists (
            select 1 from public.sales where id::text = v_parent and company_id = v_company
          ) then
            raise exception 'parent_not_materialized:sales';
          end if;
          v_mapped := jsonb_build_object(
            'id', v_id,
            'sale_id', v_parent,
            'product_id', private.materialize_id_text(
              v_company, 'products', private.materialize_text(v_row, 'product_id')
            ),
            'variant_id', private.materialize_id_text(
              v_company, 'product_variants', private.materialize_text(v_row, 'variant_id')
            ),
            'quantity', coalesce(private.materialize_number(v_row, 'quantity'), 0),
            'unit_price', coalesce(private.materialize_number(v_row, 'unit_price', 'price'), 0),
            'discount', coalesce(private.materialize_number(v_row, 'discount'), 0),
            'tax', coalesce(private.materialize_number(v_row, 'tax'), 0),
            'line_total', coalesce(
              private.materialize_number(v_row, 'line_total', 'total'),
              coalesce(private.materialize_number(v_row, 'quantity'), 0)
                * coalesce(private.materialize_number(v_row, 'unit_price', 'price'), 0)
            ),
            'serial_number', private.materialize_text(v_row, 'serial_number')
          );
          if v_mapped ->> 'product_id' is null then
            raise exception 'parent_not_materialized:products';
          end if;
          insert into public.sale_items (
            id, sale_id, product_id, variant_id, quantity, unit_price, discount, tax,
            line_total, serial_number
          )
          select r.id, r.sale_id, r.product_id, r.variant_id, r.quantity, r.unit_price,
                 r.discount, r.tax, r.line_total, r.serial_number
          from jsonb_populate_record(null::public.sale_items, v_mapped) as r
          on conflict (id) do update set
            sale_id = excluded.sale_id,
            product_id = excluded.product_id,
            variant_id = excluded.variant_id,
            quantity = excluded.quantity,
            unit_price = excluded.unit_price,
            discount = excluded.discount,
            tax = excluded.tax,
            line_total = excluded.line_total,
            serial_number = excluded.serial_number;

        elsif v_cloud = 'payments' then
          v_parent := private.materialize_id_text(
            v_company, 'sales', private.materialize_text(v_row, 'sale_id')
          );
          if v_parent is null or not exists (
            select 1 from public.sales where id::text = v_parent and company_id = v_company
          ) then
            raise exception 'parent_not_materialized:sales';
          end if;
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'sale_id', v_parent,
            'method', case lower(coalesce(private.materialize_text(v_row, 'method'), 'cash'))
                        when 'transfer' then 'bank_transfer'
                        when 'bank_transfer' then 'bank_transfer'
                        when 'card' then 'card'
                        when 'other' then 'other'
                        else 'cash'
                      end,
            'currency_code', upper(coalesce(private.materialize_text(v_row, 'currency_code', 'currency'), 'USD')),
            'amount', coalesce(private.materialize_number(v_row, 'amount'), 0),
            'exchange_rate', coalesce(private.materialize_number(v_row, 'exchange_rate'), 1),
            'reference', private.materialize_text(v_row, 'reference'),
            'created_by', private.materialize_optional_uuid(v_row, 'created_by')
          );
          insert into public.payments (
            id, company_id, sale_id, method, currency_code, amount, exchange_rate,
            reference, created_by
          )
          select r.id, r.company_id, r.sale_id, r.method, r.currency_code, r.amount,
                 r.exchange_rate, r.reference, r.created_by
          from jsonb_populate_record(null::public.payments, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            sale_id = excluded.sale_id,
            method = excluded.method,
            currency_code = excluded.currency_code,
            amount = excluded.amount,
            exchange_rate = excluded.exchange_rate,
            reference = excluded.reference,
            created_by = excluded.created_by;

        elsif v_cloud = 'cash_sessions' then
          v_register := private.materialize_id_text(
            v_company, 'cash_registers', private.materialize_text(v_row, 'cash_register_id')
          );
          v_warehouse := private.materialize_id_text(
            v_company, 'warehouses', private.materialize_text(v_row, 'warehouse_id', 'branch_id')
          );
          if v_register is null and v_warehouse is not null then
            select cr.id::text into v_register
            from public.cash_registers cr
            where cr.company_id = v_company and cr.warehouse_id::text = v_warehouse and cr.active
            order by cr.id
            limit 1;
            if v_register is null and exists (
              select 1 from public.warehouses w
              where w.id::text = v_warehouse and w.company_id = v_company
            ) then
              insert into public.cash_registers (id, company_id, warehouse_id, code, name, active)
              select r.id, r.company_id, r.warehouse_id, r.code, r.name, r.active
              from jsonb_populate_record(null::public.cash_registers, jsonb_build_object(
                'id', gen_random_uuid()::text,
                'company_id', v_company,
                'warehouse_id', v_warehouse,
                'code', 'CAJA-' || upper(left(replace(v_warehouse, '-', ''), 8)),
                'name', 'Caja principal',
                'active', true
              )) as r
              returning id::text into v_register;
            end if;
          end if;
          if v_register is null then
            raise exception 'cash_register_required';
          end if;
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'cash_register_id', v_register,
            'employee_id', private.materialize_optional_uuid(v_row, 'employee_id'),
            'opened_by', private.materialize_optional_uuid(v_row, 'opened_by'),
            'closed_by', private.materialize_optional_uuid(v_row, 'closed_by'),
            'status', case lower(coalesce(private.materialize_text(v_row, 'status'), 'open'))
                        when 'closed' then 'closed'
                        when 'voided' then 'voided'
                        else 'open'
                      end,
            'opened_at', coalesce(private.materialize_ts(v_row, 'opened_at', 'date'), timezone('utc', now())),
            'closed_at', private.materialize_ts(v_row, 'closed_at'),
            'opening_amount', coalesce(private.materialize_number(v_row, 'opening_amount', 'opening_balance'), 0),
            'expected_cash', coalesce(private.materialize_number(v_row, 'expected_cash', 'expected_balance'), 0),
            'physical_cash', private.materialize_number(v_row, 'physical_cash'),
            'difference', coalesce(private.materialize_number(v_row, 'difference'), 0),
            -- turn_number se deja en NULL a propósito: el índice único
            -- cash_sessions_turn_number_key es GLOBAL (no por empresa) y el
            -- trigger assign_cash_session_turn_number asigna el siguiente
            -- número. Calcular max+1 por empresa provocaba colisión entre
            -- empresas en el mismo turno. En el upsert no se sobrescribe.
            'metadata', coalesce(private.materialize_json(v_row, 'metadata'), '{}'::jsonb)
          );
          insert into public.cash_sessions (
            id, company_id, cash_register_id, employee_id, opened_by, closed_by, status,
            opened_at, closed_at, opening_amount, expected_cash, physical_cash,
            difference, turn_number, metadata
          )
          select r.id, r.company_id, r.cash_register_id, r.employee_id, r.opened_by,
                 r.closed_by, r.status, r.opened_at, r.closed_at, r.opening_amount,
                 r.expected_cash, r.physical_cash, r.difference, r.turn_number, r.metadata
          from jsonb_populate_record(null::public.cash_sessions, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            cash_register_id = excluded.cash_register_id,
            employee_id = excluded.employee_id,
            opened_by = excluded.opened_by,
            closed_by = excluded.closed_by,
            status = excluded.status,
            opened_at = excluded.opened_at,
            closed_at = excluded.closed_at,
            opening_amount = excluded.opening_amount,
            expected_cash = excluded.expected_cash,
            physical_cash = excluded.physical_cash,
            difference = excluded.difference,
            metadata = excluded.metadata;

        elsif v_cloud = 'cash_movements' then
          v_parent := private.materialize_id_text(
            v_company, 'cash_sessions', private.materialize_text(v_row, 'cash_session_id', 'session_id')
          );
          if v_parent is null or not exists (
            select 1 from public.cash_sessions where id::text = v_parent and company_id = v_company
          ) then
            raise exception 'parent_not_materialized:cash_sessions';
          end if;
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'cash_session_id', v_parent,
            'movement_type', case lower(coalesce(private.materialize_text(v_row, 'movement_type', 'type'), ''))
                      when 'income' then 'cash_in'
                      when 'ingreso' then 'cash_in'
                      when 'entrada' then 'cash_in'
                      when 'deposit' then 'cash_in'
                      when 'cash_in' then 'cash_in'
                      when 'expense' then 'cash_out'
                      when 'egreso' then 'cash_out'
                      when 'egress' then 'cash_out'
                      when 'withdrawal' then 'cash_out'
                      when 'salida' then 'cash_out'
                      when 'cash_out' then 'cash_out'
                      when 'sale' then 'sale'
                      when 'sale_in' then 'sale'
                      when 'return' then 'return'
                      when 'refund' then 'refund'
                      when 'sale_refund' then 'sale_refund'
                      when 'opening' then 'opening'
                      when 'closing' then 'closing'
                      when 'adjustment' then 'adjustment'
                      else null
                    end,
            'amount', coalesce(private.materialize_number(v_row, 'amount'), 0),
            'currency_code', upper(coalesce(private.materialize_text(v_row, 'currency_code', 'currency'), 'USD')),
            'reference_id', nullif(private.materialize_ref_text(
              v_company, private.materialize_text(v_row, 'reference_type'), private.materialize_text(v_row, 'reference_id')
            ), '')::uuid,
            'note', private.materialize_text(v_row, 'note', 'description'),
            'created_by', private.materialize_optional_uuid(v_row, 'created_by', 'user_id')
          );
          if v_mapped ->> 'movement_type' is null then
            raise exception 'invalid_movement_type';
          end if;
          insert into public.cash_movements (
            id, company_id, cash_session_id, movement_type, amount, currency_code,
            reference_id, note, created_by
          )
          select r.id, r.company_id, r.cash_session_id, r.movement_type, r.amount,
                 r.currency_code, r.reference_id, r.note, r.created_by
          from jsonb_populate_record(null::public.cash_movements, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            cash_session_id = excluded.cash_session_id,
            movement_type = excluded.movement_type,
            amount = excluded.amount,
            currency_code = excluded.currency_code,
            reference_id = excluded.reference_id,
            note = excluded.note,
            created_by = excluded.created_by;

        elsif v_cloud = 'stock_movements' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'warehouse_id', private.materialize_id_text(
              v_company, 'warehouses', private.materialize_text(v_row, 'warehouse_id', 'branch_id')
            ),
            'product_id', private.materialize_id_text(
              v_company, 'products', private.materialize_text(v_row, 'product_id')
            ),
            'variant_id', private.materialize_id_text(
              v_company, 'product_variants', private.materialize_text(v_row, 'variant_id')
            ),
            'movement_type', case upper(coalesce(private.materialize_text(v_row, 'movement_type', 'type'), ''))
                      when 'SALE' then 'sale'
                      when 'SALE_OUT' then 'sale'
                      when 'SALE_RETURN' then 'return'
                      when 'RETURN' then 'return'
                      when 'REFUND' then 'return'
                      when 'SALE_REFUND' then 'sale_refund'
                      when 'PURCHASE' then 'purchase'
                      when 'PURCHASE_IN' then 'purchase'
                      when 'TRANSFER_IN' then 'transfer_in'
                      when 'TRANSFER_OUT' then 'transfer_out'
                      when 'ADJUSTMENT' then 'adjustment'
                      when 'ADJUST' then 'adjustment'
                      when 'ADJUSTMENT_IN' then 'adjustment'
                      when 'ADJUSTMENT_OUT' then 'adjustment'
                      when 'AUDIT' then 'adjustment'
                      when 'INVENTORY_ADJUSTMENT' then 'adjustment'
                      else lower(coalesce(private.materialize_text(v_row, 'movement_type', 'type'), ''))
                    end,
            'quantity', coalesce(private.materialize_number(v_row, 'quantity'), 0),
            'reference_type', private.materialize_text(v_row, 'reference_type'),
            'reference_id', nullif(private.materialize_ref_text(
              v_company, private.materialize_text(v_row, 'reference_type'), private.materialize_text(v_row, 'reference_id')
            ), '')::uuid,
            'created_by', private.materialize_optional_uuid(v_row, 'created_by', 'user_id'),
            'occurred_at', coalesce(
              private.materialize_ts(v_row, 'occurred_at', 'created_at', 'date'),
              timezone('utc', now())
            ),
            'note', private.materialize_text(v_row, 'note', 'description')
          );
          if v_mapped ->> 'warehouse_id' is null then
            raise exception 'parent_not_materialized:warehouses';
          end if;
          if v_mapped ->> 'product_id' is null then
            raise exception 'parent_not_materialized:products';
          end if;
          insert into public.stock_movements (
            id, company_id, warehouse_id, product_id, variant_id, movement_type,
            quantity, reference_type, reference_id, created_by, occurred_at, note
          )
          select r.id, r.company_id, r.warehouse_id, r.product_id, r.variant_id,
                 r.movement_type, r.quantity, r.reference_type, r.reference_id,
                 r.created_by, r.occurred_at, r.note
          from jsonb_populate_record(null::public.stock_movements, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            warehouse_id = excluded.warehouse_id,
            product_id = excluded.product_id,
            variant_id = excluded.variant_id,
            movement_type = excluded.movement_type,
            quantity = excluded.quantity,
            reference_type = excluded.reference_type,
            reference_id = excluded.reference_id,
            created_by = excluded.created_by,
            occurred_at = excluded.occurred_at,
            note = excluded.note;

        elsif v_cloud = 'customers' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'name', coalesce(private.materialize_text(v_row, 'name'), 'Cliente'),
            'phone', private.materialize_text(v_row, 'phone'),
            'email', private.materialize_text(v_row, 'email'),
            'tax_id', private.materialize_text(v_row, 'tax_id', 'taxid'),
            'active', coalesce(private.materialize_bool(v_row, 'active', 'is_active'), true)
          );
          insert into public.customers (id, company_id, name, phone, email, tax_id, active)
          select r.id, r.company_id, r.name, r.phone, r.email, r.tax_id, coalesce(r.active, true)
          from jsonb_populate_record(null::public.customers, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            name = excluded.name,
            phone = excluded.phone,
            email = excluded.email,
            tax_id = excluded.tax_id,
            active = excluded.active;

        elsif v_cloud = 'suppliers' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'name', coalesce(private.materialize_text(v_row, 'name'), 'Proveedor'),
            'phone', private.materialize_text(v_row, 'phone'),
            'address', private.materialize_text(v_row, 'address'),
            'email', private.materialize_text(v_row, 'email'),
            'rating', coalesce(private.materialize_number(v_row, 'rating'), 0),
            'merchandise_type', private.materialize_text(v_row, 'merchandise_type', 'type_of_merchandise'),
            'active', coalesce(private.materialize_bool(v_row, 'active', 'is_active'), true)
          );
          insert into public.suppliers (
            id, company_id, name, phone, address, email, rating, merchandise_type, active
          )
          select r.id, r.company_id, r.name, r.phone, r.address, r.email, r.rating,
                 r.merchandise_type, coalesce(r.active, true)
          from jsonb_populate_record(null::public.suppliers, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            name = excluded.name,
            phone = excluded.phone,
            address = excluded.address,
            email = excluded.email,
            rating = excluded.rating,
            merchandise_type = excluded.merchandise_type,
            active = excluded.active;

        elsif v_cloud = 'purchase_orders' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'supplier_id', private.materialize_id_text(
              v_company, 'suppliers', private.materialize_text(v_row, 'supplier_id')
            ),
            'warehouse_id', private.materialize_id_text(
              v_company, 'warehouses', private.materialize_text(v_row, 'warehouse_id', 'branch_id')
            ),
            'status', case lower(coalesce(private.materialize_text(v_row, 'status'), 'ordered'))
                        when 'pending' then 'ordered'
                        when 'draft' then 'draft'
                        when 'received' then 'received'
                        when 'cancelled' then 'cancelled'
                        when 'canceled' then 'cancelled'
                        else 'ordered'
                      end,
            'order_number', coalesce(
              private.materialize_text(v_row, 'order_number'), left(replace(v_id, '-', ''), 40)
            ),
            'currency_code', upper(coalesce(private.materialize_text(v_row, 'currency_code', 'currency'), 'USD')),
            'subtotal', coalesce(private.materialize_number(v_row, 'subtotal'), 0),
            'total', coalesce(private.materialize_number(v_row, 'total'), 0),
            'created_by', private.materialize_optional_uuid(v_row, 'created_by', 'user_id'),
            'expected_delivery_date', private.materialize_ts(v_row, 'expected_delivery_date'),
            'transport_cost', coalesce(private.materialize_number(v_row, 'transport_cost'), 0),
            'transport_details', coalesce(private.materialize_json(v_row, 'transport_details'), '{}'::jsonb)
          );
          if v_mapped ->> 'warehouse_id' is null then
            raise exception 'parent_not_materialized:warehouses';
          end if;
          insert into public.purchase_orders (
            id, company_id, supplier_id, warehouse_id, status, order_number, currency_code,
            subtotal, total, created_by, expected_delivery_date, transport_cost, transport_details
          )
          select r.id, r.company_id, r.supplier_id, r.warehouse_id, r.status, r.order_number,
                 r.currency_code, r.subtotal, r.total, r.created_by, r.expected_delivery_date,
                 r.transport_cost, r.transport_details
          from jsonb_populate_record(null::public.purchase_orders, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            supplier_id = excluded.supplier_id,
            warehouse_id = excluded.warehouse_id,
            status = excluded.status,
            order_number = excluded.order_number,
            currency_code = excluded.currency_code,
            subtotal = excluded.subtotal,
            total = excluded.total,
            created_by = excluded.created_by,
            expected_delivery_date = excluded.expected_delivery_date,
            transport_cost = excluded.transport_cost,
            transport_details = excluded.transport_details,
            updated_at = timezone('utc', now());

        elsif v_cloud = 'purchase_items' then
          v_parent := private.materialize_id_text(
            v_company, 'purchase_orders', private.materialize_text(v_row, 'purchase_order_id', 'purchase_id')
          );
          if v_parent is null or not exists (
            select 1 from public.purchase_orders where id::text = v_parent and company_id = v_company
          ) then
            raise exception 'parent_not_materialized:purchase_orders';
          end if;
          v_mapped := jsonb_build_object(
            'id', v_id,
            'purchase_order_id', v_parent,
            'product_id', private.materialize_id_text(
              v_company, 'products', private.materialize_text(v_row, 'product_id')
            ),
            'quantity', coalesce(private.materialize_number(v_row, 'quantity'), 0),
            'unit_cost', coalesce(private.materialize_number(v_row, 'unit_cost', 'cost'), 0),
            'line_total', coalesce(
              private.materialize_number(v_row, 'line_total', 'total'),
              coalesce(private.materialize_number(v_row, 'quantity'), 0)
                * coalesce(private.materialize_number(v_row, 'unit_cost', 'cost'), 0)
            )
          );
          if v_mapped ->> 'product_id' is null then
            raise exception 'parent_not_materialized:products';
          end if;
          insert into public.purchase_items (id, purchase_order_id, product_id, quantity, unit_cost, line_total)
          select r.id, r.purchase_order_id, r.product_id, r.quantity, r.unit_cost, r.line_total
          from jsonb_populate_record(null::public.purchase_items, v_mapped) as r
          on conflict (id) do update set
            purchase_order_id = excluded.purchase_order_id,
            product_id = excluded.product_id,
            quantity = excluded.quantity,
            unit_cost = excluded.unit_cost,
            line_total = excluded.line_total;

        elsif v_cloud = 'transfers' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'origin_warehouse_id', private.materialize_id_text(
              v_company, 'warehouses', private.materialize_text(v_row, 'origin_warehouse_id', 'from_branch_id')
            ),
            'destination_warehouse_id', private.materialize_id_text(
              v_company, 'warehouses', private.materialize_text(v_row, 'destination_warehouse_id', 'to_branch_id')
            ),
            'status', case lower(coalesce(private.materialize_text(v_row, 'status'), 'posted'))
                        when 'completed' then 'posted'
                        when 'in_transit' then 'in_transit'
                        when 'received' then 'received'
                        when 'cancelled' then 'cancelled'
                        when 'canceled' then 'cancelled'
                        else 'posted'
                      end,
            'notes', private.materialize_text(v_row, 'notes', 'description'),
            'created_by', private.materialize_optional_uuid(v_row, 'created_by', 'user_id'),
            'batch_id', private.materialize_optional_uuid(v_row, 'batch_id'),
            'received_at', private.materialize_ts(v_row, 'received_at'),
            'received_by', private.materialize_optional_uuid(v_row, 'received_by')
          );
          if v_mapped ->> 'origin_warehouse_id' is null
             or v_mapped ->> 'destination_warehouse_id' is null then
            raise exception 'parent_not_materialized:warehouses';
          end if;
          insert into public.transfers (
            id, company_id, origin_warehouse_id, destination_warehouse_id, status,
            notes, created_by, batch_id, received_at, received_by
          )
          select r.id, r.company_id, r.origin_warehouse_id, r.destination_warehouse_id,
                 r.status, r.notes, r.created_by, r.batch_id, r.received_at, r.received_by
          from jsonb_populate_record(null::public.transfers, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            origin_warehouse_id = excluded.origin_warehouse_id,
            destination_warehouse_id = excluded.destination_warehouse_id,
            status = excluded.status,
            notes = excluded.notes,
            created_by = excluded.created_by,
            batch_id = excluded.batch_id,
            received_at = excluded.received_at,
            received_by = excluded.received_by;

        elsif v_cloud = 'transfer_items' then
          v_parent := private.materialize_id_text(
            v_company, 'transfers', private.materialize_text(v_row, 'transfer_id')
          );
          if v_parent is null or not exists (
            select 1 from public.transfers where id::text = v_parent and company_id = v_company
          ) then
            raise exception 'parent_not_materialized:transfers';
          end if;
          v_mapped := jsonb_build_object(
            'id', v_id,
            'transfer_id', v_parent,
            'product_id', private.materialize_id_text(
              v_company, 'products', private.materialize_text(v_row, 'product_id')
            ),
            'quantity', coalesce(private.materialize_number(v_row, 'quantity'), 0),
            'variant_id', private.materialize_id_text(
              v_company, 'product_variants', private.materialize_text(v_row, 'variant_id')
            )
          );
          if v_mapped ->> 'product_id' is null then
            raise exception 'parent_not_materialized:products';
          end if;
          insert into public.transfer_items (id, transfer_id, product_id, quantity, variant_id)
          select r.id, r.transfer_id, r.product_id, r.quantity, r.variant_id
          from jsonb_populate_record(null::public.transfer_items, v_mapped) as r
          on conflict (id) do update set
            transfer_id = excluded.transfer_id,
            product_id = excluded.product_id,
            quantity = excluded.quantity,
            variant_id = excluded.variant_id;

        elsif v_cloud = 'sales_returns' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'sale_id', private.materialize_id_text(
              v_company, 'sales', private.materialize_text(v_row, 'sale_id', 'transaction_id')
            ),
            'status', case lower(coalesce(private.materialize_text(v_row, 'status'), 'pending'))
                        when 'completed' then 'completed'
                        when 'pending' then 'pending'
                        when 'rejected' then 'rejected'
                        else 'pending'
                      end,
            'reason', private.materialize_text(v_row, 'reason'),
            'total', coalesce(private.materialize_number(v_row, 'total', 'refund_amount'), 0),
            'created_by', private.materialize_optional_uuid(v_row, 'created_by', 'user_id'),
            -- Vocabularios cerrados de la nube: return_type (refund |
            -- warranty_exchange), refund_status (not_required | pending |
            -- approved | paid | rejected) y refund_method (cash | transfer |
            -- store_credit). Cualquier valor local desconocido se normaliza o
            -- se descarta para no romper CHECK/consumidores.
            'return_type', case lower(coalesce(private.materialize_text(v_row, 'return_type', 'type'), 'refund'))
                             when 'warranty_exchange' then 'warranty_exchange'
                             when 'warranty' then 'warranty_exchange'
                             else 'refund'
                           end,
            'refund_status', case lower(coalesce(private.materialize_text(v_row, 'refund_status'), 'pending'))
                               when 'not_required' then 'not_required'
                               when 'approved' then 'approved'
                               when 'paid' then 'paid'
                               when 'rejected' then 'rejected'
                               else 'pending'
                             end,
            'refund_amount', coalesce(private.materialize_number(v_row, 'refund_amount'), 0),
            'refund_currency_code', upper(nullif(private.materialize_text(v_row, 'refund_currency_code', 'refund_currency'), '')),
            'refund_method', case lower(coalesce(private.materialize_text(v_row, 'refund_method'), ''))
                               when 'cash' then 'cash'
                               when 'transfer' then 'transfer'
                               when 'store_credit' then 'store_credit'
                               else null
                             end,
            'refund_bank_card_id', private.materialize_optional_uuid(v_row, 'refund_bank_card_id'),
            'refund_transaction_id', private.materialize_optional_uuid(v_row, 'refund_transaction_id'),
            'refunded_at', private.materialize_ts(v_row, 'refunded_at'),
            'updated_at', coalesce(private.materialize_ts(v_row, 'updated_at'), timezone('utc', now()))
          );
          if v_mapped ->> 'sale_id' is null or not exists (
            select 1 from public.sales
            where id::text = (v_mapped ->> 'sale_id') and company_id = v_company
          ) then
            raise exception 'parent_not_materialized:sales';
          end if;
          insert into public.sales_returns (
            id, company_id, sale_id, status, reason, total, created_by, return_type,
            refund_status, refund_amount, refund_currency_code, refund_method,
            refund_bank_card_id, refund_transaction_id, refunded_at, updated_at
          )
          select r.id, r.company_id, r.sale_id, r.status, r.reason, r.total, r.created_by,
                 r.return_type, r.refund_status, r.refund_amount, r.refund_currency_code,
                 r.refund_method, r.refund_bank_card_id, r.refund_transaction_id,
                 r.refunded_at, r.updated_at
          from jsonb_populate_record(null::public.sales_returns, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            sale_id = excluded.sale_id,
            status = excluded.status,
            reason = excluded.reason,
            total = excluded.total,
            created_by = excluded.created_by,
            return_type = excluded.return_type,
            refund_status = excluded.refund_status,
            refund_amount = excluded.refund_amount,
            refund_currency_code = excluded.refund_currency_code,
            refund_method = excluded.refund_method,
            refund_bank_card_id = excluded.refund_bank_card_id,
            refund_transaction_id = excluded.refund_transaction_id,
            refunded_at = excluded.refunded_at,
            updated_at = excluded.updated_at;

        elsif v_cloud = 'sales_return_items' then
          v_parent := private.materialize_id_text(
            v_company, 'sales_returns', private.materialize_text(v_row, 'return_id')
          );
          if v_parent is null or not exists (
            select 1 from public.sales_returns where id::text = v_parent and company_id = v_company
          ) then
            raise exception 'parent_not_materialized:sales_returns';
          end if;
          v_mapped := jsonb_build_object(
            'id', v_id,
            'return_id', v_parent,
            'sale_item_id', private.materialize_id_text(
              v_company, 'sale_items', private.materialize_text(v_row, 'sale_item_id')
            ),
            'product_id', private.materialize_id_text(
              v_company, 'products', private.materialize_text(v_row, 'product_id')
            ),
            'quantity', coalesce(private.materialize_number(v_row, 'quantity'), 0),
            'unit_price', coalesce(private.materialize_number(v_row, 'unit_price', 'price'), 0),
            'line_total', coalesce(
              private.materialize_number(v_row, 'line_total', 'total'),
              coalesce(private.materialize_number(v_row, 'quantity'), 0)
                * coalesce(private.materialize_number(v_row, 'unit_price', 'price'), 0)
            ),
            'variant_id', private.materialize_id_text(
              v_company, 'product_variants', private.materialize_text(v_row, 'variant_id')
            )
          );
          if v_mapped ->> 'product_id' is null then
            raise exception 'parent_not_materialized:products';
          end if;
          insert into public.sales_return_items (
            id, return_id, sale_item_id, product_id, quantity, unit_price, line_total, variant_id
          )
          select r.id, r.return_id, r.sale_item_id, r.product_id, r.quantity, r.unit_price,
                 r.line_total, r.variant_id
          from jsonb_populate_record(null::public.sales_return_items, v_mapped) as r
          on conflict (id) do update set
            return_id = excluded.return_id,
            sale_item_id = excluded.sale_item_id,
            product_id = excluded.product_id,
            quantity = excluded.quantity,
            unit_price = excluded.unit_price,
            line_total = excluded.line_total,
            variant_id = excluded.variant_id;

        elsif v_cloud = 'quotes' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'quote_number', coalesce(
              private.materialize_text(v_row, 'quote_number'), left(v_id, 80)
            ),
            'customer_id', private.materialize_id_text(
              v_company, 'customers', private.materialize_text(v_row, 'customer_id')
            ),
            'warehouse_id', private.materialize_id_text(
              v_company, 'warehouses', private.materialize_text(v_row, 'warehouse_id', 'branch_id')
            ),
            'currency_code', upper(coalesce(private.materialize_text(v_row, 'currency_code', 'currency'), 'USD')),
            'status', lower(coalesce(private.materialize_text(v_row, 'status'), 'draft')),
            'total', coalesce(private.materialize_number(v_row, 'total'), 0),
            'valid_until', private.materialize_ts(v_row, 'valid_until'),
            'notes', private.materialize_text(v_row, 'notes'),
            'created_by', private.materialize_optional_uuid(v_row, 'created_by', 'user_id')
          );
          if v_mapped ->> 'warehouse_id' is null then
            raise exception 'parent_not_materialized:warehouses';
          end if;
          insert into public.quotes (
            id, company_id, quote_number, customer_id, warehouse_id, currency_code,
            status, total, valid_until, notes, created_by
          )
          select r.id, r.company_id, r.quote_number, r.customer_id, r.warehouse_id,
                 r.currency_code, r.status, r.total, r.valid_until, r.notes, r.created_by
          from jsonb_populate_record(null::public.quotes, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            quote_number = excluded.quote_number,
            customer_id = excluded.customer_id,
            warehouse_id = excluded.warehouse_id,
            currency_code = excluded.currency_code,
            status = excluded.status,
            total = excluded.total,
            valid_until = excluded.valid_until,
            notes = excluded.notes,
            created_by = excluded.created_by;

        elsif v_cloud = 'quote_items' then
          v_parent := private.materialize_id_text(
            v_company, 'quotes', private.materialize_text(v_row, 'quote_id')
          );
          if v_parent is null or not exists (
            select 1 from public.quotes where id::text = v_parent and company_id = v_company
          ) then
            raise exception 'parent_not_materialized:quotes';
          end if;
          v_mapped := jsonb_build_object(
            'id', v_id,
            'quote_id', v_parent,
            'product_id', private.materialize_id_text(
              v_company, 'products', private.materialize_text(v_row, 'product_id')
            ),
            'quantity', coalesce(private.materialize_number(v_row, 'quantity'), 0),
            'unit_price', coalesce(private.materialize_number(v_row, 'unit_price', 'price'), 0),
            'discount', coalesce(private.materialize_number(v_row, 'discount'), 0),
            'tax', coalesce(private.materialize_number(v_row, 'tax'), 0),
            'line_total', coalesce(
              private.materialize_number(v_row, 'line_total', 'total'),
              coalesce(private.materialize_number(v_row, 'quantity'), 0)
                * coalesce(private.materialize_number(v_row, 'unit_price', 'price'), 0)
            )
          );
          if v_mapped ->> 'product_id' is null then
            raise exception 'parent_not_materialized:products';
          end if;
          insert into public.quote_items (
            id, quote_id, product_id, quantity, unit_price, discount, tax, line_total
          )
          select r.id, r.quote_id, r.product_id, r.quantity, r.unit_price, r.discount,
                 r.tax, r.line_total
          from jsonb_populate_record(null::public.quote_items, v_mapped) as r
          on conflict (id) do update set
            quote_id = excluded.quote_id,
            product_id = excluded.product_id,
            quantity = excluded.quantity,
            unit_price = excluded.unit_price,
            discount = excluded.discount,
            tax = excluded.tax,
            line_total = excluded.line_total;

        elsif v_cloud = 'bank_accounts' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'name', coalesce(private.materialize_text(v_row, 'name', 'bank_name', 'bank'), 'Cuenta bancaria'),
            'bank_name', coalesce(private.materialize_text(v_row, 'bank_name', 'bank'), 'Banco'),
            'last_four', left(coalesce(private.materialize_text(v_row, 'last_four', 'last_four_digits'), ''), 4),
            'currency_code', upper(coalesce(private.materialize_text(v_row, 'currency_code', 'currency'), 'USD')),
            'balance', coalesce(private.materialize_number(v_row, 'balance'), 0),
            'active', coalesce(private.materialize_bool(v_row, 'active', 'is_active'), true),
            'updated_at', coalesce(private.materialize_ts(v_row, 'updated_at'), timezone('utc', now()))
          );
          insert into public.bank_accounts (
            id, company_id, name, bank_name, last_four, currency_code, balance, active, updated_at
          )
          select r.id, r.company_id, r.name, r.bank_name, r.last_four, r.currency_code,
                 r.balance, coalesce(r.active, true), r.updated_at
          from jsonb_populate_record(null::public.bank_accounts, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            name = excluded.name,
            bank_name = excluded.bank_name,
            last_four = excluded.last_four,
            currency_code = excluded.currency_code,
            balance = excluded.balance,
            active = excluded.active,
            updated_at = excluded.updated_at;

        elsif v_cloud = 'bank_transactions' then
          v_parent := private.materialize_id_text(
            v_company, 'bank_accounts', private.materialize_text(v_row, 'bank_account_id', 'card_id')
          );
          if v_parent is null or not exists (
            select 1 from public.bank_accounts where id::text = v_parent and company_id = v_company
          ) then
            raise exception 'parent_not_materialized:bank_accounts';
          end if;
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'bank_account_id', v_parent,
            -- Vocabulario canónico del ledger: credit | debit | transfer
            -- (ver palmyra_process_bank_transaction y pull.ts). La UI local usa
            -- deposit/withdrawal/payment_received/supplier_payment; se traducen
            -- aquí y se rechaza cualquier otro valor antes del INSERT.
            'transaction_type', case lower(coalesce(private.materialize_text(v_row, 'transaction_type', 'type'), ''))
                      when 'deposit' then 'credit'
                      when 'credit' then 'credit'
                      when 'ingreso' then 'credit'
                      when 'payment_received' then 'credit'
                      when 'transfer_in' then 'credit'
                      when 'withdrawal' then 'debit'
                      when 'debit' then 'debit'
                      when 'retiro' then 'debit'
                      when 'supplier_payment' then 'debit'
                      when 'transfer_out' then 'debit'
                      when 'transfer' then 'transfer'
                      else null
                    end,
            'amount', abs(coalesce(private.materialize_number(v_row, 'amount'), 0)),
            'currency_code', upper(coalesce(private.materialize_text(v_row, 'currency_code', 'currency'), 'USD')),
            'reference', coalesce(
              private.materialize_text(v_row, 'reference'),
              private.materialize_text(v_row, 'reference_id', 'transaction_id')
            ),
            'note', private.materialize_text(v_row, 'note', 'description'),
            'created_by', private.materialize_optional_uuid(v_row, 'created_by', 'user_id'),
            'created_at', coalesce(private.materialize_ts(v_row, 'created_at', 'date'), timezone('utc', now()))
          );
          if coalesce(v_mapped ->> 'transaction_type', '') not in ('credit', 'debit', 'transfer') then
            raise exception 'invalid_transaction_type';
          end if;
          insert into public.bank_transactions (
            id, company_id, bank_account_id, transaction_type, amount, currency_code,
            reference, note, created_by, created_at
          )
          select r.id, r.company_id, r.bank_account_id, r.transaction_type, r.amount,
                 r.currency_code, r.reference, r.note, r.created_by, r.created_at
          from jsonb_populate_record(null::public.bank_transactions, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            bank_account_id = excluded.bank_account_id,
            transaction_type = excluded.transaction_type,
            amount = excluded.amount,
            currency_code = excluded.currency_code,
            reference = excluded.reference,
            note = excluded.note,
            created_by = excluded.created_by;

        elsif v_cloud = 'inventory_audits' then
          v_mapped := jsonb_build_object(
            'id', v_id,
            'company_id', v_company,
            'warehouse_id', private.materialize_id_text(
              v_company, 'warehouses', private.materialize_text(v_row, 'warehouse_id', 'branch_id')
            ),
            'status', case lower(coalesce(private.materialize_text(v_row, 'status'), 'counting'))
                        when 'pending' then 'counting'
                        when 'counting' then 'counting'
                        when 'in_progress' then 'counting'
                        when 'submitted' then 'submitted'
                        when 'completed' then 'approved'
                        when 'approved' then 'approved'
                        when 'recount_requested' then 'recount_requested'
                        else 'counting'
                      end,
            'blind_count', coalesce(private.materialize_bool(v_row, 'blind_count'), false),
            'notes', private.materialize_text(v_row, 'notes'),
            'created_by', private.materialize_optional_uuid(v_row, 'created_by', 'user_id'),
            'submitted_at', private.materialize_ts(v_row, 'submitted_at'),
            'reviewed_by', private.materialize_optional_uuid(v_row, 'reviewed_by'),
            'reviewed_at', private.materialize_ts(v_row, 'reviewed_at'),
            'updated_at', coalesce(private.materialize_ts(v_row, 'updated_at'), timezone('utc', now()))
          );
          if v_mapped ->> 'warehouse_id' is null then
            raise exception 'parent_not_materialized:warehouses';
          end if;
          insert into public.inventory_audits (
            id, company_id, warehouse_id, status, blind_count, notes, created_by,
            submitted_at, reviewed_by, reviewed_at, updated_at
          )
          select r.id, r.company_id, r.warehouse_id, r.status, r.blind_count, r.notes,
                 r.created_by, r.submitted_at, r.reviewed_by, r.reviewed_at, r.updated_at
          from jsonb_populate_record(null::public.inventory_audits, v_mapped) as r
          on conflict (id) do update set
            company_id = excluded.company_id,
            warehouse_id = excluded.warehouse_id,
            status = excluded.status,
            blind_count = excluded.blind_count,
            notes = excluded.notes,
            created_by = excluded.created_by,
            submitted_at = excluded.submitted_at,
            reviewed_by = excluded.reviewed_by,
            reviewed_at = excluded.reviewed_at,
            updated_at = excluded.updated_at;

        elsif v_cloud = 'inventory_audit_items' then
          v_parent := private.materialize_id_text(
            v_company, 'inventory_audits', private.materialize_text(v_row, 'audit_id')
          );
          if v_parent is null or not exists (
            select 1 from public.inventory_audits where id::text = v_parent and company_id = v_company
          ) then
            raise exception 'parent_not_materialized:inventory_audits';
          end if;
          v_mapped := jsonb_build_object(
            'id', v_id,
            'audit_id', v_parent,
            'product_id', private.materialize_id_text(
              v_company, 'products', private.materialize_text(v_row, 'product_id')
            ),
            'expected_quantity', coalesce(private.materialize_number(v_row, 'expected_quantity', 'expected'), 0),
            'counted_quantity', private.materialize_number(v_row, 'counted_quantity', 'counted'),
            'difference', coalesce(
              private.materialize_number(v_row, 'difference'),
              coalesce(private.materialize_number(v_row, 'counted_quantity', 'counted'), 0)
                - coalesce(private.materialize_number(v_row, 'expected_quantity', 'expected'), 0)
            ),
            'notes', private.materialize_text(v_row, 'notes')
          );
          if v_mapped ->> 'product_id' is null then
            raise exception 'parent_not_materialized:products';
          end if;
          insert into public.inventory_audit_items (
            id, audit_id, product_id, expected_quantity, counted_quantity, difference, notes
          )
          select r.id, r.audit_id, r.product_id, r.expected_quantity, r.counted_quantity,
                 r.difference, r.notes
          from jsonb_populate_record(null::public.inventory_audit_items, v_mapped) as r
          on conflict (id) do update set
            audit_id = excluded.audit_id,
            product_id = excluded.product_id,
            expected_quantity = excluded.expected_quantity,
            counted_quantity = excluded.counted_quantity,
            difference = excluded.difference,
            notes = excluded.notes;
        end if;
      end if;

    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
      v_error := left(coalesce(v_message, 'unknown_error'), 500);
      if v_attempts < 5 and (v_state = '23503' or v_message like 'parent_not_materialized:%') then
        -- Orden de llegada invertido (hija antes que padre) o padre aún en cola:
        -- se reintenta en el próximo lote en vez de darla por perdida.
        v_status := 'pending';
      else
        v_status := 'failed';
      end if;
    end;

    update public.local_change_inbox
       set status = v_status,
           processed_at = case when v_status = 'pending' then null else timezone('utc', now()) end,
           attempts = coalesce(attempts, 0) + 1,
           error = left(v_error, 500)
     where company_id = v_change.company_id
       and origin_device = v_change.origin_device
       and seq = v_change.seq;

    if v_status = 'processed' then
      v_processed := v_processed + 1;
    elsif v_status = 'skipped' then
      v_skipped := v_skipped + 1;
    elsif v_status = 'failed' then
      v_failed := v_failed + 1;
    end if;
  end loop;

  select count(*)::int into v_remaining
  from public.local_change_inbox
  where status = 'pending';

  return jsonb_build_object(
    'processed', v_processed,
    'failed', v_failed,
    'skipped', v_skipped,
    'remaining', v_remaining,
    'limit', v_limit
  );
end;
$function$;

comment on function public.materialize_local_change_inbox(integer) is
  'Aplica cambios pendientes de local_change_inbox a las tablas de negocio. Solo service_role.';

revoke all on function public.materialize_local_change_inbox(integer) from public, anon, authenticated;
grant execute on function public.materialize_local_change_inbox(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Anulación de venta y visibilidad de reportes deben mover `updated_at`,
--    que es el cursor del pull. Cuerpos copiados de 20261121091000 y
--    20261123180000 con el SET añadido.
-- ---------------------------------------------------------------------------
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

  -- `updated_at` es el cursor del pull: sin moverlo la anulación no baja.
  update public.sales
     set status = 'voided',
         notes = concat_ws(E'\n', nullif(notes, ''), coalesce(v_reason, 'Anulación')),
         updated_at = timezone('utc', now())
   where id = p_sale_id and company_id = p_company_id;

  return jsonb_build_object('success', true, 'already_refunded', false, 'restored_units', v_restored);
end;
$function$;

revoke all on function public.palmyra_void_sale(uuid, uuid, text) from public, anon;
grant execute on function public.palmyra_void_sale(uuid, uuid, text) to authenticated;

create or replace function public.palmyra_set_sale_report_hidden(
  p_sale_id uuid,
  p_company_id uuid,
  p_hidden boolean
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_updated_id uuid;
begin
  if v_user is null then
    raise exception 'authentication_required';
  end if;
  if not private.has_company_access(p_company_id) then
    raise exception 'company_access_denied';
  end if;

  -- Gate de plan: en solo lectura no se alteran reportes ocultos.
  perform public.assert_company_plan_active(p_company_id);

  if not private.has_permission(p_company_id, 'reports.view') then
    raise exception 'permission_denied';
  end if;
  if p_sale_id is null or p_hidden is null then
    raise exception 'invalid_report_visibility';
  end if;

  update public.sales
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb),
       '{report_visibility}',
       jsonb_build_object(
         'hidden', p_hidden,
         'updated_at', timezone('utc', now()),
         'updated_by', v_user
       ),
       true
     ),
     updated_at = timezone('utc', now())
   where id = p_sale_id
     and company_id = p_company_id
     and status = 'completed'
   returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'completed_sale_not_found';
  end if;

  return jsonb_build_object('success', true, 'sale_id', v_updated_id, 'hidden', p_hidden);
end;
$function$;

revoke all on function public.palmyra_set_sale_report_hidden(uuid, uuid, boolean) from public, anon;
grant execute on function public.palmyra_set_sale_report_hidden(uuid, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Respaldos en la nube: la membresía solo vale en empresas activas y no
--    suspendidas (antes una empresa suspendida seguía leyendo/escribiendo su
--    cubo con un miembro activo).
-- ---------------------------------------------------------------------------
create or replace function private.cloud_backup_member(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_company_id is not null
    and auth.uid() is not null
    and exists (
      select 1
      from public.company_memberships cm
      join public.companies c on c.id = cm.company_id
      where cm.company_id = p_company_id
        and cm.user_id = auth.uid()
        and cm.status = 'active'
        and c.active
        and c.account_status <> 'suspended'
    );
$$;

revoke all on function private.cloud_backup_member(uuid) from public;
grant execute on function private.cloud_backup_member(uuid) to authenticated;

commit;
