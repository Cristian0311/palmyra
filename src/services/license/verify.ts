import {
  LICENSE_SIGNATURE_ALG,
  LICENSE_VERSION,
  fromBase64Url,
  leaseSigningInput,
  spkiFingerprint
} from "./contract";
import type { LicensePlanCode, SignedLease } from "./contract";

/**
 * Verificación criptográfica del lease de licencia (ES256 / ECDSA P-256).
 * Nada de lo que guarda localStorage se considera confiable: la firma se
 * valida contra la clave pública conocida y, opcionalmente, contra la clave
 * real del dispositivo.
 */

const PLAN_CODES: readonly LicensePlanCode[] = ["free", "starter", "growth", "pro"];
const DATE_FIELDS = [
  "paidThrough",
  "issuedAt",
  "notBefore",
  "expiresAt",
  "offlineUntil",
  "serverTimeAnchor"
] as const;

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Importa la clave pública del servidor (JWK EC P-256) solo para verificar. */
export async function importVerifyKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify"
  ]);
}

/** Verifica la firma del payload canónico. Datos corruptos devuelven false. */
export async function verifyLeaseSignature(lease: SignedLease, key: CryptoKey): Promise<boolean> {
  try {
    const signature = fromBase64Url(lease.signature);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      utf8(leaseSigningInput(lease))
    );
  } catch {
    return false;
  }
}

export type LeaseVerification =
  | { ok: true }
  | { ok: false; reason: "invalid-signature" | "wrong-device" | "invalid-lease" };

/**
 * Validación defensiva de forma: el lease llega de disco/red y puede estar
 * truncado o manipulado. Nunca lanza: los datos corruptos son invalid-lease.
 */
function isWellFormedLease(lease: SignedLease): boolean {
  if (!lease || typeof lease !== "object") return false;
  const record = lease as unknown as Record<string, unknown>;
  if (record.v !== LICENSE_VERSION) return false;
  if (record.signatureAlg !== LICENSE_SIGNATURE_ALG) return false;
  if (typeof record.signature !== "string" || record.signature.trim() === "") return false;
  if (typeof record.planCode !== "string" || !PLAN_CODES.includes(record.planCode as LicensePlanCode)) {
    return false;
  }
  if (typeof record.devicePubKeyFp !== "string" || record.devicePubKeyFp === "") return false;
  for (const field of ["leaseId", "companyId", "deviceId"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string) === "") return false;
  }
  for (const field of DATE_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  }
  if (!Array.isArray(record.featureKeys) || record.featureKeys.some((key) => typeof key !== "string")) {
    return false;
  }
  if (!record.limits || typeof record.limits !== "object" || Array.isArray(record.limits)) return false;
  return true;
}

/**
 * Verifica firma + vínculo con el equipo. Si se entrega el SPKI local se exige
 * que su huella coincida con devicePubKeyFp; así un lease copiado de otra PC
 * no sirve.
 */
export async function verifyLeaseForDevice(
  lease: SignedLease,
  args: { verifyKey: CryptoKey; devicePublicKeySpki?: ArrayBuffer | null }
): Promise<LeaseVerification> {
  if (!isWellFormedLease(lease)) return { ok: false, reason: "invalid-lease" };

  if (args.devicePublicKeySpki) {
    try {
      const fingerprint = await spkiFingerprint(args.devicePublicKeySpki);
      if (fingerprint !== lease.devicePubKeyFp) return { ok: false, reason: "wrong-device" };
    } catch {
      return { ok: false, reason: "invalid-lease" };
    }
  }

  const valid = await verifyLeaseSignature(lease, args.verifyKey);
  return valid ? { ok: true } : { ok: false, reason: "invalid-signature" };
}
