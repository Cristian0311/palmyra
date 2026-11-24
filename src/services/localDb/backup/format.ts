/**
 * Formato y criptografía del respaldo lógico de PALMYRA (versión 1).
 *
 * El archivo es un sobre JSON con la carga cifrada:
 *
 *   { v: 1, kdf: "PBKDF2-SHA256", iterations: >=310000, salt, iv, ciphertext }
 *
 * - La clave AES-256 se deriva de la frase del usuario con PBKDF2-SHA256.
 * - El cifrado es AES-256-GCM con etiqueta de 128 bits; la cabecera
 *   (v|kdf|iterations|salt) viaja como AAD, de modo que alterarla invalida la
 *   autenticación además de cambiar la clave derivada.
 * - Todo usa WebCrypto (`globalThis.crypto.subtle`), disponible en navegador,
 *   en la PWA, en Android y en Node 24, sin dependencias nativas.
 *
 * La carga en claro es JSON canónico (claves ordenadas) para que el hash
 * SHA-256 sea reproducible en cualquier motor.
 */

export const BACKUP_ENVELOPE_VERSION = 1;
export const BACKUP_KDF = "PBKDF2-SHA256";
export const BACKUP_CIPHER = "AES-256-GCM";
export const BACKUP_PAYLOAD_FORMAT = "palmyra-localdb-backup";

/** Mínimo exigido de iteraciones PBKDF2 (OWASP 2023 para SHA-256). */
export const BACKUP_MIN_ITERATIONS = 310_000;
/** Valor por defecto al crear un respaldo nuevo. */
export const BACKUP_DEFAULT_ITERATIONS = 310_000;
/** Techo defensivo: un archivo no puede pedir una derivación abusiva. */
export const BACKUP_MAX_ITERATIONS = 5_000_000;
export const BACKUP_MIN_PASSPHRASE_LENGTH = 8;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BITS = 128;

export type BackupErrorCode =
  | "invalid_passphrase"
  | "invalid_format"
  | "unsupported_version"
  | "schema_too_new"
  | "decrypt_failed"
  | "integrity_failed"
  | "crypto_unavailable"
  | "restore_failed";

export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

