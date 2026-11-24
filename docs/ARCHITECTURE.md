# Arquitectura PALMYRA

Fuente canónica de la arquitectura. El `ARCHITECTURE.md` de la raíz es solo un
índice que apunta aquí.

## Fuente de verdad y principios

PALMYRA es un SaaS multiempresa local-first sobre React/Vite + Supabase Auth +
PostgreSQL/RLS/RPC. El modelo operativo es:

**Empresa → Almacenes → Empleados → Roles/Permisos → Acceso por almacén → Operaciones**

El inventario pertenece al almacén. El aislamiento de datos se determina por la
empresa activa (tenant) y el acceso a almacenes se controla por
membresía/permisos. El código conserva algunos nombres históricos como
`branchId`/`currentBranchId` por compatibilidad durante la migración progresiva
de nomenclatura; no se debe reintroducir una arquitectura de sucursales en la
base de datos.

Hoy no hay despliegue público activo: la aplicación se instala y opera en local
(Windows, Android y navegador/PWA). Supabase sigue siendo la autoridad remota de
identidad, tenant, licencias y datos empresariales.

## Superficies de ejecución

- **Windows (Electron)**: `main.electron.cjs` + `electron/` empaquetan el servidor
  local (`dist/desktop-server.cjs`) y sirven la app desde `http://127.0.0.1:10000`.
- **Android**: APK con base SQLite nativa y el mismo cliente web.
- **Web/PWA**: navegador con IndexedDB y service worker.
- **LAN**: `src/services/lanHub/` y `lanHost.ts` actúan como hub de una tienda
  (emparejamiento por PIN/QR, SSE y respaldo) para cajas que comparten datos.

## Licencias y actualizaciones

- Licencias locales en `src/services/license/` (activación, lease, revocación,
  guardia de reloj y telemetría); las edge functions `issue-lease` y
  `revoke-lease` emiten y revocan leases.
- Actualizaciones de escritorio en `src/services/updates/`: el manifiesto
  `update-manifest.json` se firma con ES256 y es el ancla de confianza del
  updater (ver `electron-builder.yml`).
- Actualizaciones de Android por red (OTA) o desde un archivo copiado por USB/SD,
  con verificación del paquete antes de instalar.

### Cadena firmada (F5 cerrada)

Contrato y verificación: `src/services/updates/manifest.ts` (esquema v1 y
comparación de versiones), `verify.ts` (firma ES256, evaluación de canal,
rollout y «shell demasiado antiguo»), `client.ts` (descarga con timeout, solo
HTTPS y cadencia) y `runtime.ts` (estado compartido del renderer). El hook
`useAppUpdateRuntime` es único por módulo, así que Layout, el Centro de
actualizaciones (`src/components/system/UpdateCenter.tsx`) y el resto de la UI
comparten una sola comprobación y un solo descarte persistente.

- **Cadencia**: al arrancar (primer montaje del hook), cada 24 h
  (`DEFAULT_UPDATE_INTERVAL_MS`, persistida en `palmyra-update-check-v1`) y
  manual desde el Centro de actualizaciones; además se reintenta al volver a
  primer plano o a tener red, sin temporizadores propios.
- **Custodia de la clave**: la privada (PEM PKCS8 o JWK EC P-256) vive solo en
  `C:\Users\R3ZERO\Documents\Qoder\2026-11-17\aeac25cf\.secrets`
  (`update-signing-key.pem`, `update-signing-key.jwk.json`), nunca en el
  repositorio ni en el bundle. La pública está versionada en
  `src/services/updates/update-public-key.json` (`kid` `palmyra-stable-2026-11`,
  huella SHA-256 SPKI `D4:3C:AE:7B:5F:4D:C5:88:AC:DE:29:27:50:78:17:E0:94:1D:B9:47:C4:A2:48:F9:ED:85:CA:6D:EB:9A:58:E9`).
  Rotar la clave exige publicar un build con la nueva JWK incrustada y volver a
  firmar el manifiesto: los equipos rechazan cualquier manifiesto cuya firma no
  corresponda a la clave incrustada.
