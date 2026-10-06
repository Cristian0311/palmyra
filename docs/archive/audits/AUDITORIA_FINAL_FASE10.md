# Auditoría final — Fase 10

## Áreas revisadas

- Dashboard
- Navegación y rutas
- Roles admin/cajero
- Configuración
- Inventario
- Compras / proveedores
- Transferencias
- Devoluciones / garantías
- Acciones destructivas y referencias antiguas

## Resultado

- No quedan referencias a `deleteCashSession`.
- No quedan referencias a `SupabaseRefreshModal`.
- No quedan referencias a `SyncLogsPanel`.
- No quedan etiquetas `Reactualizar Supabase`.
- No queda la acción `Eliminar este Turno`.
- Las ventas usan el concepto `Anular`.
- Los turnos usan `Cancelar`, conservando historial.
- Los productos/empleados usan descontinuación/desactivación cuando corresponde.
- Las órdenes de compra pendientes pueden cancelarse sin borrar el registro.
- Las devoluciones distinguen pendiente, completada y rechazada.
- Las transferencias se ejecutan mediante el flujo existente y no exponen un borrado de historial.
- El restablecimiento total sigue siendo una acción explícitamente separada en Zona Peligrosa y requiere escribir `ELIMINAR`.

## Punto pendiente deliberado

### Movimientos bancarios

El módulo bancario todavía permite eliminar manualmente un movimiento. No se cambió en esta fase porque el modelo actual no tiene un estado de anulación para `bank_transactions`. Convertirlo correctamente en `voided`/`reversed` requiere una modificación coordinada del tipo, Supabase, sincronización offline y ajuste de saldo para evitar doble aplicación.

Se conserva la funcionalidad existente en vez de introducir una migración parcial que pudiera afectar saldos históricos.

## Verificación

El código fue revisado mediante búsqueda estática de acciones destructivas y referencias obsoletas. La compilación TypeScript completa continúa dependiendo de instalar las dependencias (`node_modules` no están presentes en el paquete de trabajo).
