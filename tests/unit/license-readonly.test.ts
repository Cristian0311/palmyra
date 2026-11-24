import test from "node:test";
import assert from "node:assert/strict";
import { leaseSigningInput, toBase64Url } from "../../src/services/license/contract";
import type { LeasePayloadV1, SignedLease } from "../../src/services/license/contract";
import { evaluateLease, OFFLINE_CAP_DAYS } from "../../src/services/license/evaluate";
import { createDeviceKey } from "../../src/services/license/deviceKey";
import {
  applyLicenseClockGuard,
  applyLicenseTimeGate,
  assertLicenseWritable,
  clearLicenseClockTamper,
  getLicenseWriteBlock,
  isLicenseClockTampered,
  isLicenseOperationAllowed,
  isLicenseReadOnly,
  LicenseClockTamperError,
  LicenseReadOnlyError,
  setLicenseReadOnly
} from "../../src/services/license/guard";
import { createLicenseRuntime, LICENSE_REVOKED_MESSAGE } from "../../src/services/license/runtime";
import type { LicenseFetch, LicenseRuntimeClient, LicenseSnapshot } from "../../src/services/license/runtime";
import { resolveLicenseNotice } from "../../src/components/system/LicenseBanner";
import {
  createMemoryLicenseStore,
  loadLease,
  saveDeviceKey,
  saveLease,
  saveWatermark
} from "../../src/services/license/storage";

/**
 * Aceptación F3 vista desde el cliente de licencia: Gratis indefinido, mensual
 * vencido con gracia y luego solo lectura, topes de ventana offline, reloj
 * atrasado, lease de otro equipo, revocación y comportamiento de la guarda
 * (bloquea escritura, nunca lectura ni exportación).
 */

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const iso = (ms: number): string => new Date(ms).toISOString();

function leaseFixture(overrides: Partial<SignedLease> = {}): SignedLease {
  return {
    v: 1,
    leaseId: "lease-f3-d",
    companyId: COMPANY_ID,
    deviceId: "equipo-f3-d",
    devicePubKeyFp: "huella-equipo-1",
    planCode: "starter",
    billingMonths: 1,
    limits: { warehouses: 1, employees: 2 },
    featureKeys: ["pos", "inventory"],
    storageMode: "cloud",
    paidThrough: iso(NOW + 10 * DAY),
    issuedAt: iso(NOW - DAY),
    notBefore: iso(NOW - DAY),
    expiresAt: iso(NOW + 65 * DAY),
    offlineUntil: iso(NOW + 20 * DAY),
    graceDays: 5,
    maxOfflineDays: OFFLINE_CAP_DAYS.monthly,
    serverTimeAnchor: iso(NOW - DAY),
    seq: 3,
    keyId: "key-test",
    signature: "firma-simulada",
    signatureAlg: "ES256",
    ...overrides
  };
}

function evaluate(overrides: Partial<SignedLease> = {}, nowMs = NOW, extra: Record<string, unknown> = {}) {
  return evaluateLease({ lease: leaseFixture(overrides), nowMs, ...extra });
}

function resetGuard(): void {
  clearLicenseClockTamper();
  setLicenseReadOnly(false);
}

/* ------------------------------ 1. Gratis ------------------------------ */

test("Gratis tras 400 días sin red: sigue operable y sin solo lectura", () => {
  resetGuard();
  const issued = NOW - 400 * DAY;
  const result = evaluate(
    {
      planCode: "free",
      billingMonths: 0,
      issuedAt: iso(issued),
      notBefore: iso(issued),
      paidThrough: "9999-12-31T23:59:59.000Z",
      offlineUntil: "9999-12-31T23:59:59.000Z",
      expiresAt: "9999-12-31T23:59:59.000Z",
      graceDays: 0,
      maxOfflineDays: 0
    },
    NOW
  );

  assert.equal(result.mode, "free");
  assert.equal(result.readOnly, false);
  assert.equal(result.reason, "free");
  assert.equal(result.clockWarning, false);
  assert.deepEqual(result.featureKeys, ["pos", "inventory"]);

  // Ni siquiera se le aplica el tope offline ni el vínculo de equipo.
  assert.equal(
    evaluateLease({
      lease: leaseFixture({
        planCode: "free",
        billingMonths: 0,
        paidThrough: iso(issued),
        offlineUntil: iso(issued),
        expiresAt: iso(issued),
        graceDays: 0,
        maxOfflineDays: 0
      }),
      nowMs: NOW,
      devicePublicKeyFp: "otra-huella"
    }).mode,
    "free"
  );
});

/* ------------------- 2. Mensual vencido: gracia y bloqueo -------------- */

