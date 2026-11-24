/**
 * Pruebas de la simulación del piloto F7 (scripts/pilot-sim.ts).
 *
 * Todo es puro y determinista: no hay temporizadores, red ni archivos. Se
 * valida la semilla, el reparto nube/LAN de cada topología, los cortes de
 * internet, los presupuestos de 1 y 5 equipos, el pico diario y el informe.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PILOT_DEVICE_BUDGET,
  PILOT_RESTORE_BUDGET_MINUTES,
  assertPilotBudgets,
  createPrng,
  formatPilotReport,
  simulatePilot,
  type PilotDeviceSummary,
  type PilotResult
} from "../../scripts/pilot-sim";

const SEED = 20261117;

function copy(result: PilotResult): PilotResult {
  return structuredClone(result);
}

test("la misma semilla produce el mismo piloto y otra semilla lo cambia", () => {
  const first = simulatePilot({ seed: 4242, days: 14 });
  const again = simulatePilot({ seed: 4242, days: 14 });
  const other = simulatePilot({ seed: 9999, days: 14 });

  assert.deepEqual(first, again);
  assert.notDeepEqual(first, other);
  assert.equal(first.totals.sales, again.totals.sales);
  assert.notEqual(
    `${first.totals.sales}/${first.totals.conflicts}`,
    `${other.totals.sales}/${other.totals.conflicts}`
  );

  // El PRNG también es reproducible por sí solo y devuelve valores en [0,1).
  const rollA = createPrng(7);
  const rollB = createPrng(7);
  for (let index = 0; index < 8; index += 1) {
    const value = rollA();
    assert.equal(value, rollB());
    assert.ok(value >= 0 && value < 1);
  }
});

test("topología hub: un solo equipo habla con la nube y el resto va por LAN", () => {
  const hub = simulatePilot({ topology: "hub", devices: 5, seed: SEED });

  assert.equal(hub.cloudSyncers.length, 1);
  const syncer = hub.deviceSummaries.find((device) => device.cloudSyncer);
  assert.ok(syncer, "el hub debe tener un syncer en la nube");
  assert.ok((syncer as PilotDeviceSummary).totalCloud > 0);

  for (const device of hub.deviceSummaries) {
    if (device.cloudSyncer) continue;
    assert.equal(device.totalCloud, 0, `${device.label} no debe gastar nube en hub`);
    assert.ok(device.days.every((day) => day.cloudRequests === 0));
    assert.ok(device.totalLan > 0, `${device.label} debe trabajar por LAN`);
    assert.ok(device.days.filter((day) => day.online).every((day) => day.lanRequests > 0));
  }

  // En directa cada equipo es su propio syncer y no hay tráfico LAN.
  const direct = simulatePilot({ topology: "direct", devices: 5, seed: SEED });
  assert.equal(direct.cloudSyncers.length, 5);
  assert.ok(direct.deviceSummaries.every((device) => device.cloudSyncer));
  assert.equal(direct.totals.lanRequests, 0);
});

test("los días sin internet no gastan nube y el atraso se recupera por LAN o lote", () => {
  const offlineDays = [4, 5, 6];
  const hub = simulatePilot({ topology: "hub", devices: 5, days: 14, offlineDays, seed: SEED });

  for (const device of hub.deviceSummaries) {
    for (const day of device.days) {
      if (offlineDays.includes(day.day)) {
        assert.equal(day.online, false);
        assert.equal(day.cloudRequests, 0, `${device.label} gastó nube el día ${day.day} sin internet`);
      } else {
        assert.equal(day.online, true);
        if (device.cloudSyncer) {
          assert.ok(day.cloudRequests > 0, `${device.label} no sincronizó el día ${day.day} en línea`);
        } else {
          assert.ok(day.lanRequests > 0, `${device.label} no sincronizó por LAN el día ${day.day}`);
        }
      }
    }
  }

  // El syncer acumuló las filas del negocio durante el corte y las vació al
  // reconectar: no se pierde ninguna venta.
  const syncer = hub.deviceSummaries.find((device) => device.cloudSyncer) as PilotDeviceSummary;
  assert.ok(syncer.days.some((day) => day.backlogRows > 0));
  assert.ok(hub.totals.rowsRecovered > 0);
  assert.equal(hub.totals.backlogAtEnd, 0);
  assert.equal(hub.totals.rowsRecovered, syncer.days.reduce((max, day) => Math.max(max, day.backlogRows), 0));

  // La LAN sigue funcionando sin internet: los clientes siguen empujando al hub.
  const client = hub.deviceSummaries.find((device) => !device.cloudSyncer) as PilotDeviceSummary;
  for (const day of client.days.filter((entry) => offlineDays.includes(entry.day))) {
    assert.ok(day.lanRequests > 0, `el cliente LAN se quedó sin canal el día ${day.day}`);
  }
});

test("presupuestos directos: 1 equipo <100/día y 5 equipos <500/día", () => {
  const one = simulatePilot({ topology: "direct", devices: 1, seed: SEED });
  const five = simulatePilot({ topology: "direct", devices: 5, seed: SEED });
  const hub = simulatePilot({ topology: "hub", devices: 5, seed: SEED });

  assert.equal(one.budgets.business, PILOT_DEVICE_BUDGET);
  assert.equal(five.budgets.business, 500);
  assert.equal(hub.budgets.business, PILOT_DEVICE_BUDGET);

  assert.ok(one.totals.perDayAverage < 100, `directa 1 equipo: ${one.totals.perDayAverage}/día`);
  assert.ok(five.totals.perDayAverage < 500, `directa 5 equipos: ${five.totals.perDayAverage}/día`);
  assert.ok(hub.totals.perDayAverage < 100, `hub 5 equipos: ${hub.totals.perDayAverage}/día`);

  // El hub consolida: gasta bastante menos nube que cinco equipos en directa.
  assert.ok(hub.totals.cloudRequests < five.totals.cloudRequests);

  for (const result of [one, five, hub]) {
    const report = assertPilotBudgets(result);
    assert.equal(report.ok, true, report.failures.join("; "));
    assert.deepEqual(report.failures, []);
    assert.ok(result.restore.estimatedMinutes < PILOT_RESTORE_BUDGET_MINUTES);

    for (const device of result.deviceSummaries) {
      for (const day of device.days) {
        assert.ok(day.push <= 96, `push ${day.push} fuera de tope el día ${day.day}`);
        assert.ok(day.pull <= 48, `pull ${day.pull} fuera de tope el día ${day.day}`);
        assert.ok(day.lease <= 2);
        assert.ok(day.rates <= 48);
        assert.ok(day.plan <= 1);
        assert.ok(day.cloudRequests >= 0);
        assert.equal(
          day.cloudRequests,
          day.push + day.pull + day.bootstrap + day.lease + day.rates + day.plan
        );
      }
      assert.equal(device.bootstrapRequests, device.cloudSyncer ? 34 : 0);
    }
  }
});

test("el pico diario coincide con el máximo real de la serie", () => {
  for (const result of [
    simulatePilot({ topology: "hub", devices: 5, seed: SEED }),
    simulatePilot({ topology: "direct", devices: 5, seed: SEED })
  ]) {
    const dailyMax = Math.max(...result.daily.map((day) => day.cloudRequests));
    assert.ok(result.totals.peakDay, "debe haber un pico");
    assert.equal((result.totals.peakDay as { requests: number }).requests, dailyMax);

    const peakDay = result.daily.find((day) => day.cloudRequests === dailyMax);
    assert.ok(peakDay);
    assert.equal((result.totals.peakDay as { day: number }).day, (peakDay as { day: number }).day);

    // La suma por día cuadra con la suma por equipo.
    assert.equal(
      result.daily.reduce((sum, day) => sum + day.cloudRequests, 0),
      result.deviceSummaries.reduce((sum, device) => sum + device.totalCloud, 0)
    );

    for (const device of result.deviceSummaries) {
      const max = Math.max(...device.days.map((day) => day.cloudRequests));
      if (max > 0) assert.equal((device.peakDay as { requests: number }).requests, max);
      else assert.equal(device.peakDay, null);
      assert.equal(device.averagePerDay, Math.round((device.totalCloud / result.days) * 100) / 100);
    }
  }
});

test("el informe trae las etiquetas exigidas por el piloto", () => {
  const hub = simulatePilot({ topology: "hub", devices: 5, seed: SEED });
  const text = formatPilotReport(hub);

  for (const label of [
    /Piloto PALMYRA/,
    /28 días · 5 equipos/,
    /topología hub/,
    /Semilla 20261117/,
    /días sin internet: 9, 10, 18, 24/,
    /Syncer en la nube: PC Caja 1/,
    /nube días 1-7:/,
    /LAN  días 1-7:/,
    /Solicitudes a la nube \(total\): \d+/,
    /Promedio diario del negocio: \d+\.\d\/día/,
    /Pico: día \d+ con \d+ solicitudes/,
    /Tráfico LAN \(no cuenta contra la nube\): \d+/,
    /Conflictos resueltos: \d+/,
    /Ciclos de sincronización: \d+/,
    /Restauración estimada: \d+\.\d min/,
    /Presupuesto por equipo \(<100\/día\): OK/,
    /Presupuesto del negocio \(<100\/día\): OK/,
    /presupuestos F7 en verde/
  ]) {
    assert.match(text, label);
  }

  const direct = formatPilotReport(simulatePilot({ topology: "direct", devices: 1, seed: SEED }));
  assert.match(direct, /28 días · 1 equipo · topología directa/);
  assert.match(direct, /Presupuesto del negocio \(<100\/día\): OK/);
  assert.match(direct, /Pico: día \d+ con \d+ solicitudes/);
});

test("un presupuesto excedido sale a la luz y no se silencia", () => {
  const base = simulatePilot({ topology: "direct", devices: 5, seed: SEED });

  const inflated = copy(base);
  inflated.totals.cloudRequests *= 10;
  inflated.totals.perDayAverage = 640;
  inflated.deviceSummaries = inflated.deviceSummaries.map((device) => ({
    ...device,
    totalCloud: device.totalCloud * 10,
    averagePerDay: 128
  }));

  const report = assertPilotBudgets(inflated);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((failure) => /Presupuesto por equipo excedido/.test(failure)));
  assert.ok(report.failures.some((failure) => /Presupuesto del negocio excedido/.test(failure)));
  assert.ok(report.failures.some((failure) => /límite 500/.test(failure)));
  const text = formatPilotReport(inflated);
  assert.match(text, /FALLA: presupuesto F7 incumplido/);
  assert.match(text, /Presupuesto del negocio \(<500\/día\): FALLA/);

  const slowRestore = copy(base);
  slowRestore.restore.estimatedMinutes = 40;
  const slowReport = assertPilotBudgets(slowRestore);
  assert.equal(slowReport.ok, false);
  assert.ok(slowReport.failures.some((failure) => /Restauración demasiado lenta/.test(failure)));

  const twoSyncers = copy(simulatePilot({ topology: "hub", devices: 3, seed: SEED }));
  twoSyncers.cloudSyncers.push("equipo-intruso");
  const syncerReport = assertPilotBudgets(twoSyncers);
  assert.equal(syncerReport.ok, false);
  assert.ok(syncerReport.failures.some((failure) => /exactamente 1/.test(failure)));

  const pending = copy(base);
  pending.totals.backlogAtEnd = 12;
  const pendingReport = assertPilotBudgets(pending);
  assert.equal(pendingReport.ok, false);
  assert.ok(pendingReport.failures.some((failure) => /sin subir al cierre/.test(failure)));
});
