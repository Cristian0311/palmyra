# Mapa de refactor PALMYRA

## Completado
- Estado global: extracción de transformaciones y hooks; `useStore.ts` reducido a 449 líneas.
- POS: recibos de venta, cierre y cálculos de checkout extraídos a `src/modules/pos/utils/`.
- Reports: exportación, descuadres, cálculos de sesión y tickets de impresión extraídos a `src/modules/reports/`.
- Inventory: vista de inventario, CSV y procesamiento de imágenes extraídos a `src/modules/inventory/utils/`.
- Cash Register: cálculo de salario/comisiones de turnos extraído.
- Transfers: cálculo de stock extraído.
- Offline: reconciliación y procesamiento del outbox extraídos.
- Supabase Sync: payload de ventas, operaciones auxiliares y mappers extraídos.
- Seguridad SaaS: caché de tenant invalidada al cambiar de cuenta; wrappers de onboarding/plan endurecidos con autenticación/propietario.
- Consultas hijas de sincronización acotadas por IDs de padres filtrados por tenant.
- CI: auditoría arquitectónica estricta y pruebas de regresión para módulos extraídos.

## Próximos límites
- Reducir gradualmente POS y Reports por debajo de 3500 líneas sin mover flujos críticos de estado/efectos.
- Continuar división de Settings cuando exista un bloque de dominio claramente aislable.
- Migrar `branchId`, `allowedBranches` y nombres derivados hacia `warehouseId`/terminología de almacén mediante compatibilidad progresiva.
- Completar QA funcional de impresora, cierre de caja, selección de vendedor, offline/reinicio y onboarding con escenarios reales.
- Mantener verificación de producción en Render después de cada lote de cambios.

## Criterio de aceptación
Cada cambio estructural debe pasar typecheck, tests, auditoría arquitectónica y build antes de integrarse a `main`. Los cambios de Supabase deben quedar además versionados como migración.
