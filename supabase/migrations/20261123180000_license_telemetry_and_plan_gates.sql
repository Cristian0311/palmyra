-- PENDIENTE DE APLICAR — no ejecutar sin autorización.
--
-- F3-B: telemetría de manipulación del reloj y gates de plan en RPCs de nube.
-- Forward-only, aditivo e idempotente: se puede reejecutar sin duplicar objetos.
--
-- Qué hace:
--  1. Completa public.clock_tamper_reports con el contrato de la Edge Function
--     license-telemetry (reason, effective_now, anchor, app_version, platform,
--     detail) sin perder las columnas kind/source/skew_ms/lease_id que ya usa el
--     cliente actual.
--  2. Cierra la tabla: RLS habilitado, sin políticas y sin permisos para
--     anon/authenticated. El único escritor es license-telemetry (service_role).
--  3. Añade public.assert_company_plan_active(uuid) y la aplica a tres RPCs de
--     nube que hoy NO validan plan: ingesta de cambios locales, visibilidad de
--     reportes de venta y borrado de auditorías de inventario.
--
-- No toca suscripciones, pagos, planes ni datos de negocio existentes.
begin;

-- ---------------------------------------------------------------------------
-- 1. Columnas del contrato license-telemetry.
--    Nulables para que los reportes del cliente anterior (solo kind/source)
--    sigan entrando sin cambios.
-- ---------------------------------------------------------------------------
alter table public.clock_tamper_reports add column if not exists reason text;
alter table public.clock_tamper_reports add column if not exists effective_now timestamptz;
alter table public.clock_tamper_reports add column if not exists anchor timestamptz;
alter table public.clock_tamper_reports add column if not exists app_version text;
alter table public.clock_tamper_reports add column if not exists platform text;
alter table public.clock_tamper_reports add column if not exists detail jsonb;

comment on column public.clock_tamper_reports.reason is
  'Clase de anomalía reportada por el equipo (minúsculas, p. ej. clock_rollback).';
comment on column public.clock_tamper_reports.effective_now is
  'Tiempo efectivo calculado por el cliente (reloj de pared, monotónico y ancla).';
comment on column public.clock_tamper_reports.anchor is
  'Último serverTimeAnchor conocido por el equipo, si lo hubo.';
comment on column public.clock_tamper_reports.app_version is
  'Versión de la aplicación que detectó la anomalía.';
comment on column public.clock_tamper_reports.platform is
  'Plataforma de origen (win32, darwin, linux, android, ...).';
comment on column public.clock_tamper_reports.detail is
  'Contexto acotado y saneado: sin tokens, claves ni credenciales.';

-- ---------------------------------------------------------------------------
-- 2. Compatibilidad con el contrato anterior.
--    Los reportes nuevos no traen kind/source: se relajan esos NOT NULL y se
--    conservan sus CHECK (un valor nulo sigue siendo válido).
-- ---------------------------------------------------------------------------
alter table public.clock_tamper_reports alter column kind drop not null;
alter table public.clock_tamper_reports alter column source drop not null;

