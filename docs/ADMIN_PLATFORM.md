# PALMYRA Admin Platform

## Objetivo

PALMYRA Admin es la consola privada del dueño/operador del SaaS. Se mantiene como una aplicación independiente del CRM de las empresas para reducir superficie de ataque, separar despliegues y evitar mezclar permisos de plataforma con permisos de negocio.

## Estructura

- admin/ contiene la aplicación Vite + React del panel.
- admin/supabase.ts crea el cliente con una clave publicable; nunca debe contener service_role ni una clave secreta.
- admin/platformAdminApi.ts consume las RPC administrativas ya existentes.
- admin/AdminApp.tsx orquesta la aplicación y admin/AdminShell.tsx provee el shell; las vistas viven en admin/views/.
- admin/admin.css contiene el sistema visual responsive y las reglas de reduced motion.

## Render

El servicio administrativo puede crearse como un servicio estático separado:

- Branch: `main` (el servicio debe seguir la rama principal; una rama antigua sirve código de octubre)
- Root directory: vacío
- Build command: npm install --no-audit --no-fund && npm run build:admin
- Publish directory: dist-admin
- VITE_SUPABASE_URL: URL pública de Supabase
- VITE_SUPABASE_ANON_KEY o VITE_SUPABASE_PUBLISHABLE_KEY: clave publicable
- Auto-Deploy: activado, o Manual Deploy → «Clear build cache & deploy» cuando se cambie configuración

El servicio no necesita service_role.

Una publicación correcta debe exponer `https://palmyra-admin.onrender.com/version.json` y cargar `assets/AdminShell-*.js`. Si `/version.json` responde 404 o los assets no cambian tras un push, Render está compilando otra rama, otro directorio o una caché vieja: corregir branch/build/publish y redesplegar sin caché.

## Dos consolas, una sola fuente

- `admin/` + `dist-admin` es la consola real del SaaS en `palmyra-admin.onrender.com`. Todos los cambios de diseño y funcionalidad se hacen aquí.
- `src/pages/PlatformAdmin.tsx` (ruta `/platform-admin` del CRM) es una consola heredada que se conserva por compatibilidad; no recibe el rediseño y no es lo que publica Render.

## Acceso

La aplicación usa Supabase Auth para iniciar sesión. La comprobación en navegador solo confirma que existe una sesión; la autorización real para consultar/modificar datos administrativos debe permanecer en RPCs protegidas y políticas de base de datos.

Acciones sensibles actuales (todas security definer + pertenencia a platform_admins):

- get_platform_companies
- get_platform_overview (totales, MRR estimado, vencimientos, cobros y soporte)
- get_platform_plans (catálogo activo para asignación manual)
- get_pending_plan_requests (filtrable por estado; también incluye contacto y correo del propietario)
- get_platform_company_detail (suscripción, conteos, últimas solicitudes, facturas y pagos)
- get_platform_billing_payments
- get_platform_admin_audit (registro con operador, empresa, acción y detalle)
- approve_plan_request_v3 (importe recibido, moneda CUP/USD y referencia obligatoria)
- reject_plan_request
- set_platform_company_plan_v2 (asignación o extensión manual de plan, cancela solicitudes pendientes y anula facturas abiertas)
- set_platform_company_status
- set_platform_support_request_status (open / in_progress / resolved / closed)
- get_platform_support_requests (filtrable por estado; incluye teléfono y correo)
- load_platform_support_settings / set_platform_support_settings (WhatsApp, correo, privacidad, Facebook y canal de WhatsApp)

La renovación desde el CRM usa `request_company_plan_v3` y `cancel_my_plan_request`. Una solicitud pendiente ya no bloquea la renovación: si el dueño cambia de plan, método o duración, la anterior se marca como `cancelled` y su factura abierta se anula antes de crear la nueva.

Migraciones aplicadas en producción (2026-11-20 y 2026-11-21):

- 20261118130000_cuba_free_plans_manual_renewals.sql — catálogo free/starter/growth/pro sin PayPal y RPCs v3.
- 20261120120000_free_plan_cloud_backup.sql — Gratis conserva límites y suma respaldo comercial en la nube.
- 20261120121000_platform_admin_console.sql — get_platform_companies, set_platform_company_status, set_platform_support_request_status y retiro de la sobrecarga ambigua de settings.
- 20261121150000_plan_admin_console_v2.sql — desbloqueo de renovaciones, cancelación por el dueño, métricas globales, detalle por empresa, pagos, auditoría (tabla platform_admin_audit y triggers), asignación manual de plan y consulta de soporte ampliada.
- 20261122120000_fix_plan_requests_overload.sql — retira la sobrecarga vacía de `get_pending_plan_requests` que hacía ambigua la llamada sin argumentos en PostgREST.

`scripts/apply-sql.mjs` aplica un archivo SQL por la Management API leyendo las credenciales desde `.secrets/supabase.env`; nunca imprime el token.

## Regla de aislamiento

Una cuenta empresarial no obtiene privilegios administrativos por entrar a /admin. No se debe implementar autorización basada únicamente en localStorage, user_metadata o un flag de frontend.

## Evolución

Implementado en 1.1.0:

1. Dashboard global
2. Empresas con estado, plan y vencimiento
3. Planes y solicitudes con aprobación manual (importe + referencia)
4. Centro de soporte con triage por estado
5. Configuración de canales oficiales (WhatsApp, correo, privacidad, Facebook, canal)

Implementado en 1.3.0:

1. Dashboard con MRR estimado, vencimientos, cobros y alertas operativas
2. Empresas con plan, vencimiento y detalle profundo (solicitudes, facturas y pagos por cuenta)
3. Asignación y extensión manual de plan desde el panel, con auditoría
4. Solicitudes filtrables por estado e historial de pagos
5. Auditoría administrativa visible con operador, empresa y detalle
6. Navegación con enlaces directos (`#/empresas`, `#/planes`, …) y contadores de pendientes
7. Renovación desde el CRM sin bloqueos por solicitudes viejas, con cancelación por el dueño

Pendiente:

1. Sesiones de soporte temporales
2. Seguridad avanzada (2FA obligatorio, IP allowlist)

Las nuevas tablas administrativas deben diseñarse con RLS y, cuando requieran elevación de privilegios, mediante funciones seguras con autenticación explícita del operador administrativo.