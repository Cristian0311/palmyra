# OmniSync POS — Restauración offline-first completa

## Objetivo

Reorganizar el comportamiento del POS para un entorno donde los terminales trabajan mayoritariamente offline y varios dispositivos vuelven a sincronizar con una Supabase real.

## Correcciones incluidas

### 1. Persistencia local
- Estado persistido en IndexedDB con escrituras agrupadas.
- La cola transaccional offline usa IndexedDB y mantiene compatibilidad con la cola antigua de localStorage.
- Las escrituras de la cola se serializan para evitar que operaciones cercanas se sobrescriban entre sí.
- Se conserva un `device_id` estable por terminal.

### 2. Sincronización
- Realtime ya no escucha todo el esquema público.
- Se limita a inventario y transacciones de la sucursal activa.
- Los cambios de inventario de Realtime se aplican directamente al caché local, sin volver a consultar toda la tabla.
- Se añadió una reparación periódica ligera del inventario de la sucursal.
- El primer arranque online del POS usa un bootstrap reducido en lugar de descargar todo el CRM/histórico.
- `pullAllFromSupabase()` queda reservado para recuperación/sincronización administrativa explícita.

### 3. Ventas offline/multi-POS
- Las ventas pasan por `process_pos_transaction_v2`.
- La RPC agrega las necesidades de stock por producto/variante antes de validar.
- Los locks se adquieren en orden determinista para reducir deadlocks entre POS.
- El `transaction.id` funciona como clave de idempotencia.
- Los errores de negocio de una RPC se marcan como conflicto y no se reintentan indefinidamente.

### 4. Inventario
- Se eliminaron del flujo normal del POS las escrituras absolutas tipo `stock = X`.
- Los ajustes utilizan `apply_inventory_adjustment_v2` y son deltas idempotentes.
- Los conteos/reconciliaciones utilizan `reconcile_inventory_v2` con `expected_quantity` para detectar cambios hechos por otro POS.
- Los snapshots antiguos de inventario no sobrescriben silenciosamente cambios remotos.
- `Guardar Datos Maestros` ya no sobrescribe el inventario ni inserta ventas directamente.

### 5. Histórico
- Una venta completada no se edita directamente.
- Las ventas recuperadas desde backup se vuelven a procesar por la RPC idempotente en vez de insertarse directamente, evitando crear ventas sin movimientos de inventario.

### 6. Rendimiento del POS
- El POS ya no se suscribe al store global completo.
- Usa un selector shallow para reducir renders provocados por cambios no relacionados.
- El store persistido excluye estados transitorios y datos bancarios pesados de la escritura frecuente.
- Las rutas siguen con code-splitting.

## SQL

Se actualizaron:
- `HOTFIX_OFFLINE_FIRST.sql`
- `SUPABASE_MIGRATION.sql`
- `update-schema.sql`

Las nuevas funciones importantes son:
- `process_pos_transaction_v2`
- `apply_inventory_adjustment_v2`
- `reconcile_inventory_v2`

## Importante

Esta restauración **no ejecuta SQL contra la Supabase real**. Los archivos SQL quedan preparados para aplicarse después del respaldo correspondiente.

La validación funcional completa se realizará después de terminar toda la restauración, tal como se acordó: primero estabilizar/reorganizar todo y luego probar los escenarios offline/online y multi-POS de extremo a extremo.


## Pasada adicional: operaciones críticas

Se completó una segunda pasada antes de las pruebas integrales:

- Devoluciones: el RPC bloquea la venta original durante la validación para impedir dos devoluciones concurrentes sobre el mismo saldo vendido.
- Transferencias: se agregan variantes repetidas antes de validar/mover stock y se bloquean origen/destino en orden determinista para evitar carreras A→B contra B→A.
- Transferencias: el frontend ya no hace un segundo upsert del registro después de que la RPC atómica confirma la operación.
- Devoluciones locales: se conserva el ID de operación generado por el formulario, evitando que el ID enviado al servidor difiera del mostrado en el POS.
- Caja offline: apertura/cierre y liquidación se conservan en la cola; los movimientos de caja ya no dependen exclusivamente de un fire-and-forget.
- Cola offline: la escritura espera a terminar la migración inicial de localStorage→IndexedDB, evitando que la primera operación offline pueda sobrescribir una migración concurrente.
- Datos maestros: se mantiene el patrón de cola existente para clientes/productos/categorías/sucursales cuando no hay conexión.

### Estado

La batería de pruebas funcionales/concurrentes **todavía no se ha ejecutado**, siguiendo el orden solicitado. La comprobación TypeScript no pudo completarse en este entorno porque las dependencias de `node_modules` no están instaladas y `npm ci` excedió el tiempo disponible.
