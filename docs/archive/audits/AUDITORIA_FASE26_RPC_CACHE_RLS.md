# Auditoría Fase 26 — RPC, schema cache, salary settlements y RLS

## Hallazgos

1. `open_cash_session_v2` sí existe en producción con la firma esperada. El 404 `PGRST202` correspondía al schema cache de PostgREST; se forzó `NOTIFY pgrst, 'reload schema'` y se verificó la función.
2. Se verificaron las 12 RPC críticas usadas por el frontend; todas existen en `public` con una única firma actual.
3. `salary_settlements` ya no recibe `discrepancy_deduction` en los upserts actuales. También se eliminó ese campo del payload JSON del cierre para mantener una sola representación canónica.
4. Se mejoró el diagnóstico de errores RPC para incluir `code`, `status`, `details` y `hint`.
5. `complete_inventory_audit_v2` es `SECURITY INVOKER` y escribe/elimina filas en `inventory_audit_items`. Esa tabla tenía RLS activo pero ninguna policy, por lo que el RPC podía fallar. Se creó `Public Full Access`, coherente con la arquitectura actual de autenticación personalizada, y se actualizó el SQL de migración.
6. El servidor ahora evita cachear `sw.js`, `registerSW.js` y el manifest, reduciendo el riesgo de que un navegador mantenga un Service Worker antiguo que sirva un bundle obsoleto.

## Riesgo conocido

Las policies `Public Full Access` son una solución de compatibilidad con el modelo actual `anon` + autenticación propia de la aplicación. No constituyen un modelo de autorización fuerte. La migración futura recomendada es Supabase Auth + RLS por usuario/sucursal/rol, pero no se mezcla con esta reparación para no romper el flujo offline-first.

## Estado

- Schema cache de RPC: corregido y recargado.
- RPC críticas: presentes.
- Salary settlements: esquema alineado.
- Diagnóstico RPC: mejorado.
- Inventory audit items: RLS desbloqueado para el RPC invoker.
- Service Worker: mitigación de cache stale añadida.
- Build completo: aún no certificado en este entorno porque las dependencias npm no están instaladas localmente.
