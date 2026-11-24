/**
 * Manifiesto de actualizaciones de PALMYRA (contrato v1).
 *
 * Un único JSON firmado describe qué versiones existen para cada plataforma
 * (Windows, Android y web), su hash y el porcentaje de dispositivos que debe
 * recibirlas. El cliente solo confía en un manifiesto que verifica contra la
 * clave pública conocida (ver ./verify.ts); este módulo se limita a validar la
 * forma y a decidir si el manifiesto aplica al equipo actual.
 *
 * Toda desviación del contrato se señala con `UpdateManifestError` y un
 * `code` estable (ver UPDATE_MANIFEST_ERROR_CODES) para que el proceso
 * principal, la UI y las pruebas no dependan del texto en español.
 */

export const UPDATE_MANIFEST_VERSION = 1;

export type UpdateChannel = "stable" | "beta";
export type UpdatePlatform = "windows" | "android" | "web";

export interface UpdateArtifact {
  platform: UpdatePlatform;
  name: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface UpdateManifestV1 {
  v: typeof UPDATE_MANIFEST_VERSION;
  version: string;
  channel: UpdateChannel;
  releasedAt: string;
  /** Momento (ISO 8601) a partir del cual el manifiesto puede aplicarse. */
  notBefore?: string;
  minShellVersion?: string;
  minWebVersion?: string;
  notes?: string;
  /** Porcentaje de dispositivos que recibe esta versión (0-100, entero). */
  rollout: number;
  artifacts: UpdateArtifact[];
  keyId?: string;
  signature?: string;
}

/** Códigos estables de validación del manifiesto (no cambian de texto). */
export const UPDATE_MANIFEST_ERROR_CODES = [
  "manifest-unreadable",
  "manifest-not-object",
  "manifest-version",
  "version-invalid",
  "version-not-monotonic",
  "version-downgrade",
  "channel-invalid",
  "released-at-invalid",
  "not-before-invalid",
  "not-before-future",
  "rollout-range",
  "artifacts-missing",
  "artifact-shape",
  "artifact-platform",
  "artifact-duplicate-platform",
  "artifact-name",
  "artifact-url",
  "artifact-url-insecure",
  "artifact-sha256",
  "artifact-bytes",
  "min-shell-invalid",
  "min-web-invalid",
  "notes-invalid",
  "key-id-invalid",
  "signature-invalid",
  "signing-key-invalid"
] as const;

export type UpdateManifestErrorCode = (typeof UPDATE_MANIFEST_ERROR_CODES)[number];

/** Error de validación; el mensaje siempre está en español y es mostrable. */
export class UpdateManifestError extends Error {
  /** Código estable para ramificar sin mirar el texto. */
  readonly code: UpdateManifestErrorCode;

  constructor(message: string, code: UpdateManifestErrorCode = "manifest-not-object") {
    super(message);
    this.name = "UpdateManifestError";
    this.code = code;
  }
}

/** True solo si el valor es un UpdateManifestError (útil con `unknown`). */
export function isUpdateManifestError(error: unknown): error is UpdateManifestError {
  return error instanceof UpdateManifestError;
}

/** Código de un error de manifiesto; null si el error es de otra naturaleza. */
export function updateManifestErrorCode(error: unknown): UpdateManifestErrorCode | null {
  return isUpdateManifestError(error) ? error.code : null;
}

const CHANNELS: readonly UpdateChannel[] = ["stable", "beta"];
const PLATFORMS: readonly UpdatePlatform[] = ["windows", "android", "web"];

/** Semver estricto: sin ceros a la izquierda y con beta opcional (-beta[.N]). */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta(?:\.(0|[1-9]\d*))?)?$/;
/** ISO 8601 con hora y zona explícita: nada de fechas ambiguas ni locales. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
/** Nombre de archivo: sin rutas, sin separadores y sin caracteres de control. */
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** Identificador de clave: legible y sin espacios. */
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_ARTIFACT_NAME_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const MAX_SIGNATURE_LENGTH = 512;
/** Las notas son texto libre; solo se acota para evitar payloads absurdos. */
const MAX_NOTES_LENGTH = 20_000;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
  beta: number;
}

