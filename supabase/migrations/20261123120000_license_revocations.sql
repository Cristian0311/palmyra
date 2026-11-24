-- Revocación de leases de licencia y telemetría de manipulación del reloj.
-- Forward-only, aditivo e idempotente: no modifica tablas existentes.
--
-- Privacidad y seguridad:
--  * clock_tamper_reports no guarda datos personales: solo clase de anomalía,
--    origen, magnitud y marcas de tiempo, con empresa/equipo/lease opcionales.
--  * El cliente autenticado solo puede INSERTAR reportes de SU empresa.
--  * Nadie con rol anon/authenticated puede leer reportes ni revocaciones: la
--    lectura queda para el service_role (Edge Function revoke-lease).
--  * license_revocations solo la escribe el service_role / Edge Function.
begin;

-- ---------------------------------------------------------------------------
-- 1. Revocaciones por lease.
-- ---------------------------------------------------------------------------
create table if not exists public.license_revocations (
  -- lease_id es el UUID del lease; text para aceptar identificadores legados.
  lease_id text primary key check (length(btrim(lease_id)) between 1 and 128),
  company_id uuid not null references public.companies(id) on delete cascade,
  reason text null check (reason is null or length(reason) <= 200),
  revoked_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists license_revocations_lease_uidx
  on public.license_revocations(lease_id);
create index if not exists license_revocations_company_idx
  on public.license_revocations(company_id, revoked_at desc);

alter table public.license_revocations enable row level security;
-- Sin políticas y sin permisos: solo el service_role (que ignora RLS) accede.
revoke all on table public.license_revocations from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Telemetría acotada de manipulación del reloj.
-- ---------------------------------------------------------------------------
create table if not exists public.clock_tamper_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  device_id text null check (device_id is null or length(btrim(device_id)) between 1 and 128),
  lease_id text null check (lease_id is null or length(btrim(lease_id)) between 1 and 128),
  kind text not null check (kind in ('wall-rollback', 'monotonic-regression')),
  source text not null check (source in ('watermark', 'server-anchor', 'monotonic')),
  skew_ms bigint not null default 0 check (skew_ms >= 0),
  detected_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists clock_tamper_reports_company_idx
  on public.clock_tamper_reports(company_id, detected_at desc);

-- Idempotencia del vaciado: un reintento del mismo evento no duplica filas.
create unique index if not exists clock_tamper_reports_dedupe_uidx
  on public.clock_tamper_reports(
    company_id,
    kind,
    source,
    detected_at,
    coalesce(device_id, ''),
    coalesce(lease_id, '')
  );

alter table public.clock_tamper_reports enable row level security;

revoke all on table public.clock_tamper_reports from public, anon, authenticated;
grant insert on table public.clock_tamper_reports to authenticated;

-- Inserción autenticada limitada a la propia empresa.
drop policy if exists clock_tamper_reports_member_insert on public.clock_tamper_reports;
create policy clock_tamper_reports_member_insert on public.clock_tamper_reports
  for insert to authenticated
  with check (private.has_company_access(company_id));

-- Sin políticas de SELECT: la lectura queda reservada al service_role.

commit;