- **Secretos de GitHub requeridos por `.github/workflows/release.yml`**:
  `UPDATE_SIGNING_KEY` (PEM PKCS8 EC P-256, firma del manifiesto),
  `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` y
  `ANDROID_KEY_PASSWORD` (APK de release firmado). Opcionales:
  `UPDATE_MANIFEST_KEY_JWK` (JWK privada heredada; el pipeline avisa que se
  migre a `UPDATE_SIGNING_KEY`) y, como variables de build del escritorio,
  `UPDATE_MANIFEST_PUBLIC_JWK` y `PALMYRA_UPDATE_PUBLISHER_THUMBPRINT` (huella
  SHA-1 del certificado Authenticode en mayúsculas). Ningún valor de estos
  secretos se documenta ni se registra en logs.
- **Guardián de CI**: el preflight exige los secretos y compara la clave privada
  con la JWK incrustada (`src/services/updates/update-public-key.json`); si no
  coinciden, el release falla antes de compilar. `scripts/build-update-manifest.mjs`
  firma el manifiesto y `scripts/check-release-assets.mjs` +
  `scripts/verify-release-assets.mjs` validan los cinco assets publicados.
- **Escritorio**: `main.electron.cjs` verifica el manifiesto antes de descargar
  (`verifyUpdateManifestForBoot`) y bloquea la descarga mientras
  `verifiedUpdateVersion` no coincida con la versión ofrecida; la instalación
  desde archivo (USB/SD) se ancla al manifiesto firmado (SHA-256 y tamaño del
  artefacto Windows) cuando no hay certificado Authenticode, y exige la huella
  del publisher cuando está configurada.
- **Android**: `src/services/updates/android.ts` validación y aplicación OTA
  (bundle o APK) con SHA-256 del artefacto; `AndroidManualUpdate.tsx` cubre el
  paquete copiado por USB/SD. El shell web conserva su propio aviso PWA; el
  polling web `/version.json` ya no alimenta el aviso del POS.


## Nube mínima, respaldo y presupuesto (F6 cerrada)

La nube deja de ser un espejo periódico del negocio: el hub LAN mueve los datos
de operación y Supabase queda para identidad, tenant, licencias, catálogo de
arranque, historial bajo demanda y respaldo cifrado.

### Cursores de sincronización

- **Subida** (`cloudSync/sync.ts`, `runner.ts`): journal local por `seq`, cursor
  por empresa en `palmyra:cloudsync:cursor:<companyId>` y lote de 200 filas.
  Intervalo mínimo 15 min, 96 envíos/día y retroceso exponencial hasta 30 min.
- **Descarga** (`cloudSync/pullRemote.ts` → `pullEngine.ts` → `pull.ts`): cursor
  de tiempo `updated_at` en `palmyra:cloudsync:pull:<companyId>`, ventana máxima
  de 7 días, 500 filas por lote (tope duro 1000), RPC `pull_cloud_changes` y
  filtro de tabla segura vía `localTableForCloud`/`PULLABLE_TABLES` (nunca
  `outbox`, `hub_devices` ni `hub_receipts`). La aplicación es last-writer-wins
  por `(version, updated_at)` en una sola transacción; los conflictos se
  reportan, no se pisan. El cursor solo avanza cuando el lote se aplicó.
- Cadencia: la descarga programada se intenta como mucho cada 30 min
  (`PULL_INTERVAL_MS`) y se salta cuando el día ya consumió 90 solicitudes
  (`SCHEDULED_REQUEST_CEILING`); `syncNow` (manual) ignora intervalo y umbral.

### Ventana de arranque e historial

`loadBootstrapData` (`services/supabaseSync/pull.ts`) es el único arranque: un
catálogo pequeño más una ventana operativa de 90 días (`BOOTSTRAP_WINDOW_DAYS`)
acotada por tabla (300 ventas, 400 turnos, 500 movimientos, 200 traslados y
extras, 2.000 clientes) y por `BOOTSTRAP_REQUEST_BUDGET = 25` consultas de
ventana. El historial anterior se pide bajo demanda con `loadOlderSalesHistory`
(keyset por `created_at`, 100 filas por página, máximo 200) y el paginador
`ReportsHistoryPager`. No existe ruta de descarga de historial completo.

### Presupuesto de solicitudes

