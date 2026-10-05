# Auditoría de acceso Administrador vs Trabajador — Fase 21

## Resultado

El enrutamiento del CRM ya separaba correctamente los perfiles:
- Administrador: Dashboard, POS, transferencias, clientes, inventario, auditoría, proveedores, bancos, devoluciones, reportes y configuración.
- Trabajador: únicamente `/pos`.
- Las rutas administrativas redirigen al POS si el usuario no tiene `role === 'admin'`.

## Problemas encontrados y corregidos

### 1. Apertura de turno podía acreditar a otro trabajador
En el POS, el formulario de apertura mostraba todos los trabajadores/IDN activos a cualquier usuario. Un trabajador podía seleccionar otro trabajador y, si conocía su contraseña, abrir el turno con la identidad de ese otro trabajador.

Corrección:
- Administrador conserva el selector de trabajadores/IDN.
- Trabajador queda asociado a su propia cuenta.
- Un trabajador no puede abrir un turno para otro usuario.

### 2. Trabajador sin sucursal podía heredar todas las sucursales
El cálculo anterior de sucursales tenía un fallback a todas las sucursales cuando el trabajador no tenía asignación.

Corrección:
- Administrador: todas las sucursales.
- Trabajador: únicamente `assignedBranchId`, `branchId` o `allowedBranches`.
- Sin ninguna autorización: 0 sucursales y no puede abrir caja.
- Se valida también al enviar el formulario, por lo que no depende solamente de la interfaz.

### 3. Un trabajador podía intentar unirse al turno de otro trabajador
El flujo de reanudación/join aceptaba cualquier turno abierto si se conocía la contraseña del propietario.

Corrección:
- Trabajador solo puede unirse a su propio turno y a una sucursal autorizada.
- Administrador mantiene la capacidad de operar con otros turnos.

### 4. Error de JSX detectado en la Fase 20
La versión de Fase 20 tenía un `</div>` faltante en `Settings.tsx`, lo que impedía una compilación limpia.

Corrección:
- Se restauró el cierre del contenedor.
- La transpilación sintáctica de `POS.tsx`, `Settings.tsx` y `App.tsx` queda sin diagnósticos.

## Comprobación de rutas

`App.tsx` contiene guardas para todas las rutas administrativas. Un trabajador que navegue directamente a `/settings`, `/reports`, `/inventory`, `/banks`, `/transfers`, `/returns`, `/suppliers`, `/customers` o `/inventory-audit` es redirigido a `/pos`.

## Riesgo adicional detectado

Supabase tiene políticas `Public Full Access` (`ALL`, `qual=true`, `with_check=true`) en tablas críticas como `users`, `transactions`, `inventory`, `products`, `customers`, `suppliers`, `branches`, `cash_sessions` y `bank_transactions`.

Esto no expone módulos administrativos dentro de la UI del trabajador, pero significa que la separación de roles actualmente es principalmente una restricción del frontend/flujo de la aplicación. Cambiar esas políticas a RLS por rol/sucursal requiere una migración de autorización más amplia y pruebas para no romper el POS offline-first.

## Estado

- Separación de navegación: OK.
- Redirección de rutas restringidas: OK.
- POS para trabajador: OK después de las correcciones.
- Apertura de turno: corregida.
- Sucursal autorizada: corregida.
- Unión a turno: corregida.
- Sintaxis de los archivos modificados: OK.
- Compilación completa: no certificada porque el proyecto de auditoría no tiene instaladas sus dependencias npm; `tsc` reporta módulos ausentes, no errores sintácticos en estos cambios.
