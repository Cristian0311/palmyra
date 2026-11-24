# PALMYRA — hoja de ruta actual

## Estado

- Versión en curso: **1.3.5** (`package.json`).
- Fases **F0–F7 cerradas**: base local (F0/F1), escritorio/LAN/licencias (F2),
  nube y materialización (F3), Android autónomo (F4), actualizaciones firmadas
  (F5), nube mínima y respaldo (F6) y piloto/migración (F7).
- **Nada desplegado**: no hay hosting público activo ni entorno de producción
  en uso; la operación objetivo es local-first (Windows, Android y LAN). Queda
  por delante solo el despliegue del entorno, no trabajo de producto.
- Base de conocimientos ya disponible: 133 archivos de pruebas unitarias
  (1.133 pruebas), auditoría estructural en CI y 167 migraciones versionadas en
  `supabase/migrations/`.
- Avisos de despliegue: seis migraciones, una Edge Function y el cubo de
  Storage están en el repositorio pero **sin aplicar/desplegar** (detalle en
  «Pendiente»).

## Fases

### F0 — Base operativa y saneamiento (cerrada)

Autenticación SaaS, empresa, almacenes, planes, equipo y permisos por almacén;
POS, inventario, caja/turnos, reportes, proveedores, bancos, devoluciones y
auditoría. Incluye la limpieza de artefactos históricos (`scripts/archive/`,
`docs/` de auditoría) y los portones de CI: TypeScript, pruebas unitarias,
auditoría de arquitectura, smoke de integridad, build web y build del panel.

### F1 — Offline y base local (cerrada)

Persistencia local-first en `src/services/localDb/` (SQLite en escritorio y
Android, IndexedDB en web, driver en memoria para pruebas) con escritura
directa desde POS, hidratación al arrancar, retención/backups, paridad con el
estado anterior, sombra legacy de verificación e importación del estado
histórico. La cola durable (`src/services/offline/`, `offlineQueue*`) mantiene
replay idempotente y sobrevive recargas.

### F2 — Escritorio, LAN y licencias (cerrada)

Empaquetado Electron (`main.electron.cjs`, `electron/`, `electron-builder.yml`)
con servidor local en un solo archivo, actualización automática verificada por
firma ES256 del manifiesto (`src/services/updates/`), instalador NSIS y APK
Android. Hub LAN (`src/services/lanHub/`, `lanHost.ts`) con emparejamiento por
PIN/QR, SSE y respaldo. Licencias locales (`src/services/license/`) con
activación, lease, revocación y telemetría, más las edge functions
`issue-lease` y `revoke-lease`.

### F3 — Nube y materialización (cerrada)

Sincronización con Supabase (`src/services/cloudSync/`), bandeja de cambios
locales y materializador (`materialize-local-changes`,
`20261123150000_local_change_materializer.sql`), revocaciones
(`20261123120000_license_revocations.sql`) y pruebas de extremo a extremo
(`tests/unit/cloud-*`, `scripts/local-e2e.ts`) con escenarios de recuperación
(corte de red, restauración de respaldo y revocación de licencia).

### F4 — Android autónomo (cerrada)

Respaldo cifrado en Descargas con MediaStore/SAF y respaldo programado con
estado visible; actualización por red (OTA) o desde un paquete copiado por
USB/SD. Rendimiento y aguante medidos con arneses deterministas (50.000 ventas
y 30 días sin red), diagnóstico Android exportable y validador del APK en CI
(`npm run check:android`).

### F5 — Actualizaciones firmadas (cerrada)

Manifiesto `update-manifest.json` firmado con ES256 (EC P-256) y verificado en
renderer, arranque de escritorio y CI. La clave privada se custodia solo fuera
del repositorio (`...\aeac25cf\.secrets`) y la pública queda versionada en
`src/services/updates/update-public-key.json`; el release de
`.github/workflows/release.yml` exige `UPDATE_SIGNING_KEY` y los secretos del
keystore Android, y falla si la clave firmante no coincide con la incrustada.
Incluye Centro de actualizaciones, diagnóstico de instalación, aviso OTA
Android (bundle/APK), actualización de escritorio desde archivo anclada al
manifiesto, bloqueo de descarga hasta verificar la versión y cadencia de
arranque + 24 h + manual. El polling web `/version.json` dejó de alimentar el
aviso del POS (se mantiene el aviso PWA del shell web).

### F6 — Nube mínima, respaldo y tasas (cerrada)

