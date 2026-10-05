# Arquitectura PALMYRA

## Principios
PALMYRA es un CRM/POS SaaS multiempresa. El aislamiento de datos se determina por la empresa activa (tenant) y el acceso a almacenes se controla por membresía/permisos. El frontend conserva algunos nombres históricos como `branchId` por compatibilidad, pero el dato real de inventario y operación es el almacén.

## Capas
- `src/pages/`: páginas y coordinación de UI.
- `src/modules/<dominio>/`: lógica reutilizable por dominio (POS, Reports, Inventory, Cash Register, Transfers).
- `src/services/`: sincronización, SaaS, dispositivos y persistencia offline.
- `src/store/`: estado global y fachadas; evitar introducir lógica extensa nueva aquí.
- `src/lib/`: infraestructura transversal (Supabase, impresión ESC/POS, utilidades).
- `supabase/migrations/`: cambios de esquema y RPC; toda modificación de seguridad debe quedar versionada.

## Reglas de mantenimiento
1. Ningún TS/TSX/JS/JSX puede llegar a 4000 líneas. El auditor estricto falla en 4000+.
2. Extraer primero lógica pura; mantener efectos asíncronos y estado React cerca de la página hasta tener dependencias explícitas.
3. No duplicar reglas de negocio entre página, store y sincronización.
4. Las consultas Supabase deben filtrar por `company_id` y, cuando corresponda, por los IDs de registros padre ya acotados al tenant.
5. No revocar masivamente RPC `SECURITY DEFINER`; revisar autorización función por función.
6. Los cambios de nomenclatura Branch → Warehouse son progresivos para no romper datos ni flujo de trabajadores.

## Estado actual
- `useStore.ts`: 449 líneas.
- `POS.tsx`: 3817 líneas.
- `Reports.tsx`: 3950 líneas.
- `Inventory.tsx`: 1653 líneas.
- `Settings.tsx`: 1665 líneas.
- `offlineSync.ts`: 382 líneas.
- `supabaseSync/pull.ts`: 433 líneas.
