-- PALMYRA system update signals
-- El servidor avisa a TODAS las apps instaladas cuando arranca un build nuevo
-- (redespliegue de Render con archivos nuevos o release publicado). Así cada
-- caja no necesita sondear: escucha un INSERT y muestra su aviso de
-- actualización. La fila solo lleva versión y build: ningún dato de negocio.
--
-- Acceso: la tabla se lee con RLS (SELECT para anon/authenticated) y NADIE
-- inserta directamente. La única vía de escritura es la RPC
-- `signal_system_update`, que el servidor llama con la clave anon.
-- Idempotente por build: un reinicio del mismo commit no genera fila nueva ni
-- un aviso falso en los clientes.

create table if not exists public.system_update_signals (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  build_id text not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint system_update_signals_build_id_key unique (build_id)
);

alter table public.system_update_signals enable row level security;

-- Lectura pública del último aviso: no hay datos sensibles ni de tenant.
drop policy if exists system_update_signals_read on public.system_update_signals;
create policy system_update_signals_read
  on public.system_update_signals
  for select
  to anon, authenticated
  using (true);

-- Sin políticas de escritura y sin grants de escritura: solo la RPC inserta.
revoke all on table public.system_update_signals from public;
revoke insert, update, delete, truncate on table public.system_update_signals from anon, authenticated;
grant select on table public.system_update_signals to anon, authenticated;

-- ----------------------------------------------------------------------------
-- signal_system_update
--   Anota un build. Recorta entradas, ignora vacías y nunca duplica un build
--   ya señalado. Purga avisos viejos para que la tabla siga siendo diminuta.
-- ----------------------------------------------------------------------------
create or replace function public.signal_system_update(
  p_version text,
  p_build_id text
) returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_version text := left(btrim(coalesce(p_version, '')), 64);
  v_build text := left(btrim(coalesce(p_build_id, '')), 200);
begin
  if v_version = '' or v_build = '' then
    return;
  end if;

  insert into public.system_update_signals (version, build_id)
  values (v_version, v_build)
  on conflict (build_id) do nothing;

  -- La tabla es un buzón, no un histórico: 90 días sobran para diagnosticar.
  delete from public.system_update_signals
  where created_at < timezone('utc', now()) - interval '90 days';
end;
$$;

revoke all on function public.signal_system_update(text, text) from public;
grant execute on function public.signal_system_update(text, text) to anon;

-- Realtime: los INSERT llegan a las apps suscritas. Se añade a la publicación
-- solo si existe (proyectos ya inicializados) y sin duplicar la tabla.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'system_update_signals'
    ) then
      alter publication supabase_realtime add table public.system_update_signals;
    end if;
  end if;
end $$;
