# Auditoría adicional de errores — Fase 16

Fecha: 2026-09-26

## Hallazgos corregidos

1. **Cola offline con tipo `bank_transaction` sin procesador**
   - El tipo existía y se encolaba correctamente, pero `processQueueItem()` no tenía un `case 'bank_transaction'`.
   - El `default` devolvía `true`, por lo que una operación bancaria offline podía desaparecer de la cola sin escribirse en Supabase.
   - Corregido: altas y eliminaciones de movimientos bancarios se procesan explícitamente.

2. **Apertura de turno offline con ID diferente al creado en Supabase**
   - El turno local se guardaba como `Turno-N`, pero al sincronizar `open_cash_session_v2` generaba otro ID en el servidor.
   - Las ventas offline conservaban el `sessionId` local, por lo que podían llegar después a una sesión inexistente y ser rechazadas.
   - Corregido con `open_cash_session_v3`, que conserva el ID local estable y hace la apertura idempotente.
   - Los nuevos turnos abiertos offline usan un identificador estable `Turno-N-<sufijo>` para evitar colisiones entre dispositivos.

3. **Persistencia de IndexedDB podía fallar sin impedir una falsa limpieza de cola**
   - Se mejoró el seguimiento de errores de persistencia y la espera de escritura.
   - Si el servidor confirma una operación pero la cola local no puede persistir su nuevo estado, las operaciones se conservan para reintento.

4. **Lectura inicial de IndexedDB podía tratar un error de lectura como cola vacía**
   - Se evitó reemplazar la cola persistida cuando una lectura falla.
   - Esto reduce el riesgo de perder operaciones pendientes durante el arranque.

5. **Ventas con garantía podían quedar sin registro de garantía en Supabase**
   - `applyLocalCompletedSale()` generaba la garantía en memoria, pero no la enviaba por el mismo flujo offline-first.
   - Corregido: cada garantía generada por una venta se envía inmediatamente online o queda encolada offline.

6. **Mensajes de sincronización podían decir “completada” aunque quedaran operaciones**
   - Corregidos los mensajes del POS y del watcher automático para distinguir sincronización completa de sincronización incompleta.

7. **Eliminación de movimientos bancarios no era durable offline**
   - La eliminación local podía ejecutarse mientras la eliminación remota fallaba y no se encolaba.
   - Corregido mediante una operación `bank_transaction` con `__operation: 'delete'`.

## Hallazgos observados y no necesarios para esta prueba

- Supabase Advisor mantiene un aviso de índices duplicados en `inventory`; no se eliminó automáticamente para evitar una modificación de esquema no relacionada con la prueba.
- Existen avisos de rendimiento por claves foráneas sin índices y avisos de seguridad/RLS heredados en otras tablas. No son la causa directa del fallo de sincronización POS investigado.
- Las funciones RPC principales de POS están publicadas y `process_pos_transaction_v2` es `SECURITY INVOKER`; se verificó que existe con la firma esperada.

## Estado de integridad revisado

- Movimientos bancarios huérfanos respecto a ventas: 0.
- La nueva RPC `open_cash_session_v3` quedó creada y verificada en Supabase.
- Los tipos declarados de la cola offline tienen ahora un `case` explícito; no quedan tipos sin procesador.

## Próxima prueba recomendada

La prueba debe realizarse sobre la versión Fase 16 y debe comprobar, en este orden:

1. turno abierto online o apertura offline;
2. venta POS sin conexión;
3. persistencia de la cola tras cerrar/reabrir la aplicación;
4. reconexión;
5. cola en 0 únicamente cuando las operaciones estén confirmadas;
6. existencia de la venta en Supabase;
7. inventario descontado exactamente una vez;
8. si el pago fue por transferencia, existencia del movimiento bancario;
9. si el producto tenía garantía, existencia de la garantía;
10. recarga completa de la aplicación sin que reaparezca la operación.
