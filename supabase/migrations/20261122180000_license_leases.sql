-- Lease de licencia firmado (ES256) emitido por la Edge Function issue-lease.
-- Forward-only, idempotente y aditivo: no modifica tablas existentes.
-- Los clientes solo pueden leer los leases de SUS empresas; la escritura queda
-- reservada al service role (Edge Function) al no existir políticas de INSERT.
begin;

-- ---------------------------------------------------------------------------
-- 1. Historial de leases por empresa/dispositivo.
-- ---------------------------------------------------------------------------
create table if not exists public.license_leases (
  id uuid primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  device_id text not null check (length(btrim(device_id)) between 1 and 128),
  device_pubkey_fp text not null check (length(btrim(device_pubkey_fp)) > 0),
  plan_code text not null check (length(btrim(plan_code)) > 0),
  billing_months integer not null default 0 check (billing_months >= 0),
  seq integer not null check (seq > 0),
  -- payload = LeasePayloadV1 sin firma; signature = base64url IEEE P1363 (64 bytes).
  payload jsonb not null,
  signature text not null check (length(btrim(signature)) > 0),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  revoked_reason text null,
  created_by uuid null
);

-- Secuencia única por empresa y dispositivo (reintentos seguros de emisión).
create unique index if not exists license_leases_company_device_seq_uidx
  on public.license_leases(company_id, device_id, seq);

-- Lectura del último lease por empresa.
create index if not exists license_leases_company_issued_idx
  on public.license_leases(company_id, issued_at desc);

-- ---------------------------------------------------------------------------
-- 2. RLS: lectura solo para miembros activos; sin escritura para clientes.
-- ---------------------------------------------------------------------------
alter table public.license_leases enable row level security;

revoke all on table public.license_leases from public, anon, authenticated;
grant select on table public.license_leases to authenticated;

drop policy if exists license_leases_member_read on public.license_leases;
create policy license_leases_member_read on public.license_leases
  for select to authenticated
  using (private.has_company_access(company_id));

-- Sin políticas de INSERT/UPDATE/DELETE: solo service_role (Edge Function) escribe.

commit;
