# Auditoría funcional profunda — Fase 14

Fecha: 2026-09-26

## Objetivo

Revisar los flujos de negocio principales del CRM/POS después de las fases de UI, organización y rendimiento, priorizando guardado, operaciones offline, duplicidades e integridad del inventario sin eliminar datos históricos.

## Correcciones realizadas

1. **Cola offline de datos maestros**
   - Se ampliaron los tipos de cola y sus procesadores para usuarios, monedas, precios IDN, garantías, turnos de trabajo, cotizaciones, tarjetas bancarias, proveedores, órdenes de compra y auditorías de inventario.
   - Las mutaciones correspondientes ahora encolan cuando no hay conexión o cuando Supabase devuelve un error.
   - Las funciones que usan `safeUpsert` ahora comprueban explícitamente `result.error` para que un fallo de PostgREST no parezca un guardado exitoso.

2. **Salarios**
   - `updateSalarySettlement` antes actualizaba solamente el estado local.
   - Ahora sincroniza la liquidación modificada con Supabase y usa la cola offline mediante la mutación correspondiente.

3. **Recepción de compras offline**
   - Antes, al recibir una orden offline, se llamaba `adjustInventory` además de encolar `supplier_receive`.
   - Eso podía crear una segunda operación de inventario al reconectar.
   - Ahora la recepción usa una única operación de servidor (`receive_supplier_order_v2`) y el cliente solo actualiza su espejo local mientras está offline.

4. **Controles táctiles**
   - Se normalizaron los textos de botones que estaban por debajo de un tamaño empresarial legible (6–9 px).
   - Los botones interactivos pasan a 10 px como mínimo en su clase explícita; el CSS responsive existente mantiene áreas táctiles mayores en tablet/móvil.

## Verificación estática

- No hay llamadas `useStore()` sin selector en `src`.
- La comprobación de TypeScript no encontró códigos de error de sintaxis JSX/TS (TS1005, TS1109, TS1128, TS1160, TS138, TS1434, TS1472, etc.).
- El chequeo completo sigue mostrando errores de módulos porque el entorno no tiene `node_modules` instalado.
- `npm install --ignore-scripts --no-audit --no-fund` volvió a superar el límite de 180 segundos; por eso no se declara un build de producción exitoso.

## Verificación actual de Supabase

Se ejecutaron consultas de solo lectura sobre el proyecto activo:

- transacciones anuladas: 3 (corresponden al historial ya corregido; no se eliminaron).
- turnos abiertos: 0.
- inventario negativo: 0.
- SKU duplicado: 0.
- nombre de producto duplicado: 0.
- transacciones con sucursal huérfana: 0.
- transacciones con usuario huérfano: 0.
- inventario con producto huérfano: 0.
- inventario con sucursal huérfana: 0.
- IDs de transacción duplicados: 0.

Las 11 RPC operativas esperadas siguen presentes, incluyendo `cancel_cash_session_v2`, `process_pos_transaction_v2`, `void_pos_transaction_v2`, `receive_supplier_order_v2` y `complete_inventory_audit_v2`.

## No modificado deliberadamente

- No se eliminaron ventas, inventario, clientes ni historial.
- No se hizo una limpieza destructiva de Supabase.
- La eliminación física de movimientos bancarios se mantiene pendiente de un modelo contable de reversión adecuado; no se simuló una solución incompleta.

## Limitación

La prueba funcional con navegador real/build de producción queda pendiente porque la instalación de dependencias no terminó dentro del tiempo disponible. La revisión estática y las comprobaciones SQL sí fueron ejecutadas sobre esta fase.
