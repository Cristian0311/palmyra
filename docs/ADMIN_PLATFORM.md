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

Acciones sensibles actuales:

- get_platform_companies
- get_pending_plan_requests
- approve_plan_request
- reject_plan_request
- set_platform_company_status

## Regla de aislamiento

Una cuenta empresarial no obtiene privilegios administrativos por entrar a /admin. No se debe implementar autorización basada únicamente en localStorage, user_metadata o un flag de frontend.

## Evolución prevista

1. Dashboard global
2. Empresas y detalle de empresa
3. Planes y suscripciones
4. Pagos y comprobantes
5. Centro de soporte con sesiones temporales
6. Auditoría administrativa
7. Configuración global y seguridad avanzada

Las nuevas tablas administrativas deben diseñarse con RLS y, cuando requieran elevación de privilegios, mediante funciones seguras con autenticación explícita del operador administrativo.