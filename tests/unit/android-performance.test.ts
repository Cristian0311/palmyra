import test from "node:test";
import assert from "node:assert/strict";
import {
  PERFORMANCE_BUDGETS,
  isSqliteRuntimeAvailable,
  runPerformanceBenchmark,
  type PerfMetric,
  type PerfRunResult
} from "../../scripts/android-perf";

// Versión acotada para CI: valida el arnés y detecta regresiones gruesas; los
// presupuestos se relajan ×10 para no castigar máquinas compartidas.
const CI_VENTAS = 5_000;
const CI_ESCALA = 10;
const CI_VENTAS_MEMORIA = 400;
const REGRESION_MS_POR_VENTA = 20;

function metrica(resultado: PerfRunResult, prefijo: string): PerfMetric {
  const encontrada = resultado.metricas.find((entrada) => entrada.operacion.startsWith(prefijo));
  assert.ok(encontrada, `falta la métrica "${prefijo}" (hay: ${resultado.metricas.map((entrada) => entrada.operacion).join(", ")})`);
  return encontrada;
}

test("android-perf: 5.000 ventas dentro de presupuestos holgados", async () => {
  const sqlite = await isSqliteRuntimeAvailable();
  // Sin node:sqlite no se puede medir el motor real: la muestra en memoria se
  // reduce porque su transacción copia todo el estado en cada venta (O(n²)).
  const ventas = sqlite ? CI_VENTAS : CI_VENTAS_MEMORIA;

  const resultado = await runPerformanceBenchmark({
    engine: sqlite ? "sqlite" : "memory",
    sales: ventas,
    budgetScale: CI_ESCALA,
    hydrationDiagnostic: false
  });

  assert.equal(resultado.motor, sqlite ? "sqlite" : "memory");
  assert.equal(resultado.ventas, ventas);
  assert.equal(resultado.escalaPresupuesto, CI_ESCALA);
  assert.equal(resultado.excedido, false, `presupuesto excedido: ${JSON.stringify(resultado.metricas)}`);
  assert.deepEqual(
    resultado.notas.filter((nota) => nota.includes("inconsistente")),
    [],
    "el reporte por rango no coincide con lo insertado"
  );

  // Integridad del conjunto generado: sin esto la medición no vale nada.
  const { dataset } = resultado;
  assert.equal(dataset.ventas, ventas);
  assert.ok(dataset.lineas >= dataset.ventas, "cada venta debe tener al menos una línea");
  assert.equal(dataset.movimientos, dataset.lineas, "un movimiento de stock por línea");
  assert.ok(dataset.pagos >= dataset.ventas, "al menos un pago por venta");
  assert.ok(dataset.totalVendido > 0);
  assert.ok(dataset.ventasEnRango > 0, "la ventana de 30 días debe tener ventas");
  assert.ok(dataset.ventasEnRango <= dataset.ventas);
  assert.ok(dataset.totalEnRango > 0 && dataset.totalEnRango <= dataset.totalVendido);
  if (sqlite) {
    assert.ok(dataset.ventasEnRango < dataset.ventas, "el rango debe recortar el histórico");
  }

  const insercion = metrica(resultado, `insercion ${ventas} ventas`);
  const ultimas = metrica(resultado, "ultimas 200 ventas");
  const reporte = metrica(resultado, "reporte 30 dias");
  const arranque = metrica(resultado, "arranque (catalogo + ventana 200)");

  assert.equal(ultimas.presupuestoMs, PERFORMANCE_BUDGETS.last200Ms * CI_ESCALA);
  assert.equal(arranque.presupuestoMs, PERFORMANCE_BUDGETS.bootMs * CI_ESCALA);
  assert.equal(reporte.presupuestoMs, PERFORMANCE_BUDGETS.reportRangeMs * CI_ESCALA);
  assert.equal(ultimas.veredicto, "ok");
  assert.equal(reporte.veredicto, "ok");
  assert.equal(arranque.veredicto, "ok");
  assert.ok(ultimas.detalle?.includes("200 filas"), "la ventana debe devolver 200 ventas");
  assert.equal(
    resultado.metricas.some((entrada) => entrada.operacion.includes("hidratacion")),
    false,
    "la hidratación completa no forma parte del gate de CI"
  );

  if (sqlite) {
    assert.equal(insercion.veredicto, "ok");
  } else {
    assert.equal(insercion.veredicto, "informativo");
  }

  // Regresión gruesa: por encima de esto el arnés ya no está midiendo lo mismo.
  const msPorVenta = insercion.ms / ventas;
  assert.ok(msPorVenta < REGRESION_MS_POR_VENTA, `inserción lentísima: ${msPorVenta.toFixed(2)} ms/venta`);
});
