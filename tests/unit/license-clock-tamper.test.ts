import test from "node:test";
import assert from "node:assert/strict";

import { CLOCK_ROLLBACK_TOLERANCE_MS, LICENSE_SIGNATURE_ALG, LICENSE_VERSION } from "../../src/services/license/contract";
import type { SignedLease } from "../../src/services/license/contract";
import {
  assessClockIntegrity,
  clockTamperDraft,
  createMonotonicClock,
  nextWatermark
} from "../../src/services/license/clock";
import {
  LICENSE_CLOCK_TELEMETRY_MAX_EVENTS,
  LICENSE_STORE_KEYS,
  createMemoryLicenseStore,
  drainClockTamperEvents,
  loadClockTamperEvents,
  loadLease,
  loadWatermark,
  recordClockTamperEvent,
  saveLease,
  saveWatermark
} from "../../src/services/license/storage";
import {
  LicenseClockTamperError,
  LicenseReadOnlyError,
  applyLicenseClockGuard,
  applyLicenseTimeGate,
  assertLicenseWritable,
  clearLicenseClockTamper,
  getLicenseClockTamperReason,
  isLicenseClockTampered,
  isLicenseReadOnly,
  setLicenseClockTampered,
  setLicenseReadOnly,
  subscribeReadOnly
} from "../../src/services/license/guard";

/**
 * Endurecimiento del reloj de licencia: detección de retroceso contra la marca
 * de agua y el ancla del servidor, acumulador monotónico, telemetría local
 * acotada y guarda de solo lectura que no permite escribir tras una manipulación.
 */

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const COMPANY_A = "11111111-1111-4111-8111-111111111111";

const iso = (ms: number): string => new Date(ms).toISOString();

function makeLease(companyId = COMPANY_A): SignedLease {
  return {
    v: LICENSE_VERSION,
    leaseId: "lease-reloj-1",
    companyId,
    deviceId: "equipo-reloj-1",
    devicePubKeyFp: "fp-reloj-1",
    planCode: "growth",
    billingMonths: 1,
    limits: { warehouses: 2 },
    featureKeys: ["pos", "reports"],
    storageMode: "hybrid",
    paidThrough: iso(NOW + 10 * DAY),
    issuedAt: iso(NOW - 2 * HOUR),
    notBefore: iso(NOW - DAY),
    expiresAt: iso(NOW + 40 * DAY),
    offlineUntil: iso(NOW + 5 * DAY),
    graceDays: 5,
    maxOfflineDays: 30,
    serverTimeAnchor: iso(NOW - 2 * HOUR),
    seq: 1,
    keyId: "key-reloj",
    signature: "firma-simulada",
    signatureAlg: LICENSE_SIGNATURE_ALG
  };
}

/** Deja la guarda global en estado escribible antes de cada escenario. */
function resetGuard(): void {
  setLicenseReadOnly(false);
  clearLicenseClockTamper();
}

/* ------------------------- detección de retroceso ------------------------ */

test("retroceso > 10 min contra la marca de agua: tampered, tiempo congelado", () => {
  const integrity = assessClockIntegrity({
    previousMs: NOW,
    nowMs: NOW - 11 * MINUTE
  });

  assert.equal(integrity.tampered, true);
  assert.equal(integrity.source, "watermark");
  assert.equal(integrity.referenceMs, NOW);
  assert.equal(integrity.rollbackMs, 11 * MINUTE);
  assert.equal(integrity.effectiveMs, NOW);
  assert.equal(integrity.watermarkMs, NOW);
  assert.equal(integrity.frozen, true);

  // El borde exacto de la tolerancia NO es manipulación.
  assert.equal(
    assessClockIntegrity({ previousMs: NOW, nowMs: NOW - CLOCK_ROLLBACK_TOLERANCE_MS }).tampered,
    false
  );
  assert.equal(
    assessClockIntegrity({ previousMs: NOW, nowMs: NOW - CLOCK_ROLLBACK_TOLERANCE_MS - 1 }).tampered,
    true
  );

  // Un retroceso leve sin superar la tolerancia congela el tiempo pero no acusa.
  const mild = assessClockIntegrity({ previousMs: NOW, nowMs: NOW - 5 * MINUTE });
  assert.equal(mild.tampered, false);
  assert.equal(mild.effectiveMs, NOW);
  assert.equal(mild.frozen, true);

  // Sin ninguna referencia no hay evidencia.
  const noEvidence = assessClockIntegrity({ previousMs: null, nowMs: NOW - 5 * HOUR });
  assert.equal(noEvidence.tampered, false);
  assert.equal(noEvidence.source, null);
  assert.equal(noEvidence.effectiveMs, NOW - 5 * HOUR);
});

