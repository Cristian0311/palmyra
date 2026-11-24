import type { LocalDbDriver } from "../contract";
import {
  BackupError,
  decryptBackupEnvelope,
  encryptBackupPayload,
  parseBackupEnvelope,
  sha256Hex,
  toBase64,
  utf8
} from "./format";

/**
 * Imagen binaria del almacén SQLite de escritorio (sql.js/MEMFS).
 *
 * En Electron la base real la posee el proceso principal y sql.js la mantiene
 * en MEMFS: `VACUUM INTO` no puede escribir en el disco del equipo desde ese
 * motor. Por eso el respaldo binario usa dos canales fijos del preload:
 *
 * - `palmyra:db:snapshot` → `db.export()` del proceso principal, que devuelve
 *   `{ ok, bytesBase64, size, sha256, latestSeq }`. `latestSeq` sale de la
 *   propia imagen (`_meta`/`_changes`) y permite comparar el respaldo con el
 *   estado restaurado.
 * - `palmyra:db:restore` → valida tamaño, cabecera `SQLite format 3\0` y hash,
 *   escribe el archivo de forma atómica (temporal + rename) y recarga el motor.
 *   La interfaz DEBE reiniciarse: el driver del renderer y la nube siguen
 *   apuntando a la base anterior hasta ese reinicio.
 *
 * El archivo que descarga el usuario se envuelve con el mismo sobre
 * AES-256-GCM del respaldo lógico (`format.ts`), con la marca
 * `kind: "sqlite-binary"`; una copia sin cifrar solo se acepta al restaurar
 * porque el archivo elegido empieza por la cabecera SQLite.
 *
 * En navegador/PWA/APK no hay puente y todo devuelve `{ ok:false,
 * unavailable:true }`. Ninguna función lanza: el respaldo lógico cifrado sigue
 * siendo el camino universal y estos fallos nunca rompen la creación de
 * respaldos.
 */

/** Mismo techo que el proceso principal (200 MB). */
export const BINARY_SNAPSHOT_MAX_BYTES = 200 * 1024 * 1024;

/** Marca del contenido dentro del sobre cifrado. */
export const BINARY_BACKUP_KIND = "sqlite-binary";
/** Formato de la carga descifrada; distinto del respaldo lógico. */
export const BINARY_BACKUP_FORMAT = "palmyra-localdb-binary-backup";
/** Versión del formato binario (la del sobre la aporta `format.ts`). */
export const BINARY_BACKUP_VERSION = 1;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SQLITE_HEADER = "SQLite format 3\u0000";
/** Bytes exactos de la cabecera, sin depender de la codificación del archivo. */
const SQLITE_HEADER_BYTES = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];

export interface BinaryBackupCapability {
  available: boolean;
  engine: "sqljs" | "native-sqlite" | "none";
  reason: string;
}

export interface BinarySnapshotData {
  ok: true;
  /** Imagen completa en base64 (nunca se cruza una ruta de archivo). */
  bytesBase64: string;
  size: number;
  sha256: string;
  /** Último `seq` del journal dentro de la imagen (0 si no aplica). */
  latestSeq: number;
}

export interface BinarySnapshotFailure {
  ok: false;
  /** No existe el puente de escritorio o el motor no es SQLite. */
  unavailable?: boolean;
  /** Hay una transacción abierta o el hub LAN está atendiendo equipos. */
  busy?: boolean;
  error: string;
}

export type BinarySnapshotResult = BinarySnapshotData | BinarySnapshotFailure;

export interface BinaryRestoreSuccess {
  ok: true;
  restartRequired: true;
  size: number;
  sha256: string;
  /** Secuencia del journal en la imagen restaurada. */
  latestSeq: number;
}

export type BinaryRestoreResult = BinaryRestoreSuccess | BinarySnapshotFailure;

export interface BinarySnapshotOptions {
  /** Driver activo: solo el `sqlite` de escritorio puede exportar su imagen. */
  driver?: Pick<LocalDbDriver, "kind"> | null;
}

export interface BinaryRestoreOptions {
  bytesBase64: string;
  expectedSha256: string;
}

export interface BinaryRestoreValidation {
  ok: boolean;
  error?: string;
  /** Bytes inspeccionados (0 si la entrada no era binaria). */
  size: number;
}