function parseVersion(value: string): ParsedVersion {
  const match = SEMVER_RE.exec(value);
  if (!match) {
    throw new UpdateManifestError(
      `Versión semver inválida: "${value}". Usa x.y.z o x.y.z-beta.N (sin ceros a la izquierda).`,
      "version-invalid"
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  // El grupo 4 es el sufijo "-beta" completo y el 5 el número opcional:
  // "1.3.8-beta" es una beta sin número (beta 0), nunca la estable 1.3.8.
  const beta = match[5] ? Number(match[5]) : 0;
  if (![major, minor, patch, beta].every((part) => Number.isSafeInteger(part))) {
    throw new UpdateManifestError(`Versión semver fuera de rango: "${value}".`, "version-invalid");
  }
  return { major, minor, patch, prerelease: match[4] !== undefined, beta };
}

/**
 * Compara dos versiones x.y.z (con sufijo opcional -beta.N). Una beta es
 * siempre anterior a la versión estable equivalente; entre betas gana la de
 * número mayor.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.prerelease !== right.prerelease) return left.prerelease ? -1 : 1;
  if (left.beta !== right.beta) return left.beta > right.beta ? 1 : -1;
  return 0;
}

/** True solo si candidate es estrictamente más nueva que current. */
export function isNewerVersion(candidate: string, current: string): boolean {
  try {
    return compareVersions(candidate, current) === 1;
  } catch {
    return false;
  }
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const rotr = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

/**
 * SHA-256 síncrono en TS puro: rolloutBucket debe ser determinista y no puede
 * esperar a crypto.subtle. La salida se contrasta con node:crypto en las
 * pruebas para garantizar que no diverge.
 */
function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const s0 = rotr(previous15, 7) ^ rotr(previous15, 18) ^ (previous15 >>> 3);
      const s1 = rotr(previous2, 17) ^ rotr(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  return Array.from(state, (part) => part.toString(16).padStart(8, "0")).join("");
}

/**
 * Bucket estable de despliegue 0-99 para un equipo y versión: sha256 de
 * `${deviceId}|${version}`. El mismo equipo recibe siempre la misma decisión
 * para la misma versión, aunque cambie de red o reinstale.
 */
export function rolloutBucket(deviceId: string, version: string): number {
  const digest = sha256Hex(`${deviceId}|${version}`);
  return Number.parseInt(digest.slice(0, 8), 16) % 100;
}

function readRequiredString(
  record: Record<string, unknown>,
  field: string,
  message: string,
  code: UpdateManifestErrorCode
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UpdateManifestError(message, code);
  }
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  field: string,
  message: string,
  code: UpdateManifestErrorCode
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new UpdateManifestError(message, code);
  }
  return value;
}

/** Fecha ISO 8601 con hora y zona; Date.parse por sí solo acepta demasiado. */
function readIsoDate(
  record: Record<string, unknown>,
  field: string,
  message: string,
  code: UpdateManifestErrorCode
): string {
  const value = readRequiredString(record, field, message, code);
  if (!ISO_DATE_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new UpdateManifestError(message, code);
  }
  return value;
}

/** Una URL de descarga solo se acepta por HTTPS, sin credenciales embebidas. */
function readArtifactUrl(record: Record<string, unknown>, label: string): string {
  const value = record.url;
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_URL_LENGTH) {
    throw new UpdateManifestError(`${label}: la URL de descarga es obligatoria.`, "artifact-url");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UpdateManifestError(`${label}: la URL de descarga no es válida.`, "artifact-url");
  }
  if (parsed.protocol !== "https:") {
    throw new UpdateManifestError(
      `${label}: la URL de descarga debe comenzar por https://.`,
      "artifact-url-insecure"
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new UpdateManifestError(
      `${label}: la URL de descarga no puede incluir credenciales.`,
      "artifact-url-insecure"
    );
  }
  return value;
}

function parseArtifact(input: unknown, index: number): UpdateArtifact {
  const label = `Artefacto ${index + 1}`;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new UpdateManifestError(
      `${label}: debe ser un objeto con platform, name, url, sha256 y bytes.`,
      "artifact-shape"
    );
  }
  const record = input as Record<string, unknown>;
  const platform = record.platform;
  if (!PLATFORMS.includes(platform as UpdatePlatform)) {
    throw new UpdateManifestError(
      `${label}: plataforma inválida; usa windows, android o web.`,
      "artifact-platform"
    );
  }
  const name = readRequiredString(
    record,
    "name",
    `${label}: el nombre del archivo es obligatorio.`,
    "artifact-name"
  );
  if (
    name.length > MAX_ARTIFACT_NAME_LENGTH ||
    name !== name.trim() ||
    !ARTIFACT_NAME_RE.test(name)
  ) {
    throw new UpdateManifestError(
      `${label}: el nombre debe ser un archivo simple, sin rutas ni caracteres raros.`,
      "artifact-name"
    );
  }
  const url = readArtifactUrl(record, label);
  const sha256 = readRequiredString(
    record,
    "sha256",
    `${label}: sha256 es obligatorio.`,
    "artifact-sha256"
  );
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new UpdateManifestError(
      `${label}: sha256 debe ser hexadecimal de 64 caracteres.`,
      "artifact-sha256"
    );
  }
  const bytes = record.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new UpdateManifestError(
      `${label}: bytes debe ser un entero mayor que 0.`,
      "artifact-bytes"
    );
  }
  return {
    platform: platform as UpdatePlatform,
    name,
    url,
    sha256: sha256.toLowerCase(),
    bytes
  };
}

