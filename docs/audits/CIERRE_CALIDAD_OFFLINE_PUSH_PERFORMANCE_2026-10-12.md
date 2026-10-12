# Cierre de calidad: modo offline, notificaciones y rendimiento — 2026-10-12

## Resultado

Se preparó un lote de mejoras sobre la versión que ya estaba desplegada. Incluye renovación segura de push, división de módulos de POS/Reportes y carga diferida de las pantallas administrativas. Las validaciones locales de código pasan; queda pendiente que cada móvil vuelva a consentir/registrar push, y la operación offline completa con venta real requiere probarse con la cuenta y dispositivo del usuario.

## Push: diagnóstico y correcciones

- Vault de Supabase contiene `PALMYRA_NOTIFICATION_WORKER_SECRET`, `PALMYRA_VAPID_PUBLIC_KEY` y `PALMYRA_VAPID_PRIVATE_KEY`. No se expusieron valores privados.
- Se configuró en Render `VITE_VAPID_PUBLIC_KEY` usando la clave pública correspondiente al Vault. Se comprobó el paquete público servido por Render y confirmó que contiene la clave y ya no muestra el aviso de clave VAPID ausente.
- La suscripción local se consulta contra `push_subscriptions` usando empresa, usuario y endpoint.
- Si el endpoint está ausente o deshabilitado en servidor, la app intenta retirarlo y crear uno nuevo. Si no puede leer el estado del servidor o retirar la suscripción antigua, ahora muestra un error y no vuelve a habilitar ese endpoint a ciegas.
- Estado de base de datos consultado: dos suscripciones antiguas, ambas deshabilitadas; tres preferencias conservan push activado; diez trabajos históricos quedaron `suppressed` al no existir endpoint habilitado. No se reactivaron endpoints vencidos manualmente.
- El usuario debe abrir **Notificaciones → Activar push/Registrar de nuevo → Enviar prueba** en cada móvil y conceder el permiso del navegador. Este consentimiento no se puede conceder remotamente desde el servidor.
- Las tareas programadas de entrega de notificaciones cada minuto y monitor de tasas cada cinco minutos estaban activas; sus ejecuciones recientes consultadas fueron exitosas.

## Mantenibilidad y rendimiento

| Módulo | Antes | Después | Resultado |
|---|---:|---:|---|
| `src/pages/POS.tsx` | 3.925 líneas / 217.550 bytes | 2.356 líneas / 108.391 bytes | -40,0 % líneas; -50,2 % bytes |
| `src/pages/Reports.tsx` | 3.587 líneas / 204.668 bytes | 2.412 líneas / 134.666 bytes | -32,7 % líneas; -34,2 % bytes |
| Paquete inicial de Admin | 617,50 KB / 180,60 KB gzip | 464,27 KB / 132,88 KB gzip | -24,8 % bytes; -26,4 % gzip, sin advertencia de chunk >500 KB |
| Chunk POS | ~173,86 KB / 44,37 KB gzip | 110,25 KB / 32,99 KB gzip | -36,6 % bytes; -25,7 % gzip |
| Chunk Reportes | ~173,51 KB / 33,90 KB gzip | 132,27 KB / 27,17 KB gzip | -23,8 % bytes; -19,9 % gzip |

Las ventanas de caja, turno, descuadres y componentes de Reportes se trasladaron a archivos separados. Los módulos más pesados se cargan bajo demanda. Admin ahora separa el arranque, shell y vistas de cada sección en chunks diferidos.

## Comprobaciones offline

- `dist/sw.js` generado incluye 78 recursos en precaché, incluidos el inicio de POS, caja, Reportes y el detalle de descuadres.
- Prueba automatizada nueva `npm run test:pwa:offline`: **8/8 comprobaciones PASS** para fallback de navegación, ruta offline, respuestas Supabase no cacheadas y presencia de chunks en precaché.
- Prueba manual de humo con Chromium/Playwright sobre el build local: visita online a `/auth` HTTP 200, service worker controla la página, 74 recursos aparecen en la caché del navegador y, tras simular modo offline, recargar `/auth` también devuelve HTTP 200 sin errores JavaScript.
- Esta prueba prueba la shell/cache del PWA; **no** equivale a una venta POS contra una cuenta real ni valida el commit remoto en la base de datos.
- El motor de cola ya cubre explícitamente los 48 tipos de operación y exige sesión Supabase real antes del replay. La prueba física pendiente debe confirmar, en el dispositivo con sesión autorizada, que una venta creada sin conexión se sincroniza una sola vez al reconectar y descuenta el inventario una sola vez.

## Validaciones de código

- `npm run lint`: PASS.
- `npm run test:unit`: **44/44 PASS**.
- `npm run audit:architecture:strict`: PASS sin advertencias de archivos fuente excedidos.
- `npm run test:integrity`: PASS.
- `npm run build`: PASS.
- `npm run test:pwa:offline`: **8/8 PASS**.
- `npm run build:admin`: PASS; ya no advierte chunks mayores de 500 KB.

## Pendientes no automatizables desde este entorno

1. Registrar de nuevo push desde el navegador de cada móvil y enviar la notificación de prueba; se requiere el permiso del usuario en el dispositivo.
2. Prueba completa de turno/venta offline y reconexión con la cuenta de la empresa. No se declara aprobada solo por las pruebas de shell y unitarias.


## Reauditoría adicional de tasas de cambio

- La gráfica de mercado usa `get_exchange_rate_history` de Supabase. En producción se verificaron 91 puntos en 6 códigos desde `2026-10-11 17:00 UTC` hasta `2026-10-12 01:10 UTC`; la RPC devuelve los puntos sin depender del `localStorage`.
- La tabla de tasas operativas por empresa `exchange_rates` estaba vacía. Se encontró que el código usa `upsert(..., onConflict: 'id')`, pero la base concedía `INSERT` sin `UPDATE` a `authenticated`, aunque sí existía una política RLS de actualización. Se añadió la migración `20261012012500_fix_exchange_rate_upsert_privileges.sql` para conceder `UPDATE` conservando el control RLS `settings.manage`.
- Se corrigió el replay de `currency_rate`: ya no reencola la misma operación desde dentro del worker, el error real se conserva en `lastError` y el monitor no atribuye sin prueba una falta de detalle a dependencias pendientes.
- La migración debe aplicarse en Supabase y después hay que volver a sincronizar las tasas EUR/USD pendientes en el dispositivo para confirmar que `exchange_rates` recibe los valores de esa empresa.
