import { canonicalJson } from "../license/canonicalJson";
import { fromBase64Url, toBase64Url } from "../license/contract";
import {
  compareVersions,
  parseUpdateManifest,
  rolloutBucket,
  UPDATE_MANIFEST_VERSION,
  UpdateManifestError
} from "./manifest";
import type { UpdateChannel, UpdateManifestV1 } from "./manifest";

/**
 * Firma y verificación del manifiesto de actualizaciones (ES256 / ECDSA
 * P-256). La firma cubre el JSON canónico del manifiesto sin `signature`;
 * `keyId` sí se firma para que un futuro cambio de clave sea explícito.
 *
 * Solo se acepta ES256: cualquier otra curva o algoritmo se rechaza antes de
 * tocar WebCrypto, con un código de error estable.
 */

/** Único algoritmo aceptado para firmar y verificar el manifiesto. */
export const UPDATE_SIGNATURE_ALG = "ES256";
/** Única curva aceptada (coordenadas de 32 bytes). */
export const UPDATE_KEY_CURVE = "P-256";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Coordenada EC P-256 en base64url sin relleno: 32 bytes = 43 caracteres. */
const EC_COORDINATE_RE = /^[A-Za-z0-9_-]{43}$/;
/** Firma IEEE P1363 r||s: exactamente 64 bytes = 86 caracteres sin relleno. */
const ES256_SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

function isP256Coordinate(value: unknown): boolean {
  if (typeof value !== "string" || !EC_COORDINATE_RE.test(value)) return false;
  try {
    return fromBase64Url(value).length === 32;
  } catch {
    return false;
  }
}

export type UpdateKeyFailure = "invalid-key" | "unsupported-algorithm";

export type UpdateKeyCheck =
  | { ok: true }
  | { ok: false; reason: UpdateKeyFailure };

/**
 * Valida la JWK pública antes de importarla: kty EC, crv P-256, coordenadas de
 * 32 bytes, sin material privado y sin `alg`/`key_ops` que contradigan ES256.
 * Nunca lanza: devuelve un motivo estable.
 */
export function checkUpdatePublicJwk(
  jwk: unknown,
  algorithm: unknown = UPDATE_SIGNATURE_ALG
): UpdateKeyCheck {
  if (algorithm !== UPDATE_SIGNATURE_ALG) {
    return { ok: false, reason: "unsupported-algorithm" };
  }
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) {
    return { ok: false, reason: "invalid-key" };
  }
  const record = jwk as Record<string, unknown>;
  if (record.kty !== "EC" || record.crv !== UPDATE_KEY_CURVE) {
    return { ok: false, reason: "invalid-key" };
  }
  if (record.alg !== undefined && record.alg !== UPDATE_SIGNATURE_ALG) {
    return { ok: false, reason: "unsupported-algorithm" };
  }
  if (record.use !== undefined && record.use !== "sig") {
    return { ok: false, reason: "invalid-key" };
  }
  // Una JWK pública jamás debe traer la componente privada.
  if (record.d !== undefined) return { ok: false, reason: "invalid-key" };
  if (record.key_ops !== undefined) {
    const usages = record.key_ops;
    if (
      !Array.isArray(usages) ||
      usages.some((usage) => typeof usage !== "string") ||
      !usages.includes("verify") ||
      usages.includes("sign")
    ) {
      return { ok: false, reason: "invalid-key" };
    }
  }
  if (!isP256Coordinate(record.x) || !isP256Coordinate(record.y)) {
    return { ok: false, reason: "invalid-key" };
  }
  return { ok: true };
}

/** Texto firmado: manifiesto canónico con keyId incluido y signature excluida. */
export function manifestSigningInput(manifest: UpdateManifestV1): string {
  const { signature: _ignored, ...signable } = manifest;
  return canonicalJson(signable);
}

function assertSigningKey(privateKey: CryptoKey): void {
  const key = privateKey as CryptoKey | null | undefined;
  const algorithm = (key && key.algorithm) as { name?: string; namedCurve?: string } | undefined;
  const usages = key && Array.isArray(key.usages) ? key.usages : [];
  if (
    !key ||
    typeof key !== "object" ||
    key.type !== "private" ||
    !algorithm ||
    algorithm.name !== "ECDSA" ||
    algorithm.namedCurve !== UPDATE_KEY_CURVE ||
    !usages.includes("sign")
  ) {
    throw new UpdateManifestError(
      "La clave de firma debe ser una CryptoKey privada ECDSA P-256 con uso sign (ES256).",
      "signing-key-invalid"
    );
  }
}

/**
 * Devuelve una copia firmada (no muta la original). Si se entrega keyId, queda
 * fijado antes de firmar. La firma va en base64url con formato IEEE P1363.
 * El manifiesto se valida contra el contrato v1 antes de firmarlo.
 */
export async function signUpdateManifest(
  manifest: UpdateManifestV1,
  privateKey: CryptoKey,
  keyId?: string
): Promise<UpdateManifestV1> {
  assertSigningKey(privateKey);
  const { signature: _ignored, ...unsigned } = parseUpdateManifest(manifest);
  const signable: UpdateManifestV1 = { ...unsigned, v: UPDATE_MANIFEST_VERSION };
  if (keyId !== undefined) {
    if (typeof keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(keyId)) {
      throw new UpdateManifestError(
        "keyId debe ser alfanumérico (máx. 64) sin espacios.",
        "key-id-invalid"
      );
    }
    signable.keyId = keyId;
  }
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    utf8(manifestSigningInput(signable))
  );
  return { ...signable, signature: toBase64Url(signature) };
}

