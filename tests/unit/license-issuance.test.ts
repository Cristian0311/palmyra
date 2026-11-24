import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_LIMITS,
  FREE_HORIZON_ISO,
  buildLeaseDates,
  buildLeaseFeatureKeys,
  buildLeaseLimits,
  inferBillingMonths
} from "../../supabase/functions/issue-lease/policy.ts";
import {
  LICENSE_VERSION,
  buildLeasePayload,
  canonicalLeasePayload,
  signLeasePayload,
  toBase64Url,
  uuidv4
} from "../../supabase/functions/issue-lease/lease.ts";
import type { BuildLeasePayloadInput } from "../../supabase/functions/issue-lease/lease.ts";
import {
  fromBase64Url,
  leaseSigningInput,
  spkiFingerprint,
  toBase64Url as clientToBase64Url
} from "../../src/services/license/contract";
import type { SignedLease } from "../../src/services/license/contract";
import { evaluateLease } from "../../src/services/license/evaluate";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify"
]);
const deviceSpki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
const deviceFp = await spkiFingerprint(deviceSpki);

const PAYLOAD_FIELDS = [
  "v",
  "leaseId",
  "companyId",
  "deviceId",
  "devicePubKeyFp",
  "planCode",
  "billingMonths",
  "limits",
  "featureKeys",
  "storageMode",
  "paidThrough",
  "issuedAt",
  "notBefore",
  "expiresAt",
  "offlineUntil",
  "graceDays",
  "maxOfflineDays",
  "serverTimeAnchor",
  "seq",
  "keyId"
];

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

function payload(overrides: Partial<BuildLeasePayloadInput> = {}) {
  return buildLeasePayload({
    leaseId: uuidv4(),
    companyId: COMPANY_ID,
    deviceId: "equipo-01",
    devicePubKeyFp: deviceFp,
    planCode: "growth",
    billingMonths: 6,
    issuedAt: iso(NOW),
    paidThrough: "2027-05-22T12:00:00.000Z",
    seq: 4,
    keyId: "palmyra-2026-11",
    ...overrides
  });
}

/* ------------------------------ fechas ------------------------------ */

test("Gratis: sin vencimiento, sin meses y sin ventana offline", () => {
  const dates = buildLeaseDates({ planCode: "free", billingMonths: 0, issuedAt: NOW });
  assert.equal(dates.issuedAt, iso(NOW));
  assert.equal(dates.notBefore, iso(NOW));
  assert.equal(dates.paidThrough, FREE_HORIZON_ISO);
  assert.equal(dates.offlineUntil, FREE_HORIZON_ISO);
  assert.equal(dates.expiresAt, FREE_HORIZON_ISO);
  assert.equal(dates.graceDays, 0);
  assert.equal(dates.maxOfflineDays, 0);

  assert.throws(
    () => buildLeaseDates({ planCode: "free", billingMonths: 1, issuedAt: NOW }),
    /Gratis/
  );
});

test("Mensual: paidThrough +5 días con tope de 35 días desde issuedAt", () => {
  const dates = buildLeaseDates({ planCode: "starter", billingMonths: 1, issuedAt: NOW });
  assert.equal(dates.paidThrough, "2026-12-22T12:00:00.000Z");
  assert.equal(dates.offlineUntil, iso(NOW + 35 * DAY)); // min(Dec 27, Nov 22+35d)
  assert.equal(dates.graceDays, 5);
  assert.equal(dates.maxOfflineDays, 35);
  assert.equal(dates.expiresAt, iso(NOW + 65 * DAY)); // offlineUntil + 30 días
});

test("Mensual: un paidThrough lejano queda recortado por el tope de 35 días", () => {
  const dates = buildLeaseDates({
    planCode: "growth",
    billingMonths: 1,
    issuedAt: NOW,
    paidThrough: iso(NOW + 40 * DAY)
  });
  assert.equal(dates.paidThrough, iso(NOW + 40 * DAY));
  assert.equal(dates.offlineUntil, iso(NOW + 35 * DAY));
});

