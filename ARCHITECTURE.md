# PALMYRA — arquitectura actual

## Fuente de verdad

PALMYRA es un SaaS multiempresa sobre React/Vite + Supabase Auth + PostgreSQL/RLS/RPC. El modelo operativo es:

**Empresa → Almacenes → Empleados → Roles/Permisos → Acceso por almacén → Operaciones**

El inventario pertenece al almacén. El código conserva algunos nombres históricos como `branchId`/`currentBranchId` por compatibilidad durante la migración progresiva de nomenclatura; no se debe reintroducir una arquitectura de sucursales en la base de datos.

## Reglas de operaciones críticas

- Venta online: UI → RPC transaccional → Supabase → espejo local.
- Venta offline: UI → estado local + outbox durable → replay idempotente → Supabase → reconciliación.
- Inventario: los cambios críticos pasan por RPCs atómicos en PostgreSQL.
- Transferencias: la operación remota es la autoridad y usa identificadores de operación estables.
- Caja: apertura/cierre y numeración de turnos son autoritativos en Supabase.
- Un turno nunca se renumera por borrar otro turno. Los reportes deben mostrar el `turnNumber` persistido.
- El stock por variante se mantiene separado y normalizado.
- Supabase es la fuente de verdad para identidad, tenant, permisos y datos empresariales.

## Offline

La cola durable debe sobrevivir a recargas y cierres del navegador. Las operaciones críticas conservan su ID para que un replay después de un timeout no genere una segunda venta, transferencia o movimiento.

## Organización del frontend

La refactorización es incremental para no cambiar el flujo de trabajadores:

```
src/
  app/
  modules/
    pos/
    reports/
    inventory/
    cash/
  pages/
  components/
  services/
    supabaseSync/
    offline/
    cash/
  store/
    utils/
  hooks/
  utils/
  config/
```

Las páginas grandes se convierten progresivamente en composición de componentes, hooks, servicios y utilidades. No se permite seguir acumulando dominio nuevo en `useStore.ts`, `POS.tsx` o `Reports.tsx`.

## Base de datos

Las migraciones nuevas viven únicamente en `supabase/migrations/`. Los SQL históricos de reparación pueden documentar incidentes, pero no son la fuente actual de esquema.

RLS debe permanecer habilitado en tablas públicas expuestas. Las funciones `SECURITY DEFINER` se usan solo cuando una operación necesita privilegio controlado y deben validar identidad, empresa y alcance.

## Calidad

CI debe ejecutar, como mínimo:

1. TypeScript sin errores.
2. Auditoría de arquitectura.
3. Pruebas unitarias de lógica crítica.
4. Build de producción.

Los archivos fuente de varios miles de líneas deben modularizarse antes de añadir más lógica de dominio.