test("retroceso contra el ancla del servidor: tampered aunque no haya marca", () => {
  const integrity = assessClockIntegrity({
    previousMs: null,
    serverAnchorMs: NOW,
    nowMs: NOW - 30 * MINUTE
  });

  assert.equal(integrity.tampered, true);
  assert.equal(integrity.source, "server-anchor");
  assert.equal(integrity.effectiveMs, NOW);
  // El suelo que se persistiría sube hasta el ancla: la ventana no se alarga.
  assert.equal(integrity.watermarkMs, NOW);
  assert.equal(integrity.rollbackMs, 30 * MINUTE);

  // Gana la referencia más alta cuando varias superan la tolerancia.
  const both = assessClockIntegrity({
    previousMs: NOW - 2 * HOUR,
    serverAnchorMs: NOW,
    nowMs: NOW - 3 * HOUR
  });
  assert.equal(both.source, "server-anchor");
  assert.equal(both.referenceMs, NOW);
});

test("manipulación: el tiempo efectivo no extiende offlineUntil ni la marca", () => {
  const rollbackNow = NOW - 3 * HOUR;
  const integrity = assessClockIntegrity({ previousMs: NOW, nowMs: rollbackNow });
  assert.equal(integrity.tampered, true);

  const offlineUntilMs = NOW + 5 * DAY;
  const rawRemaining = offlineUntilMs - rollbackNow;
  const effectiveRemaining = offlineUntilMs - integrity.effectiveMs;
  assert.equal(effectiveRemaining, 5 * DAY);
  assert.ok(effectiveRemaining < rawRemaining);

  // La marca de agua solo avanza: un reloj atrasado no la mueve hacia atrás.
  assert.equal(
    nextWatermark({ previousMs: NOW, nowMs: rollbackNow, serverTimeMs: NOW - HOUR }),
    NOW
  );
});

/* --------------------------- acumulador monotónico ----------------------- */

test("acumulador monotónico: avanza con performance.now y nunca retrocede", () => {
  let perf = 1_000;
  let wall = NOW;
  const clock = createMonotonicClock({
    performanceNow: () => perf,
    wallNow: () => wall,
    initialWallMs: NOW
  });

  assert.equal(clock.available, true);
  assert.equal(clock.elapsedMs(), 0);
  assert.equal(clock.floorMs(), NOW);

  perf = 6_000; // +5 s
  assert.equal(clock.elapsedMs(), 5_000);
  assert.equal(clock.floorMs(), NOW + 5_000);

  // La pared cae una hora: la estimación monotónica no retrocede.
  wall = NOW - HOUR;
  perf = 7_000;
  const monotonicNow = clock.nowMs();
  assert.equal(monotonicNow, NOW + 6_000);

  // La fuente monotónica retrocede: no reduce el acumulado, solo se anota.
  perf = 6_500;
  assert.equal(clock.elapsedMs(), 6_000);
  assert.equal(clock.regressions(), 1);
  assert.equal(clock.regressionMs(), 500);

  perf = 7_000;
  assert.equal(clock.elapsedMs(), 6_500);
  assert.ok(clock.nowMs() >= monotonicNow);

  // El suelo monotónico basta para acusar la manipulación sin marca de agua.
  const integrity = assessClockIntegrity({
    previousMs: null,
    nowMs: NOW - 2 * HOUR,
    monotonicMs: clock.floorMs()
  });
  assert.equal(integrity.tampered, true);
  assert.equal(integrity.source, "monotonic");

  // Reanclar retoma el avance sin arrastrar el histórico.
  clock.rebase(NOW);
  assert.equal(clock.floorMs(), NOW);
});

