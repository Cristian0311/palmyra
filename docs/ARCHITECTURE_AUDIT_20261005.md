# PALMYRA — Auditoría arquitectónica 2026-10-05

## Hallazgos

- La aplicación activa está en la raíz; `tsconfig.json` excluye `fixrender/`.
- `fixrender/` contiene una segunda copia de la aplicación con 99 equivalentes del árbol principal.
- Hay backups `.bak*` versionados dentro de `src/`.
- Hay SQL históricos fuera de `supabase/migrations/`.
- Los tres archivos de mayor riesgo son `src/pages/POS.tsx`, `src/pages/Reports.tsx` y `src/store/useStore.ts`.
- La sincronización offline y el transporte Supabase también concentran demasiadas responsabilidades.
- El modelo TypeScript conserva nomenclatura legacy `Branch/branchId` aunque el backend canónico es warehouse-centric.

## Orden de saneamiento

1. Eliminar o archivar duplicación de `fixrender/` sin perder blobs históricos.
2. Extraer lógica pura y de infraestructura del store.
3. Modularizar POS por catálogo, carrito, pagos, caja, impresión y checkout.
4. Modularizar Reportes por datos, filtros, cálculos y exportación.
5. Modularizar offline por replay de dominio y manejo de conflictos.
6. Modularizar Supabase sync por dominio.
7. Migrar progresivamente nomenclatura Branch -> Warehouse mediante compatibilidad.
8. Fortalecer CI con checks arquitectónicos y pruebas.
9. Auditar funcionalmente cada módulo con escenarios reales.

## Regla de seguridad

Ninguna extracción puede cambiar contratos externos del store o el comportamiento de una venta. Las operaciones críticas de inventario siguen teniendo a PostgreSQL/RPC como autoridad online y la cola durable como autoridad offline pendiente.
