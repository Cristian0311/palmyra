# Auditoría visual y funcional — Fase 5

## Criterio
Se conservaron datos y lógica transaccional. La limpieza se centró en reducir opciones duplicadas, controles de mantenimiento que no deben estar expuestos al operador y diagnósticos heurísticos presentados como si fueran evidencia.

## Cambios aplicados

### POS
- Eliminado el control de «Reactualizar Total Supabase».
- Se conserva el estado Online/Offline y la subida de operaciones pendientes.
- Eliminado el diagnóstico externo por IA del descuadre de caja.
- Eliminada la heurística que intentaba asociar un monto de descuadre con productos por coincidencia de precio.
- El cierre conserva el cálculo determinista de faltante/sobrante y la decisión administrativa sobre la liquidación.

### Reportes
- Eliminado «Organizar con IA» y el modal de diagnóstico financiero IA.
- Conservado el historial y los campos históricos `aiDiagnostic` para no destruir información ya guardada.
- Exportación Excel permanece como acción principal.
- Pestañas simplificadas visualmente: Ventas, Nómina, Cajas, Descuadres, Movimientos, Transferencias, Inventario e IDN.
- Eliminada la pestaña «Integridad» porque no tenía una vista renderizada propia en este componente; la integridad de datos pertenece a la auditoría y a los diagnósticos del sistema, no a una pestaña vacía.
- Navegación de reportes convertida en una franja horizontal para evitar saltos y exceso de botones.

### Auditoría de inventario
- Eliminado el «Análisis Inteligente» heurístico de cada discrepancia.
- Se conserva el conteo ciego, búsqueda, diferencias y ajuste final.
- Las diferencias ahora se identifican neutralmente como `Faltante` o `Sobrante`, sin atribuir una causa sin evidencia.
- Ajustados nombres de columnas: Auditoría/Fecha, Artículos, Diferencia y Ver.
- Se mantiene el historial y la posibilidad de continuar una auditoría pendiente.

### Configuración
- Eliminado «Reactualizar Todo con Supabase».
- Eliminado el panel visible de monitor de logs en tiempo real.
- Se conserva el diagnóstico de conexión y la sincronización administrativa de datos maestros donde todavía tienen utilidad.

### Archivos retirados
- `src/components/SupabaseRefreshModal.tsx`
- `src/components/SyncLogsPanel.tsx`

Los logs internos siguen existiendo para diagnóstico del motor offline; se retiró únicamente su interfaz permanente para usuarios.

## Verificación
- TypeScript ya no reporta errores de sintaxis/JSX en POS, Reportes, Auditoría de Inventario ni Configuración.
- La comprobación completa de tipos queda limitada por la ausencia de `node_modules` en el entorno; `npm ci` agotó el tiempo disponible.
- La base Supabase permanece con 153 productos, 229 filas de inventario, 26 transacciones y 9 sesiones de caja.
- Inventario negativo: 0.
- Claves de inventario duplicadas: 0.
- `inventory_movements`: presente.
