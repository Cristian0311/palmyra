/**
 * Firma y emparejamiento del hub LAN.
 *
 * El token de dispositivo nunca viaja en las peticiones ni se guarda en claro:
 * el hub solo conserva su sha256. Por eso la firma usa como clave HMAC ese
 * mismo hash (el cliente lo deriva de su token con hashDeviceToken); el token
 * en claro solo hizo falta una vez, en la respuesta del emparejamiento.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { HUB_CLOCK_SKEW_MS, HUB_NONCE_TTL_MS } from "./protocol";
import { HUB_AUTH_HEADERS, canonicalPath, type HubCanonicalInput } from "./shared";

export { HUB_AUTH_HEADERS, canonicalPath };
export type { HubCanonicalInput };

const PAIRING_CODE_DIGITS = 8;
const PAIRING_CODE_SPACE = 10 ** PAIRING_CODE_DIGITS;
const MAX_NONCE_LENGTH = 200;

export function createPairingCode(): string {
  // randomInt evita el sesgo de Math.random y el relleno garantiza 8 dígitos.
  return String(randomInt(0, PAIRING_CODE_SPACE)).padStart(PAIRING_CODE_DIGITS, "0");
}

/** Token de dispositivo opaco de 256 bits. Solo se entrega al emparejar. */
export function createDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createNonce(): string {
  return randomBytes(16).toString("hex");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashDeviceToken(token: string): string {
  return sha256Hex(token);
}

function timestampMs(timestamp: number | string): number {
  return typeof timestamp === "number" ? timestamp : Number(timestamp);
}

export function buildCanonicalRequest(input: HubCanonicalInput): string {
  const timestamp = timestampMs(input.timestamp);
  if (!Number.isFinite(timestamp)) throw new TypeError("timestamp inválido");
  return [
    input.method.toUpperCase(),
    canonicalPath(input.path),
    String(timestamp),
    input.nonce,
    sha256Hex(input.body)
  ].join("\n");
}

function hmacHex(key: string, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

export interface HubSignInput extends HubCanonicalInput {
  token: string;
}

export function signHubRequest(input: HubSignInput): string {
  return hmacHex(hashDeviceToken(input.token), buildCanonicalRequest(input));
}

/** Caché de nonces en memoria con TTL; el reloj se inyecta para poder probarla. */
export interface HubReplayGuard {
  /** Devuelve true si el nonce es nuevo y queda registrado. */
  accept(deviceId: string, nonce: string): boolean;
  size(): number;
}

export function createReplayGuard(
  options: { now?: () => number; ttlMs?: number } = {}
): HubReplayGuard {
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? HUB_NONCE_TTL_MS;
  const seen = new Map<string, number>();

  function prune(at: number): void {
    for (const [key, expiresAt] of seen) {
      if (expiresAt <= at) seen.delete(key);
    }
  }

  return {
    accept(deviceId, nonce) {
      const at = now();
      prune(at);
      const key = `${deviceId}:${nonce}`;
      if (seen.has(key)) return false;
      seen.set(key, at + ttl);
      return true;
    },
    size: () => seen.size
  };
}

export type HubVerifyReason = "clock_skew" | "invalid_signature" | "replayed_nonce";

export interface HubVerifyResult {
  ok: boolean;
  /** Solo presente cuando `ok` es false. */
  reason?: HubVerifyReason;
}

export interface HubVerifyInput {
  token?: string;
  /** Hash guardado por el hub; sustituye a `token` en el servidor. */
  tokenHash?: string;
  signature: string;
  deviceId: string;
  method: string;
  path: string;
  timestamp: number | string;
  nonce: string;
  body: string;
  now?: number;
  replay?: HubReplayGuard;
  skewMs?: number;
}

/**
 * Verifica reloj, firma y anti-replay en ese orden: un intento con firma
 * inválida no consume el nonce de una petición legítima.
 */
export function verifyHubRequest(input: HubVerifyInput): HubVerifyResult {
  const nowMs = input.now ?? Date.now();
  const timestamp = timestampMs(input.timestamp);
  const skew = input.skewMs ?? HUB_CLOCK_SKEW_MS;
  if (!Number.isFinite(timestamp) || Math.abs(nowMs - timestamp) > skew) {
    return { ok: false, reason: "clock_skew" };
  }

  const key = input.tokenHash ?? (input.token ? hashDeviceToken(input.token) : "");
  if (!key || typeof input.nonce !== "string" || !input.nonce || input.nonce.length > MAX_NONCE_LENGTH) {
    return { ok: false, reason: "invalid_signature" };
  }

  let expected: string;
  try {
    expected = hmacHex(key, buildCanonicalRequest(input));
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
  const actual = typeof input.signature === "string" ? input.signature.trim().toLowerCase() : "";
  if (!safeEqual(expected, actual)) {
    return { ok: false, reason: "invalid_signature" };
  }

  if (input.replay && !input.replay.accept(input.deviceId, input.nonce)) {
    return { ok: false, reason: "replayed_nonce" };
  }
  return { ok: true };
}

function safeEqual(expectedHex: string, actualHex: string): boolean {
  // timingSafeEqual exige buffers del mismo tamaño; la longitud no es secreta.
  const expected = Buffer.from(expectedHex, "utf8");
  const actual = Buffer.from(actualHex, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
