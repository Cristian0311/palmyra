# TEST REPORT — OmniSync POS

## Automatizado

### PASS

- Parseo sintáctico de 37 archivos `.ts/.tsx` con TypeScript.
- Presencia de todas las RPC críticas y sus wrappers.
- Presencia de cola offline para ventas, anulaciones, devoluciones, transferencias, recepción de proveedores y auditorías.
- Verificación de que la ruta de venta espera confirmación antes de registrar movimientos bancarios.
- Verificación de ausencia de borrado físico de `transactions` en el servicio.
- Verificación de paginación para ventas, movimientos bancarios y turnos.
- Verificación de índices de idempotencia y unicidad crítica.
- Verificación de vistas de diagnóstico de sucursales.

### No ejecutado contra una base Supabase real

No hay credenciales/instancia de base de datos disponibles en el entorno de reparación, por lo que no se puede afirmar que las RPC hayan sido ejecutadas realmente contra el esquema remoto.

Tampoco se pudo ejecutar `npm run build`/`npm run lint` porque el entorno no dispone de las dependencias npm del proyecto y no tiene acceso al registro npm. El `tsc` global detectó principalmente módulos ausentes y errores de tipado que ya requieren las dependencias del proyecto; no aparecieron nuevos errores no relacionados en las zonas modificadas críticas.

## Casos que deben verificarse al aplicar `SUPABASE_MIGRATION.sql`

1. Venta con stock suficiente → exactamente un descuento.
2. Venta sin stock → rechazo y stock intacto.
3. Doble clic/reintento de la misma venta → una sola venta y un solo movimiento.
4. Venta de kit → descuentan sus componentes.
5. Anulación de kit → se restauran sus componentes una sola vez.
6. Dos devoluciones que superen lo vendido → segunda rechazada.
7. Transferencia repetida con mismo `operation_id` → una sola transferencia.
8. Dos recepciones de la misma orden → stock aplicado una sola vez.
9. Completar auditoría dos veces → segundo intento no modifica stock.
10. Dos aperturas simultáneas en una sucursal → solo una queda abierta.
11. Cierre/reintento de turno → una sola liquidación salarial.
12. Duplicados de `ALMACEN TIENDA GUINERA` / `ALMACEN ELÉCTRICO` → revisar `duplicate_branch_candidates` y `branch_usage_audit` antes de eliminar cualquier registro.
