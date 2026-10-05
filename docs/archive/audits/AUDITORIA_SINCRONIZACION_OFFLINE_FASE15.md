# AUDITORÍA DE SINCRONIZACIÓN OFFLINE — FASE 15

## Problema reproducido/investigado

El flujo offline podía mostrar una sincronización completada aunque una venta no hubiera sido confirmada en Supabase, y la cola podía reaparecer después de recargar la tablet.

## Hallazgos críticos

1. `processOfflineQueue()` podía leer `memoryQueue` antes de que terminara la hidratación desde IndexedDB al arrancar/reconectar.
2. Las operaciones de IndexedDB (`put`, `delete`, `clear`) resolvían incluso cuando la transacción fallaba; el motor no podía distinguir persistencia correcta de fallo.
3. `processOfflineQueue()` actualizaba la cola en memoria y devolvía el resultado antes de esperar la persistencia durable del nuevo estado.
4. Una venta se consideraba sincronizada después de una respuesta RPC sin una comprobación explícita de que la fila `transactions` existía realmente.
5. Algunas pantallas mostraban “sincronización completa” aunque todavía quedaran operaciones pendientes.
6. `pushAllToSupabase()` ignoraba varios resultados de `safeUpsertMany()`, por lo que podía devolver éxito sin identificar todos los fallos de guardado.

## Correcciones

- Añadido `waitForOfflineQueueReady()`.
- `processOfflineQueue()` espera la hidratación de IndexedDB antes de inspeccionar la cola.
- Al terminar la migración, el watcher inicia automáticamente la cola cuando hay conexión y no está activado el modo manual.
- IndexedDB ahora rechaza explícitamente errores de `write`, `delete`, `clear`, `abort`.
- La cola espera a que la persistencia durable termine antes de informar el resultado.
- Si falla la persistencia local, las operaciones procesadas se conservan en la cola para reintento idempotente.
- Las ventas sincronizadas mediante RPC se verifican posteriormente en `transactions` por ID.
- Los mensajes de UI ahora distinguen entre sincronización completa e incompleta cuando quedan pendientes.
- `pushAllToSupabase()` registra fallos de `safeUpsertMany()` y devuelve `success:false` cuando corresponde.

## Seguridad contra duplicados

La RPC `process_pos_transaction_v2` usa el ID de la transacción como clave idempotente: si el ID ya existe, devuelve éxito sin volver a descontar inventario. Esto permite conservar una operación en la cola cuando falla la persistencia local y reintentarlo sin duplicar la venta.

## Estado de Supabase verificado durante la investigación

- No se observaron nuevas ventas correspondientes al último escenario descrito entre las transacciones más recientes consultadas.
- Inventario negativo: 0.
- SKU duplicados: 0.
- Nombres de producto duplicados: 0.
- Transacciones con sucursal huérfana: 0.
- Transacciones con usuario huérfano: 0.
- Inventario con producto huérfano: 0.
- Inventario con sucursal huérfana: 0.
- IDs de transacción duplicados: 0.
- Turnos abiertos al momento de la revisión: 0.

## Validación de código

La comprobación TypeScript sigue limitada porque el entorno no consiguió completar `npm ci`; faltan dependencias de React/Supabase/Vite. La comprobación de códigos de error de sintaxis TS/JSX no mostró errores de sintaxis. La instalación de dependencias volvió a superar 180 segundos.

## Próxima prueba recomendada en tablet

1. Abrir el POS con conexión.
2. Crear/abrir turno.
3. Desactivar Wi-Fi/datos.
4. Registrar una venta.
5. Confirmar que aparece una operación pendiente.
6. Cerrar y volver a abrir la aplicación offline para verificar que la cola sigue presente.
7. Restaurar conexión.
8. Esperar la sincronización o ejecutarla manualmente.
9. Confirmar que el contador queda en 0.
10. Confirmar en Reportes/Supabase que la venta existe y el inventario se descontó una sola vez.
11. Recargar la aplicación y confirmar que la cola sigue en 0.
