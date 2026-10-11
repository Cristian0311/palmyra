# Reauditoría total PALMYRA — 2026-10-11

## Resumen

Se revisó el árbol del repositorio (541 rutas en la rama de auditoría), se ejecutaron comprobaciones de TypeScript, pruebas unitarias, auditoría de arquitectura, prueba de integridad y las dos compilaciones. La revisión profunda se centró en autenticación offline, empresa/tenant, almacenamiento, sincronización outbox, ciclo de vida Realtime, onboarding, recuperación de contraseña, notificaciones push, migraciones SQL y consistencia de datos. Esto no equivale a una revisión manual línea por línea de cada archivo ni a una prueba física de una tablet.

## Hallazgos de esta reauditoría y correcciones preparadas

1. **Versiones de migración duplicadas.** Había dos pares de archivos con el mismo prefijo de 14 dígitos:
   - `20261003091000_palmyra_final_onboarding_runtime.sql` y `remove_legacy_invitation_overload.sql`.
   - `20261008113000_harden_offline_sync_root_causes.sql` y `harden_offline_sync_root_failures.sql`.
   Se renombraron las dos migraciones pequeñas a versiones únicas `20261003091100` y `20261008113100`. La prueba de regresión confirma 119 archivos SQL con 119 versiones únicas.
2. **Registro nuevo y acceso offline.** El login guardaba el verificador offline antes de que una cuenta nueva tuviera empresa y almacén. Ese verificador quedaba ligado al contexto incompleto, así que el primer acceso offline tras terminar onboarding podía fallar. Ahora la credencial queda temporalmente solo en memoria y se vincula al contexto completo tras crear una empresa activa; nunca se conserva la contraseña en `localStorage` o `sessionStorage`.
3. **Almacenamiento local lleno o bloqueado.** Un fallo al guardar el alcance local podía convertir un inicio de sesión online válido en un error de acceso. Se hizo best-effort: la sesión validada por Supabase sigue funcionando aunque el navegador no pueda guardar la caché.
4. **Cambio de contraseña.** Tras recuperar o cambiar una contraseña, podía seguir existiendo el verificador creado con la contraseña anterior. El flujo de recuperación ahora lo invalida; el usuario debe volver a iniciar sesión online con la nueva contraseña para activar el acceso offline en ese dispositivo.
5. **Estado push poco fiable.** La pantalla solo miraba la suscripción del navegador. El navegador puede conservar una suscripción cuyo endpoint esté deshabilitado en el servidor. La comprobación ahora consulta también la fila del usuario, empresa y endpoint en `push_subscriptions` y no afirma que esté registrado en el servidor si está deshabilitado o falta. Al activarlo, si el endpoint local ya no está habilitado, la interfaz intenta retirar la suscripción antigua y crear una nueva en lugar de reactivar a ciegas un endpoint vencido.

## Validaciones de código

- `npm run lint`: PASS.
- `npm run test:unit`: 43/43 PASS, incluyendo login offline, rechazo de credenciales erróneas o contexto alterado, ciclo de onboarding, reinicio de contraseña, detección de errores de red, cobertura de los 48 tipos de la cola, orden de callbacks Realtime, estado push y unicidad de migraciones.
- `npm run audit:architecture:strict`: PASS; deja advertencias de mantenibilidad por `src/pages/POS.tsx` (3926 líneas) y `src/pages/Reports.tsx` (3588 líneas).
- `npm run test:integrity`: PASS.
- `npm run build`: PASS.
- `npm run build:admin`: PASS; mantiene la advertencia de un chunk administrativo superior a 500 KB.
- El código actualizado de esta rama debe pasar también GitHub Actions y Render tras la integración; no se considera desplegado hasta comprobar el build ID público.

## Validaciones de la base de datos en vivo

En las comprobaciones de solo lectura:
- 3 empresas.
- 0 ventas sin empresa.
- 0 balances de inventario negativos.
- 0 SKU duplicados entre productos activos.
- 0 ventas con almacén inexistente o perteneciente a otra empresa.
- 0 líneas de venta huérfanas o con producto de otra empresa.
- 119 versiones de migración locales únicas tras la corrección.
- Las dos tareas programadas estaban activas: monitor de tasas cada 5 minutos y entrega de notificaciones cada minuto. Sus ejecuciones recientes consultadas figuraban como exitosas.
- El histórico de tasas tenía 48 puntos almacenados al tomar la muestra.

## Pendientes reales encontrados

### Notificaciones push
Estado de la base de datos en la última consulta: 2 suscripciones históricas, **0 habilitadas**, 3 preferencias de usuario con push activado, 10 trabajos en estado `suppressed`, 0 `pending`, 0 `failed` y 0 `processing`. Las notificaciones dentro de la aplicación siguen registrándose; las notificaciones push no pueden llegar a dispositivos sin una suscripción de servidor habilitada. No se habilitaron filas a ciegas porque los endpoints anteriores pueden haber expirado. Tras el despliegue, cada dispositivo debe abrir **Notificaciones → Activar push** o **Registrar de nuevo**, conceder el permiso del navegador y enviar una prueba. La pantalla ahora detectará el endpoint deshabilitado en el servidor.

### Prueba física offline
No se puede certificar únicamente mediante pruebas unitarias el ciclo completo en una tablet real: iniciar sesión con conexión, cerrar la app, activar modo avión, volver a entrar a la empresa, registrar una venta, recuperar internet y confirmar que se sincroniza una sola vez y descuenta el inventario una sola vez. Esa prueba sigue pendiente.

### Restricciones inevitables del trabajo offline
La primera creación de cuenta/empresa requiere conexión. Mientras el dispositivo permanece offline no puede saber si el servidor revocó la cuenta, cambió permisos, suspendió el plan o desactivó el dispositivo después de la última sincronización. Esas verificaciones se reanudan al volver la conexión.

## Conclusión

La reauditoría encontró varios defectos adicionales y deja sus correcciones y pruebas preparadas en la rama de trabajo. Las pruebas locales pasan; los dos pendientes operativos importantes son reactivar las suscripciones push desde los dispositivos y realizar la prueba de ciclo offline en hardware real.