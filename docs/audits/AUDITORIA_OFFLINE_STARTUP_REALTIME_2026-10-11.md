# Auditoría de continuidad offline, autenticación y Realtime — PALMYRA

Fecha: 2026-10-11  
Repositorio: `Cristian0311/palmyra`  
Rama de corrección: `fix/offline-startup-and-realtime-guards`

## Alcance de la revisión

Se inventariaron 532 rutas del repositorio en el árbol Git: `src` (225 archivos/rutas), `supabase` (131), `docs` (41), `scripts` (52), `tests` (25), y el resto de la aplicación, assets y configuración. La revisión funcional se concentró en el arranque SaaS, la sesión local, selección del tenant/empresa, persistencia IndexedDB, cola outbox, replay, módulos store/actions, conectividad y Realtime. No se considera una prueba física equivalente a desconectar una tablet ni una comprobación línea por línea de todos los 532 archivos.

## Fallos identificados

1. **El navegador puede decir que está online aunque Supabase no responda.** Varios flujos solo se guiaban por `navigator.onLine`, de modo que un `Failed to fetch`, un timeout o un `AbortError` podía acabar en el error «Debes iniciar sesión para acceder a la empresa» aunque existiese un contexto local válido.
2. **No había un inicio SaaS offline completo con correo y contraseña.** El código conservaba contexto de la última sesión, pero la pantalla de login intentaba autenticar contra Supabase y no validaba localmente una credencial previamente verificada en ese dispositivo.
3. **La suscripción Realtime tenía una carrera de ciclo de vida.** Podía iniciarse una segunda suscripción durante una conexión pendiente o una transición online/offline. Todos los callbacks tienen que añadirse antes de `subscribe()`.
4. **Se intentaba filtrar la tabla compartida `currencies` por `company_id`.** Esa columna no existe en esa tabla.
5. **Algunos listeners se registraban para tablas hijas sin `company_id`.** No deben subscribirse sin filtro de tenant: además de provocar filtros inválidos, podrían entregar metadatos de otras empresas.
6. **El replay de la cola no comprobaba explícitamente un usuario Supabase autenticado antes de procesar operaciones.** En un inicio offline, la cola debe conservarse, nunca escribirse como un usuario anónimo.
7. **El ajuste de sincronización manual podía ser anulado por el coordinador Realtime**, que iniciaba replay durante un refresh de fondo.
8. **La cola contiene 48 tipos de operación.** Se comparó el union `OfflineActionType` con los `case` de `processQueueItem`: en esta versión se encontraron handlers explícitos para los 48 tipos.

## Correcciones propuestas en esta rama

- Nuevo `offlineNetwork.ts`: clasifica errores de conectividad reales, incluso si `navigator.onLine` está desactualizado.
- Nuevo `offlineSaaSAuth.ts`: al completar un login online, guarda solo un verificador PBKDF2-SHA-256 con salt; no guarda la contraseña. Offline, requiere correo y contraseña coincidentes, contexto previamente cacheado, empresa y almacén, y estado local no suspendido.
- `SaaSAuth.tsx`: intenta el acceso local verificado cuando no hay red y como fallback ante errores transitorios de red.
- `saas.ts` y `tenant.ts`: recuperan el último contexto confirmado y el tenant del alcance local cuando el transporte no está disponible. Mantienen un único par usuario/empresa para que las colas no se mezclen.
- `signOutSaaSAccount`: elimina el verificador offline local de la cuenta cerrada.
- `realtimeSync.ts`: hace referencia compartida a la inicialización, cancela generaciones pendientes, serializa la retirada de canales, registra callbacks antes de suscribir, evita filtros en tablas sin `company_id`, y conserva el polling cuando Realtime falla.
- `offlineSync.ts`: no procesa la cola mientras no pueda confirmar que hay un usuario Supabase válido; en ese caso la cola no se borra y se reintentará al volver la autenticación. Respeta la opción de sincronización manual también desde Realtime.
- Pruebas nuevas de detección de red, login local, rechazo de empresas suspendidas, cobertura de handlers de cola y orden de suscripción Realtime.

## Qué significa «trabajar offline»

La primera creación de cuenta/empresa requiere conexión. Una vez que el usuario inicia sesión con conexión y el sistema ha almacenado el contexto, el mismo dispositivo puede abrir el CRM offline y verificar el acceso local. Las operaciones comerciales que ya están conectadas a la cola duradera se conservan en IndexedDB/localStorage y esperan para sincronizar cuando regrese una sesión autenticada.

Un inicio offline no puede validar contra el servidor cambios de contraseña, suspensiones, revocaciones de dispositivos o permisos producidos después de la última sincronización. La aprobación de cuentas, invitaciones por email y otras acciones externas también requieren conexión para su efecto remoto. No se afirma que absolutamente todas las acciones administrativas estén implementadas como offline-first hasta completar pruebas por módulo en un dispositivo real.

## Validación

- `npm run lint`: PASS en la rama durante la revisión inicial.
- `npm run test:unit`: 32/32 tests PASS antes de las últimas pruebas estáticas de cobertura.
- `npm run audit:architecture:strict`: PASS con dos advertencias de mantenimiento ya existentes: `src/pages/POS.tsx` y `src/pages/Reports.tsx` superan 3.500 líneas.
- `npm run test:integrity`: PASS.
- `npm run build`: PASS.
- `npm run build:admin`: PASS.
- Se vieron advertencias de Node en la instalación local porque el entorno disponible era Node 20.9 mientras algunos paquetes solicitan Node 20.19+/22+. CI usa Node 24.
- No se ha verificado aún un escenario físico offline → venta → cierre → reconexión → cola vacía ni el despliegue de esta rama en Render. Estos pasos no se deben dar por concluidos hasta que el PR esté integrado y Render confirme el deploy.