`requestBudget` cuenta en `palmyra:request-budget:v1` (7 días) cada solicitud
medida con su ruta: `cloud/pull`, `cloud/push`, `catalog/*` y `window/*` del
bootstrap, `rates/client`, `rates/hub`, `license/lease`, `backup/cloud` y
`admin/*`. El panel de Ajustes (`RequestBudgetPanel`) lo compara con 100/día por
equipo (`DEVICE_DAILY_BUDGET`) y 500/día por negocio (`BUSINESS_DAILY_BUDGET`).
Fórmula de referencia por equipo y día:

```
pull programado  ≤ 48   (cada 30 min, se corta al llegar a 90 en el día)
bootstrap        ~ 34   (una vez por arranque: catálogo + ventana ≤ 25)
lease de licencia  2    (cada 12 h)
tasas del cliente  pocas (una por ciclo de 45 min y solo sin sesión de hub)
                    < 100/día por equipo
```

El tráfico de negocio en tiempo real va por el hub LAN, así que cinco equipos
siguen por debajo de 500/día. El push conserva además su propio tope interno
(`DEFAULT_MAX_REQUESTS_PER_DAY = 96`), que es un límite de cadencia, no el
presupuesto compartido.

### Tasas elTOQUE desde el hub

`lanHub/rateScheduler.ts` fija la cadencia del hub: 45 min como objetivo
(`RATE_TARGET_MS`) con ±3 min de jitter acotado entre 30 y 60 min
(`RATE_MIN_MS`/`RATE_MAX_MS`), arranque a los 10 s y retroceso de 5 a 30 min
ante fallos. El runtime de escritorio (`src/desktop/mainRuntime.ts`) ejecuta el
planificador y persiste la última copia válida en `hub-rates.json` (permisos
0600) dentro del directorio de usuario; el hub publica `GET /lan/v1/rates`.
`ELTOQUE_API_TOKEN` solo vive en el servidor/hub: `server.ts` (Render) y el
runtime de escritorio lo leen para consultar elTOQUE, y el renderer nunca habla
con elTOQUE directamente. `lanHub/rates.ts` es cache-first: si no hay sesión de
hub usa la copia local y solo consulta `/api/exchange-rates` propio cuando la
superficie es autónoma (web/APK/escritorio sin hub).

### Respaldo cifrado fuera del sitio

`localDb/backup/cloud.ts` sube el MISMO sobre cifrado del respaldo local
(`.pmlr`, AES-256-GCM con PBKDF2-SHA256) más un manifiesto `.pmlr.json` con
tamaño, SHA-256 del archivo, hash de contenido y conteos. Ruta obligatoria
`<companyId>/<deviceId>/<YYYY-MM-DD>.pmlr[.json]` en el cubo privado
`palmyra-backups` (200 MB por archivo, sin acceso público: la política compara
la primera carpeta con las membresías activas). Retención con mínimo de copias,
deduplicación por SHA-256/hash de contenido y restauración verificada
(tamaño → SHA-256 → manifiesto → frase → conteos). `useCloudBackup` programa el
ciclo cada 24 h con reanudación al volver la red.

**Custodia de la clave**: la frase que escribe el usuario nunca se guarda. Para
que el respaldo diario funcione sin abrir Ajustes se genera una clave de
recuperación por empresa que sí queda en `localStorage`
(`palmyra:cloud-backup-key:v1:<companyId>`) y la UI la muestra para que el dueño
la copie fuera del equipo. Aviso obligatorio en soporte: si se pierden la frase y
esa clave, el respaldo es irrecuperable (ni PALMYRA ni Supabase pueden
descifrarlo); borrar los datos del navegador o cambiar de equipo sin haber
guardado la clave equivale a perderla.

### Alcance de Realtime

`realtimeSync.ts` solo se suscribe a `notifications` (ámbito de usuario) y
`plan_requests` (consola de plataforma) para la aprobación de planes. No hay
canales de tablas de negocio, ni sondeo de 120 s, ni refresco al recuperar foco:
eso lo cubre SSE del hub LAN. Al arrancar se ejecuta un único
`bootstrapCloudData()` por tenant/sucursal y `refreshRealtimeNow()` queda como
refresco manual de Ajustes.

### Dependencias y migraciones pendientes (no aplicadas)

- `supabase/migrations/20261123090000_local_change_inbox.sql`: bandeja de
  cambios locales y RPC `ingest_local_changes`.