export interface ParseUpdateManifestOptions {
  /**
   * Reloj de referencia en ms. Si se indica, un `notBefore` posterior se
   * rechaza con "not-before-future"; sin reloj la fecha solo se valida.
   */
  now?: number;
  /**
   * Versión instalada. Si se indica, un manifiesto que declare una versión
   * anterior se rechaza con "version-downgrade" (no se permite retroceder).
   */
  currentVersion?: string;
}

function parseUpdateManifestUnsafe(
  input: unknown,
  options: ParseUpdateManifestOptions
): UpdateManifestV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new UpdateManifestError("El manifiesto debe ser un objeto JSON.", "manifest-not-object");
  }
  const record = input as Record<string, unknown>;

  if (record.v !== UPDATE_MANIFEST_VERSION) {
    throw new UpdateManifestError(
      `Versión de manifiesto no soportada: se esperaba ${UPDATE_MANIFEST_VERSION}.`,
      "manifest-version"
    );
  }

  const version = readRequiredString(
    record,
    "version",
    "La versión del manifiesto es obligatoria.",
    "version-invalid"
  );
  parseVersion(version);

  const channel = record.channel;
  if (!CHANNELS.includes(channel as UpdateChannel)) {
    throw new UpdateManifestError('Canal inválido: debe ser "stable" o "beta".', "channel-invalid");
  }

  const releasedAt = readIsoDate(
    record,
    "releasedAt",
    "releasedAt debe ser una fecha ISO válida.",
    "released-at-invalid"
  );
  const releasedAtMs = Date.parse(releasedAt);

  let notBefore: string | undefined;
  if (record.notBefore !== undefined) {
    notBefore = readIsoDate(
      record,
      "notBefore",
      "notBefore debe ser una fecha ISO válida.",
      "not-before-invalid"
    );
    const notBeforeMs = Date.parse(notBefore);
    if (notBeforeMs < releasedAtMs) {
      throw new UpdateManifestError(
        "notBefore no puede ser anterior a releasedAt.",
        "not-before-invalid"
      );
    }
    if (typeof options.now === "number" && Number.isFinite(options.now) && notBeforeMs > options.now) {
      throw new UpdateManifestError(
        "notBefore está en el futuro: esta versión todavía no debe aplicarse.",
        "not-before-future"
      );
    }
  }

  const rollout = record.rollout;
  if (
    typeof rollout !== "number" ||
    !Number.isInteger(rollout) ||
    rollout < 0 ||
    rollout > 100
  ) {
    throw new UpdateManifestError(
      "rollout debe ser un número entero entre 0 y 100.",
      "rollout-range"
    );
  }

  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
    throw new UpdateManifestError(
      "El manifiesto necesita al menos un artefacto.",
      "artifacts-missing"
    );
  }
  const artifacts = record.artifacts.map((item, index) => parseArtifact(item, index));
  const seenPlatforms = new Set<string>();
  for (const artifact of artifacts) {
    if (seenPlatforms.has(artifact.platform)) {
      throw new UpdateManifestError(
        `El manifiesto repite la plataforma ${artifact.platform}; debe haber un artefacto por plataforma.`,
        "artifact-duplicate-platform"
      );
    }
    seenPlatforms.add(artifact.platform);
  }

  const minShellVersion = readOptionalString(
    record,
    "minShellVersion",
    "minShellVersion debe ser una cadena semver.",
    "min-shell-invalid"
  );
  if (minShellVersion !== undefined) {
    try {
      parseVersion(minShellVersion);
    } catch {
      throw new UpdateManifestError(
        `minShellVersion debe ser una cadena semver válida: "${minShellVersion}".`,
        "min-shell-invalid"
      );
    }
    if (compareVersions(minShellVersion, version) > 0) {
      throw new UpdateManifestError(
        `minShellVersion (${minShellVersion}) no puede ser posterior a la versión publicada (${version}).`,
        "version-not-monotonic"
      );
    }
  }
  const minWebVersion = readOptionalString(
    record,
    "minWebVersion",
    "minWebVersion debe ser una cadena semver.",
    "min-web-invalid"
  );
  if (minWebVersion !== undefined) {
    try {
      parseVersion(minWebVersion);
    } catch {
      throw new UpdateManifestError(
        `minWebVersion debe ser una cadena semver válida: "${minWebVersion}".`,
        "min-web-invalid"
      );
    }
    if (compareVersions(minWebVersion, version) > 0) {
      throw new UpdateManifestError(
        `minWebVersion (${minWebVersion}) no puede ser posterior a la versión publicada (${version}).`,
        "version-not-monotonic"
      );
    }
  }

  const notes = readOptionalString(record, "notes", "notes debe ser texto.", "notes-invalid");
  if (notes !== undefined && notes.length > MAX_NOTES_LENGTH) {
    throw new UpdateManifestError(
      `notes no puede superar ${MAX_NOTES_LENGTH} caracteres.`,
      "notes-invalid"
    );
  }
  const keyId = readOptionalString(record, "keyId", "keyId debe ser texto.", "key-id-invalid");
  if (keyId !== undefined && !KEY_ID_RE.test(keyId)) {
    throw new UpdateManifestError(
      "keyId debe ser alfanumérico (máx. 64) sin espacios.",
      "key-id-invalid"
    );
  }
  const signature = readOptionalString(
    record,
    "signature",
    "signature debe ser texto.",
    "signature-invalid"
  );
  if (signature !== undefined && signature.length > MAX_SIGNATURE_LENGTH) {
    throw new UpdateManifestError(
      "signature tiene una longitud imposible para ES256.",
      "signature-invalid"
    );
  }

  // Opcional: contrato monotónico respecto a la versión ya instalada.
  if (options.currentVersion !== undefined) {
    parseVersion(options.currentVersion);
    if (compareVersions(version, options.currentVersion) < 0) {
      throw new UpdateManifestError(
        `El manifiesto declara ${version}, anterior a la versión instalada ${options.currentVersion}; no se permite retroceder.`,
        "version-downgrade"
      );
    }
  }

  const manifest: UpdateManifestV1 = {
    v: UPDATE_MANIFEST_VERSION,
    version,
    channel: channel as UpdateChannel,
    releasedAt,
    rollout,
    artifacts
  };
  if (notBefore !== undefined) manifest.notBefore = notBefore;
  if (minShellVersion !== undefined) manifest.minShellVersion = minShellVersion;
  if (minWebVersion !== undefined) manifest.minWebVersion = minWebVersion;
  if (notes !== undefined) manifest.notes = notes;
  if (keyId !== undefined) manifest.keyId = keyId;
  if (signature !== undefined) manifest.signature = signature;
  return manifest;
}

/**
 * Valida un manifiesto llegado de disco o red y devuelve una copia tipada con
 * solo los campos conocidos. Lanza UpdateManifestError (con `code` estable y
 * mensaje en español) ante cualquier desviación del contrato.
 */
export function parseUpdateManifest(
  input: unknown,
  options: ParseUpdateManifestOptions = {}
): UpdateManifestV1 {
  try {
    return parseUpdateManifestUnsafe(input, options ?? {});
  } catch (error) {
    if (isUpdateManifestError(error)) throw error;
    // Objetos hostiles (getters que lanzan, proxies) también son manifiestos inválidos.
    throw new UpdateManifestError(
      "El manifiesto no se pudo interpretar.",
      "manifest-unreadable"
    );
  }
}
