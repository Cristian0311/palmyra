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

## 6. Errores visuales corregidos

1. **105 estados `hover:` inertes.** Las utilidades `.bg-secondary`, `.bg-subtle`,
   `.bg-primary`, `.text-primary`, `.text-muted`, `.border-base` están escritas a mano en
   `@layer base` de `src/index.css`, y Tailwind v4 no genera variantes (`hover:`) para
   clases personalizadas. Por eso `hover:bg-subtle` (47 usos), `hover:bg-secondary` (12),
   `hover:bg-primary` (5) y `hover:text-primary` (41) no producían ningún cambio visual.
   Se añadió un bloque `@layer utilities` con esas variantes (verificado en el CSS
   compilado de producción).
2. **Insignia y estado del botón «Ocultos».** En la pestaña Ventas, el botón no indicaba
   cuándo se estaba viendo la lista de tickets ocultos; ahora se resalta en ámbar y cada
   fila oculta muestra la insignia «Oculto».

## 7. Errores visuales detectados y no modificados (requieren tu decisión)

- `src/pages/Quotes.tsx`: página huérfana (no enrutada). Al no tener acceso visual al
  navegador no se validó su diseño.
- Tablas anchas (`Reports.tsx` 2.522 líneas, `Inventory.tsx`, `POS.tsx`) usan `overflow-x-auto`
  pero no fijan `min-width`, por lo que en móviles las columnas se comprimen en lugar de
  desplazarse.
- `colSpan` fijos en tablas (8 columnas en reportes) son correctos hoy, pero frágiles si se
  añade o quita una columna.
- No se detectaron `dark:` sobre utilidades personalizadas (0 casos), por lo que el tema
  oscuro no depende de variantes inexistentes.

## 8. Pendiente recomendado (no aplicado)

- Generar `database.types.ts` (`supabase gen types typescript`) y tipar el cliente.
- Quitar la clave publicable embebida como *fallback* en `src/lib/supabase.ts`.
- Endurecer la RPC de visibilidad: exigir permiso de anulación, no solo `reports.view`.
- Añadir un índice específico en `notification_reads (company_id)` solo si en el futuro
  se filtran avisos por empresa sin usuario (hoy el índice `(user_id, company_id)` cubre
  el patrón real de consulta).

## 9. Correcciones aplicadas en la base de datos (2026-11-15)

Aplicadas en producción con migraciones rastreadas y rollback disponible. **Ningún dato
fue eliminado**: los valores anteriores quedan copiados en `metadata`.

**Migración `audit_fix_cash_session_chronology_and_legacy_cleanup`**

1. Constraint `cash_sessions_chronology_chk`: `closed_at >= opened_at` (validado sobre 78
   turnos). Impide que vuelva a existir un turno cerrado antes de abrirse.
2. Reparación de los **21 turnos** con fechas invertidas: se desplazó `closed_at` el mínimo
   número de días necesario (desfase real medido: −24 h, −48 h, −72 h, −96 h). El valor
   original queda en `metadata.chronology_repair.previous_closed_at`. Las ventas no se
   tocaron, por lo que los reportes de ventas por día no cambian.
3. Restos de MARÉ fuera del esquema expuesto: `legacy_pos_migration_staging` (1.898 filas),
   `legacy_pos_migration_map` (1.901), `mare_pre_migration_backup_20261010` (168) se
   movieron a `legacy_archive` conservando todos los datos.
4. Eliminado el índice redundante `idx_cash_sessions_cash_sessions_company_id_fkey`
   (`company_id` ya está cubierto por tres índices compuestos).

**Migración `audit_recompute_expected_cash_for_migrated_sessions`**

5. **15 turnos cerrados** migrados desde MARÉ tenían `expected_cash = 0` con ventas en
   efectivo. Se recalculó con datos ya almacenados (apertura + cobros en efectivo +
   movimientos) y se recalculó `difference`. Originales en
   `metadata.financial_repair.previous_expected_cash` / `.previous_difference`.

Resultado: 0 turnos con fechas invertidas, 0 turnos cerrados con esperado nulo salvo los
que no tuvieron efectivo, y 78/78 turnos con cronología válida.

## 10. Verificación del modo offline

Comprobaciones ejecutadas:

| Comprobación | Resultado |
|---|---|
| `scripts/pwa-offline-smoke.mjs` (build real de producción) | **8/8** |
| Precache del shell completo | 78 entradas |
| Supabase REST/Auth/Storage/Functions | `NetworkOnly` (nunca se sirve una respuesta vieja) |
| Rutas críticas precacheadas (POS, caja, reportes, discrepancias, cierre) | sí |
| Suite de pruebas offline (`offline-coverage`, `offline-network`, `offline-pos-auth`, `offline-reaudit-regressions`, `offline-saas-auth`, `team-access-offline-regressions`, `syncMerges`) | todas en verde |
| Total de pruebas unitarias | **82/82** |

Diseño verificado en código:

- Cola durable en IndexedDB por *scope* (empresa/usuario), con migración desde
  `localStorage`, fusión de fuentes y tombstones para no resucitar operaciones borradas.
- Si IndexedDB falla, la cola **no se sobrescribe**: se conserva en memoria y se respalda
  en `localStorage`.
- Reintentos con backoff exponencial persistido (`nextRetryAt`, 30 s → máx. 15 min),
  distinción entre error transitorio y permanente, y bloqueo de operaciones dependientes.
- Idempotencia por identificador de operación estable (`source_operation_id` único por
  empresa), por lo que un replay tras un timeout no duplica ventas ni movimientos.
- `navigator.onLine` no se usa solo: `isTransientNetworkError` detecta fallos de transporte
  aunque el navegador diga que hay conexión.

Limitación declarada: la prueba en dispositivo físico (cortar Wi-Fi en el POS real) no
puede ejecutarse desde este entorno; queda cubierta por el build + los tests anteriores.