test("mensual vencido: gracia operable y solo lectura al agotarse la ventana", () => {
  resetGuard();
  const paidThrough = NOW - 2 * DAY;
  const offlineUntil = NOW + 3 * DAY;

  const grace = evaluate({ paidThrough: iso(paidThrough), offlineUntil: iso(offlineUntil) });
  assert.equal(grace.mode, "grace");
  assert.equal(grace.reason, "grace");
  assert.equal(grace.readOnly, false);

  const afterGrace = evaluate(
    { paidThrough: iso(paidThrough), offlineUntil: iso(offlineUntil) },
    offlineUntil + 1
  );
  assert.equal(afterGrace.mode, "expired");
  assert.equal(afterGrace.reason, "expired");
  assert.equal(afterGrace.readOnly, true);
  // El historial y la fecha del lease siguen disponibles para exportar.
  assert.equal(afterGrace.paidThrough, iso(paidThrough));
  assert.equal(afterGrace.offlineUntil, iso(offlineUntil));
});

/* --------------------- 3. Topes de ventana offline --------------------- */

test("mensual: una ventana firmada de 60 días se recorta al tope de 35", () => {
  const issuedAt = NOW - DAY;
  const result = evaluate({
    billingMonths: 1,
    issuedAt: iso(issuedAt),
    paidThrough: iso(NOW + 55 * DAY),
    offlineUntil: iso(NOW + 60 * DAY),
    expiresAt: iso(NOW + 90 * DAY)
  });

  const cappedUntil = issuedAt + OFFLINE_CAP_DAYS.monthly * DAY;
  assert.equal(OFFLINE_CAP_DAYS.monthly, 35);
  assert.equal(result.offlineUntil, iso(cappedUntil));
  assert.equal(result.mode, "active");

  const beyondCap = evaluate(
    {
      billingMonths: 1,
      issuedAt: iso(issuedAt),
      paidThrough: iso(NOW + 55 * DAY),
      offlineUntil: iso(NOW + 60 * DAY),
      expiresAt: iso(NOW + 90 * DAY)
    },
    cappedUntil + 1
  );
  assert.equal(beyondCap.mode, "expired");
  assert.equal(beyondCap.readOnly, true);
});

test("6 meses: una ventana firmada de 365 días se recorta al tope de 200", () => {
  const issuedAt = NOW - DAY;
  const overrides: Partial<SignedLease> = {
    planCode: "pro",
    billingMonths: 6,
    issuedAt: iso(issuedAt),
    paidThrough: iso(NOW + 300 * DAY),
    offlineUntil: iso(NOW + 365 * DAY),
    expiresAt: iso(NOW + 900 * DAY),
    graceDays: 7,
    maxOfflineDays: OFFLINE_CAP_DAYS.extended
  };

  const cappedUntil = issuedAt + OFFLINE_CAP_DAYS.extended * DAY;
  assert.equal(OFFLINE_CAP_DAYS.extended, 200);

  const inside = evaluate(overrides, cappedUntil - HOUR);
  assert.equal(inside.offlineUntil, iso(cappedUntil));
  assert.equal(inside.mode, "active");

  const outside = evaluate(overrides, cappedUntil + 1);
  assert.equal(outside.mode, "expired");
  assert.equal(outside.readOnly, true);

  // Un lease con meses de facturación ilegibles no se evalúa como vigente.
  const broken = evaluateLease({
    lease: { ...leaseFixture(), billingMonths: Number.NaN } as SignedLease,
    nowMs: NOW
  });
  assert.equal(broken.mode, "invalid");
  assert.equal(broken.reason, "invalid-lease");
});

/* ------------------------ 4. Reloj atrasado ---------------------------- */

test("reloj atrasado 11 min: aviso en la evaluación y solo lectura en la guarda", async () => {
  resetGuard();
  const store = createMemoryLicenseStore();
  const watermarkMs = NOW;
  // Marca de agua persistida: sin ella no hay evidencia de retroceso.
  await saveWatermark(store, COMPANY_ID, watermarkMs);

  // 9 minutos: dentro de la tolerancia de 10 min, no hay manipulación.
  const inside = applyLicenseTimeGate({ nowMs: NOW - 9 * MINUTE, watermarkMs });
  assert.equal(inside.tampered, false);
  assert.equal(inside.readOnly, false);

  // 11 minutos: se congela el tiempo efectivo y la app pasa a solo lectura.
  const rollback = applyLicenseTimeGate({ nowMs: NOW - 11 * MINUTE, watermarkMs });
  assert.equal(rollback.tampered, true);
  assert.equal(rollback.readOnly, true);
  assert.ok(rollback.effectiveMs >= watermarkMs);
  assert.equal(isLicenseClockTampered(), true);
  assert.throws(() => assertLicenseWritable(), LicenseClockTamperError);
  assert.equal(getLicenseWriteBlock()?.code, "license_clock_tampered");

  // Lectura, exportación y respaldo no se bloquean nunca.
  assert.equal(isLicenseOperationAllowed("read"), true);
  assert.equal(isLicenseOperationAllowed("export"), true);
  assert.equal(isLicenseOperationAllowed("backup"), true);
  assert.equal(isLicenseOperationAllowed("restore"), true);
  assert.equal(isLicenseOperationAllowed("write"), false);

  const guarded = await applyLicenseClockGuard(store, {
    companyId: COMPANY_ID,
    nowMs: NOW - 11 * MINUTE,
    evaluationReadOnly: false,
    offlineUntilMs: NOW + DAY
  });
  assert.equal(guarded.tampered, true);
  assert.equal(guarded.readOnly, true);

  resetGuard();
  assert.equal(isLicenseReadOnly(), false);
});

