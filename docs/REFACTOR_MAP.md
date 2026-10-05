# PALMYRA — Mapa de trabajo arquitectónico

| Área | Archivo actual | Estado | Próximo paso |
|---|---|---|---|
| POS | `src/pages/POS.tsx` (~4500 líneas) | Parcialmente modularizado | separar checkout, sesión, impresión y hooks |
| Reportes | `src/pages/Reports.tsx` (~4700 líneas) | primeros helpers extraídos | separar datos, filtros, cálculos y vistas |
| Store | `src/store/useStore.ts` (~3700 líneas) | helpers puros extraídos | separar slices de dominio sin cambiar API |
| Offline | `src/services/offlineSync.ts` (~930 líneas) | reconciliación extraída | separar replay por dominio |
| Supabase mutations | `src/services/supabaseSync/mutations.ts` | 39 exports | dividir por dominio y mantener fachada |
| Supabase pull | `src/services/supabaseSync/pull.ts` | centralizado | separar cargas por dominio |
| RPC | `src/services/supabaseSync/rpc.ts` | wrapper central | separar por dominio |
| Inventario | `src/pages/Inventory.tsx` | pendiente | separar catálogo/stock/ajustes |
| Configuración | `src/pages/Settings.tsx` | pendiente | separar tabs y acciones críticas |
| Caja | `src/pages/CashRegister.tsx` | pendiente | separar apertura/cierre/movimientos |
| Excel | `src/utils/excelExport.ts` | parcial | extraer más hojas |
| SaaS | onboarding/auth/services | estable | pruebas E2E y casos de error |
| Seguridad DB | RLS/RPC | endurecida | revisar legado y Auth leaked passwords |
| Legacy | `fixrender/`, `.bak*`, SQL históricos | pendiente | archivar/eliminar controladamente |
