import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOCK_ROLLBACK_TOLERANCE_MS,
  leaseSigningInput,
  toBase64Url
} from "../../src/services/license/contract";
import type { LeasePayloadV1, SignedLease } from "../../src/services/license/contract";
import { importVerifyKey, verifyLeaseForDevice, verifyLeaseSignature } from "../../src/services/license/verify";
import { evaluateLease } from "../../src/services/license/evaluate";
import { assessClockIntegrity, detectClockRollback } from "../../src/services/license/clock";
import {
  applyLicenseTimeGate,
  assertLicenseWritable,
  clearLicenseClockTamper,
  isLicenseClockTampered,
  isLicenseOperationAllowed,
  isLicenseReadOnly,
  LicenseClockTamperError,
  LicenseReadOnlyError,
  setLicenseReadOnly
} from "../../src/services/license/guard";
import { createDeviceKey } from "../../src/services/license/deviceKey";
import { createMemoryLicenseStore, saveDeviceKey, saveLease } from "../../src/services/license/storage";
import {
  createLicenseRuntime,
  LICENSE_REVOKED_MESSAGE,
  type LicenseFetch
} from "../../src/services/license/runtime";
import { resetLeaseRevocationCache } from "../../src/services/license/revocation";

/**
 * Pruebas de aceptación de la licencia firmada (F3), de punta a punta:
 * política temporal (evaluate), reloj anti-manipulación (clock + guard),
 * firma y vínculo de equipo (verify/contract) y revocación (runtime).
 *
 * Escenarios del plan que se certifican aquí:
 *   - mensual vencido -> solo lectura, sin borrar datos;
 *   - Gratis sigue activa aunque hayan pasado 400 días;
 *   - reloj atrasado más de 10 min -> manipulación y solo lectura;
 *   - lease copiado a otro equipo -> inválido;
 *   - lease revocado -> read_only con mensaje del proveedor;
 *   - firma alterada -> inválida;
 *   - 6 meses (y 12) nunca operan más allá del tope de 200 días.
 */

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const REVOKE_BASE = "https://proyecto.test/functions/v1";
const iso = (ms: number): string => new Date(ms).toISOString();

const serverKeys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify"
])) as CryptoKeyPair;
const serverPublicJwk = await crypto.subtle.exportKey("jwk", serverKeys.publicKey);
const verifyKey = await importVerifyKey(serverPublicJwk);

const deviceKey = await createDeviceKey();

async function spkiOf(jwk: JsonWebKey): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify"
  ]);
  return crypto.subtle.exportKey("spki", key);
}

const deviceSpki = await spkiOf(deviceKey.publicJwk);

let leaseSeq = 0;

/** Lease emitido por el servidor de pruebas; los overrides se firman incluidos. */
async function makeLease(overrides: Partial<LeasePayloadV1> = {}): Promise<SignedLease> {
  leaseSeq += 1;
  const payload: LeasePayloadV1 = {
    v: 1,
    leaseId: `lease-acceptance-${leaseSeq}`,
    companyId: COMPANY_ID,
    deviceId: "equipo-aceptacion",
    devicePubKeyFp: deviceKey.fingerprint,
    planCode: "growth",
    billingMonths: 1,
    limits: { warehouses: 3, employees: 4 },
    featureKeys: ["pos", "cash", "inventory"],
    storageMode: "cloud",
    paidThrough: iso(NOW + 10 * DAY),
    issuedAt: iso(NOW - 2 * HOUR),
    notBefore: iso(NOW - DAY),
    expiresAt: iso(NOW + 300 * DAY),
    offlineUntil: iso(NOW + 20 * DAY),
    graceDays: 5,
    maxOfflineDays: 35,
    serverTimeAnchor: iso(NOW - 2 * HOUR),
    seq: leaseSeq,
    keyId: "test-key",
    ...overrides
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    serverKeys.privateKey,
    new TextEncoder().encode(leaseSigningInput({ ...payload, signature: "", signatureAlg: "ES256" }))
  );
  return { ...payload, signature: toBase64Url(signature), signatureAlg: "ES256" };
}

/**
 * Fechas del periodo extendido (3/6/12 meses) según la política publicada:
 * offlineUntil = min(paidThrough + 7 días, issuedAt + 200 días) y
 * expiresAt = offlineUntil + 30 días. Aquí se replican para comprobar que el
 * cliente no deja operar más allá del tope aunque el pago sea más largo.
 */
function extendedLeaseDates(months: number): Partial<LeasePayloadV1> {
  const paidMs = NOW + months * 30 * DAY;
  const offlineMs = Math.min(paidMs + 7 * DAY, NOW + 200 * DAY);
  return {
    billingMonths: months,
    paidThrough: iso(paidMs),
    issuedAt: iso(NOW),
    notBefore: iso(NOW),
    offlineUntil: iso(offlineMs),
    expiresAt: iso(offlineMs + 30 * DAY),
    graceDays: 7,
    maxOfflineDays: 200
  };
}

