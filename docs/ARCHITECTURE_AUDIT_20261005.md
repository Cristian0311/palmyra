# PALMYRA — Auditoría arquitectónica 2026-10-05

## Estado posterior al saneamiento

La aplicación activa permanece en la raíz del repositorio. Esta auditoría comenzó con referencias históricas a `fixrender/`, backups y SQL de reparación en la superficie raíz; esos artefactos ya no forman parte del árbol activo de esta rama.

### Limpieza realizada

- `fixrender/`: no existe en el árbol activo de `main` ni en la rama de refactor.
- Artefactos históricos de auditoría/reparación: archivados bajo `docs/archive/`.
- SQL histórico fuera de `supabase/migrations/`: archivado bajo `docs/archive/sql/`.
- Scripts de pruebas/parches temporales: archivados bajo `scripts/archive/legacy/`.
- Binarios/residuos raíz `omnisync-pos-reparado-fase28-estabilidad.zip` y `Gg`: retirados.
- No se modificó la lógica de negocio de ventas, inventario, caja, pagos, offline o permisos como parte del saneamiento.

## Tamaños actuales de los focos principales

| Archivo | Líneas actuales |
| --- | ---: |
| `src/store/useStore.ts` | 449 |
| `src/pages/POS.tsx` | 3.372 |
| `src/pages/Reports.tsx` | 3.492 |
| `src/services/offlineSync.ts` | 382 |
| `src/services/supabaseSync/mutations.ts` | 295 |
| `src/services/supabaseSync/pull.ts` | 433 |
| `src/pages/Inventory.tsx` | 1.653 |
| `src/pages/Settings.tsx` | 1.665 |
| `src/pages/Transfers.tsx` | 995 |
| `src/pages/CashRegister.tsx` | 1.017 |

## Modularización ya existente

PALMYRA ya dispone de límites de dominio bajo `src/modules/` y de acciones separadas bajo `src/store/actions/`.

POS cuenta actualmente con hooks/utilidades para pagos, scanner, offline y printer/recibos. Reports cuenta con hooks/utilidades para exportación, impresión, nómina, sesiones y contexto.

## Riesgos restantes

1. POS y Reports siguen siendo los dos componentes de presentación más grandes y deben continuar dividiéndose por dominio visual.
2. Inventory, Settings y CashRegister todavía pueden dividirse cuando exista una frontera de responsabilidad clara.
3. La nomenclatura TypeScript conserva compatibilidad histórica `branchId`/Branch mientras el backend es warehouse-centric.
4. CI debe crecer desde typecheck/tests/audit/build hacia pruebas de integración de flujos críticos.
5. La verificación funcional debe cubrir onboarding, permisos multiempresa, POS offline/reinicio, caja, vendedor e impresión real.

## Regla de seguridad

Ninguna extracción estructural puede cambiar contratos externos del store ni el comportamiento de una venta. Las operaciones críticas de inventario siguen teniendo PostgreSQL/RPC como autoridad online y el outbox durable como autoridad offline pendiente.

Fecha de actualización: 2026-10-05.