test("acumulador monotónico: sin performance.now queda inerte pero seguro", () => {
  const clock = createMonotonicClock({
    performanceNow: null,
    wallNow: () => NOW + 500,
    initialWallMs: NOW
  });

  assert.equal(clock.available, false);
  assert.equal(clock.elapsedMs(), 0);
  assert.equal(clock.floorMs(), NOW);
  // Sin suelo monotónico manda la pared (nunca por debajo de la última lectura).
  assert.equal(clock.nowMs(), NOW + 500);
  assert.equal(clock.regressions(), 0);
});

/* ----------------------------- telemetría -------------------------------- */

test("telemetría: acotada a N eventos, agrupa repetidos y sin datos personales", async () => {
  const store = createMemoryLicenseStore();
  const lease = makeLease();
  await saveLease(store, lease, COMPANY_A);
  await saveWatermark(store, COMPANY_A, NOW);

  const overflow = LICENSE_CLOCK_TELEMETRY_MAX_EVENTS + 5;
  for (let index = 0; index < overflow; index += 1) {
    await recordClockTamperEvent(store, {
      kind: index % 2 === 0 ? "wall-rollback" : "monotonic-regression",
      source: index % 2 === 0 ? "watermark" : "monotonic",
      skewMs: 1_000 + index,
      // Una hora entre eventos: fuera de la ventana de deduplicación.
      detectedAtMs: NOW + index * HOUR
    });
  }

  const events = await loadClockTamperEvents(store);
  assert.equal(events.length, LICENSE_CLOCK_TELEMETRY_MAX_EVENTS);
  // Se descartan los más antiguos, no los más recientes.
  assert.equal(events[0].skewMs, 1_000 + (overflow - LICENSE_CLOCK_TELEMETRY_MAX_EVENTS));
  assert.equal(events[events.length - 1].skewMs, 1_000 + overflow - 1);

  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [
      "count",
      "firstSeenAt",
      "kind",
      "lastSeenAt",
      "skewMs",
      "source"
    ]);
    assert.ok(event.count >= 1);
    assert.ok(event.lastSeenAt >= event.firstSeenAt);
  }

  // Nada de identificadores de empresa, equipo ni lease en la telemetría.
  const serialized = JSON.stringify(events);
  for (const secret of [COMPANY_A, lease.leaseId, lease.deviceId, lease.devicePubKeyFp]) {
    assert.equal(serialized.includes(secret), false);
  }

  // La telemetría no toca el lease ni la marca de agua.
  assert.deepEqual(await loadLease(store, COMPANY_A), lease);
  assert.equal(await loadWatermark(store, COMPANY_A), NOW);
});

test("telemetría: agrupa repeticiones cercanas y el vaciado no borra datos", async () => {
  const store = createMemoryLicenseStore();
  const lease = makeLease();
  await saveLease(store, lease, COMPANY_A);
  await saveWatermark(store, COMPANY_A, NOW);

  await recordClockTamperEvent(store, {
    kind: "wall-rollback",
    source: "watermark",
    skewMs: 700_000,
    detectedAtMs: NOW
  });
  await recordClockTamperEvent(store, {
    kind: "wall-rollback",
    source: "watermark",
    skewMs: 900_000,
    detectedAtMs: NOW + 5 * MINUTE
  });

  let events = await loadClockTamperEvents(store);
  assert.equal(events.length, 1);
  assert.equal(events[0].count, 2);
  assert.equal(events[0].skewMs, 900_000);
  assert.equal(events[0].firstSeenAt, NOW);
  assert.equal(events[0].lastSeenAt, NOW + 5 * MINUTE);

  // Un evento de otro origen abre un registro nuevo.
  await recordClockTamperEvent(store, {
    kind: "monotonic-regression",
    source: "monotonic",
    skewMs: 1_500,
    detectedAtMs: NOW + 6 * MINUTE
  });
  assert.equal((await loadClockTamperEvents(store)).length, 2);

  const drained = await drainClockTamperEvents(store);
  assert.equal(drained.length, 2);
  assert.deepEqual(await loadClockTamperEvents(store), []);
  // Vaciar la telemetría no es vaciar la licencia.
  assert.deepEqual(await loadLease(store, COMPANY_A), lease);
  assert.equal(await loadWatermark(store, COMPANY_A), NOW);

  // Sigue vacío si no hay nada pendiente.
  assert.deepEqual(await drainClockTamperEvents(store), []);
});

