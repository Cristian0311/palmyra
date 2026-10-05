# Auditoría UI, rendimiento y persistencia — Fase 11

## Objetivo
Optimizar la navegación en teléfonos, tablets de gama baja y PC sin alterar el historial operativo ni eliminar datos.

## Cambios realizados
- Se eliminaron las fuentes Google remotas del CSS base; la interfaz usa fuentes del sistema si no están disponibles localmente.
- Se eliminaron `will-change: transform` aplicados de forma global a contenedores con scroll; esa propiedad podía aumentar el consumo de GPU/memoria sin beneficio constante.
- Se añadieron reglas responsive para tablet/móvil: tamaños táctiles mínimos, inputs de 16px para evitar zoom accidental y soporte de safe-area inferior.
- Las imágenes de catálogo/productos usan `loading="lazy"` y `decoding="async"`.
- Las páginas/componentes que usaban `useStore()` completo fueron migradas a selectores `useShallow`, evitando renders por cambios de estado no relacionados.
- Reports mantiene un selector acotado a sus dependencias reales.
- `catalogConfig` ahora se guarda en Supabase mediante `settings.catalog_config` y entra en la cola offline cuando no hay conexión o falla la escritura.
- `pushProductToSupabase` ahora encola el producto si Supabase no está disponible, si el dispositivo está offline o si el upsert falla.
- `addProduct` ya no intenta sincronizar un producto cuando la deduplicación local detectó que realmente no se añadió.

## Verificaciones
- `tsc --noEmit --skipLibCheck` no reportó errores de sintaxis JSX/TS después de las correcciones.
- La compilación completa no pudo ejecutarse en este entorno porque el ZIP no contiene `node_modules` y la instalación de dependencias agotó el tiempo disponible.
- Los errores restantes reportados por TypeScript corresponden a módulos/dependencias ausentes y a errores de tipado ya existentes en `Inventory.tsx`; no son errores de sintaxis introducidos por esta fase.
- No quedan llamadas `useStore()` sin selector en `src`.
- No quedan referencias a `Eliminar este Turno`, `Anular/Eliminar`, `Reactualizar Supabase`, `SupabaseRefreshModal` ni `SyncLogsPanel`.

## Punto deliberadamente no modificado
Los movimientos bancarios siguen teniendo acciones de eliminación física en el módulo bancario. No se cambió en esta fase porque una corrección correcta requiere modelar una anulación/reversión contable y verificar su efecto sobre saldos.
