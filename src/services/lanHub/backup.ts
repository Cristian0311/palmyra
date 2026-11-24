/**
 * Respaldo cifrado del hub LAN.
 *
 * Un respaldo es una foto de TODAS las tablas de negocio del almacén (incluidas
 * las filas borradas) serializada como JSON canónico y cifrada con AES-256-GCM
 * usando WebCrypto puro: el mismo código sirve en Node y en el renderer.
 *
 * Decisiones:
 * - Las tablas internas del hub (`hub_devices`, `hub_receipts`) y la bandeja de
 *   salida (`outbox`) quedan fuera: el emparejamiento de la instalación destino
 *   se conserva y no hace falta volver a emparejar equipos para restaurar.
 * - El sobre lleva metadatos en claro (fecha, empresa, tablas y conteos) para
 *   poder listar respaldos sin la clave; el contenido autoritativo va cifrado y
 *   debe coincidir con esos metadatos o el sobre se rechaza.
 * - La clave nunca viaja dentro del respaldo ni se puede reexportar: una clave
 *   GCM equivocada o un byte alterado hacen fallar la autenticación y no se
 *   escribe nada.
 */
import {
  LocalDbError,
  assertLocalRow,
  type LocalDbDriver,
  type LocalRow,
  type LocalTable,
  type QuerySpec
} from "../localDb/contract";
import { LOCAL_DB_TABLE_NAMES } from "../localDb/schema";

export const BACKUP_FORMAT = "palmyra-backup-v1" as const;
export const BACKUP_ALG = "AES-256-GCM" as const;
/** WebCrypto nombra el algoritmo por familia; el tamaño de clave fija AES-256. */
const WEB_CRYPTO_ALG = "AES-GCM";
/** Datos autenticados pero no cifrados: fijan la versión del formato. */
const BACKUP_AAD = "palmyra-backup-v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Filas por página al leer y por lote al escribir. */
export const BACKUP_PAGE_SIZE = 500;
export const BACKUP_PUT_CHUNK = 200;

/** Tablas que no forman parte del respaldo: estado interno de esta instalación. */
const INTERNAL_TABLES = new Set<string>(["hub_devices", "hub_receipts", "outbox"]);

/** Tablas de negocio respaldables por defecto (30 de las 33 del esquema). */
export const BACKUP_BUSINESS_TABLES: LocalTable[] = LOCAL_DB_TABLE_NAMES.filter(
  (table) => !INTERNAL_TABLES.has(table)
);

const KNOWN_TABLES = new Set<string>(LOCAL_DB_TABLE_NAMES);

export type HubBackupErrorCode =
  | "invalid_format"
  | "invalid_key"
  | "integrity_failed"
  | "company_mismatch"
  | "internal_table"
  | "restore_failed";

export class HubBackupError extends Error {
  readonly code: HubBackupErrorCode;

  constructor(code: HubBackupErrorCode, message: string) {
    super(message);
    this.name = "HubBackupError";
    this.code = code;
  }
}

export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  alg: typeof BACKUP_ALG;
  /** IV de 12 bytes en base64. */
  iv: string;
  /** Cifrado + etiqueta GCM en base64. */
  data: string;
  createdAt: string;
  companyId: string;
  tables: string[];
  counts: Record<string, number>;
}

export interface BackupContent {
  createdAt: string;
  companyId: string;
  tables: string[];
  rows: Record<string, LocalRow[]>;
  counts: Record<string, number>;
}

export interface CreateBackupOptions {
  companyId: string;
  key: CryptoKey;
  /** Reloj inyectable; por defecto la hora del sistema. */
  now?: () => string;
  /** Sustituye el conjunto de tablas; nunca admite tablas internas. */
  tables?: LocalTable[];
  /** Solo para pruebas: fija el IV y así el cifrado es reproducible. */
  iv?: string | Uint8Array;
}

export interface RestoreBackupOptions {
  companyId: string;
}

export interface RestoreBackupResult {
  restored: number;
  counts: Record<string, number>;
}

export interface BackupVerificationReport {
  ok: boolean;
  tables: Record<string, { expected: number; actual: number }>;
  hash: { expected: string; actual: string };
  mismatches: string[];
}