test("6 meses: +7 días, tope de 200 días y gracia de 7", () => {
  const dates = buildLeaseDates({ planCode: "pro", billingMonths: 6, issuedAt: NOW });
  assert.equal(dates.paidThrough, "2027-05-22T12:00:00.000Z");
  assert.equal(dates.offlineUntil, "2027-05-29T12:00:00.000Z");
  assert.equal(dates.graceDays, 7);
  assert.equal(dates.maxOfflineDays, 200);
  assert.equal(dates.expiresAt, "2027-06-28T12:00:00.000Z");

  const capped = buildLeaseDates({
    planCode: "pro",
    billingMonths: 6,
    issuedAt: NOW,
    paidThrough: iso(NOW + 210 * DAY)
  });
  assert.equal(capped.offlineUntil, iso(NOW + 200 * DAY));
});

test("Valida plan, meses y paidThrough con mensajes en español", () => {
  assert.throws(
    () => buildLeaseDates({ planCode: "starter", billingMonths: 2, issuedAt: NOW }),
    /1, 3, 6, 12/
  );
  assert.throws(
    () =>
      buildLeaseDates({ planCode: "trial", billingMonths: 1, issuedAt: NOW }),
    /Plan no válido/
  );
  assert.throws(
    () =>
      buildLeaseDates({
        planCode: "starter",
        billingMonths: 1,
        issuedAt: NOW,
        paidThrough: iso(NOW)
      }),
    /posterior a la fecha de emisión/
  );
});

test("inferBillingMonths encaja el fin de periodo en 1/3/6/12", () => {
  assert.equal(inferBillingMonths(iso(NOW), iso(NOW + 30 * DAY)), 1);
  assert.equal(inferBillingMonths(iso(NOW), "2027-05-22T12:00:00.000Z"), 6);
  assert.equal(inferBillingMonths(iso(NOW), iso(NOW + 400 * DAY)), 12);
});

/* ------------------------------ límites ----------------------------- */

test("Límites y feature keys por plan según la tabla plans", () => {
  assert.deepEqual(buildLeaseLimits("free"), {
    warehouses: 1,
    employees: 1,
    products: 25,
    reports: "basic",
    support: "self_service"
  });
  assert.equal(buildLeaseLimits("starter").employees, 2);
  assert.equal(buildLeaseLimits("growth").warehouses, 3);
  assert.equal(buildLeaseLimits("pro").products, 300);
  assert.deepEqual(buildLeaseLimits("pro"), PLAN_LIMITS.pro);

  const free = buildLeaseFeatureKeys("free");
  assert.ok(free.includes("basic_reports"));
  assert.ok(free.includes("cloud_backup"));
  assert.ok(!free.includes("custom_roles"));

  const starter = buildLeaseFeatureKeys("starter");
  assert.ok(starter.includes("custom_roles"));

  const pro = buildLeaseFeatureKeys("pro");
  for (const key of ["excel_exports", "ai_dashboard", "advanced_analytics", "transfers"]) {
    assert.ok(pro.includes(key), `pro debe incluir ${key}`);
  }
});

/* ------------------------------ payload ----------------------------- */

test("buildLeasePayload devuelve exactamente los campos del contrato", () => {
  const lease = payload();
  assert.deepEqual(Object.keys(lease).sort(), [...PAYLOAD_FIELDS].sort());
  assert.equal(lease.v, LICENSE_VERSION);
  assert.equal(lease.companyId, COMPANY_ID);
  assert.equal(lease.planCode, "growth");
  assert.equal(lease.billingMonths, 6);
  assert.equal(lease.seq, 4);
  assert.equal(lease.keyId, "palmyra-2026-11");
  assert.equal(lease.storageMode, "cloud");
  assert.equal(lease.serverTimeAnchor, lease.issuedAt);
  assert.deepEqual(lease.limits, PLAN_LIMITS.growth);
  assert.deepEqual(lease.featureKeys, buildLeaseFeatureKeys("growth"));
});

