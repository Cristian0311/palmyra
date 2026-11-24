-- PENDIENTE DE APLICAR — no ejecutar sin autorización.
--
-- Bandeja de cambios locales para el motor de sincronización por cursores.
-- Cada dispositivo sube una ventana de su journal local y la nube guarda aquí
-- los cambios tal como llegaron, sin aplicarlos: la aplicación de esos cambios
-- a las tablas de negocio es una fase posterior.
--
-- Idempotente y aditiva: se puede reejecutar sin duplicar objetos ni filas.
-- Nadie lee ni escribe la tabla directamente: solo la función security definer
-- `ingest_local_changes`, que valida la sesión y el acceso a la empresa.
begin;

-- ---------------------------------------------------------------------------
-- 1. Bandeja por empresa y secuencia del journal.
-- ---------------------------------------------------------------------------
create table if not exists public.local_change_inbox (
  company_id uuid not null,
  seq bigint not null,
  table_name text not null,
  row_id text not null,
  op text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  primary key (company_id, seq),
  constraint local_change_inbox_seq_check check (seq >= 0),
  constraint local_change_inbox_op_check check (op in ('upsert', 'delete')),
  constraint local_change_inbox_table_check check (length(btrim(table_name)) between 1 and 120),
  constraint local_change_inbox_row_check check (length(btrim(row_id)) between 1 and 200)
);

-- Barrido por antigüedad para limpieza y auditoría.
create index if not exists local_change_inbox_received_at_idx
  on public.local_change_inbox (received_at);

-- ---------------------------------------------------------------------------
-- 2. RLS sin políticas: el acceso directo queda cerrado para todos los roles
--    de cliente; la función definer es la única vía de escritura.
-- ---------------------------------------------------------------------------
alter table public.local_change_inbox enable row level security;

revoke all on table public.local_change_inbox from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Ingesta idempotente: on conflict (company_id, seq) do nothing.
--    El cursor se limita a 1e12 para no desbordar bigint ni aceptar acuses
--    absurdos; los cambios fuera de la ventana confirmada se ignoran.
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
begin
  if v_auth is null then
    raise exception 'authentication_required';
  end if;

  if p_company_id is null or not private.has_company_access(p_company_id) then
    raise exception 'company_access_denied';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'invalid_changes';
  end if;

  insert into public.local_change_inbox (company_id, seq, table_name, row_id, op, payload)
  select
    p_company_id,
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
  on conflict (company_id, seq) do nothing;

  return jsonb_build_object('acceptedThrough', v_cursor);
end;
$function$;

revoke all on function public.ingest_local_changes(uuid, bigint, jsonb)
  from public, anon;

grant execute on function public.ingest_local_changes(uuid, bigint, jsonb)
  to authenticated;

commit;
