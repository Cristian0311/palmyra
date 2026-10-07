# PALMYRA — Auditoría integral del sistema
Fecha: 2026-10-07
Rama auditada: main
Commit auditado: 4409a2513a898c850ddfdb7c3845d658c579ed84
Producción: palmyracrm.onrender.com
Render deploy confirmado LIVE: dep-db2ul77lk1mc738qqip0

## 1. Alcance

Se realizó una auditoría integral del árbol del repositorio, con inventario estructural completo y revisión dirigida de las rutas navegables, store, persistencia local, cola offline, sincronización, PWA, impresión, servicios SaaS y estado real de Supabase.

Inventario del árbol:
- 432 archivos totales; árbol no truncado.
- src/: 182
- supabase/: 96
- scripts/: 48
- docs/: 36
- tests/: 22
- public/: 23
- admin/: 9
- raíz/.github y configuración: 16 aprox.

La revisión funcional profundizó especialmente en las operaciones que deben conservarse sin conexión: ventas, anulaciones, devoluciones, caja, movimientos de caja, inventario, traslados, auditorías, compras/recepciones, bancos, clientes, proveedores, empleados, cotizaciones, nómina y sincronización.

## 2. Criterio de “100% offline + 100% online”

El objetivo técnicamente correcto es:
- El núcleo operativo de una empresa ya autenticada debe poder trabajar sin red usando el estado local y el outbox durable.
- Al recuperar internet, las operaciones deben sincronizarse de forma idempotente, sin duplicar ventas ni destruir cambios locales.
- El servidor/Supabase sigue siendo la autoridad canónica para operaciones críticas y conflictos.
- Funciones que por naturaleza dependen de un tercero/red (registro inicial, recuperación de contraseña por correo, envío de invitaciones, IA remota, métricas de plataforma, aprobación administrativa remota y reserva fiscal cuando no existe un rango local reservado) no pueden ser literalmente “offline”; deben degradar de forma segura y nunca bloquear el núcleo operativo.

## 3. Resultado ejecutivo

Estado actual: NO APROBADO para declarar “100% estable”.

La arquitectura offline es sólida en varias áreas, pero el repositorio actual tiene errores de TypeScript/contratos que hacen fallar CI y revelan defectos funcionales reales en rutas críticas. Además, varias operaciones de borrado/configuración no tienen paridad offline completa y existen funciones deliberadamente online-only.

Bloqueadores principales:
1. CI principal falla actualmente en TypeScript.
2. CashRegister usa calculateEmployeeSaleCommission sin importarlo.
3. Inventory llama a setActiveTab('stock'), pero 'stock' no existe en la unión de estados ni tiene contenido renderizado.
4. Replay offline de transferencias llama replaceWarehousesInventory con 4 argumentos, pero la función recibe 2.
5. Replay offline de recepción de proveedor referencia reconcileSupplierReceiveCanonical sin importarlo.
6. Replay offline de eliminación bancaria referencia deleteBankCardFromSupabase sin importarlo en processQueueItem.
7. El tipo User no contiene salesPercentage, aunque POS, nómina y compensación lo consumen.
8. Team.tsx envía compensationType/salesPercentage a updateEmployee, pero updateEmployee no acepta ni persiste esos campos.
9. Eliminación offline de sucursales, categorías y proveedores no queda protegida por outbox en las acciones actuales.
10. El PWA excluye vendor-xlsx y vendor-charts del precache; debe validarse cold-start offline en exportación/Reports.
11. Hay residuos de branding “MARÉ / Mi Tienda POS” en defaults y mensajes internos; deben quedar sustituidos por PALMYRA donde se muestren al cliente.
12. Supabase Auth tiene Leaked Password Protection deshabilitada.
13. Supabase Advisor informa 122 funciones SECURITY DEFINER ejecutables por authenticated; no es automáticamente una vulnerabilidad, pero requiere auditoría de ACL/tenant/permiso función por función.
14. Hay 69 índices sin uso reportados por Advisor; son candidatos de optimización, no deben eliminarse sin evidencia.

## 4. Flujo público y cuenta

### Landing Page — 🟡
Archivo principal: src/pages/LandingPage.tsx

