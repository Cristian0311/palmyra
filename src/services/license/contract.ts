import { canonicalJson } from "./canonicalJson";

/**
 * Contrato del lease de licencia firmado.
 *
 * El servidor emite el payload y lo firma con ES256 (ECDSA P-256 + SHA-256).
 * La firma usa el formato IEEE P1363 (r||s en 64 bytes), que es el que
 * producen WebCrypto y Node con dsaEncoding "ieee-p1363". La app solo confía
 * en un lease cuya firma verifica contra una clave pública conocida; nunca en
 * fechas guardadas en localStorage.
 */

export const LICENSE_VERSION = 1;
export const LICENSE_SIGNATURE_ALG = "ES256";
export const CLOCK_ROLLBACK_TOLERANCE_MS = 10 * 60 * 1000;

export type LicensePlanCode = "free" | "starter" | "growth" | "pro";
export type LicenseStorageMode = "cloud" | "local" | "hybrid";
export type SignatureAlg = typeof LICENSE_SIGNATURE_ALG;

export interface LeasePayloadV1 {
  v: typeof LICENSE_VERSION;
  leaseId: string;
  companyId: string;
  deviceId: string;
  /** sha256 base64url del SPKI de la clave pública del dispositivo. */
  devicePubKeyFp: string;
  planCode: LicensePlanCode;
  /** 0 para Gratis; 1 mensual; 6/12 según la compra. */
  billingMonths: number;
  limits: Record<string, unknown>;
  featureKeys: string[];
  storageMode: LicenseStorageMode;
  paidThrough: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  /** Tope real de operación sin internet para planes de pago. */
  offlineUntil: string;
  graceDays: number;
  maxOfflineDays: number;
  serverTimeAnchor: string;
  seq: number;
  keyId: string;
}

export interface SignedLease extends LeasePayloadV1 {
  signature: string;
  signatureAlg: SignatureAlg;
}

/** Campos firmados, en el orden canónico. No incluye la firma. */
export function leaseSigningInput(lease: SignedLease): string {
  return canonicalJson({
    v: lease.v,
    leaseId: lease.leaseId,
    companyId: lease.companyId,
    deviceId: lease.deviceId,
    devicePubKeyFp: lease.devicePubKeyFp,
    planCode: lease.planCode,
    billingMonths: lease.billingMonths,
    limits: lease.limits,
    featureKeys: lease.featureKeys,
    storageMode: lease.storageMode,
    paidThrough: lease.paidThrough,
    issuedAt: lease.issuedAt,
    notBefore: lease.notBefore,
    expiresAt: lease.expiresAt,
    offlineUntil: lease.offlineUntil,
    graceDays: lease.graceDays,
    maxOfflineDays: lease.maxOfflineDays,
    serverTimeAnchor: lease.serverTimeAnchor,
    seq: lease.seq,
    keyId: lease.keyId
  });
}

export type LicenseMode = "free" | "active" | "grace" | "expired" | "invalid";

export type LicenseReason =
  | "free"
  | "valid"
  | "grace"
  | "expired"
  | "not-yet-valid"
  | "clock-rollback"
  | "wrong-device"
  | "invalid-signature"
  | "invalid-lease"
  | "missing";

export interface LicenseEvaluation {
  mode: LicenseMode;
  /** Si es true la app pasa a solo lectura + exportar; nunca borra datos. */
  readOnly: boolean;
  reason: LicenseReason;
  featureKeys: string[];
  limits: Record<string, unknown>;
  paidThrough?: string;
  offlineUntil?: string;
  expiresAt?: string;
  evaluatedAt: string;
  /** El reloj retrocedió; se congeló la ventana hasta reconectar. */
  clockWarning: boolean;
}

const READ_ONLY_MODES: LicenseMode[] = ["expired", "invalid"];

export function isReadOnlyEvaluation(evaluation: LicenseEvaluation): boolean {
  return evaluation.readOnly || READ_ONLY_MODES.includes(evaluation.mode);
}

export function allowsFeature(evaluation: LicenseEvaluation, featureKey: string): boolean {
  if (isReadOnlyEvaluation(evaluation)) return false;
  return evaluation.featureKeys.includes(featureKey);
}

export function invalidEvaluation(
  reason: LicenseReason,
  evaluatedAt: string,
  clockWarning = false
): LicenseEvaluation {
  return {
    mode: "invalid",
    readOnly: true,
    reason,
    featureKeys: [],
    limits: {},
    evaluatedAt,
    clockWarning
  };
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 1) {
    binary += String.fromCharCode(view[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Vincula el lease a la clave pública real del equipo. */
export async function spkiFingerprint(spki: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", spki);
  return toBase64Url(digest);
}