/** Deja la guarda global sin marcas entre pruebas (estado de módulo). */
function resetGuard(): void {
  clearLicenseClockTamper();
  setLicenseReadOnly(false);
}

/* ------------------------------------------------------------------ */
/* 1. Mensual vencido                                                  */
/* ------------------------------------------------------------------ */

test("aceptación: mensual vencido pasa a solo lectura sin borrar datos", async () => {
  resetGuard();
  const lease = await makeLease({
    paidThrough: iso(NOW - 10 * DAY),
    offlineUntil: iso(NOW - 2 * DAY),
    expiresAt: iso(NOW + 20 * DAY)
  });

  assert.deepEqual(await verifyLeaseForDevice(lease, { verifyKey, devicePublicKeySpki: deviceSpki }), {
    ok: true
  });

  const evaluation = evaluateLease({
    lease,
    nowMs: NOW,
    watermarkMs: NOW - DAY,
    devicePublicKeyFp: deviceKey.fingerprint,
    signatureValid: true
  });

  assert.equal(evaluation.mode, "expired");
  assert.equal(evaluation.readOnly, true);
  assert.equal(evaluation.reason, "expired");
  // Los datos siguen disponibles para exportar: la expiración no los vacía.
  assert.deepEqual(evaluation.featureKeys, ["pos", "cash", "inventory"]);
  assert.deepEqual(evaluation.limits, { warehouses: 3, employees: 4 });

  setLicenseReadOnly(evaluation.readOnly);
  assert.equal(isLicenseReadOnly(), true);
  assert.throws(
    () => assertLicenseWritable(),
    (error: unknown) =>
      error instanceof LicenseReadOnlyError &&
      error.code === "license_read_only" &&
      error.message.includes("Tus datos no se borran")
  );
  // Solo se frena la escritura de negocio: exportar/consultar/respaldar siguen.
  assert.equal(isLicenseOperationAllowed("write"), false);
  assert.equal(isLicenseOperationAllowed("read"), true);
  assert.equal(isLicenseOperationAllowed("export"), true);
  assert.equal(isLicenseOperationAllowed("backup"), true);
  assert.equal(isLicenseOperationAllowed("restore"), true);

  resetGuard();
});

/* ------------------------------------------------------------------ */
/* 2. Gratis tras 400 días                                             */
/* ------------------------------------------------------------------ */

test("aceptación: Gratis sigue activa 400 días después, incluso con fechas vencidas", async () => {
  resetGuard();
  const issuedAt = NOW - 400 * DAY;
  const lease = await makeLease({
    planCode: "free",
    billingMonths: 0,
    issuedAt: iso(issuedAt),
    notBefore: iso(issuedAt),
    paidThrough: iso(issuedAt),
    offlineUntil: iso(issuedAt),
    expiresAt: iso(issuedAt),
    graceDays: 0,
    maxOfflineDays: 0,
    serverTimeAnchor: iso(issuedAt)
  });

  assert.deepEqual(await verifyLeaseForDevice(lease, { verifyKey, devicePublicKeySpki: deviceSpki }), {
    ok: true
  });

  const evaluation = evaluateLease({
    lease,
    nowMs: NOW,
    watermarkMs: NOW - DAY,
    devicePublicKeyFp: deviceKey.fingerprint,
    signatureValid: true
  });

  assert.equal(evaluation.mode, "free");
  assert.equal(evaluation.readOnly, false);
  assert.equal(evaluation.reason, "free");
  assert.equal(evaluation.clockWarning, false);

  setLicenseReadOnly(evaluation.readOnly);
  assert.equal(isLicenseReadOnly(), false);
  assert.doesNotThrow(() => assertLicenseWritable());

  resetGuard();
});

/* ------------------------------------------------------------------ */
/* 3. Reloj atrasado                                                   */
/* ------------------------------------------------------------------ */

