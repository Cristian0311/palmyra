/**
 * PIN offline por equipo del hub LAN.
 *
 * Solo usa WebCrypto (`globalThis.crypto.subtle`), así que el mismo módulo se
 * importa desde el proceso principal y desde el renderer sin arrastrar
 * `node:crypto`. El PIN nunca se guarda ni se registra en claro: la fila de
 * `hub_devices` conserva únicamente este hash PBKDF2.
 *
 * El formato almacenado (`pbkdf2$sha256$<iteraciones>$<saltHex>$<hashHex>`)
 * es el mismo que el renderer puede recalcular para verificar el PIN offline.
 */

/** Iteraciones de PBKDF2-SHA256; subirlas obliga a versionar el formato. */
export const PIN_ITERATIONS = 210_000;
export const PIN_SALT_BYTES = 16;
export const PIN_HASH_BYTES = 32;
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

const PIN_HASH_ALGORITHM = "sha256";
const PIN_HASH_PREFIX = "pbkdf2";
const MAX_SANE_ITERATIONS = 1_000_000;
const PIN_PATTERN = /^[0-9]{4,8}$/;
const HEX_PATTERN = /^[0-9a-f]+$/;
const encoder = new TextEncoder();

/**
 * WebCrypto del entorno. Si falta (runtime sin crypto.subtle) se falla con un
 * mensaje claro en vez de degradar a un hash débil.
 */
function webCrypto(): Crypto {
  const candidate = (globalThis as { crypto?: Crypto }).crypto;
  if (!candidate || !candidate.subtle) {
    throw new Error("WebCrypto no disponible: se requiere crypto.subtle para el PIN de equipo");
  }
  return candidate;
}

/** 4 a 8 dígitos ASCII. Cualquier otra cosa (letras, signos, Unicode) no vale. */
export function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_PATTERN.test(pin);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    out += bytes[index].toString(16).padStart(2, "0");
  }
  return out;
}

/** Hex estricto (minúsculas o mayúsculas); null si el texto no es hex par. */
function fromHex(text: string): Uint8Array | null {
  if (text.length === 0 || text.length % 2 !== 0) return null;
  if (!HEX_PATTERN.test(text)) return null;
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

interface ParsedPinHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

/**
 * Descompone un hash almacenado. Devuelve null ante cualquier desviación del
 * formato: el llamador trata lo corrupto como PIN incorrecto, nunca lanza.
 */
function parsePinHash(stored: unknown): ParsedPinHash | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  if (parts[0] !== PIN_HASH_PREFIX || parts[1] !== PIN_HASH_ALGORITHM) return null;

  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_SANE_ITERATIONS) {
    return null;
  }

  const salt = fromHex(parts[3]);
  const hash = fromHex(parts[4]);
  if (!salt || salt.length !== PIN_SALT_BYTES) return null;
  if (!hash || hash.length !== PIN_HASH_BYTES) return null;
  return { iterations, salt, hash };
}

/** ¿El valor almacenado tiene la forma exacta de un PIN del hub? */
export function isPinHash(stored: unknown): boolean {
  return parsePinHash(stored) !== null;
}

async function derivePinBytes(
  pin: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const subtle = webCrypto().subtle;
  const key = await subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    PIN_HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

/** Comparación de tiempo constante sobre los bytes: recorre el hash entero. */
function bytesEqualConstantTime(left: Uint8Array, right: Uint8Array): boolean {
  // La longitud no es secreta (siempre 32 bytes) y evita comparar de más.
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

/**
 * Deriva el hash almacenable de un PIN nuevo. Lanza `TypeError` si el PIN no
 * cumple el formato; el mensaje nunca incluye el valor.
 */
export async function hashPin(pin: string): Promise<string> {
  if (!isValidPin(pin)) {
    throw new TypeError(`PIN inválido: se esperan de ${PIN_MIN_LENGTH} a ${PIN_MAX_LENGTH} dígitos`);
  }
  const salt = new Uint8Array(PIN_SALT_BYTES);
  webCrypto().getRandomValues(salt);
  const hash = await derivePinBytes(pin, salt, PIN_ITERATIONS);
  return `${PIN_HASH_PREFIX}$${PIN_HASH_ALGORITHM}$${PIN_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

/**
 * Verifica un PIN contra el hash guardado. Nunca lanza: PIN mal formado,
 * hash corrupto o almacén vacío responden `false` (lo mismo que un PIN erróneo).
 */
export async function verifyPin(
  pin: string,
  stored: string | null | undefined
): Promise<boolean> {
  if (!isValidPin(pin)) return false;
  const parsed = parsePinHash(stored);
  if (!parsed) return false;
  let derived: Uint8Array;
  try {
    derived = await derivePinBytes(pin, parsed.salt, parsed.iterations);
  } catch {
    return false;
  }
  return bytesEqualConstantTime(derived, parsed.hash);
}

/** Verificador ya atado a un PIN; útil para comprobar varios almacenados. */
export type DevicePinVerifier = (stored: string | null | undefined) => Promise<boolean>;

/**
 * Crea un verificador para un PIN concreto. Si el PIN no tiene el formato
 * válido el verificador siempre responde `false`, sin lanzar.
 */
export function createDevicePinVerifier(pin: string): DevicePinVerifier {
  if (!isValidPin(pin)) return async () => false;
  return (stored) => verifyPin(pin, stored);
}
