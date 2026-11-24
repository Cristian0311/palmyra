/**
 * Construcción y firma del lease de licencia en el servidor.
 *
 * El payload y la serialización canónica duplican a propósito el contrato del
 * cliente (src/services/license/contract.ts y canonicalJson.ts): el despliegue
 * de la Edge Function solo sube esta carpeta, así que no se puede importar desde
 * src/. La paridad byte a byte se cubre en tests/unit/license-issuance.test.ts.
 */

import {
  PLAN_STORAGE_MODE,
  buildLeaseDates,
  buildLeaseFeatureKeys,
  buildLeaseLimits,
  assertPlanCode,
  type PlanCode
} from "./policy.ts";

export const LICENSE_VERSION = 1 as const;
export const LICENSE_SIGNATURE_ALG = "ES256" as const;
export type SignatureAlg = typeof LICENSE_SIGNATURE_ALG;
export type LicenseStorageMode = "cloud" | "local" | "hybrid";

export interface LeasePayloadV1 {
  v: typeof LICENSE_VERSION;
  leaseId: string;
  companyId: string;
  deviceId: string;
  /** sha256 base64url del SPKI de la clave pública del dispositivo. */
  devicePubKeyFp: string;
  planCode: PlanCode;
  billingMonths: number;
  limits: Record<string, unknown>;
  featureKeys: string[];
  storageMode: LicenseStorageMode;
  paidThrough: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
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

/* ------------------------------------------------------------------ */
/* JSON canónico (idéntico a src/services/license/canonicalJson.ts)    */
/* ------------------------------------------------------------------ */

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value as number)) throw new TypeError("Número no finito en JSON canónico");
    return JSON.stringify(value);
  }
  if (type === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : serialize(item))).join(",")}]`;
  }
  if (type === "object") {
    if (value instanceof Date) throw new TypeError("Usa fechas ISO en cadenas, no objetos Date");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`Tipo no serializable en JSON canónico: ${type}`);
}

/**
 * Texto exacto que se firma. Mismo orden de campos que leaseSigningInput():
 * aunque el serializador ordena claves, se declaran en el orden del contrato
 * para que cualquier comparación estructural también coincida.
 */
export function canonicalLeasePayload(payload: LeasePayloadV1): string {
  return canonicalJson({
    v: payload.v,
    leaseId: payload.leaseId,
    companyId: payload.companyId,
    deviceId: payload.deviceId,
    devicePubKeyFp: payload.devicePubKeyFp,
    planCode: payload.planCode,
    billingMonths: payload.billingMonths,
    limits: payload.limits,
    featureKeys: payload.featureKeys,
    storageMode: payload.storageMode,
    paidThrough: payload.paidThrough,
    issuedAt: payload.issuedAt,
    notBefore: payload.notBefore,
    expiresAt: payload.expiresAt,
    offlineUntil: payload.offlineUntil,
    graceDays: payload.graceDays,
    maxOfflineDays: payload.maxOfflineDays,
    serverTimeAnchor: payload.serverTimeAnchor,
    seq: payload.seq,
    keyId: payload.keyId
  });
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url sin relleno, igual que toBase64Url() del cliente. */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let output = "";
  let index = 0;
  for (; index + 2 < view.length; index += 3) {
    const chunk = (view[index] << 16) | (view[index + 1] << 8) | view[index + 2];
    output += BASE64URL_ALPHABET[(chunk >> 18) & 63];
    output += BASE64URL_ALPHABET[(chunk >> 12) & 63];
    output += BASE64URL_ALPHABET[(chunk >> 6) & 63];
    output += BASE64URL_ALPHABET[chunk & 63];
  }
  const remaining = view.length - index;
  if (remaining === 1) {
    const chunk = view[index] << 16;
    output += BASE64URL_ALPHABET[(chunk >> 18) & 63];
    output += BASE64URL_ALPHABET[(chunk >> 12) & 63];
  } else if (remaining === 2) {
    const chunk = (view[index] << 16) | (view[index + 1] << 8);
    output += BASE64URL_ALPHABET[(chunk >> 18) & 63];
    output += BASE64URL_ALPHABET[(chunk >> 12) & 63];
    output += BASE64URL_ALPHABET[(chunk >> 6) & 63];
  }
  return output;
}

/** UUID v4 con crypto.randomUUID y respaldo manual para runtimes antiguos. */
export function uuidv4(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (!cryptoApi?.getRandomValues) {
    throw new Error("No hay generador criptográfico disponible para crear el leaseId.");
  }
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------------------------------------------ */
/* Payload                                                             */
/* ------------------------------------------------------------------ */

export interface BuildLeasePayloadInput {
  leaseId: string;
  companyId: string;
  deviceId: string;
  devicePubKeyFp: string;
  planCode: PlanCode | string;
  /** 0 para Gratis; 1, 3, 6 o 12 para planes de pago. */
  billingMonths: number;
  issuedAt: string | number | Date;
  /** Fin del periodo pagado; si falta se calcula con billingMonths. */
  paidThrough?: string | number | Date | null;
  seq: number;
  keyId: string;
}

function requireText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`${label} es obligatorio.`);
  return text;
}

/**
 * Arma exactamente LeasePayloadV1. Límites, feature keys y storageMode salen de
 * la política de planes; las fechas, de buildLeaseDates().
 */
export function buildLeasePayload(input: BuildLeasePayloadInput): LeasePayloadV1 {
  const planCode = assertPlanCode(input.planCode);
  const leaseId = requireText(input.leaseId, "leaseId");
  const companyId = requireText(input.companyId, "companyId");
  const deviceId = requireText(input.deviceId, "deviceId");
  const devicePubKeyFp = requireText(input.devicePubKeyFp, "devicePubKeyFp");
  const keyId = requireText(input.keyId, "keyId");
  if (!Number.isInteger(input.seq) || input.seq < 1) {
    throw new TypeError(`Secuencia inválida: ${String(input.seq)}.`);
  }

  const dates = buildLeaseDates({
    planCode,
    billingMonths: input.billingMonths,
    issuedAt: input.issuedAt,
    paidThrough: input.paidThrough
  });

  return {
    v: LICENSE_VERSION,
    leaseId,
    companyId,
    deviceId,
    devicePubKeyFp,
    planCode,
    billingMonths: input.billingMonths,
    limits: { ...buildLeaseLimits(planCode) },
    featureKeys: buildLeaseFeatureKeys(planCode),
    storageMode: PLAN_STORAGE_MODE[planCode],
    paidThrough: dates.paidThrough,
    issuedAt: dates.issuedAt,
    notBefore: dates.notBefore,
    expiresAt: dates.expiresAt,
    offlineUntil: dates.offlineUntil,
    graceDays: dates.graceDays,
    maxOfflineDays: dates.maxOfflineDays,
    serverTimeAnchor: dates.issuedAt,
    seq: input.seq,
    keyId
  };
}

/* ------------------------------------------------------------------ */
/* Firma                                                               */
/* ------------------------------------------------------------------ */

/**
 * Firma ES256 (ECDSA P-256 + SHA-256). WebCrypto produce la firma en formato
 * IEEE P1363 (r||s, 64 bytes), que es el que espera verifyLeaseSignature() del
 * cliente. La firma viaja en base64url sin relleno.
 */
export async function signLeasePayload(
  payload: LeasePayloadV1,
  privateKey: CryptoKey
): Promise<SignedLease> {
  const data = new TextEncoder().encode(canonicalLeasePayload(payload));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    data
  );
  return {
    ...payload,
    signature: toBase64Url(signature),
    signatureAlg: LICENSE_SIGNATURE_ALG
  };
}
