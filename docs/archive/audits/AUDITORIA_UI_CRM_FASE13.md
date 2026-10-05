# AUDITORIA UI, ORGANIZACION Y GUARDADO — FASE 13

## Objetivo
Pasada integral posterior a Fase 12 para mejorar la consistencia de CRM/POS en móvil, tablet y PC, reducir acciones visualmente pequeñas, revisar duplicidades y evitar operaciones de navegador que puedan afectar el estado local.

## Revisión realizada
- Reportes y detalle de producto revisados en Fase 12 y conservados como base.
- Auditoría estática de las páginas principales: Dashboard, POS, Inventario, Clientes, Proveedores, Reportes, Configuración, Bancos, Devoluciones y Transferencias.
- No quedan llamadas `useStore()` sin selector en `src`.
- No se encontraron referencias a controles eliminados: `Eliminar este Turno`, `Anular/Eliminar`, `Reactualizar Supabase`, `SupabaseRefreshModal`, `SyncLogsPanel` ni `Entendido`.
- No quedan botones con clases de texto interactivo de 6–8px.

## Correcciones Fase 13
### Botones
- Acciones de tarjetas bancarias `Editar`, `Transferir` y `Eliminar` pasan de texto de 6.5px a 9px, con área táctil compacta de 32px en escritorio y 40px mediante la regla responsive en pantallas pequeñas.
- Acciones principales de Devoluciones que usaban 8px pasan a 9px.
- Se mantiene una altura mínima global de 40px para controles táctiles en <=1023px.
- Reportes mantiene mínimo 36px en escritorio y 40px en tablet/móvil.

### Caché del navegador
- `Limpiar Caché Local` se renombró a `Limpiar caché del navegador` para no confundirlo con los datos operativos.
- Ya no borra claves de `localStorage` de la aplicación.
- Ya no desregistra el Service Worker.
- Limpia `sessionStorage` y Cache Storage del navegador; después recarga la aplicación.
- Ventas, inventario y estado operativo persistido en IndexedDB no se eliminan por esta acción.

### Guardado y duplicidades
- Se conserva la arquitectura de guardado y sincronización de Fases anteriores.
- No se introdujeron operaciones destructivas nuevas.
- Las anulaciones de ventas y turnos continúan conservando historial.
- El borrado físico de movimientos bancarios no se modificó en esta fase porque requiere un modelo contable de reversión para hacerlo correctamente.

## Verificación
- Búsqueda de referencias antiguas: sin resultados.
- Búsqueda de botones interactivos con texto 6–8px: sin resultados.
- `tsc --noEmit --skipLibCheck`: no se detectaron códigos de error de sintaxis JSX/TS (TS170xx/TS138xx/TS100xx/TS1128/TS1109/TS1160/TS1434/TS1472). El chequeo completo sigue condicionado por dependencias de `node_modules` ausentes y errores de tipos ya conocidos.
- No se ejecutó build de producción completo porque las dependencias no están instaladas en el entorno de trabajo.

## Criterio de diseño
La interfaz prioriza una jerarquía empresarial: acción principal visible, acciones secundarias agrupadas, texto legible, tablas desplazables cuando el ancho no alcanza y áreas táctiles adecuadas para tablet/móvil.
