import test from "node:test";
import assert from "node:assert/strict";
import { SOAK_SALES_PER_DAY, runSoak } from "../../scripts/android-soak";

test("android-soak: 3 días con integridad y reapertura diaria", async () => {
  const resumen = await runSoak({
    days: 3,
    // Arranca en lunes para que el tramo corto incluya devolución (día 1) y
    // transferencia entre almacenes (día 3).
    startDay: 1,
    dailyBackup: true
  });

  const fallos = resumen.checks.filter((check) => !check.ok).map((check) => `${check.nombre}: ${check.detalle}`);
  assert.deepEqual(fallos, [], `verificaciones fallidas: ${fallos.join(" | ")}`);
  assert.equal(resumen.ok, true);

  const nombres = new Set(resumen.checks.map((check) => check.nombre));
  for (const nombre of [
    "ventas-totales",
    "importe-vendido",
    "lineas-y-pagos",
    "sin-ventas-duplicadas",
    "documentos",
    "existencias-vs-ventas",
    "existencias-vs-libro",
    "respaldos-diarios",
    "restauracion-equivalente"
  ]) {
    assert.ok(nombres.has(nombre), `falta la verificación "${nombre}"`);
  }

  assert.equal(resumen.dias, 3);
  assert.equal(resumen.ventas, 3 * SOAK_SALES_PER_DAY);
  assert.equal(resumen.turnos, 3, "un turno abierto y cerrado por día");
  assert.ok(resumen.devoluciones >= 1, "el tramo debe incluir al menos una devolución");
  assert.ok(resumen.transferencias >= 1, "el tramo debe incluir al menos una transferencia");
  assert.equal(resumen.respaldos, 3, "un respaldo cifrado por día");
  assert.ok(resumen.bytesUltimoRespaldo > 0);
  assert.ok(resumen.reintentosIdempotentes > 0, "debe ejercitarse el reintento idempotente");
  // Un actionId por venta más uno por turno, sin repetidos tras cada reapertura.
  assert.equal(resumen.actionIds, resumen.ventas + resumen.turnos);
});