test("telemetría: registros corruptos se descartan sin lanzar", async () => {
  const store = createMemoryLicenseStore();
  const lease = makeLease();
  await saveLease(store, lease, COMPANY_A);

  await store.set(LICENSE_STORE_KEYS.clockTelemetry, "basura");
  assert.deepEqual(await loadClockTamperEvents(store), []);

  await store.set(LICENSE_STORE_KEYS.clockTelemetry, [
    { kind: "desconocido", source: "watermark", skewMs: 1, count: 1, firstSeenAt: NOW, lastSeenAt: NOW },
    { kind: "wall-rollback", source: "otro", skewMs: 1, count: 1, firstSeenAt: NOW, lastSeenAt: NOW },
    { kind: "wall-rollback", source: "watermark", skewMs: -9, count: 0, firstSeenAt: NOW, lastSeenAt: "x" },
    { kind: "wall-rollback", source: "watermark", skewMs: 50, count: 3, firstSeenAt: NOW, lastSeenAt: NOW + MINUTE }
  ]);
  const events = await loadClockTamperEvents(store);
  assert.equal(events.length, 1);
  assert.equal(events[0].skewMs, 50);
  assert.equal(events[0].count, 3);

  // Un borrador inválido no ensucia el registro ni lanza.
  await recordClockTamperEvent(store, {
    kind: "nada" as never,
    source: "watermark",
    skewMs: 1,
    detectedAtMs: NOW
  });
  assert.equal((await loadClockTamperEvents(store)).length, 1);

  assert.deepEqual(await loadLease(store, COMPANY_A), lease);
});

/* -------------------------------- guarda -------------------------------- */

test("guarda: una manipulación no permite escribir aunque la evaluación sea escribible", () => {
  resetGuard();
  const seen: boolean[] = [];
  const unsubscribe = subscribeReadOnly((value) => seen.push(value));

  const result = applyLicenseTimeGate({
    evaluationReadOnly: false,
    nowMs: NOW - 2 * HOUR,
    watermarkMs: NOW
  });

  assert.equal(result.tampered, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.effectiveMs, NOW);
  assert.equal(isLicenseReadOnly(), true);
  assert.equal(isLicenseClockTampered(), true);
  assert.ok((getLicenseClockTamperReason() ?? "").length > 0);
  assert.deepEqual(seen, [true]);

  assert.throws(
    () => assertLicenseWritable(),
    (error: unknown) =>
      error instanceof LicenseClockTamperError &&
      error instanceof LicenseReadOnlyError &&
      error.code === "license_clock_tampered"
  );

  // El runtime vuelve a publicar «escribible»: la manipulación sigue mandando.
  setLicenseReadOnly(false);
  assert.equal(isLicenseReadOnly(), true);
  assert.throws(() => assertLicenseWritable(), LicenseClockTamperError);

  // Tras resincronizar la hora se puede volver a escribir.
  clearLicenseClockTamper();
  assert.equal(isLicenseReadOnly(), false);
  assert.equal(isLicenseClockTampered(), false);
  assert.doesNotThrow(() => assertLicenseWritable());
  assert.deepEqual(seen, [true, false]);

  unsubscribe();
  resetGuard();
});

test("guarda: sin manipulación respeta el modo de la evaluación", () => {
  resetGuard();

  const clean = applyLicenseTimeGate({
    evaluationReadOnly: false,
    nowMs: NOW + MINUTE,
    watermarkMs: NOW
  });
  assert.equal(clean.tampered, false);
  assert.equal(clean.readOnly, false);
  assert.doesNotThrow(() => assertLicenseWritable());

  // Una licencia vencida sigue pasando a solo lectura con tiempo efectivo.
  const expired = applyLicenseTimeGate({
    evaluationReadOnly: true,
    nowMs: NOW + MINUTE,
    watermarkMs: NOW
  });
  assert.equal(expired.tampered, false);
  assert.equal(expired.readOnly, true);
  assert.throws(() => assertLicenseWritable(), LicenseReadOnlyError);

  // Un reloj atrasado dentro de la tolerancia no acusa pero congela la hora.
  resetGuard();
  const mild = applyLicenseTimeGate({
    evaluationReadOnly: false,
    nowMs: NOW - 5 * MINUTE,
    watermarkMs: NOW
  });
  assert.equal(mild.tampered, false);
  assert.equal(mild.frozen, true);
  assert.equal(mild.effectiveMs, NOW);
  assert.equal(mild.readOnly, false);

  resetGuard();
});