/** Lo único que hace falta del driver o de una transacción abierta. */
interface TableReader {
  query<T extends LocalRow>(spec: QuerySpec): Promise<T[]>;
}

interface WebCryptoLike {
  subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function webCrypto(): WebCryptoLike {
  const api = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (!api || !api.subtle || typeof api.getRandomValues !== "function") {
    throw new HubBackupError(
      "invalid_key",
      "WebCrypto no está disponible en este entorno para cifrar el respaldo"
    );
  }
  return api;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  webCrypto().getRandomValues(bytes);
  return bytes;
}

// --- base64 / base64url sin Buffer: el módulo no arrastra node:crypto ---------

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    out +=
      B64_ALPHABET[(chunk >> 18) & 63] +
      B64_ALPHABET[(chunk >> 12) & 63] +
      B64_ALPHABET[(chunk >> 6) & 63] +
      B64_ALPHABET[chunk & 63];
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const chunk = bytes[index] << 16;
    out += B64_ALPHABET[(chunk >> 18) & 63] + B64_ALPHABET[(chunk >> 12) & 63] + "==";
  } else if (rest === 2) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8);
    out +=
      B64_ALPHABET[(chunk >> 18) & 63] +
      B64_ALPHABET[(chunk >> 12) & 63] +
      B64_ALPHABET[(chunk >> 6) & 63] +
      "=";
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToBytes(text: string, label: string): Uint8Array {
  if (typeof text !== "string") {
    throw new HubBackupError("invalid_format", `El respaldo no incluye ${label}`);
  }
  const normalized = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const body = normalized.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(body)) {
    throw new HubBackupError("invalid_format", `El campo ${label} del respaldo no es base64 válido`);
  }
  if (body.length % 4 === 1) {
    throw new HubBackupError("invalid_format", `El campo ${label} del respaldo tiene longitud inválida`);
  }
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (let index = 0; index < body.length; index += 1) {
    const value = B64_ALPHABET.indexOf(body[index]);
    if (value < 0) {
      throw new HubBackupError("invalid_format", `El campo ${label} del respaldo no es base64 válido`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, written);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// --- JSON canónico y huella ---------------------------------------------------

/**
 * JSON canónico: claves ordenadas, sin espacios y sin `undefined`. Así el
 * cifrado no depende del orden de propiedades que devolvió cada motor.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
}

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/** FNV-1a de 64 bits en hexadecimal: estable entre plataformas y sin dependencias. */
function fnv1a64(text: string): string {
  let hash = FNV64_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * FNV64_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function byId(a: LocalRow, b: LocalRow): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Huella FNV-1a/64 del conjunto. A diferencia de `importVerify` se incluyen
 * todas las columnas, también las volátiles: la restauración escribe las filas
 * tal cual, así que su copia debe coincidir byte a byte con el respaldo.
 */
export function computeBackupHash(tables: Record<string, LocalRow[]>): string {
  const parts: string[] = [];
  for (const table of Object.keys(tables).sort()) {
    const rows = (tables[table] ?? []).slice().sort(byId);
    for (const row of rows) parts.push(`${table}\u0000${row.id}\u0000${canonicalJson(row)}`);
  }
  return fnv1a64(parts.join("\n"));
}

// --- claves -------------------------------------------------------------------

/** Clave nueva de 32 bytes en base64url; se guarda fuera del repo, nunca dentro. */
export async function createBackupKey(): Promise<string> {
  return bytesToBase64Url(randomBytes(KEY_BYTES));
}

/** Importa una clave de 32 bytes (base64url o bytes) como clave AES-GCM no exportable. */
export async function importBackupKey(raw: unknown): Promise<CryptoKey> {
  let bytes: Uint8Array;
  if (typeof raw === "string") {
    bytes = base64ToBytes(raw, "la clave");
  } else if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (raw instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw);
  } else {
    throw new HubBackupError("invalid_key", "La clave del respaldo debe ser base64url o 32 bytes");
  }
  if (bytes.length !== KEY_BYTES) {
    throw new HubBackupError(
      "invalid_key",
      `La clave del respaldo debe tener ${KEY_BYTES} bytes (recibidos ${bytes.length})`
    );
  }
  try {
    return await webCrypto().subtle.importKey("raw", bytes, { name: WEB_CRYPTO_ALG }, false, [
      "encrypt",
      "decrypt"
    ]);
  } catch {
    throw new HubBackupError("invalid_key", "No se pudo importar la clave del respaldo");
  }
}

// --- lectura paginada ---------------------------------------------------------

function tableName(value: string): LocalTable {
  if (!KNOWN_TABLES.has(value)) {
    throw new HubBackupError("invalid_format", `El respaldo menciona una tabla desconocida (${value})`);
  }
  if (INTERNAL_TABLES.has(value)) {
    throw new HubBackupError("internal_table", `La tabla ${value} es interna y no se respalda`);
  }
  return value as LocalTable;
}

function resolveTables(tables: LocalTable[] | undefined): LocalTable[] {
  if (!tables) return BACKUP_BUSINESS_TABLES.slice();
  const seen = new Set<string>();
  const resolved: LocalTable[] = [];
  for (const table of tables) {
    const name = tableName(String(table));
    if (seen.has(name)) continue;
    seen.add(name);
    resolved.push(name);
  }
  return resolved;
}

/**
 * Lee la tabla completa paginando por `id` + `offset`. Si un motor ignorara el
 * desplazamiento (página sin ids nuevos) se relee una sola vez sin paginar para
 * no perder filas; el resultado se ordena por id para que el JSON sea estable.
 */
async function readTable(reader: TableReader, table: LocalTable): Promise<LocalRow[]> {
  const spec = (offset: number): QuerySpec => ({
    table,
    includeDeleted: true,
    orderBy: { field: "id", direction: "asc" },
    limit: BACKUP_PAGE_SIZE,
    offset
  });

  const rows: LocalRow[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = await reader.query<LocalRow>(spec(offset));
    if (page.length === 0) break;
    let fresh = 0;
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push({ ...row });
      fresh += 1;
    }
    if (page.length < BACKUP_PAGE_SIZE) break;
    if (fresh === 0) {
      const all = await reader.query<LocalRow>({ table, includeDeleted: true, orderBy: { field: "id", direction: "asc" } });
      const unique: LocalRow[] = [];
      const ids = new Set<string>();
      for (const row of all) {
        if (ids.has(row.id)) continue;
        ids.add(row.id);
        unique.push({ ...row });
      }
      return unique.sort(byId);
    }
    offset += BACKUP_PAGE_SIZE;
  }
  return rows.sort(byId);
}

/** Recolecta las filas de las tablas indicadas validando la empresa de cada una. */
async function collectRows(
  reader: TableReader,
  tables: LocalTable[],
  companyId: string
): Promise<Record<string, LocalRow[]>> {
  const collected: Record<string, LocalRow[]> = {};
  for (const table of tables) {
    const rows = await readTable(reader, table);
    for (const row of rows) {
      if (row.company_id !== companyId) {
        throw new HubBackupError(
          "company_mismatch",
          `La tabla ${table} tiene una fila de otra empresa (${row.id})`
        );
      }
    }
    collected[table] = rows;
  }
  return collected;
}

// --- crear / descifrar --------------------------------------------------------

function nowIso(now?: () => string): string {
  const value = now ? now() : new Date().toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function countsOf(tables: Record<string, LocalRow[]>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of Object.keys(tables)) counts[table] = tables[table].length;
  return counts;
}

function encryptionKey(key: CryptoKey): CryptoKey {
  if (!key || typeof key !== "object") {
    throw new HubBackupError("invalid_key", "Falta la clave del respaldo");
  }
  return key;
}

function resolveIv(iv: string | Uint8Array | undefined): Uint8Array {
  if (iv === undefined) return randomBytes(IV_BYTES);
  const bytes = typeof iv === "string" ? base64ToBytes(iv, "el IV") : iv;
  if (bytes.length !== IV_BYTES) {
    throw new HubBackupError("invalid_format", `El IV del respaldo debe tener ${IV_BYTES} bytes`);
  }
  return bytes;
}

/**
 * Crea el respaldo cifrado. La carga que se cifra es el JSON canónico de
 * `{format, createdAt, companyId, tables, counts}`; el sobre repite esos datos
 * en claro solo para poder listar archivos sin la clave.
 */
export async function createBackup(
  driver: LocalDbDriver,
  options: CreateBackupOptions
): Promise<BackupEnvelope> {
  if (!driver) throw new HubBackupError("restore_failed", "No hay almacén que respaldar");
  const companyId = typeof options?.companyId === "string" ? options.companyId.trim() : "";
  if (!companyId) throw new HubBackupError("company_mismatch", "El respaldo necesita la empresa");
  const key = encryptionKey(options.key);
  const createdAt = nowIso(options.now);
  const tables = resolveTables(options.tables);
  const rows = await collectRows(driver, tables, companyId);
  const counts = countsOf(rows);

  const payload = {
    format: BACKUP_FORMAT,
    createdAt,
    companyId,
    tables,
    counts,
    rows
  };
  const plaintext = utf8(canonicalJson(payload));
  const iv = resolveIv(options.iv);
  let sealed: ArrayBuffer;
  try {
    sealed = await webCrypto().subtle.encrypt(
      { name: WEB_CRYPTO_ALG, iv, additionalData: utf8(BACKUP_AAD), tagLength: 128 },
      key,
      plaintext
    );
  } catch {
    throw new HubBackupError("invalid_key", "La clave del respaldo no sirve para AES-256-GCM");
  }

  return {
    format: BACKUP_FORMAT,
    alg: BACKUP_ALG,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(sealed)),
    createdAt,
    companyId,
    tables,
    counts
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertEnvelope(raw: unknown): BackupEnvelope {
  const envelope = asRecord(raw);
  if (!envelope) {
    throw new HubBackupError("invalid_format", "El respaldo no es un objeto válido");
  }
  if (envelope.format !== BACKUP_FORMAT) {
    throw new HubBackupError("invalid_format", "El archivo no es un respaldo de PALMYRA");
  }
  if (envelope.alg !== BACKUP_ALG) {
    throw new HubBackupError("invalid_format", "El respaldo usa un cifrado no soportado");
  }
  const iv = base64ToBytes(String(envelope.iv ?? ""), "el IV");
  if (iv.length !== IV_BYTES) {
    throw new HubBackupError("invalid_format", `El IV del respaldo debe tener ${IV_BYTES} bytes`);
  }
  const data = base64ToBytes(String(envelope.data ?? ""), "los datos");
  if (data.length <= TAG_BYTES) {
    throw new HubBackupError("integrity_failed", "El respaldo no tiene contenido cifrado");
  }
  if (typeof envelope.companyId !== "string" || !envelope.companyId.trim()) {
    throw new HubBackupError("invalid_format", "El respaldo no declara la empresa");
  }
  if (typeof envelope.createdAt !== "string" || !Number.isFinite(Date.parse(envelope.createdAt))) {
    throw new HubBackupError("invalid_format", "El respaldo no declara una fecha válida");
  }
  if (!Array.isArray(envelope.tables)) {
    throw new HubBackupError("invalid_format", "El respaldo no declara sus tablas");
  }
  const counts = asRecord(envelope.counts);
  if (!counts) {
    throw new HubBackupError("invalid_format", "El respaldo no declara sus conteos");
  }
  const tables: string[] = [];
  for (const name of envelope.tables) {
    const table = tableName(String(name));
    tables.push(table);
    const declared = counts[table];
    if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 0) {
      throw new HubBackupError("invalid_format", `El respaldo no declara el conteo de ${table}`);
    }
  }
  return {
    format: BACKUP_FORMAT,
    alg: BACKUP_ALG,
    iv: bytesToBase64(iv),
    data: bytesToBase64(data),
    createdAt: envelope.createdAt,
    companyId: envelope.companyId,
    tables,
    counts: counts as Record<string, number>
  };
}

function parseContent(raw: unknown): BackupContent {
  const payload = asRecord(raw);
  if (!payload) {
    throw new HubBackupError("integrity_failed", "El contenido del respaldo no es válido");
  }
  if (payload.format !== BACKUP_FORMAT) {
    throw new HubBackupError("integrity_failed", "El contenido del respaldo no es de PALMYRA");
  }
  const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : "";
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    throw new HubBackupError("integrity_failed", "El respaldo no tiene una fecha de creación válida");
  }
  const companyId = typeof payload.companyId === "string" ? payload.companyId.trim() : "";
  if (!companyId) {
    throw new HubBackupError("integrity_failed", "El respaldo no declara la empresa");
  }
  if (!Array.isArray(payload.tables)) {
    throw new HubBackupError("integrity_failed", "El respaldo no declara sus tablas");
  }
  const rowsByTable = asRecord(payload.rows);
  const countsRaw = asRecord(payload.counts);
  if (!rowsByTable || !countsRaw) {
    throw new HubBackupError("integrity_failed", "El respaldo no incluye filas o conteos");
  }

  const tables: string[] = [];
  const rows: Record<string, LocalRow[]> = {};
  const counts: Record<string, number> = {};
  for (const name of payload.tables) {
    const table = tableName(String(name));
    const raw = rowsByTable[table] ?? [];
    if (!Array.isArray(raw)) {
      throw new HubBackupError("integrity_failed", `La tabla ${table} del respaldo no es una lista`);
    }
    const copy: LocalRow[] = [];
    for (const candidate of raw) {
      const row = asRecord(candidate);
      if (!row) {
        throw new HubBackupError("integrity_failed", `Hay una fila inválida en la tabla ${table}`);
      }
      try {
        assertLocalRow(table, row);
      } catch (error) {
        const detail = error instanceof LocalDbError ? error.code : "invalid_row";
        throw new HubBackupError("integrity_failed", `Fila corrupta en ${table} (${detail})`);
      }
      if (String(row.company_id) !== companyId) {
        throw new HubBackupError("company_mismatch", `La tabla ${table} mezcla empresas`);
      }
      copy.push({ ...(row as LocalRow) });
    }
    const declared = countsRaw[table];
    if (declared !== copy.length) {
      throw new HubBackupError("integrity_failed", `Los conteos de ${table} no coinciden con sus filas`);
    }
    tables.push(table);
    rows[table] = copy;
    counts[table] = copy.length;
  }

  return { createdAt, companyId, tables, rows, counts };
}