Correcto:
- La landing es principalmente estática.
- Navegación y selección de plan usan sessionStorage.
- Existe identidad visual PALMYRA y assets locales de logo.

Pendientes:
- Usa una imagen remota de Flickr; en una primera apertura sin caché no existe garantía offline.
- Registro y compra/selección de plan requieren red.
- El marketing puede presentarse offline después de haber sido cacheado por PWA, pero no debe confundirse con capacidad de alta de cuenta offline.

### Autenticación — 🟡
Archivos principales: src/pages/SaaSAuth.tsx, src/pages/AuthConfirm.tsx, src/services/saas.ts

Correcto:
- Supabase es la fuente de identidad.
- Existe fallback de getSession/caché de contexto cuando ya existe una sesión y se pierde internet.

Online-only por diseño:
- Crear cuenta.
- Confirmación de correo.
- Recuperación de contraseña.
- Cambio de contraseña remoto.

Debe probarse E2E:
- login online
- cierre/recarga sin conexión con sesión ya establecida
- renovación de token al recuperar red
- comportamiento ante sesión expirada

### Onboarding — 🟡
Archivo: src/pages/SaaSOnboarding.tsx

Correcto:
- El contexto SaaS está separado del núcleo operativo.

Online-only:
- Creación de empresa/almacén y selección de plan mediante RPC.
- No debe prometerse alta de empresa sin internet.

La validación definitiva del flujo de alta debe ser E2E con datos limpios.

## 5. CRM operativo

### Dashboard — 🟢/🟡
Archivo: src/pages/Dashboard.tsx

Correcto:
- Consume estado local para ventas, inventario, clientes, monedas y sucursales.
- El contexto SaaS usa caché/fallback.
- La IA es degradable cuando no hay red.

Online-only:
- Resumen IA mediante /api/ai-business-summary.

Pendiente E2E:
- recargar Dashboard offline
- cambiar almacén offline
- comprobar que ventas offline aparecen inmediatamente en métricas y reportes

### POS — 🔴 bloqueado hasta reparar CI/replay
Archivos: src/pages/POS.tsx, store/actions/posActions.ts, módulos POS

Fortalezas:
- Venta durable: se encola antes del cobro.
- Estado local se actualiza inmediatamente offline.
- La RPC remota es idempotente.
- Al sincronizar se vuelve a verificar la venta y se reconcilia inventario.
- Anulación y devoluciones disponen de cola.
- Pago multi-moneda y vendedor están integrados.

Problemas actuales:
- El repositorio no compila por el acceso a salesPercentage del tipo User.
- Existen fallos de replay offline en processQueueItem que afectan operaciones alrededor del POS.
- Falta la prueba E2E definitiva de: offline -> venta -> cierre pestaña -> reapertura -> reinicio navegador/PWA -> online -> sincronización -> inventario -> Reports.

### Caja / turnos — 🔴
Archivos: src/pages/POS.tsx, src/pages/CashRegister.tsx, store/actions/cashActions.ts

Arquitectura:
- Apertura/cierre y movimientos usan outbox.
- Se conserva turnNumber canónico.
- La UI filtra sesiones eliminadas sin renumerar el histórico.

Bloqueador:
- CashRegister.tsx referencia calculateEmployeeSaleCommission sin importarlo. CI falla y el cierre de caja por esa ruta puede producir ReferenceError en tiempo de ejecución.

Debe probarse:
- abrir turno offline
- vender
- movimiento de caja
- cerrar
- recargar
- volver a abrir
- sincronizar
- conservar numeración histórica

### Inventario — 🔴
Archivo: src/pages/Inventory.tsx

Fortalezas:
- Alta/edición de productos usan outbox.
- Ajustes de stock y transferencias tienen operaciones durables.
- Eliminación de producto dispone de cola específica.

Bloqueador real:
- El botón “Stock” ejecuta setActiveTab('stock'), pero el estado acepta products/transfers/labels/abc/restock/bulk/excel y no existe render para activeTab='stock'. Esto puede dejar la vista sin contenido después del toque.

Debe corregirse antes de declarar inventario estable.

### Auditoría de inventario — 🟡
Archivo: src/store/actions/operationsActions.ts y src/pages/InventoryAudit.tsx

