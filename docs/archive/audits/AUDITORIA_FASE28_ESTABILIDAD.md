# Fase 28 — Auditoría y corrección de estabilidad offline/POS

## Hallazgos corregidos

1. **Reconexión engañosa (`navigator.onLine`)**
   - El navegador puede anunciar `online` antes de que DNS/TLS/PostgREST estén disponibles.
   - La cola ahora hace una prueba real contra Supabase antes de comenzar el replay.
   - Al reconectar espera brevemente y vuelve a comprobar la API.

2. **PGRST202 al abrir turno**
   - `open_cash_session_v3` existe en producción con la firma exacta.
   - Se forzó un `NOTIFY pgrst, 'reload schema'` y el proyecto ya dispone de triggers `pgrst_ddl_watch` y `pgrst_drop_watch` para refresco automático.
   - El cliente reintenta una vez un `PGRST202` antes de dejar la operación en cola.

3. **Caché de navegador/PWA sobre REST**
   - Las llamadas HTTP de Supabase usan `cache: no-store` y encabezados anti-caché.
   - Workbox queda configurado con `NetworkOnly` para REST/Auth/Storage/Functions de Supabase.
   - Realtime WebSocket no se trata como una petición HTTP cacheable.

4. **Orden incorrecto de la cola**
   - Se eliminó la prioridad global que podía mover operaciones válidas de inventario/ventas.
   - Ahora se usa orden estable con dependencias explícitas: sucursal/producto/cliente/usuario antes de ventas; apertura antes de venta; orden de proveedor antes de recepción; auditoría antes de completarla; etc.

5. **Idempotencia de reconciliación**
   - La detección de replay se limita a producto+sucursal+variante+operation_id.
   - Las reconciliaciones con delta cero reciben una marca durable, evitando reintentos infinitos.

6. **Idempotencia adicional de ventas**
   - La migración de Fase 28 deja `transactions.idempotency_key = p_id` además de la PK.

7. **Rendimiento de FKs**
   - Se agregó una migración con índices para las 35 FKs señaladas por el advisor de Supabase.

## Estado de verificación

- `open_cash_session_v3` existe con firma exacta en producción.
- Las RPC críticas son `SECURITY INVOKER` y tienen `search_path = public, pg_temp`.
- El uso de la cola sigue siendo durable en IndexedDB.
- Los archivos modificados de Fase 28 pasan análisis sintáctico TypeScript.
- No se pudo ejecutar `npm ci` dentro del entorno de auditoría: agotó el límite de tiempo. Por eso **no se declara un build Vite completo como verificado**.

## Pendiente deliberado

La migración no cambia las políticas RLS públicas actuales porque el proyecto utiliza autenticación propia basada en la tabla `users`; reemplazar esas políticas sin migrar primero a Supabase Auth/RBAC podría bloquear operaciones legítimas. Ese endurecimiento debe hacerse como una fase separada y controlada.
