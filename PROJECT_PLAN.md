# PALMYRA — Arquitectura y hoja de ruta vigente

## Fuente de verdad

PALMYRA es una aplicación SaaS multitenant con React 19, Vite, Zustand, Supabase Auth/PostgreSQL/RLS/RPC y PWA/offline-first.

La aplicación activa vive en la raíz del repositorio. `fixrender/` es una copia histórica y no participa en el build.

## Modelo de negocio

La jerarquía canónica es:

`Empresa → Almacenes → Empleados/Usuarios → Roles/Permisos → Acceso por Almacén`

El inventario es por almacén. `branchId/currentBranchId` solo permanece como compatibilidad temporal del frontend y será migrado progresivamente a nomenclatura `warehouseId`.

## Autoridad de datos

### Online
UI → RPC/servicio de dominio → PostgreSQL → espejo local.

### Offline
UI → estado local → cola durable IndexedDB → replay al recuperar conexión → RPC idempotente → reconciliación.

Las operaciones críticas no deben aplicar dos veces el mismo movimiento.

## Estructura objetivo

La refactorización es incremental y conserva las fachadas actuales para evitar regresiones.

```
src/
├── app/
├── modules/
│   ├── pos/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── services/
│   │   ├── utils/
│   │   └── types.ts
│   ├── inventory/
│   ├── reports/
│   ├── cash/
│   ├── banking/
│   ├── team/
│   └── saas/
├── services/
│   ├── offline/
│   ├── fiscal/
│   └── supabaseSync/
├── store/
│   ├── slices/
│   └── utils/
├── components/
├── hooks/
├── types/
└── utils/
```

## Archivos prioritarios actuales

P0:
- `src/pages/POS.tsx`
- `src/pages/Reports.tsx`
- `src/store/useStore.ts`
- `src/services/offlineSync.ts`
- `src/services/supabaseSync/mutations.ts`
- `src/services/supabaseSync/pull.ts`

P1:
- Inventory, Settings, CashRegister, Transfers
- Team, SaaSOnboarding, SaaSAuth
- `src/services/supabaseSync/rpc.ts`
- exportación Excel

## Reglas de refactor

1. No cambiar contratos públicos del store sin fachada compatible.
2. No modificar migraciones históricas; las correcciones nuevas son migraciones incrementales.
3. PostgreSQL/RPC sigue siendo autoridad para operaciones críticas online.
4. La cola durable es autoridad para operaciones pendientes offline.
5. No reintroducir el modelo de sucursal en la base de datos.
6. No hacer refactors masivos de una sola vez.
7. CI debe pasar antes de integrar.
8. Cada extracción debe conservar comportamiento.
9. Los archivos `.bak`, copias de aplicación y SQL históricos no productivos deben archivarse/eliminarse solo con revisión controlada.
10. Las operaciones destructivas de datos requieren confirmación explícita en UI.

## QA

El CI ejecuta:
- TypeScript
- auditoría arquitectónica
- pruebas unitarias de utilidades críticas
- build Vite/esbuild

La cobertura debe crecer hacia escenarios de:
- POS online/offline
- inventario/traslados
- caja/turnos
- devoluciones
- equipo/roles
- multitenancy
- onboarding y suscripciones
