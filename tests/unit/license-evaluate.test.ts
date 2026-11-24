import test from "node:test";
import assert from "node:assert/strict";
import { CLOCK_ROLLBACK_TOLERANCE_MS } from "../../src/services/license/contract";
import type { SignedLease } from "../../src/services/license/contract";
import {
  detectClockRollback,
  effectiveNowMs,
  nextWatermark
} from "../../src/services/license/clock";
import { evaluateLease } from "../../src/services/license/evaluate";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const iso = (ms: number): string => new Date(ms).toISOString();

function baseLease(overrides: Partial<SignedLease> = {}): SignedLease {
  return {
    v: 1,
    leaseId: "lease-1",
    companyId: "11111111-1111-4111-8111-111111111111",
    deviceId: "device-1",
    devicePubKeyFp: "fp-device-1",
    planCode: "pro",
    billingMonths: 1,
    limits: { warehouses: 3, employees: 8 },
    featureKeys: ["pos", "reports"],
    storageMode: "hybrid",
    paidThrough: iso(NOW + 10 * DAY),
    issuedAt: iso(NOW - DAY),
    notBefore: iso(NOW - DAY),
    expiresAt: iso(NOW + 300 * DAY),
    offlineUntil: iso(NOW + 20 * DAY),
    graceDays: 7,
    maxOfflineDays: 20,
    serverTimeAnchor: iso(NOW - DAY),
    seq: 7,
    keyId: "key-1",
    signature: "firma-simulada",
    signatureAlg: "ES256",
    ...overrides
  };
}

function evaluate(overrides: Partial<SignedLease> = {}, extra: Partial<Parameters<typeof evaluateLease>[0]> = {}) {
  return evaluateLease({ lease: baseLease(overrides), nowMs: NOW, ...extra });
}

test("plan Gratis: indefinido, sin fechas ni lectura forzada", () => {
  const result = evaluate({
    planCode: "free",
    paidThrough: iso(NOW - 90 * DAY),
    offlineUntil: iso(NOW - 90 * DAY),
    expiresAt: iso(NOW - 90 * DAY)
  });

  assert.equal(result.mode, "free");
  assert.equal(result.readOnly, false);
  assert.equal(result.reason, "free");
  assert.deepEqual(result.featureKeys, ["pos", "reports"]);
  assert.deepEqual(result.limits, { warehouses: 3, employees: 8 });
  assert.equal(result.clockWarning, false);
  assert.equal(result.evaluatedAt, iso(NOW));
});

test("plan de pago vigente: activo y válido", () => {
  const result = evaluate();

  assert.equal(result.mode, "active");
  assert.equal(result.readOnly, false);
  assert.equal(result.reason, "valid");
  assert.equal(result.paidThrough, iso(NOW + 10 * DAY));
  assert.equal(result.offlineUntil, iso(NOW + 20 * DAY));
  assert.equal(result.expiresAt, iso(NOW + 300 * DAY));
  assert.equal(result.clockWarning, false);
});

test("después de paidThrough y dentro de la ventana offline: gracia operable", () => {
  const result = evaluate({
    paidThrough: iso(NOW - DAY),
    offlineUntil: iso(NOW + 5 * DAY)
  });

  assert.equal(result.mode, "grace");
  assert.equal(result.reason, "grace");
  assert.equal(result.readOnly, false);
  assert.equal(result.clockWarning, false);
});

test("ventana offline agotada: expirado", () => {
  const result = evaluate({
    paidThrough: iso(NOW - 10 * DAY),
    offlineUntil: iso(NOW - 2 * DAY)
  });

  assert.equal(result.mode, "expired");
  assert.equal(result.readOnly, true);
  assert.equal(result.reason, "expired");
});

test("expiresAt es tope absoluto aunque haya pago adelantado", () => {
  const result = evaluate({
    paidThrough: iso(NOW + 30 * DAY),
    offlineUntil: iso(NOW + 40 * DAY),
    expiresAt: iso(NOW - HOUR)
  });

  assert.equal(result.mode, "expired");
  assert.equal(result.readOnly, true);
  assert.equal(result.reason, "expired");
});

test("notBefore futuro: inválido y de solo lectura", () => {
  const result = evaluate({ notBefore: iso(NOW + DAY) });

  assert.equal(result.mode, "invalid");
  assert.equal(result.readOnly, true);
  assert.equal(result.reason, "not-yet-valid");
});

