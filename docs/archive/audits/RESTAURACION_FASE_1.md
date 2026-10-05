# OmniSync POS — Restauración fase 1

Esta versión está orientada a POS **offline-first** con múltiples dispositivos.
No modifica credenciales ni ejecuta cambios contra la Supabase real.

## Cambios incluidos

- Cola offline migrada de `localStorage` a IndexedDB, con migración automática de la cola antigua.
- Identificador permanente por dispositivo para operaciones offline.
- Eliminación de clientes también se sincroniza offline/online.
- Las ventas completadas ya no se pueden editar con `updateTransaction()`; deben corregirse mediante devolución/anulación.
- Realtime dejó de disparar `pullAllFromSupabase()` completo.
- Al reconectar se procesan primero las operaciones pendientes y luego se refresca solo el inventario de la sucursal.
- Realtime de `inventory`/`transactions` dispara refresco ligero de inventario, no descarga de todo el CRM.
- La RPC `process_pos_transaction_v2` reserva/descuenta stock dentro de la misma transacción mientras valida cada línea; esto corrige líneas repetidas y mejora la concurrencia entre POS.
- Se conserva `pullAllFromSupabase()` para sincronización inicial, recuperación y sincronización manual administrativa.

## Importante antes de producción

1. Haz un backup de la base Supabase real.
2. Revisa `HOTFIX_OFFLINE_FIRST.sql`.
3. Aplica **solo esa función SQL** en Supabase para corregir la venta multi-línea/concurrente.
4. Instala la aplicación corregida en **un solo POS** primero.
5. Prueba: venta offline → reconexión → venta desde otro POS → reconexión del primero → devolución/anulación.
6. No instales esta versión en todos los dispositivos hasta validar el flujo anterior.

## Validación local

Se verificó la sintaxis TypeScript de los archivos modificados mediante el compilador TypeScript. El `npm run lint` completo no pudo ejecutarse porque el entorno de trabajo no consiguió instalar las dependencias del proyecto antes del timeout; no se considera una prueba de compilación completa.
