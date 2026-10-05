# Mapa de refactor PALMYRA

## Completado

- Saneamiento inicial: históricos movidos a `docs/archive/` y `scripts/archive/legacy/`; raíz libre de los artefactos detectados.
- Estado global: `useStore.ts` reducido a 449 líneas mediante action creators por dominio.
- POS: pagos, scanner, recibos, impresión, offline-status y cierre imprimible extraídos a módulos/componentes.
- POS: `src/pages/POS.tsx` reducido a 3.372 líneas, por debajo del límite estructural de 3.500.
- Reports: contexto, nómina, sesiones, exportación, impresión, cálculos de descuadre, gráficos y modal de regularización ya están fuera de la página.
- Reports: pestaña de ventas y modal de detalle de ticket extraídos; `src/pages/Reports.tsx` quedó en 3.492 líneas.
- Offline: procesamiento principal y reconciliación ya separados de otras responsabilidades.
- Supabase Sync: mutations/pull y mappers/payloads ya separados por dominio.
- CI: typecheck, unit tests, auditoría arquitectónica y build forman parte del pipeline.

## Próximos límites

- Continuar la división de POS y Reports por tab/modal cuando aparezca una responsabilidad claramente aislable.
- Dividir Inventory, Settings y CashRegister por dominio sin alterar el flujo de trabajadores.
- Migrar progresivamente `branchId`, `allowedBranches` y nombres derivados a `warehouseId` mediante compatibilidad, sin cambiar de golpe contratos de runtime.
- Fortalecer QA con escenarios reales de onboarding, multiempresa, permisos, caja, vendedor, offline/reinicio y printer.
- Mantener verificación de producción en Render después de cada lote.

## Criterio de aceptación

Cada cambio estructural debe pasar typecheck, tests, auditoría arquitectónica y build antes de integrarse a `main`. Los cambios de Supabase deben quedar versionados como migración.
