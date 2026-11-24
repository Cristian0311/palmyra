import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { JsonWebKey, KeyObject } from "node:crypto";
import { leaseSigningInput, spkiFingerprint, toBase64Url } from "../../src/services/license/contract";
import type { SignedLease } from "../../src/services/license/contract";
import {
  importVerifyKey,
  verifyLeaseForDevice,
  verifyLeaseSignature
} from "../../src/services/license/verify";

/** Par EC P-256 equivalente a ES256; la firma va en formato IEEE P1363. */
const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const otherPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const deviceSpki = toArrayBuffer(
  keyPair.publicKey.export({ type: "spki", format: "der" }) as Buffer
);
const deviceFp = await spkiFingerprint(deviceSpki);
const verifyKey = await importVerifyKey(keyPair.publicKey.export({ format: "jwk" }) as JsonWebKey);
const otherVerifyKey = await importVerifyKey(
  otherPair.publicKey.export({ format: "jwk" }) as JsonWebKey
);

function baseLease(overrides: Partial<SignedLease> = {}): SignedLease {
  return {
    v: 1,
    leaseId: "lease-1",
    companyId: "11111111-1111-4111-8111-111111111111",
    deviceId: "device-1",
    devicePubKeyFp: deviceFp,
    planCode: "pro",
    billingMonths: 1,
    limits: { warehouses: 2 },
    featureKeys: ["pos", "reports"],
    storageMode: "cloud",
    paidThrough: "2026-12-22T00:00:00.000Z",
    issuedAt: "2026-11-22T00:00:00.000Z",
    notBefore: "2026-11-22T00:00:00.000Z",
    expiresAt: "2027-11-22T00:00:00.000Z",
    offlineUntil: "2026-12-02T00:00:00.000Z",
    graceDays: 7,
    maxOfflineDays: 10,
    serverTimeAnchor: "2026-11-22T00:00:00.000Z",
    seq: 1,
    keyId: "key-1",
    signature: "",
    signatureAlg: "ES256",
    ...overrides
  };
}

/** Firma el payload canónico; los overrides se aplican antes de firmar. */
function signedLease(privateKey: KeyObject, overrides: Partial<SignedLease> = {}): SignedLease {
  const lease = baseLease(overrides);
  lease.signature = toBase64Url(
    sign("sha256", Buffer.from(leaseSigningInput(lease), "utf8"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363"
    })
  );
  return lease;
}

test("firma válida: verifica y el dispositivo coincide", async () => {
  const lease = signedLease(keyPair.privateKey);

  assert.equal(await verifyLeaseSignature(lease, verifyKey), true);
  assert.deepEqual(await verifyLeaseForDevice(lease, { verifyKey }), { ok: true });
  assert.deepEqual(
    await verifyLeaseForDevice(lease, { verifyKey, devicePublicKeySpki: deviceSpki }),
    { ok: true }
  );
});

test("payload alterado tras firmar: la firma deja de valer", async () => {
  const lease = signedLease(keyPair.privateKey);
  lease.paidThrough = "2030-01-01T00:00:00.000Z";

  assert.equal(await verifyLeaseSignature(lease, verifyKey), false);
  assert.deepEqual(await verifyLeaseForDevice(lease, { verifyKey }), {
    ok: false,
    reason: "invalid-signature"
  });
});

test("clave pública distinta: la firma no valida", async () => {
  const lease = signedLease(keyPair.privateKey);

  assert.equal(await verifyLeaseSignature(lease, otherVerifyKey), false);
  assert.deepEqual(
    await verifyLeaseForDevice(lease, { verifyKey: otherVerifyKey }),
    { ok: false, reason: "invalid-signature" }
  );
});

test("huella de dispositivo correcta e incorrecta", async () => {
  const lease = signedLease(keyPair.privateKey, { devicePubKeyFp: deviceFp });

  assert.deepEqual(
    await verifyLeaseForDevice(lease, { verifyKey, devicePublicKeySpki: deviceSpki }),
    { ok: true }
  );

  const otroSpki = toArrayBuffer(
    otherPair.publicKey.export({ type: "spki", format: "der" }) as Buffer
  );
  assert.deepEqual(
    await verifyLeaseForDevice(lease, { verifyKey, devicePublicKeySpki: otroSpki }),
    { ok: false, reason: "wrong-device" }
  );
});

test("lease malformado: nunca lanza y devuelve invalid-lease", async () => {
  const valid = signedLease(keyPair.privateKey);
  const cases: unknown[] = [
    null,
    { ...valid, v: 2 },
    { ...valid, signature: "" },
    { ...valid, signatureAlg: "HS256" },
    { ...valid, notBefore: "no-es-fecha" },
    { ...valid, expiresAt: "" },
    { ...valid, featureKeys: "pos" },
    { ...valid, planCode: "gold" }
  ];

  for (const candidate of cases) {
    const result = await verifyLeaseForDevice(candidate as SignedLease, {
      verifyKey,
      devicePublicKeySpki: deviceSpki
    });
    assert.deepEqual(result, { ok: false, reason: "invalid-lease" });
  }
});

test("firma con base64url corrupto no lanza y falla la verificación", async () => {
  const lease = baseLease({ signature: "no-es-un-base64url-valido!!" });

  assert.equal(await verifyLeaseSignature(lease, verifyKey), false);
  assert.deepEqual(await verifyLeaseForDevice(lease, { verifyKey }), {
    ok: false,
    reason: "invalid-signature"
  });
});