export interface BinaryBackupSummary {
  kind: typeof BINARY_BACKUP_KIND;
  createdAt: string;
  size: number;
  sha256: string;
  latestSeq: number;
  appVersion: string;
  schemaVersion: number;
  iterations: number;
  fileName: string;
}

export interface BinaryBackupResult {
  bytes: Uint8Array;
  summary: BinaryBackupSummary;
}

export interface SnapshotToBackupOptions {
  snapshot: BinarySnapshotData;
  passphrase: string;
  meta?: { appVersion?: string; schemaVersion?: number };
  now?: () => string;
  iterations?: number;
}

export interface ReadBinaryBackupOptions {
  bytes: Uint8Array | ArrayBuffer | string;
  passphrase: string;
}

export interface ReadBinaryBackupResult {
  /** Imagen SQLite ya descifrada y verificada, lista para restaurar. */
  image: Uint8Array;
  summary: BinaryBackupSummary;
}

interface BinaryBridge {
  snapshot(): Promise<unknown>;
  restore(payload: { bytesBase64: string; expectedSha256: string }): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Helpers puros                                                       */
/* ------------------------------------------------------------------ */

/** Comprueba la cabecera real `SQLite format 3\0` (16 bytes). */
export function isSqliteFile(bytes: unknown): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length < SQLITE_HEADER_BYTES.length) return false;
  for (let index = 0; index < SQLITE_HEADER_BYTES.length; index += 1) {
    if (bytes[index] !== SQLITE_HEADER_BYTES[index]) return false;
  }
  return true;
}

/**
 * Validación previa de una restauración, sin IPC ni escritura: tipo, tamaño y
 * cabecera. El hash y la apertura real del motor los comprueban el proceso
 * principal y `restoreBinarySnapshot`.
 */
export function validateBinaryRestore(
  bytes: unknown,
  options: { maxBytes?: number } = {}
): BinaryRestoreValidation {
  const maxBytes =
    typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : BINARY_SNAPSHOT_MAX_BYTES;
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, error: "La imagen no es un bloque de bytes válido.", size: 0 };
  }
  if (bytes.length === 0) {
    return { ok: false, error: "La imagen binaria está vacía.", size: 0 };
  }
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      error: `La imagen supera el límite de ${Math.round(maxBytes / (1024 * 1024))} MB.`,
      size: bytes.length
    };
  }
  if (!isSqliteFile(bytes)) {
    return {
      ok: false,
      error: "El archivo no es una imagen SQLite válida (falta la cabecera SQLite format 3).",
      size: bytes.length
    };
  }
  return { ok: true, size: bytes.length };
}

function normalizeText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function stampName(createdAt: string): string {
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `palmyra-imagen-${stamp}.pmybak`;
}

