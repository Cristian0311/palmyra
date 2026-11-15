# Auditoría y correcciones — 2026-11-15

Auditoría realizada sobre `Cristian0311/palmyra` (rama `main`, commit `f45ac5c`) y el
proyecto Supabase **PALMYRA** (`hmcvujyqloyjdvngpdxz`, Postgres 17.11).

Validación ejecutada en local:

- `tsc --noEmit` → **0 errores**.
- `tsx --test tests/unit/*.test.ts` → **82/82 pruebas correctas**.

## 1. Eliminar reporte (pestaña Reportes)

Estado anterior: el botón existía, pero **solo ocultaba el ticket en `localStorage`**
(`palmyra:hidden-sales-report-ids:v2`). No se persistía en Supabase, por lo que el
ticket reaparecía en otro dispositivo o al limpiar el navegador. La RPC
`palmyra_set_sale_report_hidden` ya existía en la base de datos, pero **ningún código
la llamaba** y su migración no estaba en el repositorio.

Estado actual:

- `src/services/supabaseSync/rpc.ts` → nueva `callSetSaleReportHiddenRPC` (valida UUID,
  usa la RPC con `SECURITY DEFINER`, nunca anula la venta).
- `src/services/supabaseSync/pull.ts` → mapea `sales.metadata.report_visibility` a
  `Transaction.reportHidden` / `reportHiddenAt`.
- `src/types.ts` → nuevos campos `reportHidden` y `reportHiddenAt`.
- `src/pages/Reports.tsx` → ocultar/restaurar persiste en Supabase, mantiene caché
  local optimista y reconcilia lo hecho en otros dispositivos.
- `src/components/reports/ReportsSalesTab.tsx` → insignia «Oculto», estado activo del
  botón «Ocultos (n)».
- `supabase/migrations/20261103025016_persist_sales_report_visibility.sql` → restaura
  la migración que ya estaba aplicada en la base de datos y no estaba versionada.

Nota de diseño: ocultar afecta **solo a la lista de reportes**. La venta, los pagos y
los movimientos de inventario permanecen intactos; los totales de caja no se alteran.
Para anular una venta sigue existiendo el botón de anular (`deleteTransaction`).

## 2. Archivos eliminados

Sin referencias en `src/`, `tests/` ni `scripts/` (verificado con `git grep`):

| Archivo | Motivo |
|---|---|
| `src/pages/RegisterAdmin.tsx` | Página no enrutada en `App.tsx` |
| `src/components/SyncLogsPanel.tsx` | Componente sin importaciones |
| `src/components/StockDiagnosticModal.tsx` | Componente sin importaciones |
| `src/components/SupabaseRefreshModal.tsx` | Componente sin importaciones |
| `docs/archive/sql/*` (11 archivos) | Volcados de esquema obsoletos (~250 KB); la fuente de esquema es `supabase/migrations/` |

## 3. Candidatos a eliminar o mover (no eliminados para no perder funcionalidad)

| Elemento | Situación | Recomendación |
|---|---|---|
| `src/pages/Quotes.tsx` | Página completa sin ruta en `App.tsx` (solo se usan los datos de `quotes`) | Añadir ruta `/quotes` o eliminar |
| Tablas `legacy_pos_migration_*`, `mare_pre_migration_backup_20261010` | Restos de la migración MARÉ (1.898 + 1.901 + 168 filas) | Respaldar y eliminar |
| Tablas `exchange_rate_*`, `notification_outbox`, `notification_summary_runs` | RLS activo sin políticas (acceso solo `service_role`) | Documentar o añadir políticas |
| RPC heredadas sin uso en el frontend | `create_sale_transaction`, `open_cash_session`, `close_cash_session`, `record_cash_movement`, `post_inventory_transfer`, `transfer_between_bank_accounts`… | Deprecar `drop function` tras confirmar que no hay integraciones externas |
| Índices redundantes | `sales`: 12 índices (pares duplicados), `cash_sessions`: 10 | Consolidar índices equivalentes |
| `docs/archive/audits/*` | Auditorías históricas | Conservar como histórico o archivar fuera del repo |

## 4. Hallazgos de base de datos (sin borrar datos)

1. **21 turnos con `closed_at` anterior a `opened_at`** (turnos 28, 33, 38, 39, 41, 46,
   47, 49, 52, 55, 56, 58, 63, 67, 68, 69, 73, 74, 75, 76, 78). El desfase es de −24 h,
   −48 h, −72 h o −96 h: al cambiar la fecha de negocio de un turno
   (`palmyra_update_cash_session_business_date_v2`) se reescribe `opened_at`, pero
   `closed_at` conserva la hora real. Recomendación: almacenar la fecha de negocio en
   `metadata.business_date` y dejar `opened_at` inmutable.
2. **4 ventas con total distinto a la suma de pagos** (datos heredados de MARÉ):
   `1ef884fd-ecd7-433e-91dc-19ee2cac94c3` (total 600 / pagos 29.200),
   `6a92d970-d259-4ef1-a4cb-03a463d5604d` (26.600 / 13.350),
   `834f886b-f544-4ab2-af7a-633b70d55b41` (30.000 / 40 USD×780),
   `64421c8e-312e-4423-b301-4c1a611e8914` (27.350 / 23.050). Requieren validación
   manual antes de ajustar; no se modificaron.
3. **19 turnos cerrados con diferencia ≠ 0**; la mayoría son turnos migrados con
   `expected_cash = 0` y `physical_cash` con el total del día (falta de cálculo de
   esperado en el histórico). El único reciente: turno 74 (2026-11-11), diferencia
   −92.040.
4. Sin `SECURITY DEFINER` sin `search_path` fijo (148 funciones auditadas).
5. RLS habilitado en las 85 tablas; 8 sin políticas (deny-all intencional).
6. Integridad: 0 ventas sin turno, 0 ventas sin almacén, 0 stock negativo,
   0 turnos abiertos > 48 h, 0 números de turno duplicados.
7. `sales` tiene 12 índices y `cash_sessions` 10; hay pares redundantes
   (`sales_quote_idx` / `sales_quote_id_fk_idx`,
   `idx_cash_sessions_cash_sessions_company_id_fkey` / `cash_sessions_company_status_idx`).

## 5. Pendiente recomendado (no aplicado)

- Generar `database.types.ts` (`supabase gen types typescript`) y tipar el cliente.
- Quitar la clave publicable embebida como *fallback* en `src/lib/supabase.ts`.
- Endurecer la RPC de visibilidad: exigir permiso de anulación, no solo `reports.view`.
- Añadir la migración de índice `notification_reads (company_id)` si se filtran avisos
  por empresa sin usuario.