- `supabase/migrations/20261123120000_license_revocations.sql`: revocaciones de
  lease y telemetría de manipulación del reloj.
- `supabase/migrations/20261123150000_local_change_materializer.sql`: RPC del
  materializador de cambios locales.
- `supabase/migrations/20261123180000_license_telemetry_and_plan_gates.sql` y
  Edge Function `license-telemetry`: telemetría de manipulación y gates de plan.
- `supabase/migrations/20261124090000_cloud_pull_changes.sql`: RPC
  `pull_cloud_changes(p_company_id, p_since, p_limit)` `SECURITY DEFINER` con
  `search_path` fijo y validación de acceso por empresa.
- `supabase/migrations/20261124091000_cloud_backups_bucket.sql`: cubo privado
  `palmyra-backups`, límite de 200 MB y políticas por prefijo de empresa.
- Sin esas migraciones el pull responde vacío (`error` en el RPC ausente), el
  respaldo en la nube queda deshabilitado y los gates de licencia no reciben
  telemetría; el resto de la app sigue operando.
- Variables de entorno: `ELTOQUE_API_TOKEN` en el servidor Render y en el
  hub de escritorio; `SUPABASE_URL`/`SUPABASE_ANON_KEY` para cliente y servidor.
  El respaldo reutiliza la sesión de Supabase del usuario, así que no añade
  secretos nuevos; el pipeline de GitHub no necesita variables extra por F6.

## Piloto, migración y rollback (F7 cerrada)

- **Migración guiada** (`localDb/migration/guided.ts`): reutiliza el importador
  verificado (`importLegacy` + `importVerify`) y añade el gate del respaldo
  obligatorio (comprobante `{ at, bytes, sha256? }`, caduca a los 30 min y debe
  coincidir con el registrado), la relectura posterior y el progreso por empresa
  en `palmyra:migration-guided:v1:<companyId>`. No borra el JSON legado: la
  retención de 30 días y la vuelta al modo anterior son marcas independientes de
  la paridad (`localDb/parity.ts`). El panel `GuidedMigrationPanel` vive en
  Configuración → Administración avanzada y crea el respaldo previo con la clave
  de recuperación por empresa que muestra `useCloudBackup`.
- **Métricas del piloto** (`pilot/metrics.ts`): lee solo registros locales
  (presupuesto F6, ledger de sync, salud de la cola, historial de
  actualizaciones y contador de tickets de `platformSupport`) y agrega la
  ventana de 7 días. Claves `palmyra:update-history:v1`,
  `palmyra:support-tickets:v1` y `palmyra:pilot-risks:v1` (90 días). El panel
  `PilotMetricsPanel` (pestaña **Piloto**) copia el informe y descarga JSON sin
  hacer red; `PilotChecklist` guarda la lista de siete pasos por ámbito de
  usuario/empresa.
- **Respaldos del hub**: `main.electron.cjs` valida el nombre del `.pbak`,
  resuelve la empresa, pide confirmación en un diálogo nativo, crea una
  instantánea `safety-*.pbak` antes de escribir y solo entonces restaura; si la
  instantánea falla no se toca nada. La ventana (`DesktopDiagnostics`) solo
  lista y solicita la restauración por IPC (`palmyra:hub:backup:list|restore`)
  y `electron/preload.cjs` sanea la respuesta.
- **Herramientas de aceptación**: `npm run drill:restore` (simulacro de
  restauración con 5.000 ventas y 2.000 saldos, tope de 15 min) y
  `npm run pilot:sim` (simulación determinista del consumo diario por topología
  y número de equipos). El manual de campo es `docs/PILOTO_MANUAL.md`.

## Reglas de operaciones críticas

- Venta online: UI → base local (write-through) → RPC transaccional → Supabase → reconciliación.
- Venta offline: UI → estado local + outbox durable → replay idempotente → Supabase → reconciliación.
- Inventario: los cambios críticos pasan por RPCs atómicos en PostgreSQL.
- Transferencias: la operación remota es la autoridad y usa identificadores de operación estables.
- Caja: apertura/cierre y numeración de turnos son autoritativos en Supabase.
- Un turno nunca se renumera por borrar otro turno. Los reportes deben mostrar el `turnNumber` persistido.
- El stock por variante se mantiene separado y normalizado.
- Supabase es la fuente de verdad para identidad, tenant, permisos y datos empresariales.