/** Decodifica la imagen con `atob` y exige que el tamaño declarado coincida. */
function decodeImageBase64(base64: unknown, expectedSize: number): Uint8Array {
  if (typeof base64 !== "string" || base64.length === 0 || base64.length % 4 !== 0) {
    throw new BackupError("invalid_format", "La imagen binaria no tiene un formato base64 válido.");
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new BackupError("invalid_format", "La imagen binaria no tiene un formato base64 válido.");
  }
  if (binary.length !== expectedSize) {
    throw new BackupError("integrity_failed", "El tamaño de la imagen no coincide con el declarado.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/* ------------------------------------------------------------------ */
/* Puente del preload                                                  */
/* ------------------------------------------------------------------ */

/** El preload expone funciones sueltas; se leen sin asumir nada del objeto global. */
function getBridge(): BinaryBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = window as {
    palmyraDbSnapshot?: unknown;
    palmyraDbRestore?: unknown;
  };
  const snapshot = candidate.palmyraDbSnapshot;
  const restore = candidate.palmyraDbRestore;
  if (typeof snapshot !== "function" || typeof restore !== "function") return null;
  return {
    snapshot: () => (snapshot as () => Promise<unknown>).call(undefined),
    restore: (payload) =>
      (restore as (value: { bytesBase64: string; expectedSha256: string }) => Promise<unknown>).call(
        undefined,
        payload
      )
  };
}

function hasDesktopDatabase(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as { palmyraDesktopDb?: unknown }).palmyraDesktopDb;
}

/** Estado actual del respaldo binario; solo informativo para la interfaz. */
export function binaryBackupCapability(
  driver?: Pick<LocalDbDriver, "kind"> | null
): BinaryBackupCapability {
  if (typeof window === "undefined") {
    return {
      available: false,
      engine: "none",
      reason: "El respaldo binario solo existe dentro de la app de escritorio; usa el respaldo lógico cifrado."
    };
  }
  if (!getBridge()) {
    return hasDesktopDatabase()
      ? {
          available: false,
          engine: "sqljs",
          reason:
            "Este puente de escritorio no expone la exportación binaria; usa el respaldo lógico cifrado."
        }
      : {
          available: false,
          engine: "none",
          reason:
            "En navegador, PWA y APK no hay un archivo SQLite que exportar; usa el respaldo lógico cifrado."
        };
  }
  if (driver && driver.kind !== "sqlite") {
    return {
      available: false,
      engine: "none",
      reason: `El almacén activo (${driver.kind}) no es SQLite; usa el respaldo lógico cifrado.`
    };
  }
  return {
    available: true,
    engine: "sqljs",
    reason: "El proceso principal exporta y restaura la imagen SQLite completa."
  };
}

function failureOf(raw: Record<string, unknown>): BinarySnapshotFailure {
  const error =
    typeof raw.error === "string" && raw.error ? raw.error : "No se pudo completar la operación binaria.";
  return {
    ok: false,
    error,
    ...(raw.unavailable === true ? { unavailable: true } : {}),
    ...(raw.busy === true ? { busy: true } : {})
  };
}

/** Cabecera SQLite a partir de los primeros 24 caracteres base64 (18 bytes). */
function looksLikeSqliteBase64(base64: string): boolean {
  try {
    const head = atob(base64.slice(0, 24));
    if (head.length < 16) return false;
    for (let index = 0; index < SQLITE_HEADER.length; index += 1) {
      if (head.charCodeAt(index) !== SQLITE_HEADER_BYTES[index]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Exportación                                                         */
/* ------------------------------------------------------------------ */

/**
 * Exporta la imagen binaria vía IPC. Devuelve base64, tamaño, SHA-256 y
 * `latestSeq` del proceso principal; nunca lanza. Si el puente no existe →
 * `unavailable`.
 */
export async function createBinarySnapshot(
  options: BinarySnapshotOptions = {}
): Promise<BinarySnapshotResult> {
  const bridge = getBridge();
  if (!bridge) {
    return {
      ok: false,
      unavailable: true,
      error: "El puente de escritorio no está disponible: esta versión no puede exportar la imagen SQLite."
    };
  }
  if (options.driver && options.driver.kind !== "sqlite") {
    return {
      ok: false,
      unavailable: true,
      error: "El almacén activo no es SQLite; usa el respaldo lógico cifrado."
    };
  }
  let raw: unknown;
  try {
    raw = await bridge.snapshot();
  } catch {
    return { ok: false, error: "No se pudo exportar la imagen binaria de la base local." };
  }
  if (!isRecord(raw)) return { ok: false, error: "La base local no respondió." };
  if (raw.ok !== true) return failureOf(raw);

  const bytesBase64 = raw.bytesBase64;
  const size = raw.size;
  const sha256 = raw.sha256;
  if (typeof bytesBase64 !== "string" || bytesBase64.length === 0 || bytesBase64.length % 4 !== 0) {
    return { ok: false, error: "La imagen binaria llegó incompleta o corrupta." };
  }
  if (typeof sha256 !== "string" || !HASH_PATTERN.test(sha256)) {
    return { ok: false, error: "La imagen binaria no incluye un hash válido." };
  }
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0 || size > BINARY_SNAPSHOT_MAX_BYTES) {
    return { ok: false, error: "La imagen binaria declara un tamaño inválido." };
  }
  if (!looksLikeSqliteBase64(bytesBase64)) {
    return { ok: false, error: "La imagen exportada no parece una base SQLite." };
  }
  return { ok: true, bytesBase64, size, sha256, latestSeq: nonNegativeInt(raw.latestSeq) };
}

/**
 * Envuelve la imagen exportada en el sobre AES-256-GCM del respaldo lógico.
 *
 * La carga descifrada lleva `kind: "sqlite-binary"` y la imagen en base64; el
 * GCM autentica el sobre y el SHA-256 se recomprueba al leer. El archivo plano
 * pesa ~1.8 veces la base (base64 de la imagen + base64 del cifrado), así que
 * el techo de 200 MB sigue aplicando antes de cifrar.
 */
export async function snapshotToBackupBytes(
  options: SnapshotToBackupOptions
): Promise<BinaryBackupResult> {
  const snapshot = options?.snapshot;
  if (!snapshot || snapshot.ok !== true) {
    throw new BackupError("invalid_format", "No hay una imagen binaria válida para cifrar.");
  }
  const image = decodeImageBase64(snapshot.bytesBase64, snapshot.size);
  const validation = validateBinaryRestore(image);
  if (!validation.ok) {
    throw new BackupError("invalid_format", validation.error || "La imagen no es una base SQLite válida.");
  }
  const digest = await sha256Hex(image);
  if (digest !== snapshot.sha256) {
    throw new BackupError("integrity_failed", "La imagen cambió desde que se exportó; vuelve a intentarlo.");
  }

  const rawDate = options.now ? options.now() : new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(rawDate)) ? rawDate : new Date().toISOString();
  const appVersion = normalizeText(options.meta?.appVersion, 40) || "0.0.0";
  const schemaVersion = nonNegativeInt(options.meta?.schemaVersion);
  const payload = {
    format: BINARY_BACKUP_FORMAT,
    kind: BINARY_BACKUP_KIND,
    version: BINARY_BACKUP_VERSION,
    createdAt,
    appVersion,
    schemaVersion,
    latestSeq: nonNegativeInt(snapshot.latestSeq),
    size: image.byteLength,
    sha256: digest,
    image: toBase64(image)
  };
  const envelope = await encryptBackupPayload(JSON.stringify(payload), options.passphrase, {
    ...(options.iterations ? { iterations: options.iterations } : {})
  });
  const bytes = utf8(
    JSON.stringify({ ...envelope, format: BINARY_BACKUP_FORMAT, kind: BINARY_BACKUP_KIND })
  );
  return {
    bytes,
    summary: {
      kind: BINARY_BACKUP_KIND,
      createdAt,
      size: image.byteLength,
      sha256: digest,
      latestSeq: payload.latestSeq,
      appVersion,
      schemaVersion,
      iterations: envelope.iterations,
      fileName: stampName(createdAt)
    }
  };
}

/**
 * Descifra y verifica un respaldo binario cifrado: sobre → GCM → formato,
 * cabecera SQLite, tamaño y SHA-256. Lanza `BackupError` con un mensaje en
 * español apto para la interfaz; nunca escribe nada.
 */
export async function readBinaryBackup(
  options: ReadBinaryBackupOptions
): Promise<ReadBinaryBackupResult> {
  const envelope = parseBackupEnvelope(options?.bytes);
  const plaintext = await decryptBackupEnvelope(envelope, options?.passphrase);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch {
    throw new BackupError("integrity_failed", "El contenido descifrado no es un respaldo binario válido.");
  }
  if (!isRecord(parsed)) {
    throw new BackupError("invalid_format", "El archivo no es un respaldo binario de PALMYRA.");
  }
  if (parsed.format !== BINARY_BACKUP_FORMAT || parsed.kind !== BINARY_BACKUP_KIND) {
    throw new BackupError(
      "invalid_format",
      "El archivo no es un respaldo binario de PALMYRA (es un respaldo lógico)."
    );
  }
  if (parsed.version !== BINARY_BACKUP_VERSION) {
    throw new BackupError(
      "unsupported_version",
      `Versión de imagen no soportada (${String(parsed.version)}). Actualiza PALMYRA para restaurarla.`
    );
  }
  const size = parsed.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0 || size > BINARY_SNAPSHOT_MAX_BYTES) {
    throw new BackupError("integrity_failed", "El respaldo binario declara un tamaño inválido.");
  }
  const sha256 = parsed.sha256;
  if (typeof sha256 !== "string" || !HASH_PATTERN.test(sha256)) {
    throw new BackupError("integrity_failed", "El respaldo binario no incluye un hash válido.");
  }
  const createdAt = parsed.createdAt;
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
    throw new BackupError("integrity_failed", "El respaldo binario no tiene una fecha válida.");
  }

  const image = decodeImageBase64(parsed.image, Math.trunc(size));
  const validation = validateBinaryRestore(image);
  if (!validation.ok) {
    throw new BackupError("invalid_format", validation.error || "La imagen no es una base SQLite válida.");
  }
  const digest = await sha256Hex(image);
  if (digest !== sha256) {
    throw new BackupError("integrity_failed", "La imagen descifrada no coincide con su hash.");
  }

  return {
    image,
    summary: {
      kind: BINARY_BACKUP_KIND,
      createdAt,
      size: image.byteLength,
      sha256: digest,
      latestSeq: nonNegativeInt(parsed.latestSeq),
      appVersion: normalizeText(parsed.appVersion, 40) || "0.0.0",
      schemaVersion: nonNegativeInt(parsed.schemaVersion),
      iterations: envelope.iterations,
      fileName: stampName(createdAt)
    }
  };
}

/* ------------------------------------------------------------------ */
/* Restauración                                                        */
/* ------------------------------------------------------------------ */

/**
 * Restaura una imagen binaria. Valida forma, tamaño y hash antes de cruzar el
 * IPC; el proceso principal vuelve a validar el hash, sustituye el archivo de
 * forma atómica y recarga el motor. La interfaz DEBE reiniciarse después.
 */
export async function restoreBinarySnapshot(
  options: BinaryRestoreOptions
): Promise<BinaryRestoreResult> {
  const bridge = getBridge();
  if (!bridge) {
    return {
      ok: false,
      unavailable: true,
      error: "El puente de escritorio no está disponible: no se puede restaurar la imagen SQLite."
    };
  }
  const bytesBase64 = options?.bytesBase64;
  const expectedSha256 = options?.expectedSha256;
  if (typeof bytesBase64 !== "string" || bytesBase64.length === 0 || bytesBase64.length % 4 !== 0) {
    return { ok: false, error: "La imagen binaria no tiene un formato válido." };
  }
  if (typeof expectedSha256 !== "string" || !HASH_PATTERN.test(expectedSha256)) {
    return { ok: false, error: "El hash SHA-256 del respaldo no es válido." };
  }
  let padding = 0;
  if (bytesBase64.endsWith("==")) padding = 2;
  else if (bytesBase64.endsWith("=")) padding = 1;
  const estimated = (bytesBase64.length / 4) * 3 - padding;
  if (estimated <= 0 || estimated > BINARY_SNAPSHOT_MAX_BYTES) {
    return { ok: false, error: "La imagen supera el límite de 200 MB." };
  }

  let raw: unknown;
  try {
    raw = await bridge.restore({ bytesBase64, expectedSha256 });
  } catch {
    return { ok: false, error: "No se pudo restaurar la imagen binaria." };
  }
  if (!isRecord(raw)) return { ok: false, error: "La base local no respondió." };
  if (raw.ok !== true) return failureOf(raw);
  if (raw.restartRequired !== true) {
    return { ok: false, error: "El proceso principal no confirmó el reinicio obligatorio." };
  }
  const size = typeof raw.size === "number" && Number.isFinite(raw.size) ? raw.size : estimated;
  const sha256 =
    typeof raw.sha256 === "string" && HASH_PATTERN.test(raw.sha256) ? raw.sha256 : expectedSha256;
  return {
    ok: true,
    restartRequired: true,
    size,
    sha256,
    latestSeq: nonNegativeInt(raw.latestSeq)
  };
}

/**
 * Compatibilidad con el respaldo anterior: devuelve los bytes o null. Se apoya
 * en `createBinarySnapshot` para heredar todas las validaciones.
 */
export async function tryCreateBinaryBackup(): Promise<Uint8Array | null> {
  const result = await createBinarySnapshot();
  if (!result.ok) return null;
  try {
    const binary = atob(result.bytesBase64);
    if (binary.length !== result.size) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
