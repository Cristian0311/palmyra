# Optimización POS — Fase 3

## Objetivo
Reducir renders y trabajo del camino crítico del POS sin sacrificar el funcionamiento offline.

## Cambios
- `transactions` ya no mantiene una suscripción activa en el POS mientras no esté abierto Gestión de Caja o el resumen de turno cerrado.
- `cashSessions` solo se suscribe mientras está abierto el flujo de apertura/unión de turno.
- La generación de número de ticket y de IDN toma un snapshot de `useStore.getState()` al ejecutar la operación, en vez de hacer que el POS observe todo el historial de transacciones.
- `html5-qrcode` pasó a importación dinámica; no forma parte del trabajo/bundle inicial del POS.
- Se eliminó un import no utilizado de `qrcode.react`.
- La persistencia IndexedDB existente ya tiene batching de 250 ms; se conserva porque retirar colecciones operativas podría romper el trabajo offline.

## Qué NO se cambió
- No se eliminó `transactions` ni `inventory` de la persistencia offline.
- No se cambió la lógica de confirmación de ventas.
- No se cambió la cola offline ni el mecanismo de sincronización.
- No se fragmentó más `POS.tsx` solo para reducir el número de líneas.

## Verificación
- `scripts/integrity-smoke.mjs`: PASS.
- No se pudo ejecutar `tsc`/build completo porque esta copia no tiene las dependencias instaladas; los errores reportados por TypeScript son principalmente módulos externos ausentes.