test("aceptación: reloj atrasado más de 10 min marca manipulación y solo lectura", async () => {
  resetGuard();
  const lease = await makeLease();
  const watermark = NOW;
  const anchorMs = Date.parse(lease.serverTimeAnchor);

  // Tolerancia exacta: 10 min de retroceso todavía no es manipulación.
  const atTolerance = NOW - CLOCK_ROLLBACK_TOLERANCE_MS;
  assert.equal(detectClockRollback({ previousMs: watermark, nowMs: atTolerance }), false);
  const boundary = assessClockIntegrity({
    previousMs: watermark,
    nowMs: atTolerance,
    serverAnchorMs: anchorMs
  });
  assert.equal(boundary.tampered, false);
  assert.equal(boundary.effectiveMs, watermark);

  // Más de 10 min ya supera la tolerancia del contrato.
  const rolled = NOW - 11 * MINUTE;
  assert.equal(detectClockRollback({ previousMs: watermark, nowMs: rolled }), true);

  const evaluation = evaluateLease({
    lease,
    nowMs: rolled,
    watermarkMs: watermark,
    devicePublicKeyFp: deviceKey.fingerprint,
    signatureValid: true
  });
  // La ventana se congela en la marca: sigue activo, pero con aviso de reloj.
  assert.equal(evaluation.clockWarning, true);
  assert.equal(evaluation.mode, "active");

  const gate = applyLicenseTimeGate({
    evaluationReadOnly: evaluation.readOnly,
    nowMs: rolled,
    watermarkMs: watermark,
    serverAnchorMs: anchorMs
  });

  assert.equal(gate.tampered, true);
  assert.equal(gate.source, "watermark");
  assert.equal(gate.rollbackMs, 11 * MINUTE);
  assert.equal(gate.effectiveMs, watermark);
  assert.equal(gate.frozen, true);
  assert.equal(gate.readOnly, true);
  assert.equal(isLicenseClockTampered(), true);
  assert.equal(isLicenseReadOnly(), true);
  assert.throws(
    () => assertLicenseWritable(),
    (error: unknown) =>
      error instanceof LicenseClockTamperError && error.code === "license_clock_tampered"
  );

  resetGuard();
});

/* ------------------------------------------------------------------ */
/* 4. Lease copiado a otro equipo                                      */
/* ------------------------------------------------------------------ */

test("aceptación: lease con huella/deviceId ajenos no vale en este equipo", async () => {
  resetGuard();
  const lease = await makeLease();
  const otherDevice = await createDeviceKey();
  const otherSpki = await spkiOf(otherDevice.publicJwk);

  // Misma firma del servidor, pero la clave del equipo no coincide.
  assert.deepEqual(
    await verifyLeaseForDevice(lease, { verifyKey, devicePublicKeySpki: otherSpki }),
    { ok: false, reason: "wrong-device" }
  );

  const evaluation = evaluateLease({
    lease,
    nowMs: NOW,
    devicePublicKeyFp: otherDevice.fingerprint,
    signatureValid: true
  });
  assert.equal(evaluation.mode, "invalid");
  assert.equal(evaluation.reason, "wrong-device");
  assert.equal(evaluation.readOnly, true);
  assert.deepEqual(evaluation.featureKeys, []);

  // Con la huella correcta pero un deviceId conocido distinto, también inválido.
  const byDeviceId = evaluateLease({
    lease,
    nowMs: NOW,
    devicePublicKeyFp: deviceKey.fingerprint,
    deviceId: "equipo-otro",
    signatureValid: true
  });
  assert.equal(byDeviceId.mode, "invalid");
  assert.equal(byDeviceId.reason, "wrong-device");
  assert.equal(byDeviceId.readOnly, true);

  // El deviceId también está firmado: cambiarlo invalida la firma.
  const reidentified: SignedLease = { ...lease, deviceId: "equipo-robado" };
  assert.equal(await verifyLeaseSignature(reidentified, verifyKey), false);
  assert.deepEqual(
    await verifyLeaseForDevice(reidentified, { verifyKey, devicePublicKeySpki: deviceSpki }),
    { ok: false, reason: "invalid-signature" }
  );

  resetGuard();
});

/* ------------------------------------------------------------------ */
/* 5. Lease revocado                                                   */
/* ------------------------------------------------------------------ */