export type UpdateVerificationFailure =
  | "missing-signature"
  | "invalid-signature"
  | "invalid-manifest"
  | "invalid-key"
  | "unsupported-algorithm";

export type UpdateVerification =
  | { ok: true }
  | { ok: false; reason: UpdateVerificationFailure };

/** Decodifica una firma ES256 estricta o devuelve null si no lo es. */
function decodeEs256Signature(value: string): Uint8Array | null {
  if (!ES256_SIGNATURE_RE.test(value)) return null;
  try {
    const bytes = fromBase64Url(value);
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

export interface VerifyUpdateManifestOptions {
  publicJwk: JsonWebKey;
  requireSignature?: boolean;
  /** Algoritmo exigido; por defecto y único permitido: ES256. */
  algorithm?: string;
}

/**
 * Verifica la firma contra la clave pública conocida. Nunca lanza: un
 * manifiesto corrupto es invalid-manifest, una clave mal formada es
 * invalid-key, un algoritmo distinto de ES256 es unsupported-algorithm y una
 * firma ilegible es invalid-signature. Sin firma solo se acepta si
 * requireSignature es false (ruta legacy).
 */
export async function verifyUpdateManifest(
  manifest: unknown,
  options: VerifyUpdateManifestOptions
): Promise<UpdateVerification> {
  let parsed: UpdateManifestV1;
  try {
    parsed = parseUpdateManifest(manifest);
  } catch {
    return { ok: false, reason: "invalid-manifest" };
  }

  if (!parsed.signature) {
    return options && options.requireSignature
      ? { ok: false, reason: "missing-signature" }
      : { ok: true };
  }

  const keyCheck = checkUpdatePublicJwk(options && options.publicJwk, options && options.algorithm);
  if ("reason" in keyCheck) {
    // `in` en lugar de estrechar por ok: el proyecto compila sin strictNullChecks.
    return { ok: false, reason: keyCheck.reason };
  }

  const signature = decodeEs256Signature(parsed.signature);
  if (!signature) return { ok: false, reason: "invalid-signature" };

  try {
    const jwk = options.publicJwk as JsonWebKey & { x: string; y: string };
    // JWK saneada: solo lo necesario para verificar, sin `alg`, `use` ni `key_ops`.
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: UPDATE_KEY_CURVE, x: jwk.x, y: jwk.y },
      { name: "ECDSA", namedCurve: UPDATE_KEY_CURVE },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      utf8(manifestSigningInput(parsed))
    );
    return valid ? { ok: true } : { ok: false, reason: "invalid-signature" };
  } catch {
    return { ok: false, reason: "invalid-signature" };
  }
}

export type UpdateEvaluationReason =
  | "up-to-date"
  | "newer"
  | "downgrade"
  | "channel"
  | "not-before"
  | "rollout"
  | "shell-too-old"
  | "invalid";

export interface UpdateEvaluation {
  allowed: boolean;
  reason: UpdateEvaluationReason;
}

export interface UpdateEvaluationRequest {
  manifest: unknown;
  currentVersion: string;
  shellVersion: string;
  deviceId: string;
  channel: UpdateChannel;
  /** Reloj de referencia en ms; por defecto Date.now(). */
  now?: number;
}

/**
 * Decide si el manifiesto aplica al equipo. Orden de bloqueo: manifiesto
 * inválido, canal, fecha de activación (notBefore), versión (retroceso o ya
 * al día), shell mínimo y rollout. Solo `newer` habilita la actualización;
 * `minWebVersion` lo aplica el cliente web por su cuenta.
 */
export function evaluateUpdate(request: UpdateEvaluationRequest): UpdateEvaluation {
  let manifest: UpdateManifestV1;
  try {
    manifest = parseUpdateManifest(request.manifest);
  } catch {
    return { allowed: false, reason: "invalid" };
  }

  if (manifest.channel !== request.channel) {
    return { allowed: false, reason: "channel" };
  }

  const deviceId = request.deviceId;
  if (typeof deviceId !== "string" || deviceId.trim() === "" || deviceId.length > 256) {
    // Sin identificador el rollout no sería determinista ni auditable.
    return { allowed: false, reason: "invalid" };
  }

  const now = typeof request.now === "number" && Number.isFinite(request.now) ? request.now : Date.now();
  if (manifest.notBefore !== undefined) {
    const notBeforeMs = Date.parse(manifest.notBefore);
    if (!Number.isFinite(notBeforeMs)) return { allowed: false, reason: "invalid" };
    if (notBeforeMs > now) return { allowed: false, reason: "not-before" };
  }

  let comparison: -1 | 0 | 1;
  try {
    comparison = compareVersions(manifest.version, request.currentVersion);
  } catch {
    return { allowed: false, reason: "invalid" };
  }
  if (comparison < 0) return { allowed: false, reason: "downgrade" };
  if (comparison === 0) return { allowed: false, reason: "up-to-date" };

  if (manifest.minShellVersion !== undefined) {
    try {
      if (compareVersions(request.shellVersion, manifest.minShellVersion) < 0) {
        return { allowed: false, reason: "shell-too-old" };
      }
    } catch {
      return { allowed: false, reason: "invalid" };
    }
  }

  // Límites explícitos: rollout 0 no llega a nadie; 100 llega a todos.
  const rollout = Math.max(0, Math.min(100, manifest.rollout));
  if (rollout < 100 && rolloutBucket(deviceId, manifest.version) >= rollout) {
    return { allowed: false, reason: "rollout" };
  }

  return { allowed: true, reason: "newer" };
}
