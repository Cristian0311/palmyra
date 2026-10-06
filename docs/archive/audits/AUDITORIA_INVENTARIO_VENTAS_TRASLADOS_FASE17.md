# Auditoría de Inventario — Fase 17

## Objetivo
Garantizar que las ventas normales e IDN descuenten del almacén correcto y que los traslados muevan existencias atómicamente entre origen y destino, sin doble descuento ni pérdida por reintentos offline.

## Hallazgos corregidos

1. `inventory_transfers` en la base de datos no tenía `operation_id`, aunque `process_inventory_transfer_v2` lo utilizaba para idempotencia. Esto hacía fallar los traslados en servidor.
2. Se añadió `operation_id`, se backfillaron los registros existentes con su `id` y se creó índice único para impedir duplicados.
3. La liquidación IDN (`LIQUIDACION_IDN`) estaba pasando por `processTransaction`, lo que podía descontar por segunda vez las unidades ya consumidas por las ventas reales. Ahora se registra como movimiento contable/reporting sin volver a consumir stock.
4. La cola offline reconoce las liquidaciones IDN como registros de transacción sin mutación física de inventario.
5. El cálculo de stock del POS usa el almacén del turno cuando existe, evitando discrepancias si `currentBranchId` cambia mientras el turno permanece abierto.

## Pruebas de base de datos

- Venta normal: RPC `process_pos_transaction_v2` comprobada en transacción reversible; el stock baja exactamente 1 unidad.
- Idempotencia de venta: repetir el mismo `transaction_id` no vuelve a descontar inventario.
- Traslado: `process_inventory_transfer_v2` comprobado en transacción reversible; origen baja 1 y destino sube 1.
- Idempotencia de traslado: repetir el mismo `operation_id` no vuelve a mover inventario.
- Inventario negativo actual: 0.
- Traslados sin `operation_id`: 0.
- Operaciones de traslado duplicadas: 0.
- Operaciones de traslado con delta neto distinto de cero: 0.

## Resultado
La capa de base de datos ya demuestra comportamiento atómico e idempotente para venta y traslado. El siguiente paso es la prueba funcional en dispositivo con el ZIP Fase 17, incluyendo modo offline y reconexión.