test("reloj atrasado con ventana ya cerrada: la evaluación no reabre la gracia", () => {
  const result = evaluateLease({
    lease: leaseFixture({
      paidThrough: iso(NOW - 2 * DAY),
      offlineUntil: iso(NOW - DAY)
    }),
    nowMs: NOW - 2 * HOUR,
    watermarkMs: NOW
  });

  assert.equal(result.clockWarning, true);
  assert.equal(result.mode, "expired");
  assert.equal(result.readOnly, true);
});

/* ------------------ 5. Lease de otro dispositivo ----------------------- */

test("lease de otro equipo: huella ajena o deviceId ajeno son inválidos", () => {
  const foreignFp = evaluate({}, NOW, { devicePublicKeyFp: "huella-de-otro-equipo" });
  assert.equal(foreignFp.mode, "invalid");
  assert.equal(foreignFp.reason, "wrong-device");
  assert.equal(foreignFp.readOnly, true);
  assert.deepEqual(foreignFp.featureKeys, []);

  const foreignId = evaluate({}, NOW, { deviceId: "equipo-ajeno" });
  assert.equal(foreignId.mode, "invalid");
  assert.equal(foreignId.reason, "wrong-device");
  assert.equal(foreignId.readOnly, true);

  // El mismo equipo declarado sigue siendo válido.
  const own = evaluate({}, NOW, {
    devicePublicKeyFp: "huella-equipo-1",
    deviceId: "equipo-f3-d"
  });
  assert.equal(own.mode, "active");
  assert.equal(own.readOnly, false);
});

/* --------------------------- 6. Revocación ----------------------------- */

const serverKeys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify"
])) as CryptoKeyPair;
const serverPublicJwk = await crypto.subtle.exportKey("jwk", serverKeys.publicKey);
const deviceKey = await createDeviceKey();

async function signedLease(overrides: Partial<LeasePayloadV1> = {}): Promise<SignedLease> {
  const payload: LeasePayloadV1 = {
    v: 1,
    leaseId: "lease-revocable",
    companyId: COMPANY_ID,
    deviceId: "equipo-f3-d",
    devicePubKeyFp: deviceKey.fingerprint,
    planCode: "growth",
    billingMonths: 1,
    limits: { warehouses: 1 },
    featureKeys: ["pos"],
    storageMode: "cloud",
    paidThrough: iso(NOW + 10 * DAY),
    issuedAt: iso(NOW - HOUR),
    notBefore: iso(NOW - DAY),
    expiresAt: iso(NOW + 45 * DAY),
    offlineUntil: iso(NOW + 20 * DAY),
    graceDays: 5,
    maxOfflineDays: 35,
    serverTimeAnchor: iso(NOW - HOUR),
    seq: 1,
    keyId: "test-key",
    ...overrides
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    serverKeys.privateKey,
    new TextEncoder().encode(
      leaseSigningInput({ ...payload, signature: "", signatureAlg: "ES256" })
    )
  );
  return { ...payload, signature: toBase64Url(signature), signatureAlg: "ES256" };
}

