import { assertLocalRow, type LocalDbDriver, type LocalRow, type MutationMeta } from "../contract";
import { LOCAL_DB_TABLE_NAMES, LOCAL_DB_VERSION } from "../schema";
import {
  BACKUP_PAYLOAD_FORMAT,
  BackupError,
  canonicalJson,
  decryptBackupEnvelope,
  encryptBackupPayload,
  normalizeBackupPassphrase,
  parseBackupEnvelope,
  sha256Hex,
  utf8,
  type BackupEnvelope
} from "./format";
import {
  applyBackupSnapshot,
  readBackupSnapshot,
  type BackupSnapshot
} from "./snapshot";

/**
 * Respaldo lógico universal del almacén local.
 *
 * Exporta TODAS las tablas del contrato con sus filas borradas incluidas, el
 * último `seq` del journal, los conteos por tabla y un hash SHA-256 del
 * contenido. Todo viaja cifrado con AES-256-GCM y una clave derivada con
 * PBKDF2-SHA256 de la frase del usuario (ver `format.ts`).
 *
 * La restauración valida el sobre, autentica el cifrado, rechaza esquemas más
 * nuevos que esta app, recompone y compara conteos y hash, y solo entonces
 * escribe, en una única transacción del driver.
 */
export interface CreateBackupOptions {
  driver: LocalDbDriver;
  passphrase: string;
  /** Datos de contexto (empresa, equipo, versión). Solo primitivas. */
  meta?: Record<string, unknown>;
  now?: () => string;
  iterations?: number;
}

export interface BackupSummary {
  createdAt: string;
  schemaVersion: number;
  latestSeq: number;
  totalRows: number;
  counts: Record<string, number>;
  hash: string;
  sizeBytes: number;
  iterations: number;
  fileName: string;
}

export interface BackupResult {
  bytes: Uint8Array;
  summary: BackupSummary;
}

export interface RestoreBackupOptions {
  bytes: Uint8Array | ArrayBuffer | string;
  passphrase: string;
  driver: LocalDbDriver;
  /** Empresa/equipo con el que se registra el cambio de cada fila escrita. */
  mutation?: Partial<MutationMeta>;
  now?: () => string;
}

export interface RestoreReport {
  createdAt: string;
  schemaVersion: number;
  latestSeq: number;
  totalRows: number;
  counts: Record<string, number>;
  hash: string;
  written: number;
  removed: number;
  appliedAt: string;
  /** El journal solo avanza: tras restaurar, la nube verá un salto de seq. */
  localSeqAfterRestore: number;
}

interface BackupPayloadCore {
  format: typeof BACKUP_PAYLOAD_FORMAT;
  schemaVersion: number;
  createdAt: string;
  latestSeq: number;
  meta: Record<string, string | number | boolean | null>;
  tables: Record<string, LocalRow[]>;
  counts: Record<string, number>;
  totalRows: number;
}

interface BackupPayload extends BackupPayloadCore {
  hash: string;
}

const KNOWN_TABLES = new Set<string>(LOCAL_DB_TABLE_NAMES);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const HEX_ISO = /^\d{4}-\d{2}-\d{2}T/;

function nowIso(now?: () => string): string {
  const value = now ? now() : new Date().toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : new Date().toISOString();
}

function normalizeMeta(meta: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!meta || typeof meta !== "object") return out;
  let count = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (count >= 40) break;
    if (typeof value === "string") {
      out[key.slice(0, 80)] = value.slice(0, 500);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key.slice(0, 80)] = value;
    } else if (value === null) {
      out[key.slice(0, 80)] = null;
    } else if (typeof value === "boolean") {
      out[key.slice(0, 80)] = value;
    } else {
      continue;
    }
    count += 1;
  }
  return out;
}

function buildFileName(createdAt: string): string {
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `palmyra-respaldo-${stamp}.pmybak`;
}

function coreOf(payload: BackupPayload): BackupPayloadCore {
  return {
    format: payload.format,
    schemaVersion: payload.schemaVersion,
    createdAt: payload.createdAt,
    latestSeq: payload.latestSeq,
    meta: payload.meta,
    tables: payload.tables,
    counts: payload.counts,
    totalRows: payload.totalRows
  };
}

