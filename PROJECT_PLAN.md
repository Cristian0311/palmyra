# PALMYRA — hoja de ruta actual

## Estado

La aplicación ya dispone de autenticación SaaS, empresa, almacén, planes, equipo, permisos, POS, inventario, caja, reportes, proveedores, bancos, devoluciones, auditoría y sincronización offline.

## Prioridad 1 — estabilidad y mantenibilidad

- Reducir gradualmente `Reports.tsx`, `POS.tsx` y `useStore.ts`.
- Separar servicios por dominio sin romper las exportaciones actuales.
- Centralizar tipos y contratos de almacén/empleado.
- Eliminar código duplicado y artefactos legacy.
- Añadir pruebas para dinero, stock, caja, turnos y sincronización.

## Prioridad 2 — SaaS real

- Validar el ciclo registro → empresa → almacén → plan → CRM.
- Validar invitaciones de empleados y acceso desde otros dispositivos.
- Validar roles/permisos por almacén.
- Validar ciclo de suscripción y aprobación de pagos manuales.

## Prioridad 3 — POS profesional

- Venta online/offline duradera.
- Reconciliación de stock.
- Vendedores.
- Caja y turnos.
- Impresión térmica 58/80 mm por Bluetooth/USB cuando el navegador/dispositivo lo soporte.
- Cierre de caja y comprobante final.
- Evitar duplicados ante desconexiones.

## Prioridad 4 — operación empresarial

- Inventario y transferencias.
- Compras/proveedores.
- Bancos.
- Devoluciones y garantías.
- Auditorías de inventario.
- Reportes y exportaciones.

## Prioridad 5 — producción

- Endurecimiento de RPC/RLS.
- Índices de rendimiento basados en evidencia.
- Smoke tests y escenarios E2E críticos.
- Observabilidad y recuperación ante errores.
- Auditoría responsive móvil/tablet/PC.

## Regla de cambios

Cada cambio funcional debe ser pequeño y verificable: código → CI → despliegue → comprobación LIVE → siguiente cambio.