test("guarda con almacén: detecta, persiste el evento y conserva los datos", async () => {
  resetGuard();
  const store = createMemoryLicenseStore();
  const lease = makeLease();
  await saveLease(store, lease, COMPANY_A);
  await saveWatermark(store, COMPANY_A, NOW);
  const offlineUntilMs = Date.parse(lease.offlineUntil);

  const tampered = await applyLicenseClockGuard(store, {
    companyId: COMPANY_A,
    nowMs: NOW - 30 * MINUTE,
    serverAnchorMs: Date.parse(lease.serverTimeAnchor),
    offlineUntilMs,
    evaluationReadOnly: false
  });

  assert.equal(tampered.tampered, true);
  assert.equal(tampered.source, "watermark");
  assert.equal(tampered.readOnly, true);
  assert.equal(tampered.effectiveMs, NOW);
  // La ventana restante sale del tiempo efectivo: no se alarga por el atraso.
  assert.equal(tampered.offlineRemainingMs, offlineUntilMs - NOW);
  assert.equal(isLicenseReadOnly(), true);
  assert.throws(() => assertLicenseWritable(), LicenseClockTamperError);

  const pending = await loadClockTamperEvents(store);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "wall-rollback");
  assert.equal(pending[0].source, "watermark");
  assert.equal(pending[0].skewMs, 30 * MINUTE);

  // Nada se borró: lease y marca intactos.
  assert.deepEqual(await loadLease(store, COMPANY_A), lease);
  assert.equal(await loadWatermark(store, COMPANY_A), NOW);

  // Al reconectar se envía y se vacía la telemetría.
  const drained = await drainClockTamperEvents(store);
  assert.equal(drained.length, 1);
  assert.deepEqual(await loadClockTamperEvents(store), []);

  // Una lectura sana posterior no genera eventos y la marca puede avanzar.
  clearLicenseClockTamper();
  const clean = await applyLicenseClockGuard(store, {
    companyId: COMPANY_A,
    nowMs: NOW + 10 * MINUTE,
    offlineUntilMs
  });
  assert.equal(clean.tampered, false);
  assert.equal(clean.readOnly, false);
  assert.deepEqual(await loadClockTamperEvents(store), []);
  assert.doesNotThrow(() => assertLicenseWritable());

  resetGuard();
});

test("marcar la manipulación por sí sola ya bloquea escrituras", () => {
  resetGuard();
  setLicenseClockTampered(true, "prueba");
  assert.equal(isLicenseClockTampered(), true);
  assert.equal(isLicenseReadOnly(), true);
  assert.equal(getLicenseClockTamperReason(), "prueba");
  assert.throws(() => assertLicenseWritable(), LicenseClockTamperError);

  setLicenseClockTampered(true);
  assert.equal(getLicenseClockTamperReason(), "prueba");

  // `setLicenseReadOnly(false)` no la limpia.
  setLicenseReadOnly(false);
  assert.throws(() => assertLicenseWritable(), LicenseClockTamperError);

  resetGuard();
  assert.doesNotThrow(() => assertLicenseWritable());
});

/* -------------------------- borradores de evento ------------------------- */

test("borrador de telemetría: solo existe cuando hay manipulación", () => {
  const clean = assessClockIntegrity({ previousMs: NOW, nowMs: NOW + MINUTE });
  assert.equal(clockTamperDraft(clean), null);

  const rollback = assessClockIntegrity({ previousMs: NOW, nowMs: NOW - HOUR });
  const draft = clockTamperDraft(rollback, NOW);
  assert.ok(draft);
  assert.equal(draft.kind, "wall-rollback");
  assert.equal(draft.source, "watermark");
  assert.equal(draft.skewMs, HOUR);
  assert.equal(draft.detectedAtMs, NOW);

  const monotonic = assessClockIntegrity({
    previousMs: null,
    nowMs: NOW - HOUR,
    monotonicMs: NOW
  });
  assert.equal(clockTamperDraft(monotonic)?.kind, "monotonic-regression");
});