Descarga incremental por cursor de tiempo (`src/services/cloudSync/pull*.ts`) con
last-writer-wins local, cadencia de 30 min y presupuesto diario; arranque acotado
a catálogo + ventana de 90 días (`loadBootstrapData`) e historial de ventas bajo
demanda (`loadOlderSalesHistory`, paginador de Reportes); respaldo cifrado fuera
del sitio en el cubo privado `palmyra-backups` (AES-256-GCM, manifiesto con
SHA-256, deduplicación y retención, ciclo de 24 h, clave de recuperación por
empresa) en `src/services/localDb/backup/cloud.ts` y `useCloudBackup`; tasas
elTOQUE servidas por el hub LAN cada 45 min ± jitter con respaldo persistido
(`hub-rates.json`); realtime de nube reducido a `notifications`/`plan_requests`
y un único `bootstrapCloudData()` por tenant; `requestBudget` como contabilidad
única (<100/día por equipo, <500/día por negocio). Las migraciones
`20261124090000_cloud_pull_changes.sql` y `20261124091000_cloud_backups_bucket.sql`
quedan versionadas **sin aplicar**.

### F7 — Piloto, migración y rollback (cerrada)

Migración guiada del JSON legado al almacén normalizado
(`src/services/localDb/migration/`) con respaldo obligatorio que caduca a los
30 minutos, ejecución transaccional verificada por conteos, ventas, stock y
huella, reporte persistido y vuelta al modo anterior con marca de paridad.
Métricas del piloto en la pestaña **Piloto** (`src/services/pilot/metrics.ts`):
ventas en riesgo, conflictos, sync, presupuesto, actualizaciones y tickets de
los últimos 7 días, con copia/exportación local y sin tráfico de red. El
diagnóstico de escritorio lista los respaldos del hub y permite restaurarlos con
palabra de confirmación, diálogo nativo e instantánea de seguridad previa (IPC
restringido en `main.electron.cjs`/`electron/preload.cjs`). Manual de campo
(`docs/PILOTO_MANUAL.md`), lista de siete pasos en Configuración, simulacro de
restauración (`npm run drill:restore`, 5,8 s) y simulación de piloto
(`npm run pilot:sim`, 72,4/53,6/216,1 solicitudes por día).

## Pendiente

Queda únicamente trabajo de entorno y despliegue; el producto está completo
hasta F7 y verificado en local.

### Nube operativa y despliegue controlado (pendiente)

Migraciones versionadas **sin aplicar**:
`20261123090000_local_change_inbox.sql`,
`20261123120000_license_revocations.sql`,
`20261123150000_local_change_materializer.sql`,
`20261123180000_license_telemetry_and_plan_gates.sql`,
`20261124090000_cloud_pull_changes.sql` (RPC `pull_cloud_changes`) y
`20261124091000_cloud_backups_bucket.sql` (cubo `palmyra-backups`). Además:
crear el cubo de Storage `palmyra-backups` con sus políticas, desplegar la Edge
Function `license-telemetry`, cargar los secretos de GitHub/Render
(`UPDATE_SIGNING_KEY`, keystore Android, `SUPABASE_*`, `ELTOQUE_API_TOKEN`),
subir el manifiesto firmado y hacer el despliegue manual en Render. Después,
repetir los escenarios E2E de F3/F4 contra el entorno real. Nada de esto está
aplicado: no hay despliegue público activo.

### Aceptación del piloto real (4 semanas)

Criterios para declarar el piloto aprobado, medidos con la pestaña **Piloto**
(ventas en riesgo, conflictos, solicitudes, actualizaciones y tickets):

1. Cuatro semanas consecutivas de operación real en un negocio, con 1 a 5
   equipos (PC hub + cajas), sin volver al modo anterior salvo incidente
   justificado y documentado.
2. **Cero ventas perdidas**: ninguna operación aceptada por la UI queda sin
   consolidar; las ventas en riesgo al cierre de caja son 0 y no hay conflictos
   sin resolver con más de 24 h.
3. **Presupuesto de nube**: promedio por debajo de 100 solicitudes/día por
   equipo y 500/día por negocio, con el simulador (`npm run pilot:sim`) como
   referencia (hub 72,4 · directo 1 equipo 53,6 · directo 5 equipos 216,1).
4. **Restauración**: al menos un simulacro mensual (`npm run drill:restore`) y
   una restauración real de prueba por debajo de 15 minutos, verificada por
   conteos, con respaldo local y en la nube del mismo día.
5. **Actualizaciones**: la versión instalada avanza por el manifiesto firmado
   (o USB en su defecto) sin reinstalar ni perder datos, y el historial del
   panel refleja el resultado.
6. **Hub**: disponibilidad ≥ 99 % del horario de venta, plan de fallo conocido
   por el dueño y al menos un cambio de hub de prueba exitoso.
7. **Cierre**: el dueño firma la lista de siete pasos y entrega el informe
   diario/semanal del piloto (manual de campo) sin incidencias abiertas de
   severidad alta.

## Regla de cambios

Cada cambio funcional debe ser pequeño y verificable: código → CI → comprobación
local (web, escritorio, Android) → siguiente cambio.