-- Topes de longitud y tamaño del detalle (idempotentes).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'clock_tamper_reports_reason_check'
      and conrelid = 'public.clock_tamper_reports'::regclass
  ) then
    alter table public.clock_tamper_reports
      add constraint clock_tamper_reports_reason_check
      check (reason is null or length(btrim(reason)) between 1 and 64);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'clock_tamper_reports_app_version_check'
      and conrelid = 'public.clock_tamper_reports'::regclass
  ) then
    alter table public.clock_tamper_reports
      add constraint clock_tamper_reports_app_version_check
      check (app_version is null or length(btrim(app_version)) between 1 and 40);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'clock_tamper_reports_platform_check'
      and conrelid = 'public.clock_tamper_reports'::regclass
  ) then
    alter table public.clock_tamper_reports
      add constraint clock_tamper_reports_platform_check
      check (platform is null or length(btrim(platform)) between 1 and 32);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'clock_tamper_reports_detail_check'
      and conrelid = 'public.clock_tamper_reports'::regclass
  ) then
    alter table public.clock_tamper_reports
      add constraint clock_tamper_reports_detail_check
      check (
        detail is null
        or (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 8192)
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Índices: consulta por empresa y fecha, y cupo por empresa+equipo+hora.
-- ---------------------------------------------------------------------------
create index if not exists clock_tamper_reports_company_detected_idx
  on public.clock_tamper_reports(company_id, detected_at desc);

create index if not exists clock_tamper_reports_company_device_created_idx
  on public.clock_tamper_reports(company_id, device_id, created_at desc);

-- Idempotencia del vaciado: se añade `reason` y se normalizan con coalesce las
-- columnas que el contrato nuevo deja nulas (en un índice único los NULL son
-- distintos entre sí, así que sin coalesce no habría deduplicación real).
drop index if exists public.clock_tamper_reports_dedupe_uidx;
create unique index if not exists clock_tamper_reports_dedupe_uidx
  on public.clock_tamper_reports(
    company_id,
    coalesce(kind, ''),
    coalesce(source, ''),
    detected_at,
    coalesce(device_id, ''),
    coalesce(lease_id, ''),
    coalesce(reason, '')
  );

-- ---------------------------------------------------------------------------
-- 4. RLS cerrado: la tabla no expone políticas ni permisos a clientes.
--    La ruta soportada es la Edge Function license-telemetry (service_role),
--    que además aplica el cupo de 20 reportes/hora por equipo. Se retira la
--    política de INSERT directo que permitía saltarse ese cupo.
-- ---------------------------------------------------------------------------
alter table public.clock_tamper_reports enable row level security;

drop policy if exists clock_tamper_reports_member_insert on public.clock_tamper_reports;

revoke all on table public.clock_tamper_reports from public, anon, authenticated;

comment on table public.clock_tamper_reports is
  'Evidencia de manipulación del reloj. Solo escribe/lee el service_role (license-telemetry); sin acceso directo de clientes.';

-- ---------------------------------------------------------------------------
-- 5. Gate de plan reutilizable.
--    Misma ventana que private.company_has_plan_feature: estado y fechas del
--    plan, prueba o gracia de 2 días. Gratis es permanente y siempre pasa.
--    No es SECURITY INVOKER para poder leer subscriptions/plans aunque el
--    llamador no tenga privilegios directos; search_path queda fijado.
-- ---------------------------------------------------------------------------
create or replace function public.assert_company_plan_active(p_company_id uuid)
returns void
language plpgsql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_company_ok boolean;
  v_plan_ok boolean;
begin
  if p_company_id is null then
    raise exception 'company_required';
  end if;

  -- La empresa debe existir, estar activa y no estar suspendida.
  select exists (
    select 1
    from public.companies c
    where c.id = p_company_id
      and c.active
      and c.account_status <> 'suspended'
  )
  into v_company_ok;

  if not v_company_ok then
    raise exception 'company_access_denied';
  end if;

  -- Debe haber un plan vigente: activo, en prueba o dentro de la gracia.
  select exists (
    select 1
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
    where s.company_id = p_company_id
      and (p.active or p.code = 'trial')
      and (
        (s.status = 'active' and (s.current_period_end is null or s.current_period_end > now()))
        or (s.status = 'trialing' and coalesce(s.trial_ends_at, s.current_period_end) > now())
        or (
          s.status in ('active', 'trialing', 'past_due')
          and coalesce(
            s.grace_ends_at,
            coalesce(s.trial_ends_at, s.current_period_end) + interval '2 days'
          ) > now()
        )
      )
  )
  into v_plan_ok;

  if not v_plan_ok then
    raise exception 'plan_not_active';
  end if;
end;
$function$;

comment on function public.assert_company_plan_active(uuid) is
  'Lanza plan_not_active si la empresa no tiene plan vigente (activo, prueba o gracia). Uso interno de RPCs de nube.';

-- Solo se invoca desde RPCs security definer (se ejecutan como su dueño):
-- no se expone al cliente ni al rol anon.
revoke all on function public.assert_company_plan_active(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Gate aplicado a RPCs de nube que hoy no validan plan.
--    Definiciones copiadas de la migración vigente + una línea de gate.
-- ---------------------------------------------------------------------------

-- 6.1 Ingesta de cambios locales (subida a la nube del motor de sync).
--     Un plan vencido deja de subir cambios; los conserva en la bandeja local.
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

  -- Gate de plan: sin plan vigente no se aceptan escrituras en la nube.
  perform public.assert_company_plan_active(p_company_id);

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'invalid_changes';
  end if;

  -- Tope de lote: el cliente empuja de 200 en 200; 1 000 deja margen y evita
  -- que un lote gigante consuma la transacción completa.
  if jsonb_array_length(p_changes) > 1000 then
    raise exception 'changes_batch_too_large';
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

revoke all on function public.ingest_local_changes(uuid, bigint, jsonb) from public, anon;
grant execute on function public.ingest_local_changes(uuid, bigint, jsonb) to authenticated;

-- 6.2 Visibilidad de reportes de venta (escritura en sales.metadata).
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
     )
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

-- 6.3 Borrado de auditorías de inventario (operación destructiva).
create or replace function public.palmyra_delete_audit(p_audit_id uuid, p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_row public.inventory_audits%rowtype;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;

  -- Gate de plan: un plan vencido no borra evidencia de inventario.
  perform public.assert_company_plan_active(p_company_id);

  if not private.has_permission(p_company_id, 'inventory.manage') then raise exception 'permission_denied'; end if;

  select * into v_row
  from public.inventory_audits
  where id = p_audit_id and company_id = p_company_id
  for update;

  if not found then
    return jsonb_build_object('success', true, 'already_deleted', true);
  end if;

  if v_row.status = 'approved' then
    raise exception 'audit_already_approved';
  end if;

  delete from public.inventory_audit_items where audit_id = p_audit_id;
  delete from public.inventory_audits where id = p_audit_id and company_id = p_company_id;

  return jsonb_build_object('success', true, 'already_deleted', false);
end;
$function$;

revoke all on function public.palmyra_delete_audit(uuid, uuid) from public, anon;
grant execute on function public.palmyra_delete_audit(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Lectura del panel SaaS: reportes recientes de manipulación de reloj.
--    Solo administradores de plataforma. Devuelve el contrato exacto que
--    consume admin/platformAdminApi.ts (PlatformClockTamperReport).
-- ---------------------------------------------------------------------------
create or replace function public.get_platform_clock_tamper_reports(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_limit integer;
begin
  if v_user is null or not exists (
    select 1 from public.platform_admins pa where pa.user_id = v_user
  ) then
    raise exception 'permission_denied';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 200), 1), 500);

  return coalesce((
    select jsonb_agg(x order by (x ->> 'detected_at') desc)
    from (
      select jsonb_build_object(
        'id', r.id,
        'company_id', r.company_id,
        'company_name', c.name,
        'device_id', r.device_id,
        'lease_id', r.lease_id,
        'kind', r.kind,
        'source', r.source,
        'skew_ms', r.skew_ms,
        'reason', r.reason,
        'effective_now', r.effective_now,
        'anchor', r.anchor,
        'app_version', r.app_version,
        'platform', r.platform,
        'detail', r.detail,
        'detected_at', r.detected_at,
        'created_at', r.created_at
      ) as x
      from public.clock_tamper_reports r
      left join public.companies c on c.id = r.company_id
      order by r.detected_at desc
      limit v_limit
    ) q
  ), '[]'::jsonb);
end $function$;

comment on function public.get_platform_clock_tamper_reports(integer) is
  'Reportes recientes de manipulación de reloj para el panel SaaS (solo platform_admins).';

revoke all on function public.get_platform_clock_tamper_reports(integer) from public, anon;
grant execute on function public.get_platform_clock_tamper_reports(integer) to authenticated;

commit;
