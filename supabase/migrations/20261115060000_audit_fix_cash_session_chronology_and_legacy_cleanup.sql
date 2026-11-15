begin;

-- Auditoría 2026-11-15 (aplicada en producción con SUPABASE_APPLY_A_MIGRATION,
-- idempotency key: palmyra-audit-2026-11-15-chronology).
--
-- Corrige la causa y el efecto de los 21 turnos con closed_at < opened_at:
-- el cambio de fecha de negocio movía opened_at (y las ventas) sin mover
-- closed_at cuando el turno seguía abierto, dejando duraciones negativas.

-- 1) Invariante: un turno nunca puede cerrarse antes de abrirse.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'cash_sessions_chronology_chk'
      and conrelid = 'public.cash_sessions'::regclass
  ) then
    alter table public.cash_sessions
      add constraint cash_sessions_chronology_chk
      check (closed_at is null or closed_at >= opened_at) not valid;
  end if;
end $$;

-- 2) Reparación determinista: desplaza closed_at el mínimo número de días
--    necesario para restaurar la cronología. El valor original queda guardado
--    en metadata.chronology_repair para poder revertir sin pérdida de datos.
with broken as (
  select id,
         closed_at,
         ceil(extract(epoch from (opened_at - closed_at)) / 86400.0)::int as days
  from public.cash_sessions
  where closed_at is not null
    and closed_at < opened_at
)
update public.cash_sessions cs
set closed_at = cs.closed_at + make_interval(days => b.days),
    metadata = jsonb_set(
      coalesce(cs.metadata, '{}'::jsonb),
      '{chronology_repair}',
      jsonb_build_object(
        'previous_closed_at', b.closed_at,
        'applied_days', b.days,
        'repaired_at', timezone('utc', now())
      ),
      true
    )
from broken b
where cs.id = b.id;

alter table public.cash_sessions validate constraint cash_sessions_chronology_chk;

-- 3) Restos de la migración MARÉ fuera del esquema público expuesto.
--    Las tablas y sus filas se conservan en legacy_archive.
create schema if not exists legacy_archive;
alter table if exists public.legacy_pos_migration_staging set schema legacy_archive;
alter table if exists public.legacy_pos_migration_map set schema legacy_archive;
alter table if exists public.mare_pre_migration_backup_20261010 set schema legacy_archive;

-- 4) Índice redundante: company_id ya está cubierto por los índices compuestos
--    cash_sessions_company_opened_idx, cash_sessions_company_status_idx e
--    idx_cash_sessions_not_deleted.
drop index if exists public.idx_cash_sessions_cash_sessions_company_id_fkey;

commit;