export interface BackupEnvelope {
  v: number;
  kdf: typeof BACKUP_KDF;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

/* ------------------------------------------------------------------ */
/* Utilidades binarias y JSON canónico                                 */
/* ------------------------------------------------------------------ */

function getCrypto(): Crypto {
  const candidate = (globalThis as { crypto?: Crypto }).crypto;
  if (!candidate || !candidate.subtle || typeof candidate.getRandomValues !== "function") {
    throw new BackupError("crypto_unavailable", "Este dispositivo no ofrece WebCrypto para cifrar el respaldo.");
  }
  return candidate;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 estándar sin depender de `btoa` ni de `Buffer`. */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    chunk +=
      B64_ALPHABET[a >> 2] +
      B64_ALPHABET[((a & 0x03) << 4) | (b >> 4)] +
      (index + 1 < bytes.length ? B64_ALPHABET[((b & 0x0f) << 2) | (c >> 6)] : "=") +
      (index + 2 < bytes.length ? B64_ALPHABET[c & 0x3f] : "=");
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  if (chunk) parts.push(chunk);
  return parts.join("");
}

/** Decodifica base64 estricto: cualquier carácter ajeno se rechaza. */
export function fromBase64(text: string): Uint8Array {
  if (typeof text !== "string") {
    throw new BackupError("invalid_format", "El contenido binario del respaldo no es texto base64.");
  }
  const clean = text.replace(/\s+/g, "");
  if (clean.length % 4 !== 0) {
    throw new BackupError("invalid_format", "El contenido binario del respaldo está truncado.");
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const usable = clean.length - padding;
  const bytes = new Uint8Array((clean.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < clean.length; index += 4) {
    let value = 0;
    for (let slot = 0; slot < 4; slot += 1) {
      const position = index + slot;
      const char = clean[position];
      let digit: number;
      if (position >= usable) {
        if (char !== "=") {
          throw new BackupError("invalid_format", "El contenido binario del respaldo está dañado.");
        }
        digit = 0;
      } else {
        digit = B64_ALPHABET.indexOf(char);
        if (digit < 0) {
          throw new BackupError("invalid_format", "El contenido binario del respaldo está dañado.");
        }
      }
      value = (value << 6) | digit;
    }
    if (offset < bytes.length) bytes[offset++] = (value >> 16) & 0xff;
    if (offset < bytes.length) bytes[offset++] = (value >> 8) & 0xff;
    if (offset < bytes.length) bytes[offset++] = value & 0xff;
  }
  return bytes;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const data = typeof value === "string" ? utf8(value) : value;
  const digest = new Uint8Array(
    await getCrypto().subtle.digest("SHA-256", data as unknown as BufferSource)
  );
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * JSON estable: claves ordenadas en todos los niveles y sin espacios, para que
 * el mismo contenido produzca siempre el mismo hash en cualquier motor.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
      return null;
    }
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    sorted[key] = canonicalize(item);
  }
  return sorted;
}

/* ------------------------------------------------------------------ */
/* Derivación de clave y cifrado                                       */
/* ------------------------------------------------------------------ */

export function normalizeBackupPassphrase(passphrase: unknown): string {
  if (typeof passphrase !== "string" || passphrase.length < BACKUP_MIN_PASSPHRASE_LENGTH) {
    throw new BackupError(
      "invalid_passphrase",
      `La frase del respaldo debe tener al menos ${BACKUP_MIN_PASSPHRASE_LENGTH} caracteres.`
    );
  }
  if (passphrase.length > 1024) {
    throw new BackupError("invalid_passphrase", "La frase del respaldo es demasiado larga.");
  }
  return passphrase;
}

function clampIterations(iterations: number | undefined): number {
  const requested = Number.isFinite(iterations) ? Math.trunc(iterations as number) : BACKUP_DEFAULT_ITERATIONS;
  return Math.min(BACKUP_MAX_ITERATIONS, Math.max(BACKUP_MIN_ITERATIONS, requested));
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const subtle = getCrypto().subtle;
  const material = await subtle.importKey("raw", utf8(passphrase) as unknown as BufferSource, "PBKDF2", false, [
    "deriveKey"
  ]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Datos autenticados de la cabecera: ata versión, KDF, iteraciones y sal. */
function headerAad(envelope: Pick<BackupEnvelope, "v" | "kdf" | "iterations" | "salt">): Uint8Array {
  return utf8(`${envelope.v}|${envelope.kdf}|${envelope.iterations}|${envelope.salt}`);
}

/** Cifra una carga JSON y devuelve el sobre listo para guardar como bytes. */
export async function encryptBackupPayload(
  payloadJson: string,
  passphrase: string,
  options: { iterations?: number } = {}
): Promise<BackupEnvelope> {
  const phrase = normalizeBackupPassphrase(passphrase);
  const iterations = clampIterations(options.iterations);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header = {
    v: BACKUP_ENVELOPE_VERSION,
    kdf: BACKUP_KDF,
    iterations,
    salt: toBase64(salt)
  } as const;
  const key = await deriveKey(phrase, salt, iterations);
  let ciphertext: Uint8Array;
  try {
    ciphertext = new Uint8Array(
      await getCrypto().subtle.encrypt(
        { name: "AES-GCM", iv: iv as unknown as BufferSource, additionalData: headerAad(header), tagLength: TAG_BITS },
        key,
        utf8(payloadJson) as unknown as BufferSource
      )
    );
  } catch {
    throw new BackupError("crypto_unavailable", "No se pudo cifrar el respaldo en este dispositivo.");
  }
  return {
    v: BACKUP_ENVELOPE_VERSION,
    kdf: BACKUP_KDF,
    iterations,
    salt: header.salt,
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext)
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Valida la forma del sobre sin intentar descifrarlo. */
export function parseBackupEnvelope(source: unknown): BackupEnvelope {
  let raw = source;
  if (source instanceof Uint8Array) raw = fromUtf8(source);
  else if (source instanceof ArrayBuffer) raw = fromUtf8(new Uint8Array(source));
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      throw new BackupError("invalid_format", "El archivo no es un respaldo de PALMYRA.");
    }
  }
  if (!isPlainRecord(raw)) {
    throw new BackupError("invalid_format", "El archivo no es un respaldo de PALMYRA.");
  }
  const candidate = raw as Partial<BackupEnvelope>;
  if (candidate.v !== BACKUP_ENVELOPE_VERSION) {
    throw new BackupError(
      "unsupported_version",
      `Versión de respaldo no soportada (${String(candidate.v)}). Esta app solo abre la versión ${BACKUP_ENVELOPE_VERSION}.`
    );
  }
  if (candidate.kdf !== BACKUP_KDF) {
    throw new BackupError("invalid_format", "El método de derivación del respaldo no es compatible.");
  }
  if (
    typeof candidate.iterations !== "number" ||
    !Number.isFinite(candidate.iterations) ||
    candidate.iterations < BACKUP_MIN_ITERATIONS ||
    candidate.iterations > BACKUP_MAX_ITERATIONS
  ) {
    throw new BackupError("invalid_format", "Las iteraciones del respaldo están fuera de rango.");
  }
  for (const field of ["salt", "iv", "ciphertext"] as const) {
    if (typeof candidate[field] !== "string" || candidate[field]!.length === 0) {
      throw new BackupError("invalid_format", `El respaldo no incluye ${field}.`);
    }
  }
  if (fromBase64(candidate.iv!).length !== IV_BYTES) {
    throw new BackupError("invalid_format", "El vector de inicialización del respaldo no es válido.");
  }
  if (fromBase64(candidate.salt!).length < SALT_BYTES) {
    throw new BackupError("invalid_format", "La sal del respaldo no es válida.");
  }
  return {
    v: BACKUP_ENVELOPE_VERSION,
    kdf: BACKUP_KDF,
    iterations: candidate.iterations,
    salt: candidate.salt!,
    iv: candidate.iv!,
    ciphertext: candidate.ciphertext!
  };
}

/**
 * Descifra y autentica el sobre. Una frase incorrecta o un ciphertext alterado
 * fallan aquí, antes de que nadie toque el almacén.
 */
export async function decryptBackupEnvelope(
  envelope: BackupEnvelope,
  passphrase: string
): Promise<string> {
  const phrase = normalizeBackupPassphrase(passphrase);
  const key = await deriveKey(phrase, fromBase64(envelope.salt), envelope.iterations);
  try {
    const plain = new Uint8Array(
      await getCrypto().subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64(envelope.iv) as unknown as BufferSource,
          additionalData: headerAad(envelope),
          tagLength: TAG_BITS
        },
        key,
        fromBase64(envelope.ciphertext) as unknown as BufferSource
      )
    );
    return fromUtf8(plain);
  } catch {
    throw new BackupError(
      "decrypt_failed",
      "No se pudo descifrar el respaldo: la frase no coincide o el archivo fue alterado."
    );
  }
}
