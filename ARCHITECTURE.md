# PALMYRA — arquitectura

La fuente canónica y completa de la arquitectura está en
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): principios y fuente de verdad,
superficies de ejecución (Windows/Electron, Android, web/PWA, LAN), licencias y
actualizaciones, nube mínima (cursores, ventana de arranque, presupuesto,
respaldo cifrado y alcance de Realtime), piloto con migración guiada, métricas y
restauración del hub, reglas de operaciones críticas, offline, capas del
frontend, base de datos y calidad.

Índice rápido:

- Modelo operativo: Empresa → Almacenes → Empleados → Roles/Permisos → Acceso por almacén → Operaciones.
- Local-first: `src/services/localDb/` es la base de lectura/escritura de la UI; `src/services/cloudSync/` materializa contra Supabase.
- Migración guiada: `src/services/localDb/migration/guided.ts` exige respaldo verificado (30 min) y permite volver al modo anterior; el hub restaura `.pbak` desde IPC con confirmación.
- Piloto: métricas locales en `src/services/pilot/metrics.ts`, lista de 7 pasos en `src/components/system/PilotChecklist.tsx` y manual en [docs/PILOTO_MANUAL.md](docs/PILOTO_MANUAL.md).
- Sin despliegue público activo: se opera en local (Windows, Android y PWA).
- Reglas y tamaño de archivos: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#reglas-de-mantenimiento).