/** Descifra y valida sin escribir nada. Clave errónea o manipulación → error. */
export async function decryptBackup(envelope: unknown, key: CryptoKey): Promise<BackupContent> {
  const parsed = assertEnvelope(envelope);
  const cryptoKey = encryptionKey(key);
  const iv = base64ToBytes(parsed.iv, "el IV");
  const data = base64ToBytes(parsed.data, "los datos");

  let plaintext: ArrayBuffer;
  try {
    plaintext = await webCrypto().subtle.decrypt(
      { name: WEB_CRYPTO_ALG, iv, additionalData: utf8(BACKUP_AAD), tagLength: 128 },
      cryptoKey,
      data
    );
  } catch {
    throw new HubBackupError(
      "integrity_failed",
      "No se pudo descifrar el respaldo: la clave no es la correcta o el archivo fue alterado"
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new HubBackupError("integrity_failed", "El contenido descifrado no es un respaldo válido");
  }
  const content = parseContent(decoded);
  // Los metadatos en claro del sobre deben coincidir con lo cifrado: si alguien
  // los cambia, el respaldo deja de ser el que se creó.
  if (content.companyId !== parsed.companyId.trim()) {
    throw new HubBackupError("integrity_failed", "La empresa del sobre no coincide con el contenido");
  }
  if (content.createdAt !== parsed.createdAt) {
    throw new HubBackupError("integrity_failed", "La fecha del sobre no coincide con el contenido");
  }
  for (const table of content.tables) {
    if (parsed.counts[table] !== content.counts[table]) {
      throw new HubBackupError("integrity_failed", `El conteo de ${table} no coincide con el sobre`);
    }
  }
  return content;
}

// --- verificación y restauración ---------------------------------------------

function assertCompany(content: BackupContent, companyId: string): string {
  const expected = typeof companyId === "string" ? companyId.trim() : "";
  if (!expected) {
    throw new HubBackupError("company_mismatch", "Falta la empresa de la instalación destino");
  }
  if (content.companyId !== expected) {
    throw new HubBackupError(
      "company_mismatch",
      `El respaldo es de la empresa ${content.companyId} y la instalación es ${expected}`
    );
  }
  return expected;
}

/** Filas almacenadas de esta empresa limitadas a los ids del respaldo. */
async function readStoredSubset(
  reader: TableReader,
  table: LocalTable,
  companyId: string,
  ids: Set<string>
): Promise<LocalRow[]> {
  const stored = await reader.query<LocalRow>({
    table,
    where: [{ field: "company_id", op: "eq", value: companyId }],
    includeDeleted: true
  });
  return stored.filter((row) => ids.has(row.id));
}

/**
 * Compara conteos y huella FNV-1a de las filas del respaldo con lo almacenado,
 * sin escribir. Se restringe a los ids del respaldo: si el destino tiene filas
 * de más, no cuenta como fallo de la restauración.
 */
export async function verifyBackupContent(
  driver: LocalDbDriver,
  content: BackupContent,
  options: { companyId: string }
): Promise<BackupVerificationReport> {
  if (!driver) throw new HubBackupError("restore_failed", "No hay almacén que verificar");
  const companyId = assertCompany(content, options?.companyId);
  const tables: Record<string, { expected: number; actual: number }> = {};
  const mismatches: string[] = [];
  const expectedRows: Record<string, LocalRow[]> = {};
  const actualRows: Record<string, LocalRow[]> = {};

  for (const table of content.tables) {
    const declared = content.rows[table] ?? [];
    const ids = new Set(declared.map((row) => row.id));
    const actual = await readStoredSubset(driver, table as LocalTable, companyId, ids);
    expectedRows[table] = declared;
    actualRows[table] = actual;
    tables[table] = { expected: declared.length, actual: actual.length };
    if (declared.length !== actual.length) {
      mismatches.push(`tabla ${table}: esperado ${declared.length}, real ${actual.length}`);
    }
  }

  const expectedHash = computeBackupHash(expectedRows);
  const actualHash = computeBackupHash(actualRows);
  if (expectedHash !== actualHash) {
    mismatches.push(`hash: esperado ${expectedHash}, real ${actualHash}`);
  }

  return { ok: mismatches.length === 0, tables, hash: { expected: expectedHash, actual: actualHash }, mismatches };
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/**
 * Restaura el respaldo en UNA transacción: escribe por lotes y vuelve a leer lo
 * escrito dentro de la misma transacción. Cualquier diferencia lanza y el
 * driver deshace todo (memoria y SQLite revierten de verdad). Las tablas
 * internas del hub no se tocan: los equipos ya emparejados siguen siéndolo.
 */
export async function restoreBackup(
  driver: LocalDbDriver,
  envelope: unknown,
  key: CryptoKey,
  options: RestoreBackupOptions
): Promise<RestoreBackupResult> {
  if (!driver) throw new HubBackupError("restore_failed", "No hay almacén donde restaurar");
  const content = await decryptBackup(envelope, key);
  const companyId = assertCompany(content, options?.companyId);

  // Validación completa antes de abrir la transacción.
  for (const table of content.tables) {
    for (const row of content.rows[table] ?? []) assertLocalRow(table as LocalTable, row);
  }

  const expected: Record<string, LocalRow[]> = {};
  for (const table of content.tables) expected[table] = content.rows[table] ?? [];

  let restored = 0;
  await driver.transaction(async (tx) => {
    for (const table of content.tables) {
      for (const batch of chunk(content.rows[table] ?? [], BACKUP_PUT_CHUNK)) {
        restored += await tx.put(table as LocalTable, batch);
      }
    }

    // Verificación dentro de la transacción: si algo no cuadra, no se confirma.
    const actual: Record<string, LocalRow[]> = {};
    for (const table of content.tables) {
      const ids = new Set((content.rows[table] ?? []).map((row) => row.id));
      actual[table] = await readStoredSubset(tx, table as LocalTable, companyId, ids);
      if (actual[table].length !== expected[table].length) {
        throw new HubBackupError(
          "restore_failed",
          `Restauración incompleta en ${table}: ${actual[table].length}/${expected[table].length}`
        );
      }
    }
    const expectedHash = computeBackupHash(expected);
    const actualHash = computeBackupHash(actual);
    if (expectedHash !== actualHash) {
      throw new HubBackupError(
        "restore_failed",
        `La restauración no coincide con el respaldo (hash ${actualHash} ≠ ${expectedHash})`
      );
    }
  });

  return { restored, counts: { ...content.counts } };
}