async function buildPayload(
  snapshot: BackupSnapshot,
  meta: Record<string, unknown> | undefined,
  createdAt: string
): Promise<BackupPayload> {
  const core: BackupPayloadCore = {
    format: BACKUP_PAYLOAD_FORMAT,
    schemaVersion: snapshot.schemaVersion,
    createdAt,
    latestSeq: snapshot.latestSeq,
    meta: normalizeMeta(meta),
    tables: snapshot.tables,
    counts: snapshot.counts,
    totalRows: snapshot.totalRows
  };
  const hash = await sha256Hex(canonicalJson(core));
  return { ...core, hash };
}

/** Crea el respaldo cifrado y devuelve solo los bytes del archivo. */
export async function createBackup(options: CreateBackupOptions): Promise<Uint8Array> {
  const result = await createBackupResult(options);
  return result.bytes;
}

/** Igual que `createBackup` pero con el resumen que la interfaz necesita. */
export async function createBackupResult(options: CreateBackupOptions): Promise<BackupResult> {
  const passphrase = normalizeBackupPassphrase(options?.passphrase);
  const driver = options?.driver;
  if (!driver) throw new BackupError("restore_failed", "No hay almacén local para respaldar.");

  const createdAt = nowIso(options.now);
  const snapshot = await readBackupSnapshot(driver);
  const payload = await buildPayload(snapshot, options.meta, createdAt);
  const envelope = await encryptBackupPayload(canonicalJson(payload), passphrase, {
    ...(options.iterations ? { iterations: options.iterations } : {})
  });
  const bytes = utf8(JSON.stringify(envelope));
  return {
    bytes,
    summary: {
      createdAt,
      schemaVersion: payload.schemaVersion,
      latestSeq: payload.latestSeq,
      totalRows: payload.totalRows,
      counts: payload.counts,
      hash: payload.hash,
      sizeBytes: bytes.byteLength,
      iterations: envelope.iterations,
      fileName: buildFileName(createdAt)
    }
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Valida la carga descifrada ANTES de escribir nada: formato, esquema, conteos,
 * total y hash. Cualquier desviación es un respaldo corrupto o manipulado.
 */
async function validatePayload(raw: unknown): Promise<BackupPayload> {
  if (!isPlainRecord(raw)) {
    throw new BackupError("integrity_failed", "El contenido del respaldo no es un objeto válido.");
  }
  if (raw.format !== BACKUP_PAYLOAD_FORMAT) {
    throw new BackupError("invalid_format", "El archivo no es un respaldo de PALMYRA.");
  }

  const schemaVersion = raw.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new BackupError("integrity_failed", "El respaldo no declara una versión de esquema válida.");
  }
  if (schemaVersion > LOCAL_DB_VERSION) {
    throw new BackupError(
      "schema_too_new",
      `Este respaldo viene de una versión más nueva (esquema ${schemaVersion}; esta app soporta ${LOCAL_DB_VERSION}). Actualiza PALMYRA antes de restaurar.`
    );
  }

  const createdAt = raw.createdAt;
  if (typeof createdAt !== "string" || !HEX_ISO.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) {
    throw new BackupError("integrity_failed", "El respaldo no tiene una fecha de creación válida.");
  }
  const latestSeq = raw.latestSeq;
  if (typeof latestSeq !== "number" || !Number.isFinite(latestSeq) || latestSeq < 0) {
    throw new BackupError("integrity_failed", "El respaldo no declara una secuencia de journal válida.");
  }

  if (!isPlainRecord(raw.tables) || !isPlainRecord(raw.counts)) {
    throw new BackupError("integrity_failed", "El respaldo no incluye las tablas o los conteos.");
  }

  const tables: Record<string, LocalRow[]> = {};
  let totalRows = 0;
  for (const table of LOCAL_DB_TABLE_NAMES) {
    const rows = raw.tables[table];
    if (!Array.isArray(rows)) {
      throw new BackupError("integrity_failed", `El respaldo no incluye la tabla ${table}.`);
    }
    const copy: LocalRow[] = [];
    for (const row of rows) {
      if (!isPlainRecord(row)) {
        throw new BackupError("integrity_failed", `Hay una fila inválida en la tabla ${table}.`);
      }
      try {
        assertLocalRow(table, row);
      } catch {
        throw new BackupError("integrity_failed", `Hay una fila corrupta en la tabla ${table}.`);
      }
      copy.push({ ...(row as LocalRow) });
    }
    const declared = raw.counts[table];
    if (declared !== copy.length) {
      throw new BackupError("integrity_failed", `Los conteos de ${table} no coinciden con su contenido.`);
    }
    tables[table] = copy;
    totalRows += copy.length;
  }

  // Tablas ajenas al contrato: el archivo no es de esta app o está manipulado.
  for (const key of Object.keys(raw.tables)) {
    if (!KNOWN_TABLES.has(key)) {
      throw new BackupError("integrity_failed", `El respaldo contiene una tabla desconocida (${key}).`);
    }
  }

  if (typeof raw.totalRows !== "number" || raw.totalRows !== totalRows) {
    throw new BackupError("integrity_failed", "El total de filas del respaldo no coincide.");
  }

  const counts: Record<string, number> = {};
  for (const table of LOCAL_DB_TABLE_NAMES) counts[table] = tables[table].length;

  const payload: BackupPayload = {
    format: BACKUP_PAYLOAD_FORMAT,
    schemaVersion,
    createdAt,
    latestSeq,
    meta: normalizeMeta(isPlainRecord(raw.meta) ? (raw.meta as Record<string, unknown>) : undefined),
    tables,
    counts,
    totalRows,
    hash: typeof raw.hash === "string" ? raw.hash : ""
  };

  if (!HASH_PATTERN.test(payload.hash)) {
    throw new BackupError("integrity_failed", "El respaldo no incluye un hash válido.");
  }
  const expected = await sha256Hex(canonicalJson(coreOf(payload)));
  if (expected !== payload.hash) {
    throw new BackupError("integrity_failed", "El hash del respaldo no coincide: el contenido fue alterado.");
  }

  return payload;
}

/** Descifra y verifica un respaldo sin escribir en el almacén. */
export async function inspectBackup(options: {
  bytes: Uint8Array | ArrayBuffer | string;
  passphrase: string;
}): Promise<{ createdAt: string; schemaVersion: number; totalRows: number; counts: Record<string, number>; latestSeq: number; hash: string }> {
  const passphrase = normalizeBackupPassphrase(options?.passphrase);
  const envelope: BackupEnvelope = parseBackupEnvelope(options?.bytes);
  const plaintext = await decryptBackupEnvelope(envelope, passphrase);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch {
    throw new BackupError("integrity_failed", "El contenido descifrado no es un respaldo válido.");
  }
  const payload = await validatePayload(parsed);
  return {
    createdAt: payload.createdAt,
    schemaVersion: payload.schemaVersion,
    totalRows: payload.totalRows,
    counts: payload.counts,
    latestSeq: payload.latestSeq,
    hash: payload.hash
  };
}

/**
 * Restaura un respaldo. Orden estricto: sobre → GCM → esquema → conteos/hash →
 * transacción única. Nada se escribe si la verificación falla.
 */
export async function restoreBackup(options: RestoreBackupOptions): Promise<RestoreReport> {
  const passphrase = normalizeBackupPassphrase(options?.passphrase);
  const driver = options?.driver;
  if (!driver) throw new BackupError("restore_failed", "No hay almacén local donde restaurar.");

  const envelope = parseBackupEnvelope(options.bytes);
  const plaintext = await decryptBackupEnvelope(envelope, passphrase);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch {
    throw new BackupError("integrity_failed", "El contenido descifrado no es un respaldo válido.");
  }
  const payload = await validatePayload(parsed);

  const firstRow = LOCAL_DB_TABLE_NAMES.map((table) => payload.tables[table][0]).find(Boolean);
  const mutation: MutationMeta = {
    company_id: options.mutation?.company_id || firstRow?.company_id || "restauracion-local",
    origin_device: options.mutation?.origin_device || "restauracion-local",
    ...(options.mutation?.at ? { at: options.mutation.at } : {})
  };

  const snapshot: BackupSnapshot = {
    schemaVersion: payload.schemaVersion,
    latestSeq: payload.latestSeq,
    tables: payload.tables,
    counts: payload.counts,
    totalRows: payload.totalRows
  };

  let applied: { written: number; removed: number };
  try {
    applied = await applyBackupSnapshot(driver, snapshot, mutation);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "error desconocido";
    throw new BackupError("restore_failed", `No se pudo escribir el respaldo: ${detail}`);
  }

  const appliedAt = nowIso(options.now);
  let localSeqAfterRestore = payload.latestSeq;
  try {
    // El contrato no permite retroceder el journal; se informa el seq real.
    localSeqAfterRestore = await driver.latestSeq();
  } catch {
    // Diagnóstico únicamente.
  }

  return {
    createdAt: payload.createdAt,
    schemaVersion: payload.schemaVersion,
    latestSeq: payload.latestSeq,
    totalRows: payload.totalRows,
    counts: payload.counts,
    hash: payload.hash,
    written: applied.written,
    removed: applied.removed,
    appliedAt,
    localSeqAfterRestore
  };
}
