# Mapa de refactor PALMYRA

## Completado en esta fase

- Saneamiento inicial: históricos retirados de la superficie raíz y conservados en `docs/archive/` y `scripts/archive/legacy/`.
- Verificación recursiva: sin `fixrender/`, `.bak`, `.orig`, `.rej`, HOTFIX, REPAIR ni LIVE_REPAIR en el árbol activo.
- Estado global: `useStore.ts` permanece en 449 líneas mediante action creators por dominio.
- POS: estado offline, printer/recibos, cierre imprimible y modales principales extraídos; `POS.tsx` quedó en 3.372 líneas.
- Reports: pestaña de ventas y detalle de ticket extraídos; `Reports.tsx` quedó en 3.492 líneas.
- Offline: procesamiento y reconciliación ya están separados; `offlineSync.ts` está en 382 líneas.
- Supabase Sync: mutations y pull ya están separados por dominios; no se consolidaron nuevamente.
- Excel: generadores de hojas separados por dominio y `excelExport.ts` convertido en fachada de 198 líneas.
- Settings: categorías, almacenes y configuración de empleados extraídos; página en 1.524 líneas.
- Warehouse migration: creada una frontera de compatibilidad canónica que prefiere `warehouseId/allowedWarehouseIds` y conserva `branchId/allowedBranches` solo como fallback. La política evita ampliar permisos accidentalmente.
- Inventory/Transfers/POS: las asignaciones de trabajador ya pueden resolverse mediante la frontera Warehouse sin romper los campos históricos.
- CI: validación por push/PR con TypeScript, tests unitarios, auditoría estructural y build; además cancela ejecuciones obsoletas por rama.

## Tamaños de mantenimiento actuales

| Archivo | Líneas |
| --- | ---: |
| `src/pages/POS.tsx` | 3.372 |
| `src/pages/Reports.tsx` | 3.492 |
| `src/store/useStore.ts` | 449 |
| `src/services/offlineSync.ts` | 382 |
| `src/services/supabaseSync/mutations.ts` | 295 |
| `src/services/supabaseSync/pull.ts` | 433 |
| `src/pages/Inventory.tsx` | 1.653 |
| `src/pages/Settings.tsx` | 1.524 |
| `src/pages/Transfers.tsx` | 995 |
| `src/pages/CashRegister.tsx` | 1.017 |
| `src/utils/excelExport.ts` | 198 |

## Próxima fase

La siguiente etapa debe ser funcional y de seguridad, no otro cambio de arquitectura global:

1. Auditoría módulo por módulo desde onboarding/login hasta cada área del CRM.
2. Validación multitenant real en Supabase y permisos por empresa/almacén.
3. Pruebas E2E de registro, login, permisos, POS, caja, offline/reinicio, impresión y sincronización.
4. Revisión final de Inventory, CashRegister, Transfers y Settings para extraer solo responsabilidades claramente aislables.
5. Migración progresiva restante de nombres Branch → Warehouse.
6. Verificación contra Render y smoke test de producción.

## Criterio de aceptación

Cada lote estructural debe pasar TypeScript, pruebas unitarias, auditoría arquitectónica y build antes de integrarse a `main`. Las migraciones de Supabase deben permanecer versionadas y las operaciones críticas de negocio no deben perder su persistencia offline ni sus límites de tenant.

Fecha: 2026-10-05.