Correcto:
- Inicio, conteo y solicitud de recuento se guardan en outbox.
- La aprobación exige conexión para validar el inventario canónico y evitar aprobar sobre datos desactualizados.

Conclusión:
- El conteo puede hacerse offline.
- La aprobación es correctamente online-only por seguridad/concurrencia.

### Transferencias — 🔴
Archivos: src/store/actions/inventoryActions.ts, src/services/offline/processQueueItem.ts, src/services/offline/reconcileInventory.ts

Arquitectura:
- La operación tiene operationId/batchId y RPC como autoridad.

Bloqueador real:
- processQueueItem llama replaceWarehousesInventory con cuatro parámetros.
- replaceWarehousesInventory actualmente acepta solamente (warehouseIds, inventory).

Impacto:
- La sincronización/replay de una transferencia offline no está en estado aprobable.

Además debe validarse el flujo de múltiples artículos y variantes tras reconexión.

### Proveedores / compras — 🟡/🔴
Archivos: src/store/actions/operationsActions.ts, src/services/supabaseSync/mutations.ts, processQueueItem.ts

Fortalezas:
- creación/edición/recepción están pensadas para cola.
- recepción usa RPC canónica.

Bloqueador:
- processQueueItem referencia reconcileSupplierReceiveCanonical sin importarlo.

Gap offline:
- deleteSupplierFromSupabase no tiene cola interna y la acción deleteSupplier simplemente llama la función; una eliminación offline puede desaparecer de la UI local y no quedar garantizada en el outbox.

### Clientes — 🟢/🟡
Archivo principal: src/pages/Customers.tsx, src/store/useStore.ts

Correcto:
- alta y edición pasan por pushCustomerToSupabase, que dispone de fallback a cola.
- eliminación de cliente sí crea customer_delete en outbox cuando falla o no existe conexión.

Debe verificarse E2E con recarga offline y posterior reconciliación.

### Bancos — 🟡
Archivos: src/store/actions/bankActions.ts, services/supabaseSync

Fortalezas:
- movimientos bancarios usan outbox y RPC.
- saldos optimistas se reconcilian.
- transferencias internas tienen operación reversible.

Diseño online-only:
- deleteBankCard está bloqueado offline para validar historial.

Bloqueador de CI/replay:
- processQueueItem usa deleteBankCardFromSupabase pero no lo importa.

Conclusión:
- movimientos pueden ser offline-first.
- eliminar una cuenta bancaria no debe venderse como operación offline hasta implementar una política explícita y segura.

### Garantías y devoluciones — 🟡
Archivos: src/pages/Returns.tsx, POS, supabaseSync

Correcto:
- solicitudes y completado usan operaciones en cola.
- inventario se reconcilia después de confirmación remota.

Pendiente:
- prueba E2E de devolución offline asociada a venta offline y su reconciliación en orden.

### Reportes — 🟡/🔴
Archivo: src/pages/Reports.tsx y módulos reports

Fortalezas:
- usa store local y reconciliación.
- hay módulos separados para sesiones, nómina, impresión y exportaciones.
- existe recuperación de ventas pendientes desde el outbox.

Riesgos:
- CI está afectado por salesPercentage en nómina.
- Reportes históricos deben probarse después de múltiples turnos offline + online.
- exportación Excel/charts puede depender de chunks excluidos del precache.

No se debe declarar que “todos los reportes ya están validados” sin E2E.

### Configuración — 🟡
Archivo: src/pages/Settings.tsx

Fortalezas:
- configuración local y push remoto.
- impresora Bluetooth/USB integrada.
- configuración de recibos y almacenes persiste localmente.

Gaps:
- algunos borrados de sucursales/categorías no tienen outbox explícito.
- defaults del store/recibo todavía contienen “Mi Tienda POS” y “MARÉ”.

### Equipo — 🔴
Archivos: src/pages/Team.tsx, src/services/team.ts, src/services/employeeCompensation.ts

Bloqueadores:
- User carece de salesPercentage.
- Team.tsx envía compensationType/salesPercentage a updateEmployee.
- updateEmployee no acepta esos argumentos.
- En el camino updateEmployee el RPC se invoca con p_pos_password:null y no se envían los datos de compensación.

