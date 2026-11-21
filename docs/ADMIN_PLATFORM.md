# PALMYRA Admin Platform

## Objetivo

PALMYRA Admin es la consola privada del dueño/operador del SaaS. Se mantiene como una aplicación independiente del CRM de las empresas para reducir superficie de ataque, separar despliegues y evitar mezclar permisos de plataforma con permisos de negocio.

## Estructura

- admin/ contiene la aplicación Vite + React del panel.
- admin/supabase.ts crea el cliente con una clave publicable; nunca debe contener service_role ni una clave secreta.
- admin/platformAdminApi.ts consume las RPC administrativas ya existentes.
- admin/AdminApp.tsx contiene el shell y las vistas administrativas.
- admin/admin.css contiene el sistema visual responsive y las reglas de reduced motion.

## Render

El servicio administrativo puede crearse como un servicio estático separado:

- Root directory: vacío
- Build command: npm install --no-audit --no-fund && npm run build:admin
- Publish directory: dist-admin
- VITE_SUPABASE_URL: URL pública de Supabase
- VITE_SUPABASE_ANON_KEY o VITE_SUPABASE_PUBLISHABLE_KEY: clave publicable

El servicio no necesita service_role.

## Acceso

La aplicación usa Supabase Auth para iniciar sesión. La comprobación en navegador solo confirma que existe una sesión; la autorización real para consultar/modificar datos administrativos debe permanecer en RPCs protegidas y políticas de base de datos.

Acciones sensibles actuales (todas security definer + pertenencia a platform_admins):

- get_platform_companies
- get_pending_plan_requests
- approve_plan_request_v3 (importe recibido, moneda CUP/USD y referencia obligatoria)
- reject_plan_request
- set_platform_company_status
- set_platform_support_request_status (open / in_progress / resolved / closed)
- load_platform_support_settings / set_platform_support_settings (WhatsApp, correo, privacidad, Facebook y canal de WhatsApp)

Migraciones aplicadas en producción (2026-11-20):

- 20261118130000_cuba_free_plans_manual_renewals.sql — catálogo free/starter/growth/pro sin PayPal y RPCs v3.
- 20261120120000_free_plan_cloud_backup.sql — Gratis conserva límites y suma respaldo comercial en la nube.
- 20261120121000_platform_admin_console.sql — get_platform_companies, set_platform_company_status, set_platform_support_request_status y retiro de la sobrecarga ambigua de settings.

## Regla de aislamiento

Una cuenta empresarial no obtiene privilegios administrativos por entrar a /admin. No se debe implementar autorización basada únicamente en localStorage, user_metadata o un flag de frontend.

## Evolución

Implementado en 1.1.0:

1. Dashboard global
2. Empresas con estado, plan y vencimiento
3. Planes y solicitudes con aprobación manual (importe + referencia)
4. Centro de soporte con triage por estado
5. Configuración de canales oficiales (WhatsApp, correo, privacidad, Facebook, canal)

Pendiente:

1. Detalle profundo por empresa (historial de pagos por cuenta)
2. Sesiones de soporte temporales
3. Auditoría administrativa visible en el panel
4. Seguridad avanzada (2FA obligatorio, IP allowlist)

Las nuevas tablas administrativas deben diseñarse con RLS y, cuando requieran elevación de privilegios, mediante funciones seguras con autenticación explícita del operador administrativo.