test("Secuencia y datos obligatorios se validan", () => {
  assert.equal(payload({ seq: 17 }).seq, 17);
  assert.throws(() => payload({ seq: 0 }), /Secuencia inválida/);
  assert.throws(() => payload({ deviceId: "  " }), /deviceId es obligatorio/);
  assert.throws(() => payload({ keyId: "" }), /keyId es obligatorio/);
});

test("Paridad byte a byte con leaseSigningInput() del cliente", () => {
  const lease = payload();
  assert.equal(
    canonicalLeasePayload(lease),
    leaseSigningInput({ ...lease, signature: "firma", signatureAlg: "ES256" } as SignedLease)
  );

  const tricky = payload({
    deviceId: 'equipo-"ñ"\\01',
    keyId: "clave/2026+ñ",
    companyId: COMPANY_ID
  });
  assert.equal(
    canonicalLeasePayload(tricky),
    leaseSigningInput({ ...tricky, signature: "x", signatureAlg: "ES256" } as SignedLease)
  );
});

test("toBase64Url propio coincide con el del cliente", () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 64, 63]);
  assert.equal(toBase64Url(bytes), clientToBase64Url(bytes));
  assert.equal(toBase64Url(new Uint8Array([1])), clientToBase64Url(new Uint8Array([1])));
  assert.equal(toBase64Url(new Uint8Array([1, 2])), clientToBase64Url(new Uint8Array([1, 2])));
});

test("uuidv4 genera identificadores v4 distintos", () => {
  const first = uuidv4();
  const second = uuidv4();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

/* ------------------------------- firma ------------------------------ */

test("Firma ES256 real verificable con la clave pública derivada", async () => {
  const lease = payload();
  const signed = await signLeasePayload(lease, keyPair.privateKey);
  assert.equal(signed.signatureAlg, "ES256");
  assert.equal(signed.signature.length, 86); // 64 bytes en base64url

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.publicKey,
    fromBase64Url(signed.signature),
    new TextEncoder().encode(leaseSigningInput(signed))
  );
  assert.equal(valid, true);

  const tampered = { ...signed, seq: signed.seq + 1 };
  const tamperedValid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.publicKey,
    fromBase64Url(signed.signature),
    new TextEncoder().encode(leaseSigningInput(tampered))
  );
  assert.equal(tamperedValid, false);
});

test("evaluateLease acepta el lease emitido como active, grace y expired", async () => {
  const signed = await signLeasePayload(payload(), keyPair.privateKey);

  const active = evaluateLease({
    lease: signed,
    nowMs: NOW + 60 * 60 * 1000,
    devicePublicKeyFp: deviceFp
  });
  assert.equal(active.mode, "active");
  assert.equal(active.readOnly, false);
  assert.equal(active.reason, "valid");
  assert.equal(active.limits.warehouses, 3);
  assert.ok(active.featureKeys.includes("transfers"));

  const grace = evaluateLease({
    lease: signed,
    nowMs: Date.parse(signed.offlineUntil),
    devicePublicKeyFp: deviceFp
  });
  assert.equal(grace.mode, "grace");
  assert.equal(grace.readOnly, false);

  const expired = evaluateLease({
    lease: signed,
    nowMs: Date.parse(signed.expiresAt) + DAY,
    devicePublicKeyFp: deviceFp
  });
  assert.equal(expired.mode, "expired");
  assert.equal(expired.readOnly, true);

  const wrongDevice = evaluateLease({
    lease: signed,
    nowMs: NOW + 60 * 60 * 1000,
    devicePublicKeyFp: "otra-huella"
  });
  assert.equal(wrongDevice.mode, "invalid");
  assert.equal(wrongDevice.reason, "wrong-device");
});

test("Gratis firmado sigue siendo free diez años después", async () => {
  const signed = await signLeasePayload(
    payload({ planCode: "free", billingMonths: 0, paidThrough: undefined, seq: 1 }),
    keyPair.privateKey
  );
  const result = evaluateLease({ lease: signed, nowMs: NOW + 3650 * DAY });
  assert.equal(result.mode, "free");
  assert.equal(result.readOnly, false);
  assert.ok(result.featureKeys.includes("basic_reports"));
});
