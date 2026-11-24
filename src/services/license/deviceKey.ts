import { spkiFingerprint } from "./contract";

/**
 * Identidad criptográfica del dispositivo.
 *
 * Se genera un par ECDSA P-256 por equipo. La pública se guarda como JWK
 * (para poder recomprobar la huella y enviarla al servidor) y la privada se
 * reimporta como CryptoKey NO extraíble, de modo que no pueda volver a salir
 * del contexto criptográfico ni siquiera con acceso al almacenamiento.
 *
 * Además, la JWK privada queda disponible una sola vez para el almacén del
 * sistema operativo (`safeStorage` en escritorio, Android Keystore en el APK):
 * así existe una copia cifrada por el llavero del SO que NO viaja al copiar la
 * carpeta del perfil a otro equipo. Sin ella, la identidad se puede reconstruir
 * únicamente en la máquina y el usuario que la creó.
 */

export interface DeviceKey {
  publicJwk: JsonWebKey;
  /** Clave privada NO extraíble, almacenada como CryptoKey. */
  privateKey: CryptoKey;
  /** sha256 base64url del SPKI de la clave pública. */
  fingerprint: string;
}

/** Material privado pendiente de sellar por el sistema operativo. */
export interface DevicePrivateSeal {
  alg: "ES256";
  privateJwk: JsonWebKey;
}

/**
 * Copia de la JWK privada asociada a su CryptoKey no extraíble.
 *
 * Es un `WeakMap`: cuando la CryptoKey deja de usarse, el material desaparece
 * con ella. Solo se consulta al escribir la copia cifrada del sistema; nunca
 * se registra, se serializa a texto plano ni se envía por red.
 */
const deviceSeals = new WeakMap<CryptoKey, DevicePrivateSeal>();

const ECDSA_P256: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };

/** Importa una JWK pública tolerando que falten/sobren metadatos (ext, key_ops). */
function sanitizePublicJwk(jwk: JsonWebKey): JsonWebKey {
  const copy: JsonWebKey = { ...jwk };
  delete (copy as { key_ops?: string[] }).key_ops;
  delete (copy as { ext?: boolean }).ext;
  // Si por error llegara una JWK privada, nunca se importa la parte secreta.
  delete (copy as { d?: string }).d;
  return copy;
}

function assertPublicJwk(jwk: JsonWebKey): void {
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("La clave pública del dispositivo no es una JWK ECDSA P-256 válida");
  }
}

/**
 * Copia mínima (kty/crv/x/y/d) de una JWK privada recién exportada. Se
 * reconstruye campo a campo para no arrastrar metadatos del exportador.
 */
function secretCopy(jwk: JsonWebKey): JsonWebKey | null {
  const secret = (jwk as { d?: unknown }).d;
  if (
    jwk?.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string" ||
    typeof secret !== "string" ||
    secret.length === 0
  ) {
    return null;
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: secret };
}

/**
 * Crea el par de claves del equipo y devuelve la pública exportable junto con
 * la privada no extraíble. La huella sale del SPKI de la pública.
 */
export async function createDeviceKey(): Promise<DeviceKey> {
  // Se genera extraíble solo para poder exportar su JWK una única vez.
  const pair = (await crypto.subtle.generateKey(
    ECDSA_P256,
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;

  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const seal = secretCopy(privateJwk);

  // Se descarta la referencia a la clave privada extraíble original.
  (pair as { privateKey?: CryptoKey }).privateKey = undefined;

  // Reimportación no extraíble: a partir de aquí la privada no puede exportarse.
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const fingerprint = await spkiFingerprint(spki);

  // Única vía por la que la JWK privada llega al almacén del sistema operativo.
  if (seal) deviceSeals.set(privateKey, { alg: "ES256", privateJwk: seal });

  // Best effort: los secretos de una JWK no se pueden borrar de memoria, pero
  // se elimina la referencia exportada antes de que el objeto salga de ámbito
  // (la copia sellada se construyó antes, campo a campo).
  delete (privateJwk as { d?: string }).d;

  return { publicJwk, privateKey, fingerprint };
}

/**
 * Material privado de una clave creada en esta sesión, listo para que el
 * secure store del SO lo cifre. Devuelve null para claves ajenas (migraciones
 * o pruebas): en ese caso el llamador decide si puede exportarlas.
 */
export function devicePrivateSeal(key: CryptoKey | null | undefined): DevicePrivateSeal | null {
  if (!key) return null;
  const seal = deviceSeals.get(key);
  if (!seal) return null;
  return { alg: seal.alg, privateJwk: { ...seal.privateJwk } };
}

/**
 * Recalcula la huella a partir de la pública guardada. Permite recomprobar
 * que la clave almacenada sigue siendo la misma tras recargar la aplicación.
 */
export async function fingerprintFromPublicJwk(jwk: JsonWebKey): Promise<string> {
  assertPublicJwk(jwk);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    sanitizePublicJwk(jwk),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"]
  );
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  return spkiFingerprint(spki);
}

/**
 * Reimporta una JWK privada como clave NO extraíble y comprueba que la pareja
 * x/y coincide con la pública almacenada: un sobre manipulado que sustituya la
 * privada por otra se rechaza aquí y no puede suplantar al equipo.
 */
export async function importStoredPrivateKey(
  privateJwk: JsonWebKey,
  publicJwk: JsonWebKey
): Promise<CryptoKey | null> {
  const secret = secretCopy(privateJwk);
  if (!secret) return null;
  if (secret.x !== publicJwk.x || secret.y !== publicJwk.y) return null;
  try {
    return await crypto.subtle.importKey(
      "jwk",
      secret,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
  } catch {
    return null;
  }
}