Impacto:
- compilación CI roja.
- el tipo de compensación/porcentaje puede no persistir por la ruta de edición con invitación.

Este módulo no está listo para certificación.

### Tasa de cambio — 🔴 funcionalmente incompleta
Archivo: src/pages/ExchangeRate.tsx

La sección actual es informativa y está marcada “Próximamente”.
No existe aún la integración provincial.
No modifica automáticamente precios, inventario ni operaciones.

Esto debe considerarse una funcionalidad pendiente, no una funcionalidad 100% online/offline terminada.

### Soporte / seguridad / privacidad — 🟡
Archivo: src/pages/HelpCenter.tsx y servicios de soporte

Correcto:
- documentación y secciones informativas pueden abrirse offline si el bundle está disponible.

Online-only:
- crear solicitud de soporte.
- cargar canales remotos si no están cacheados.

### Plan / suscripción — 🟡
Archivos: src/pages/Subscription.tsx, services/subscription.ts, billing providers

Online-only:
- cambios de plan
- aprobación de solicitudes
- pagos externos
- sincronización del estado de suscripción

La operación empresarial ya autenticada puede continuar offline según el contexto local, pero cambios de facturación no pueden confirmarse offline.

### Tutorial — 🟢
Archivo: src/pages/Tutorial.tsx

Debe ser principalmente estático/local.
Debe incluirse en la prueba de cold-start offline.

### Catálogo Online — 🔴 pendiente
La navegación del sidebar está marcada “Próximamente”.
No existe una implementación operativa que pueda certificarse.

## 6. PWA, caché y actualización

### PWA — 🟢 con verificación pendiente de cold-start
Archivos: src/main.tsx, vite.config.ts

Correcto:
- registerType prompt.
- detección de nueva versión.
- actualización mediante Service Worker waiting.
- espera controllerchange.
- protección contra bucles de recarga.
- recuperación de chunks fallidos cuando existe red.
- IndexedDB + localStateStorage.

Riesgo:
- vendor-xlsx y vendor-charts están excluidos del precache.
- Debe ejecutarse prueba de entrada en frío offline a Reports/exportación.

## 7. Persistencia local

### Zustand / localStateStorage — 🟢
src/store/useStore.ts persiste:
usuarios sin contraseñas, empresa/sesión operativa, monedas, sucursales, categorías, productos, inventario, carrito, ventas, devoluciones, garantías, cajas, transferencias, proveedores, compras, auditorías, nómina, cotizaciones, turnos, configuración de recibos y bancos.

Esto es una buena base para offline.

### Outbox — 🟢/🟡
src/services/offlineQueue.ts

Fortalezas:
- IndexedDB duradero.
- fallback a localStorage.
- scope por empresa/dispositivo.
- tombstones.
- acción idempotente.
- recuperación después de reload/restart.

Pendientes:
- cerrar todos los huecos de tipos/funciones de processQueueItem.
- verificar cada operación de borrado.
- pruebas de fallo de red después de que el servidor ya aplicó la RPC.

## 8. Impresión

Archivos: src/lib/escpos.ts, src/components/POSPrinterSetupModal.tsx, src/modules/pos/hooks/usePOSPrinter.ts

Capacidades:
- Bluetooth BLE.
- USB/Serie vía APIs del navegador.
- ESC/POS.
- 58mm y 80mm.
- apertura de cajón.
- impresión de cierre de caja.

Limitación real:
- Bluetooth/USB no puede garantizarse en todos los navegadores/dispositivos porque depende de APIs de hardware y permisos del navegador.
- No está habilitada la impresión directa por IP/Wi-Fi en el camino actual.

Pendiente de branding:
- revisar defaults y texto de prueba que todavía usan “MARÉ”.

## 9. Seguridad / Supabase runtime

Estado del proyecto:
- Supabase ACTIVE_HEALTHY.
- PostgreSQL 17.11.0.002.
- 74 tablas públicas detectadas y las 74 tienen RLS habilitado.

Advisors actuales:
- WARN: 122 funciones SECURITY DEFINER ejecutables por authenticated.
- WARN: protección contra contraseñas comprometidas deshabilitada.
- INFO: 69 índices sin uso.

