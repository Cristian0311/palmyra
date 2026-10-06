# Reestructuración Fase 2 — POS offline-first

## Objetivo
Separar responsabilidades de los módulos grandes sin reducir líneas de forma artificial y sin cambiar el contrato público de sincronización usado por `useStore.ts`.

## Cambios

### `src/services/supabaseSync.ts`
Se convirtió en una fachada de 11 líneas que conserva todos los exports existentes y delega en:
- `supabaseSync/core.ts`: tipos y helpers compartidos (`fetchAllRows`, `safeUpsert`, `safeUpsertMany`).
- `supabaseSync/pull.ts`: lectura/bootstrap desde Supabase.
- `supabaseSync/mutations.ts`: altas, cambios, eliminaciones y operaciones de datos.
- `supabaseSync/rpc.ts`: llamadas RPC de operaciones críticas.
- `supabaseSync/diagnostics.ts`: diagnósticos y push completo.
- `supabaseSync/cleanup.ts`: limpieza cloud.

Esto mantiene la API importada por el store y separa las responsabilidades de sincronización.

### `src/pages/POS.tsx`
Se redujo de 5,647 a 5,273 líneas y, más importante, se sacaron dos superficies que no son necesarias durante el flujo inicial del POS:
- `POSReceiptModal.tsx` — carga diferida al abrir un ticket.
- `POSPrinterSetupModal.tsx` — carga diferida al abrir configuración de impresora.

Ambos se cargan mediante `React.lazy`, por lo que su código no forma parte del trabajo inicial del componente POS.

### `src/pages/Reports.tsx`
Se redujo de 6,462 a 6,258 líneas.
- `hooks/useReportsAnalytics.ts` concentra procesamiento de gráficas, filtros de transacciones/transferencias y estadísticas IDN.
- La página queda enfocada principalmente en estado de UI, acciones y presentación.

### `src/store/useStore.ts`
Se redujo de 2,372 a 2,306 líneas.
- `store/storeInitialData.ts` contiene los datos iniciales/configuración base del store.
- El store conserva la misma interfaz y comportamiento esperado.

### `Settings.tsx` e `Inventory.tsx`
No se dividieron artificialmente en esta fase. `Inventory.tsx` ya delega varias responsabilidades a componentes especializados (`PrintLabels`, `ABCAnalysis`, `RestockAlerts`, `TransferHistory`), y dividir más sus formularios requeriría una capa de props/contexto sin una ganancia clara para el arranque offline del POS.

## Verificación
- Se comprobó que las importaciones relativas locales nuevas resuelven correctamente.
- Se ejecutó el parser/TypeScript sobre los módulos modificados: no aparecieron errores de sintaxis en la reestructuración.
- La comprobación completa de tipos/build no pudo completarse porque `npm ci --ignore-scripts` agotó el tiempo disponible dos veces antes de instalar las dependencias.

Por tanto, esta fase no debe considerarse todavía una aprobación final de compilación/pruebas; la lógica no se ha sometido aún al build completo del proyecto.