function revocationFetch(revoked: boolean): LicenseFetch {
  return async (input) => {
    if (input.includes("/revoke-lease")) {
      return new Response(JSON.stringify({ revoked, reason: revoked ? "impago" : undefined }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ keyId: "test-key", jwk: serverPublicJwk }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
}

test("licencia revocada: solo lectura con mensaje y guarda que bloquea escritura", async () => {
  resetGuard();
  const lease = await signedLease();
  const store = createMemoryLicenseStore();
  await saveDeviceKey(store, deviceKey);
  await saveLease(store, lease, COMPANY_ID);

  const runtime = createLicenseRuntime({
    store,
    fetchImpl: revocationFetch(true),
    now: () => NOW,
    revokeBaseUrl: "https://proyecto.test/functions/v1",
    storageKeyPrefix: "f3d-revoked",
    getClient: () => null as LicenseRuntimeClient | null
  });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "revoked");
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.reason, "lease-revoked");
  assert.equal(snapshot.message, LICENSE_REVOKED_MESSAGE);
  assert.equal(isLicenseReadOnly(), true);
  assert.throws(
    () => assertLicenseWritable(),
    (error: unknown) =>
      error instanceof LicenseReadOnlyError && error.code === "license_read_only"
  );
  // Nada se borra: el lease sigue en disco y la lectura/exportación se permiten.
  assert.ok(await loadLease(store, COMPANY_ID));
  assert.equal(isLicenseOperationAllowed("read"), true);
  assert.equal(isLicenseOperationAllowed("export"), true);
  assert.equal(isLicenseOperationAllowed("backup"), true);

  resetGuard();
});

/* ------------- 7. Guarda: bloquea escritura, no lectura ----------------- */

test("guarda de solo lectura: códigos claros y exportación siempre permitida", () => {
  resetGuard();
  assert.equal(isLicenseOperationAllowed("write"), true);
  assert.equal(getLicenseWriteBlock(), null);

  setLicenseReadOnly(true);
  assert.equal(isLicenseReadOnly(), true);
  assert.equal(isLicenseOperationAllowed("write"), false);
  assert.equal(isLicenseOperationAllowed("read"), true);
  assert.equal(isLicenseOperationAllowed("export"), true);
  assert.equal(isLicenseOperationAllowed("backup"), true);
  assert.equal(isLicenseOperationAllowed("restore"), true);

  const block = getLicenseWriteBlock();
  assert.equal(block?.code, "license_read_only");
  assert.match(block?.message ?? "", /solo lectura/i);
  assert.match(block?.message ?? "", /datos no se borran/i);

  assert.throws(
    () => assertLicenseWritable(),
    (error: unknown) =>
      error instanceof LicenseReadOnlyError &&
      error.code === "license_read_only" &&
      /Renueva/.test(error.message)
  );

  resetGuard();
  assert.doesNotThrow(() => assertLicenseWritable());
});

/* ----------------- 8. Aviso de la app (LicenseBanner) ------------------ */

function snapshotFixture(overrides: Partial<LicenseSnapshot> = {}): LicenseSnapshot {
  return {
    mode: "active",
    readOnly: false,
    reason: "valid",
    clockWarning: false,
    lastCheckedAt: NOW,
    keyConfigured: true,
    leasePresent: true,
    planCode: "starter",
    paidThrough: iso(NOW + 20 * DAY),
    offlineUntil: iso(NOW + 25 * DAY),
    expiresAt: iso(NOW + 55 * DAY),
    ...overrides
  };
}

test("aviso de la app: aparece al acercarse el límite, en gracia y con reloj atrasado", () => {
  // Lejos del vencimiento: silencio.
  assert.equal(resolveLicenseNotice(snapshotFixture(), NOW), null);

  // Menos de 7 días de ventana offline: avisa con fecha límite y renovación.
  const soon = resolveLicenseNotice(
    snapshotFixture({ paidThrough: iso(NOW + 2 * DAY), offlineUntil: iso(NOW + 5 * DAY) }),
    NOW
  );
  assert.ok(soon);
  assert.equal(soon.showRenew, true);
  assert.match(soon.message, /5 días/);
  assert.ok(soon.deadline);

  // Ventana de gracia: explica que después pasa a solo lectura.
  const grace = resolveLicenseNotice(
    snapshotFixture({
      mode: "grace",
      reason: "grace",
      paidThrough: iso(NOW - 2 * DAY),
      offlineUntil: iso(NOW + 3 * DAY)
    }),
    NOW
  );
  assert.equal(grace?.title, "Ventana de gracia");
  assert.equal(grace?.showRenew, true);

  // Reloj atrasado: aviso específico, sin ofrecer renovación.
  const clock = resolveLicenseNotice(snapshotFixture({ clockWarning: true }), NOW);
  assert.equal(clock?.title, "Fecha del equipo atrasada");
  assert.equal(clock?.showRenew, false);

  // Gratis (horizonte lejano) y estados sin licencia: no generan aviso propio.
  assert.equal(
    resolveLicenseNotice(
      snapshotFixture({
        mode: "free",
        reason: "free",
        planCode: "free",
        paidThrough: "9999-12-31T23:59:59.000Z",
        offlineUntil: "9999-12-31T23:59:59.000Z",
        expiresAt: "9999-12-31T23:59:59.000Z"
      }),
      NOW
    ),
    null
  );
  assert.equal(resolveLicenseNotice(snapshotFixture({ mode: "loading" }), NOW), null);

  // El aviso de solo lectura no se duplica: Layout ya muestra la tarjeta.
  assert.equal(
    resolveLicenseNotice(snapshotFixture({ mode: "expired", reason: "expired", readOnly: true }), NOW),
    null
  );
});
