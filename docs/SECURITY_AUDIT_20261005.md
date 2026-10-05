# PALMYRA — Auditoría de seguridad y multitenant 2026-10-05

## Verificación ejecutada

Proyecto Supabase PALMYRA (ref hmcvujyqloyjdvngpdxz), PostgreSQL 17.

### Hallazgos corregidos

- Se detectó un teléfono fijo histórico (55581669) en palmyra_onboard_company y select_company_plan.
- La función de onboarding y selección de plan ya no lo contiene.
- La solicitud existente que lo tenía fue normalizada a teléfono de perfil/Auth cuando existe; si no, queda vacía.
- La corrección quedó aplicada en Supabase como migración 20261005145703_fix_plan_request_phone_source y debe permanecer versionada en el repositorio.

### RLS / tenant

Las tablas públicas revisadas mantienen RLS habilitado. Las tablas críticas de empresa, membresías, roles, empleados, acceso de empleados a almacenes, almacenes, ventas, pagos, caja, sincronización y solicitudes de plan usan predicados de pertenencia/permiso basados en la capa privada.

company_fiscal_reservations y company_fiscal_sequences aparecen con RLS habilitado y sin políticas directas. Se consideran tablas internas y no se deben exponer como tablas de lectura/escritura directa; su acceso debe ocurrir por funciones privilegiadas controladas.

### SECURITY DEFINER

Supabase Advisors reporta 96 funciones SECURITY DEFINER ejecutables por authenticated. Este aviso no demuestra por sí solo una vulnerabilidad: la aplicación usa estas funciones como frontera de operaciones privilegiadas.

La revisión de funciones críticas incluyó:

- create_sale_transaction: autentica al usuario, valida pertenencia a empresa, permiso POS, almacén, vendedor, empleado y caja.
- close_cash_session: autentica, exige permiso de cierre y valida acceso al almacén.
- create_employee_secure: autentica, exige permiso de gestión de empleados y valida rol, límites y almacenes.
- create_warehouse_secure: autentica y exige permisos de configuración de empresa.
- enqueue_sync_operation: autentica, valida el plan offline, empresa y dispositivo.
- select_company_plan: autentica y exige que el usuario sea propietario de la empresa.
- approve_plan_request: exige pertenencia a platform_admins.

No se debe revocar EXECUTE de estas funciones en bloque sin clasificar primero qué RPC son parte del runtime.

### Pendiente de configuración externa

Supabase Advisor reporta:

- Protección contra contraseñas filtradas/descomprometidas deshabilitada. Debe activarse desde la configuración de Auth.
- 102 índices actualmente marcados como no usados. Esto es un hallazgo de rendimiento informativo; no se eliminan automáticamente porque varios son índices de soporte FK o pueden empezar a usarse cuando crezca el SaaS.

### Regla para la siguiente fase

No introducir nuevas funciones SECURITY DEFINER en public sin:

1. comprobar auth.uid();
2. comprobar empresa/tenant;
3. comprobar permiso explícito;
4. comprobar almacén cuando la operación sea localizada;
5. limitar los argumentos de acceso a IDs pertenecientes al tenant;
6. restringir el grant de EXECUTE al rol mínimo necesario.

Fecha: 2026-10-05.