Recomendación:
- no revocar SECURITY DEFINER en bloque.
- revisar cada función privilegiada para autenticación, company_id/tenant, almacén y permisos.
- habilitar Leaked Password Protection.
- revisar índices después de medir carga real.

## 10. CI / calidad

Último workflow PALMYRA CI:
- run 37583315459
- resultado: failure
- paso que falla: TypeScript
- unit tests, admin typecheck/build, architecture audit y production build quedan omitidos por fail-fast.

Errores actuales verificados:
- Layout.tsx: typing de requiredFeature.
- getClosureReceiptLines.ts: salesPercentage no existe en User.
- useReportsPayroll.ts: salesPercentage no existe en User.
- CashRegister.tsx: calculateEmployeeSaleCommission no definida/importada.
- Inventory.tsx: 'stock' no pertenece al union de activeTab.
- POS.tsx: salesPercentage no existe en User.
- Team.tsx: compensationType no pertenece al input de updateEmployee.
- employeeCompensation.ts: salesPercentage no existe en User.
- processQueueItem.ts: argumentos incorrectos en replaceWarehousesInventory.
- processQueueItem.ts: reconcileSupplierReceiveCanonical no definida/importada.
- processQueueItem.ts: deleteBankCardFromSupabase no definida/importada.

## 11. Prueba E2E obligatoria antes de declarar “100%”

Matriz mínima:

### Offline frío
1. Entrar una vez online.
2. Cerrar navegador/PWA.
3. Cortar internet.
4. Abrir PALMYRA.
5. Ver Dashboard/POS.
6. Abrir turno.
7. Vender.
8. Anular venta.
9. Registrar movimiento de caja.
10. Cerrar turno.
11. Crear/editar cliente.
12. Crear/editar producto.
13. Ajustar stock.
14. Transferir entre almacenes.
15. Registrar/recibir compra.
16. Crear auditoría y contar.
17. Consultar Reports.
18. Cerrar/reabrir el navegador.
19. Confirmar que todo permanece.

### Reconexión
20. Recuperar internet.
21. Procesar la cola.
22. Confirmar 0 pendientes.
23. Confirmar 0 conflictos.
24. Confirmar ventas, pagos, inventario, caja y reportes en Supabase.
25. Repetir con corte de red durante una RPC.

### Multi-dispositivo
26. Dispositivo A offline.
27. Dispositivo B online modifica la misma entidad.
28. A vuelve online.
29. Verificar conflicto/reconciliación sin pérdida de datos.

### Seguridad
30. Probar empresa A contra datos de empresa B.
31. Probar empleado sin permiso.
32. Probar almacén no autorizado.
33. Probar funciones SECURITY DEFINER directamente mediante rol autenticado donde corresponda.

### PWA / actualización
34. Tener versión N instalada.
35. Desplegar N+1.
36. Recibir burbuja.
37. Pulsar Actualizar.
38. Confirmar nueva versión sin bucle.
39. Repetir offline.

## 12. Prioridad de corrección

P0:
- Dejar CI en verde.
- Reparar processQueueItem/reconcileInventory.
- Reparar CashRegister.
- Reparar Team/compensación.
- Reparar Inventory activeTab.
- Reparar imports faltantes del replay offline.

P1:
- Completar paridad offline para borrados de sucursal/categoría/proveedor.
- Validar cold-start de Reports/Excel/charts.
- Eliminar branding MARÉ/Mi Tienda POS expuesto al usuario.
- E2E offline/reconnect completa.

P2:
- habilitar Leaked Password Protection.
- auditoría completa de los 122 SECURITY DEFINER.
- revisar 69 índices no usados con métricas de carga.
- completar Tasa de cambio y Catálogo Online.

## 13. Veredicto

PALMYRA ya tiene una base real de arquitectura offline-first, no es una simple aplicación online con una pantalla “offline”. El outbox durable, la persistencia local, la reconciliación y las RPC idempotentes son una base correcta.

Sin embargo, el estado actual del código NO permite certificar “100% online + 100% offline” porque existen fallos comprobables en compilación y en replay de operaciones, además de funciones deliberadamente online-only y algunas operaciones de borrado sin paridad offline.

La aprobación final debe darse solamente después de corregir P0/P1 y pasar la matriz E2E completa.
