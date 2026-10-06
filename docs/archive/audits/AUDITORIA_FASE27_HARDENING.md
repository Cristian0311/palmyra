# Auditoría Fase 27 — endurecimiento de sincronización y RPC

Fecha: 2026-09-26

## Correcciones aplicadas

1. **Apertura de turno idempotente**
   - El flujo online deja de usar `open_cash_session_v2` (que genera su propio ID) y usa `open_cash_session_v3` con el ID estable del dispositivo.
   - Esto evita duplicar turnos si una RPC confirma en servidor pero la respuesta se pierde.
   - `open_cash_session_v3` ahora valida sucursal/usuario cuando recibe un ID ya existente.

2. **Cierre de turno sin fallback parcial**
   - Se eliminó el fallback directo de `callCloseSessionRPC`.
   - Un fallo de red/RPC ya no puede marcar el turno como cerrado y, simultáneamente, perder la liquidación.
   - El cierre queda en la cola y se reintenta mediante `close_cash_session_v2`, que es idempotente.
   - `sales_goal` vuelve a persistirse en `salary_settlements` desde el RPC.

3. **Cancelación de turno sin fallback parcial**
   - Se eliminó el fallback cliente que podía anular ventas individualmente, actualizar el turno y aun así reportar éxito parcial.
   - La operación ahora espera al RPC o queda en cola para replay idempotente.
   - `cancel_cash_session_v2` pasó a `SECURITY INVOKER`.

4. **Hardening de funciones**
   - Se fijó `search_path = public, pg_temp` en los RPC críticos y en `update_updated_at_column`.
   - Se recargó el schema cache de PostgREST.

5. **RLS / superficie expuesta**
   - `cash_movements` ahora tiene RLS habilitado (manteniendo la política existente para no romper el modelo actual).
   - La tabla de backup `inventory_repair_backup_20260926` quedó fuera del acceso de `anon`/`authenticated` y sin RLS innecesario.
   - Se revocó la ejecución pública de `rls_auto_enable()`.
   - Las vistas `shift_audit_view` y `data_integrity_alerts` fueron recreadas con `security_invoker=true`.

## Resultado del Security Advisor

Después de los cambios, los hallazgos de seguridad relacionados con:
- RLS deshabilitado en `cash_movements`
- vistas SECURITY DEFINER
- RPC SECURITY DEFINER ejecutable por anon
- search_path mutable en los RPC auditados

quedaron resueltos. El advisor quedó sin findings de seguridad; se verificó también que los tres RPC de apertura/cierre/cancelación siguen siendo ejecutables por `anon`, porque el proyecto usa autenticación propia y no Supabase Auth.

## Nota de arquitectura

El proyecto todavía usa políticas RLS muy amplias (`Public Full Access`) porque el frontend actual autentica usuarios en una tabla propia y consume Supabase como `anon`. Eso mantiene compatibilidad, pero **no constituye autorización fuerte por usuario/sucursal**. La migración futura recomendada es Supabase Auth + RLS por usuario/sucursal/rol o RPC privilegiados con validación explícita.

## Estado

- Cambios de base de datos aplicados y verificados en el proyecto live.
- Cambios de frontend aplicados al paquete fuente.
- No se declara build certificado todavía: anteriormente `npm run build` no pudo ejecutarse porque las dependencias no estaban instaladas (`vite: not found`).

## Auditoría adicional — Fase 27.1

Se detectó una condición de bloqueo de la cola: el procesamiento estaba ordenando exclusivamente por `timestamp`. En dispositivos offline, la apertura de un turno y la primera venta pueden compartir el mismo milisegundo; el desempate por UUID podía colocar la venta antes que la apertura. Como las operaciones críticas detienen la cola ante un fallo, la venta podía quedar bloqueando indefinidamente la apertura que necesitaba para procesarse.

Corrección: `processOfflineQueue()` ahora aplica prioridades de dependencia antes del timestamp:
- apertura de turno → snapshot → ventas → anulaciones/devoluciones
- orden de proveedor → recepción
- auditoría → completado
- cierre/cancelación y liquidación después de sus dependencias

Esto no cambia el orden de operaciones independientes y evita el deadlock lógico por desempate temporal.
