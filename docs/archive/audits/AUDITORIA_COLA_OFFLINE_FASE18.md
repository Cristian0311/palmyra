# Auditoría de cola offline — Fase 18

Fecha: 2026-09-26
Proyecto: OmniSync POS
Base de código auditada: Fase 17

## Resultado

Se auditó la cola offline de extremo a extremo: almacenamiento, hidratación al iniciar, encolado, deduplicación, reintentos, orden temporal, operaciones concurrentes, persistencia IndexedDB/localStorage, sincronización automática/manual y RPC críticas de Supabase.

Se encontraron y corrigieron **5 problemas funcionales importantes**.

## Hallazgos y correcciones

### 1. Operaciones concurrentes podían desaparecer de la cola

`processOfflineQueue()` trabajaba con una instantánea y al finalizar reemplazaba `memoryQueue` por el resultado de esa instantánea. Si durante una sincronización entraba una nueva venta/transferencia o se actualizaba el mismo `actionId`, la operación podía quedar fuera de memoria aunque ya hubiera sido guardada en IndexedDB.

**Corrección:** se agregó reconciliación entre la instantánea inicial y el estado actual de la cola. Las operaciones nuevas o modificadas durante la sincronización sobreviven al ciclo actual y quedan `pending`.

También se respetan eliminaciones explícitas realizadas durante el procesamiento.

### 2. Un tipo de operación no soportado podía marcarse como sincronizado

El `switch` terminaba con `default: return true`. Eso podía retirar una operación desconocida de la cola sin enviarla a Supabase.

**Corrección:** ahora un tipo no soportado genera `PermanentSyncError` y queda como `conflict`, nunca como sincronizado.

### 3. Fallos de IndexedDB podían considerarse persistidos

`openDb()` convertía un error de apertura de IndexedDB en `null`, y varias funciones interpretaban `null` como una operación exitosa. Además, algunos fallos de escritura solo se registraban en consola.

**Corrección:** los errores de apertura/escritura ahora se propagan; las operaciones intentan conservar un respaldo en localStorage y el sincronizador no declara una cola limpia cuando no pudo persistir correctamente.

La migración inicial tampoco elimina la cola legacy si IndexedDB falla.

### 4. La opción de sincronización manual no se respetaba completamente

`manualOfflineSync=true` evitaba el watcher principal, pero `realtimeSync.ts` podía ejecutar `processOfflineQueue()` al reconectar, enfocar la ventana o hacer visible la aplicación.

**Corrección:** el coordinador Realtime ahora respeta `manualOfflineSync`; solo una sincronización explícita (`force`) puede saltarse esa preferencia.

### 5. `close_cash_session_v2` no era idempotente y usaba una columna inexistente

La función existente generaba un nuevo ID aleatorio de liquidación en cada reintento. Esto era peligroso para una cola offline porque una respuesta perdida después de que Supabase hubiera confirmado el cierre podía producir otra liquidación al reintentar.

Además, la función hacía referencia a `salary_settlements.discrepancy_deduction`, pero esa columna no existe en la tabla actual.

**Corrección aplicada en Supabase:**
- bloquea el turno con `FOR UPDATE`;
- si ya está cerrado, devuelve el cierre existente;
- reutiliza la liquidación existente por `session_id`;
- utiliza el `id` de liquidación generado localmente cuando existe;
- usa `ON CONFLICT (id)` para hacer el upsert idempotente;
- elimina la referencia a `discrepancy_deduction` inexistente.

La misma corrección quedó reflejada en `SUPABASE_MIGRATION.sql` y `SUPABASE_MIGRATION.canonical.sql`.

## Cobertura de operaciones

La unión `OfflineActionType` contiene **31 tipos** y los 31 tienen un handler explícito en `processQueueItem()`.

Se verificó que no existen tipos declarados sin `case` correspondiente.

## Verificaciones realizadas

- Balance de llaves de `offlineSync.ts`: 0.
- `tsc --noEmit`: no reporta errores dentro de `src/services/offlineSync.ts` ni `src/services/realtimeSync.ts`. El proyecto completo no puede compilarse en este entorno porque `node_modules` no está instalado; los errores restantes son principalmente módulos/dependencias ausentes.
- Pruebas estáticas de los 31 tipos de cola: PASS.
- Pruebas de regresión de concurrencia de cola: PASS.
- Operación no soportada: ahora se bloquea como conflicto en lugar de eliminarse silenciosamente.
- Supabase confirma que `close_cash_session_v2` es idempotente y ya no referencia `discrepancy_deduction`.
- Prueba reversible del cierre offline: dos ejecuciones sobre el mismo turno dentro de una transacción produjeron **1 sola liquidación**; la transacción fue revertida con `ROLLBACK`.
- Antes de la corrección no había sesiones con liquidaciones duplicadas en `salary_settlements`.
- Después de la prueba reversible, no quedó la liquidación de prueba ni se cerró permanentemente el turno usado.

## Comportamiento esperado después de Fase 18

1. Una venta offline se guarda primero localmente.
2. Si la aplicación se reconecta, la cola puede sincronizar automáticamente solo cuando la configuración lo permite.
3. Si la sincronización es manual, Realtime no vacía la cola por detrás.
4. Una operación que entra mientras otra sincroniza no se pierde.
5. Una operación repetida conserva su `actionId` y puede reintentarse de forma segura cuando la RPC es idempotente.
6. Si IndexedDB falla, la aplicación no debe declarar falsamente que la cola quedó vacía.
7. Una operación desconocida nunca se elimina silenciosamente.
8. El cierre de turno no debe crear liquidaciones duplicadas por reintentos de red.

## Pendiente de prueba física

La auditoría de código y base de datos quedó corregida/verificada. La última validación que requiere un dispositivo real es el ciclo completo en una tablet:

**offline → venta → cola visible → reconexión → sincronización → recarga de página → cola 0 → venta existente en Supabase → inventario descontado una sola vez.**

Esta prueba depende de cambiar físicamente la conectividad del dispositivo y no se puede simular completamente desde la base de datos.