## Offline

La base local (`src/services/localDb/`: SQLite en escritorio/Android, IndexedDB en
web) es la fuente de lectura y escritura de la UI. La cola durable
(`src/services/offline/`, `offlineQueue*`) debe sobrevivir a recargas y cierres
del navegador. Las operaciones críticas conservan su ID para que un replay
después de un timeout no genere una segunda venta, transferencia o movimiento.
`src/services/cloudSync/` transporta y materializa los cambios contra Supabase.

## Capas y organización del frontend

- `src/pages/`: páginas y coordinación de UI.
- `src/modules/<dominio>/`: lógica reutilizable por dominio (POS, Reports, Inventory, Cash Register, Transfers).
- `src/services/`: sincronización, SaaS, dispositivos y persistencia offline.
- `src/store/`: estado global y fachadas; evitar introducir lógica extensa nueva aquí.
- `src/lib/`: infraestructura transversal (Supabase, impresión ESC/POS, utilidades).
- `supabase/migrations/`: cambios de esquema y RPC; toda modificación de seguridad debe quedar versionada.

La refactorización es incremental para no cambiar el flujo de trabajadores:

```
src/
  components/
  config/
  design/
  desktop/
  hooks/
  lib/
  modules/
    cash-register/
    inventory/
    pos/
    reports/
    transfers/
    warehouse/
  pages/
  services/
    cloudSync/
    lanHub/
    license/
    localDb/
    offline/
    offlineQueue/
    supabaseSync/
    updates/
  store/
    actions/
    utils/
  utils/
```

Las páginas grandes se convierten progresivamente en composición de componentes, hooks, servicios y utilidades. No se permite seguir acumulando dominio nuevo en `useStore.ts`, `POS.tsx` o `Reports.tsx`.

## Reglas de mantenimiento

1. Ningún TS/TSX/JS/JSX puede llegar a 4000 líneas. El auditor estricto falla en 4000+.
2. Extraer primero lógica pura; mantener efectos asíncronos y estado React cerca de la página hasta tener dependencias explícitas.
3. No duplicar reglas de negocio entre página, store y sincronización.
4. Las consultas Supabase deben filtrar por `company_id` y, cuando corresponda, por los IDs de registros padre ya acotados al tenant.
5. No revocar masivamente RPC `SECURITY DEFINER`; revisar autorización función por función.
6. Los cambios de nomenclatura Branch → Warehouse son progresivos para no romper datos ni flujo de trabajadores.

## Base de datos

Las migraciones nuevas viven únicamente en `supabase/migrations/`. Los SQL históricos de reparación pueden documentar incidentes, pero no son la fuente actual de esquema.

No hay entorno de producción publicado: las migraciones se validan en local y en
el entorno de pruebas antes de cualquier despliegue.

RLS debe permanecer habilitado en tablas públicas expuestas. Las funciones `SECURITY DEFINER` se usan solo cuando una operación necesita privilegio controlado y deben validar identidad, empresa y alcance.

## Calidad

CI debe ejecutar, como mínimo:

1. TypeScript sin errores (cliente y panel admin).
2. Auditoría de arquitectura.
3. Pruebas unitarias de lógica crítica (133 archivos en `tests/unit/`).
4. Build de producción web, desktop-ready y smoke PWA offline.
5. `npm run check:android`: validador estático del empaquetado Android.

Bajo demanda: `npm run drill:restore` (simulacro de restauración) y
`npm run pilot:sim` (simulación de consumo del piloto).

Los archivos fuente de varios miles de líneas deben modularizarse antes de añadir más lógica de dominio.

## Estado actual (2026-11-24)

- `useStore.ts`: 563 líneas.
- `POS.tsx`: 2.458 líneas.
- `Reports.tsx`: 1.734 líneas.
- `Inventory.tsx`: 1.980 líneas.
- `Settings.tsx`: 927 líneas.
- `offlineSync.ts`: 665 líneas.
- `supabaseSync/pull.ts`: 1.316 líneas (arranque acotado + historial; el resto
  del archivo son los cargadores por tabla que ya existían).
