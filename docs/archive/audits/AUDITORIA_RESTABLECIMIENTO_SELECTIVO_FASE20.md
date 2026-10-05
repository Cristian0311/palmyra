# Auditoría — Restablecimiento selectivo Fase 20

## Objetivo
Convertir el botón "Restablecer Todo" de Configuración en un flujo selectivo por módulos.

## Comportamiento
1. El botón abre un selector visual.
2. Cada módulo tiene una casilla independiente.
3. Se puede marcar/desmarcar cualquier combinación.
4. "Marcar todo" selecciona todos los módulos; "Desmarcar todo" los quita.
5. La acción requiere seleccionar al menos un módulo y escribir `ELIMINAR`.
6. El backend/local state solo procesa los módulos seleccionados.
7. Si hay operaciones pendientes en la cola offline y se intenta restablecer un módulo operativo, la operación se bloquea para evitar pérdida de datos.
8. Si Supabase no puede limpiar un módulo, no se aplica el borrado local de esa selección.
9. Tras completar correctamente, se recarga la aplicación para hidratar el estado limpio.

## Módulos disponibles
- Inventario: existencias, movimientos y transferencias.
- Reportes e historial: ventas, turnos, devoluciones, garantías, auditorías y movimientos bancarios históricos.
- Catálogo: productos, categorías y precios IDN.
- Clientes.
- Proveedores.
- Compras.
- Caja y turnos.
- Bancos.
- Usuarios y empleados (restaura localmente al administrador inicial).
- Sucursales.
- Cotizaciones y pedidos.
- Configuración: tasas de moneda y valores de configuración restablecibles.

## Validaciones realizadas
- Tablas de Supabase verificadas antes de definir las operaciones.
- `currencies` no tiene columna `id`; el borrado selectivo usa `code`.
- Se eliminaron referencias a tablas inexistentes (`pending_orders`, `receipt_configs`, `store_configs`, `catalog_configs`) del limpiador remoto.
- Llaves `{}` balanceadas en `Settings.tsx`, `useStore.ts` y `mutations.ts`.
- El proyecto no tiene `node_modules` disponible en este entorno; por eso `tsc --noEmit` completo no pudo ejecutarse.
- El flujo conserva la protección contra operaciones offline pendientes.

## Nota
El restablecimiento selectivo es una operación destructiva y no tiene deshacer. Debe utilizarse con la confirmación explícita `ELIMINAR`.