test("aceptación: lease revocado por el proveedor deja la app en solo lectura", async () => {
  resetGuard();
  resetLeaseRevocationCache();
  const lease = await makeLease();

  const store = createMemoryLicenseStore();
  await saveDeviceKey(store, deviceKey);
  await saveLease(store, lease, COMPANY_ID);

  const fetchImpl: LicenseFetch = async (input) => {
    if (input.includes("/revoke-lease")) {
      return new Response(
        JSON.stringify({ revoked: true, revokedAt: iso(NOW - HOUR), reason: "impago" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ keyId: "test-key", jwk: serverPublicJwk }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const runtime = createLicenseRuntime({
    store,
    fetchImpl,
    now: () => NOW,
    revokeBaseUrl: REVOKE_BASE,
    storageKeyPrefix: "acceptance-revoked"
  });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "revoked");
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.reason, "lease-revoked");
  assert.equal(snapshot.message, LICENSE_REVOKED_MESSAGE);
  assert.equal(snapshot.clockWarning, false);
  assert.equal(isLicenseReadOnly(), true);
  assert.throws(() => assertLicenseWritable(), LicenseReadOnlyError);

  runtime.dispose();
  resetLeaseRevocationCache();
  resetGuard();
});

/* ------------------------------------------------------------------ */
/* 6. Firma alterada                                                   */
/* ------------------------------------------------------------------ */

test("aceptación: cualquier cambio posterior a la firma invalida el lease", async () => {
  resetGuard();
  const lease = await makeLease();

  // Extender el pago a mano sin volver a firmar no cuela.
  const extended: SignedLease = {
    ...lease,
    paidThrough: iso(NOW + 400 * DAY),
    offlineUntil: iso(NOW + 400 * DAY)
  };
  assert.equal(await verifyLeaseSignature(extended, verifyKey), false);
  assert.deepEqual(
    await verifyLeaseForDevice(extended, { verifyKey, devicePublicKeySpki: deviceSpki }),
    { ok: false, reason: "invalid-signature" }
  );

  // También una firma con un byte cambiado.
  const flipped: SignedLease = {
    ...lease,
    signature: (lease.signature[0] === "A" ? "B" : "A") + lease.signature.slice(1)
  };
  assert.equal(await verifyLeaseSignature(flipped, verifyKey), false);

  const evaluation = evaluateLease({
    lease: extended,
    nowMs: NOW,
    devicePublicKeyFp: deviceKey.fingerprint,
    signatureValid: false
  });
  assert.equal(evaluation.mode, "invalid");
  assert.equal(evaluation.reason, "invalid-signature");
  assert.equal(evaluation.readOnly, true);

  resetGuard();
});

/* ------------------------------------------------------------------ */
/* 7. Tope de 200 días en periodos extendidos                          */
/* ------------------------------------------------------------------ */

test("aceptación: 6 meses queda dentro del tope de 200 días y vence al agotar la ventana", async () => {
  resetGuard();
  const dates = extendedLeaseDates(6);
  const lease = await makeLease(dates);

  const offlineMs = Date.parse(lease.offlineUntil);
  const paidMs = Date.parse(lease.paidThrough);
  // paidThrough + 7 días es más corto que el tope para 6 meses.
  assert.equal(offlineMs, paidMs + 7 * DAY);
  assert.ok(offlineMs <= NOW + 200 * DAY);

  const withinWindow = evaluateLease({
    lease,
    nowMs: offlineMs - DAY,
    watermarkMs: offlineMs - DAY,
    devicePublicKeyFp: deviceKey.fingerprint,
    signatureValid: true
  });
  assert.equal(withinWindow.mode, "grace");
  assert.equal(withinWindow.readOnly, false);

  const afterWindow = evaluateLease({
    lease,
    nowMs: offlineMs + DAY,
    watermarkMs: offlineMs + DAY,
    devicePublicKeyFp: deviceKey.fingerprint,
    signatureValid: true
  });
  assert.equal(afterWindow.mode, "expired");
  assert.equal(afterWindow.readOnly, true);

  resetGuard();
});

test("aceptación: 12 meses corta en el tope de 200 días aunque el pago siga vigente", async () => {
  resetGuard();
  const dates = extendedLeaseDates(12);
  const lease = await makeLease(dates);

  const offlineMs = Date.parse(lease.offlineUntil);
  const paidMs = Date.parse(lease.paidThrough);
  const expiresMs = Date.parse(lease.expiresAt);

  // El pago dura más que el tope: offlineUntil se recorta a 200 días.
  assert.ok(paidMs > NOW + 200 * DAY);
  assert.equal(offlineMs, NOW + 200 * DAY);
  assert.equal(lease.maxOfflineDays, 200);
  assert.equal(lease.billingMonths, 12);
  // expiresAt = offlineUntil + 30 días, tope absoluto del contrato.
  assert.equal(expiresMs, offlineMs + 30 * DAY);

  // En el tope exacto todavía se opera: el pago está vigente y la ventana vale.
  const atCap = evaluateLease({
    lease,
    nowMs: offlineMs,
    watermarkMs: offlineMs,
    devicePublicKeyFp: deviceKey.fingerprint,
    signatureValid: true
  });
  assert.equal(atCap.readOnly, false);

  // Un día después del tope la app ya es solo lectura aunque paidThrough siga
  // en el futuro: la ventana offline firmada no se puede alargar.
  const pastCap = evaluateLease({
    lease,
    nowMs: offlineMs + DAY,
    watermarkMs: offlineMs + DAY,
    devicePublicKeyFp: deviceKey.fingerprint,
    signatureValid: true
  });
  assert.ok(offlineMs + DAY < paidMs);
  assert.equal(pastCap.mode, "expired");
  assert.equal(pastCap.readOnly, true);
  assert.equal(pastCap.reason, "expired");

  resetGuard();
});