test("firma inválida explícita: no se evalúa la ventana", () => {
  const result = evaluate({}, { signatureValid: false });

  assert.equal(result.mode, "invalid");
  assert.equal(result.reason, "invalid-signature");
});

test("huella de dispositivo: coincide y no coincide", () => {
  const ok = evaluate({}, { devicePublicKeyFp: "fp-device-1" });
  assert.equal(ok.mode, "active");

  const wrong = evaluate({}, { devicePublicKeyFp: "fp-de-otro-equipo" });
  assert.equal(wrong.mode, "invalid");
  assert.equal(wrong.reason, "wrong-device");
  assert.equal(wrong.readOnly, true);
  assert.deepEqual(wrong.featureKeys, []);
});

test("lease malformado: invalid-lease sin lanzar", () => {
  const valid = baseLease();
  const cases: unknown[] = [
    null,
    undefined,
    { ...valid, v: 2 },
    { ...valid, paidThrough: "fecha-rota" },
    { ...valid, notBefore: "" },
    { ...valid, signature: "   " },
    { ...valid, planCode: "oro" }
  ];

  for (const candidate of cases) {
    const result = evaluateLease({ lease: candidate as SignedLease, nowMs: NOW });
    assert.equal(result.mode, "invalid");
    assert.equal(result.reason, "invalid-lease");
    assert.equal(result.evaluatedAt, iso(NOW));
  }
});

test("reloj atrasado 2 h con marca de agua: avisa y congela la ventana", () => {
  const rollbackNow = NOW - 2 * HOUR;
  const result = evaluateLease({
    lease: baseLease({
      paidThrough: iso(NOW - 2 * HOUR),
      offlineUntil: iso(NOW + 5 * DAY)
    }),
    nowMs: rollbackNow,
    watermarkMs: NOW - HOUR
  });

  assert.equal(result.clockWarning, true);
  // Con el reloj local crudo todavía sería «activo»; la marca lo mueve a gracia.
  assert.equal(result.mode, "grace");
  assert.equal(result.reason, "grace");
  assert.equal(result.readOnly, false);
  assert.equal(
    evaluateLease({
      lease: baseLease({ paidThrough: iso(NOW - 2 * HOUR), offlineUntil: iso(NOW + 5 * DAY) }),
      nowMs: rollbackNow
    }).mode,
    "active"
  );
});

test("reloj atrasado no reabre una ventana ya cerrada", () => {
  const result = evaluateLease({
    lease: baseLease({
      paidThrough: iso(NOW - DAY),
      offlineUntil: iso(NOW - HOUR)
    }),
    nowMs: NOW - 2 * HOUR,
    watermarkMs: NOW
  });

  assert.equal(result.clockWarning, true);
  assert.equal(result.mode, "expired");
  assert.equal(result.readOnly, true);
  assert.equal(result.expiresAt, iso(NOW + 300 * DAY));
});

test("reloj válido sin marca de agua: sin aviso", () => {
  const result = evaluateLease({ lease: baseLease(), nowMs: NOW, watermarkMs: null });

  assert.equal(result.clockWarning, false);
  assert.equal(result.mode, "active");
});

test("marca de agua: avanza con la hora del servidor y nunca retrocede", () => {
  assert.equal(
    nextWatermark({ previousMs: 1_000, nowMs: 2_000, serverTimeMs: 5_000 }),
    5_000
  );
  assert.equal(nextWatermark({ previousMs: 9_000, nowMs: 2_000 }), 9_000);
  assert.equal(nextWatermark({ previousMs: null, nowMs: 2_000, serverTimeMs: null }), 2_000);
});

test("detección de retroceso: tolerancia y hora efectiva", () => {
  assert.equal(detectClockRollback({ previousMs: NOW, nowMs: NOW - 2 * HOUR }), true);
  assert.equal(
    detectClockRollback({ previousMs: NOW, nowMs: NOW - CLOCK_ROLLBACK_TOLERANCE_MS / 2 }),
    false
  );
  assert.equal(
    detectClockRollback({ previousMs: NOW, nowMs: NOW - 2 * HOUR, toleranceMs: 3 * HOUR }),
    false
  );
  assert.equal(detectClockRollback({ previousMs: null, nowMs: NOW }), false);

  assert.equal(effectiveNowMs({ nowMs: NOW, watermarkMs: NOW + HOUR }), NOW + HOUR);
  assert.equal(effectiveNowMs({ nowMs: NOW, watermarkMs: null }), NOW);
});
