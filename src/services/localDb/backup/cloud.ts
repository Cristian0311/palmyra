/**
 * Respaldo cifrado FUERA DEL SITIO (nube) del almacén local.
 *
 * El POS sigue funcionando sin internet: este módulo nunca bloquea una venta,
 * nunca lanza y siempre devuelve un resultado estructurado. Cada día se sube el
 * MISMO sobre cifrado del respaldo local (`createBackupResult` → AES-256-GCM con
 * PBKDF2-SHA256) a la ruta `<companyId>/<deviceId>/<YYYY-MM-DD>.pmlr`, junto a un
 * manifiesto `<mismo nombre>.pmlr.json` con tamaño, SHA-256 del archivo, hash del
 * contenido y conteos por tabla.
 *
 * Garantías:
 *  - Cifrado solo en el dispositivo: la frase nunca viaja ni se guarda.
 *  - Incremental: si el día ya existe con el mismo hash de contenido (o el mismo
 *    archivo), no se sube nada.
 *  - Retención 7 diarios + 4 semanales reutilizando `pruneBackups`; jamás se
 *    borran los dos respaldos correctos más recientes.
 *  - Restauración verificada (tamaño → SHA-256 → manifiesto → frase → conteos)
 *    ANTES de escribir una sola fila. Nunca automática.
 *
 * Todo lo externo es inyectable (transporte, reloj, almacenamiento de estado,
 * creador de la foto y espera) para probarlo sin red ni esperas reales.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LocalDbDriver } from "../contract";
import {
  createBackupResult,
  inspectBackup,
  restoreBackup,
  type BackupSummary
} from "./backup";
import { BackupError, sha256Hex, utf8, fromUtf8 } from "./format";
import { BACKUP_DAILY_LIMIT, BACKUP_WEEKLY_LIMIT, pruneBackups } from "./retention";

export const CLOUD_BACKUP_BUCKET = "palmyra-backups";
/** Clave base del estado local; por empresa se añade `:<companyId>`. */
export const CLOUD_BACKUP_STATE_KEY = "palmyra:cloud-backup:v1";
/** Techo por archivo (y límite declarado del bucket). */
export const CLOUD_BACKUP_MAX_BYTES = 200 * 1024 * 1024;
export const CLOUD_BACKUP_MAX_ATTEMPTS = 3;
export const CLOUD_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CLOUD_BACKUP_MANIFEST_VERSION = 1;
export const CLOUD_BACKUP_SNAPSHOT_SUFFIX = ".pmlr";
export const CLOUD_BACKUP_MANIFEST_SUFFIX = ".pmlr.json";
export const CLOUD_BACKUP_MIN_KEPT = 2;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;
const CONTENT_TYPE_SNAPSHOT = "application/octet-stream";
const CONTENT_TYPE_MANIFEST = "application/json";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

export interface CloudStorageEntry {
  path: string;
  name: string;
  size?: number;
  updatedAt?: string | null;
}

/** Transporte mínimo que el servicio necesita; la nube real es `supabase.storage`. */
export interface CloudStorageTransport {
  list(prefix: string): Promise<CloudStorageEntry[]>;
  upload(path: string, bytes: Uint8Array, contentType?: string): Promise<{ ok: boolean; error?: string }>;
  download(path: string): Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }>;
  remove(paths: string[]): Promise<{ ok: boolean; removed?: string[]; error?: string }>;
}

export interface CloudBackupManifest {
  version: number;
  day: string;
  bytes: number;
  /** SHA-256 del archivo cifrado tal cual se descarga. */
  sha256: string;
  /** Hash del contenido en claro (el `hash` del respaldo): deduplica por datos. */
  contentHash: string;
  tables: number;
  counts: Record<string, number>;
  totalRows: number;
  latestSeq: number;
  schemaVersion: number;
  companyId: string;
  deviceId: string;
  createdAt: string;
  tool: string;
}

export interface CloudBackupState {
  lastUploadAt: string | null;
  lastDay: string | null;
  lastBytes: number | null;
  lastSha256: string | null;
  lastError: string | null;
  lastRestoreAt: string | null;
  lastRestoreDay: string | null;
  lastRestoreResult: "ok" | "failed" | null;
}

export interface CloudBackupStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CloudSnapshot {
  bytes: Uint8Array;
  summary: Pick<
    BackupSummary,
    "createdAt" | "schemaVersion" | "latestSeq" | "totalRows" | "counts" | "hash"
  >;
}

export type CloudBackupSkipReason =
  | "offline"
  | "disabled"
  | "deduplicated"
  | "no_transport"
  | "no_snapshot"
  | "too_large"
  | "upload_failed"
  | "manifest_failed";

export interface CloudBackupOutcome {
  ok: boolean;
  skipped?: boolean;
  reason?: CloudBackupSkipReason;
  day?: string;
  path?: string;
  bytes?: number;
  sha256?: string;
  removed?: string[];
  error?: string;
}

export interface CloudBackupDay {
  day: string;
  createdAt: string;
  bytes: number;
  totalRows: number;
  tables: number;
  sha256: string;
}

export type CloudRestoreFailure =
  | "disabled"
  | "no_transport"
  | "no_driver"
  | "confirmation_required"
  | "invalid_day"
  | "not_found"
  | "foreign_company"
  | "download_failed"
  | "size_mismatch"
  | "checksum_mismatch"
  | "wrong_passphrase"
  | "corrupt"
  | "schema_too_new"
  | "row_count_mismatch"
  | "restore_failed";

export interface CloudRestoreInput {
  day: string;
  passphrase: string;
  confirm: boolean;
}

export interface CloudRestoreOutcome {
  ok: boolean;
  reason?: CloudRestoreFailure;
  error?: string;
  day?: string;
  applied?: {
    createdAt: string;
    totalRows: number;
    written: number;
    removed: number;
  };
}

export interface CloudBackupManagerDeps {
  companyId: string | null | undefined;
  deviceId: string;
  transport?: CloudStorageTransport | null;
  /** Driver del almacén local; obligatorio para subir y restaurar. */
  getDriver?: () => Promise<LocalDbDriver>;
  /** Inyectable para pruebas; por defecto cifra la foto real del almacén. */
  snapshot?: (passphrase: string) => Promise<CloudSnapshot>;
  now?: () => string;
  storage?: CloudBackupStateStorage | null;
  sleep?: (ms: number) => Promise<void>;
  isOnline?: () => boolean;
  maxBytes?: number;
  maxAttempts?: number;
  retention?: { dailyLimit?: number; weeklyLimit?: number };
  /** Contabilidad del presupuesto de solicitudes (`backup/cloud`). */
  recordRequest?: (route: string, outcome: { ms?: number; ok?: boolean }) => void;
  tool?: string;
}

export interface CloudBackupManager {
  readonly companyId: string | null;
  isEnabled(): boolean;
  state(): CloudBackupState;
  backupNow(passphrase: string): Promise<CloudBackupOutcome>;
  listCloudBackups(): Promise<CloudBackupDay[]>;
  restoreCloudBackup(input: CloudRestoreInput): Promise<CloudRestoreOutcome>;
}

/* ------------------------------------------------------------------ */
/* Estado local (localStorage por empresa, memoria como respaldo)      */
/* ------------------------------------------------------------------ */

const memoryStates = new Map<string, CloudBackupState>();

function emptyState(): CloudBackupState {
  return {
    lastUploadAt: null,
    lastDay: null,
    lastBytes: null,
    lastSha256: null,
    lastError: null,
    lastRestoreAt: null,
    lastRestoreDay: null,
    lastRestoreResult: null
  };
}

function defaultStateStorage(): CloudBackupStateStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function segmentOf(companyId: string): string {
  return String(companyId).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "sin-empresa";
}

export function cloudBackupStateKey(companyId: string): string {
  return `${CLOUD_BACKUP_STATE_KEY}:${segmentOf(companyId)}`;
}

function sanitizeState(raw: unknown): CloudBackupState {
  const base = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const source = raw as Record<string, unknown>;
  const iso = (value: unknown): string | null =>
    typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  return {
    lastUploadAt: iso(source.lastUploadAt),
    lastDay: typeof source.lastDay === "string" && DAY_PATTERN.test(source.lastDay) ? source.lastDay : null,
    lastBytes: count(source.lastBytes),
    lastSha256: typeof source.lastSha256 === "string" && SHA_PATTERN.test(source.lastSha256) ? source.lastSha256 : null,
    lastError:
      typeof source.lastError === "string" && source.lastError.trim()
        ? source.lastError.trim().slice(0, 300)
        : null,
    lastRestoreAt: iso(source.lastRestoreAt),
    lastRestoreDay:
      typeof source.lastRestoreDay === "string" && DAY_PATTERN.test(source.lastRestoreDay)
        ? source.lastRestoreDay
        : null,
    lastRestoreResult:
      source.lastRestoreResult === "ok" || source.lastRestoreResult === "failed"
        ? source.lastRestoreResult
        : null
  };
}

export function readCloudBackupState(
  storage: CloudBackupStateStorage | null | undefined,
  companyId: string
): CloudBackupState {
  const key = cloudBackupStateKey(companyId);
  // El respaldo en memoria es solo para sesiones SIN almacenamiento (modo
  // privado antiguo, pruebas). Con almacenamiento, un perfil vacío está vacío:
  // nunca hereda el estado de otro contexto.
  if (!storage) {
    const fallback = memoryStates.get(key);
    return fallback ? { ...fallback } : emptyState();
  }
  try {
    const raw = storage.getItem(key);
    if (!raw) return emptyState();
    return sanitizeState(JSON.parse(raw) as unknown);
  } catch {
    return emptyState();
  }
}

function writeCloudBackupState(
  storage: CloudBackupStateStorage | null | undefined,
  companyId: string,
  state: CloudBackupState
): CloudBackupState {
  const key = cloudBackupStateKey(companyId);
  if (!storage) {
    memoryStates.set(key, { ...state });
    return state;
  }
  try {
    storage.setItem(key, JSON.stringify(state));
  } catch {
    // Sin cuota o en modo privado: el estado en memoria sigue la sesión.
    memoryStates.set(key, { ...state });
  }
  return state;
}

/* ------------------------------------------------------------------ */
/* Nombres, días y manifiestos                                         */
/* ------------------------------------------------------------------ */

/** Segmento seguro para una ruta de Storage: sin separadores ni `..`. */
export function normalizeCloudSegment(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  const clean = text.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "").slice(0, 80);
  return clean || fallback;
}

export function normalizeCloudDay(value: unknown): string | null {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return null;
  return Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ? value : null;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export function cloudBackupPrefix(companyId: string, deviceId: string): string {
  return `${normalizeCloudSegment(companyId, "sin-empresa")}/${normalizeCloudSegment(deviceId, "equipo")}`;
}

export function cloudSnapshotPath(companyId: string, deviceId: string, day: string): string {
  return `${cloudBackupPrefix(companyId, deviceId)}/${day}${CLOUD_BACKUP_SNAPSHOT_SUFFIX}`;
}

export function cloudManifestPath(companyId: string, deviceId: string, day: string): string {
  return `${cloudBackupPrefix(companyId, deviceId)}/${day}${CLOUD_BACKUP_MANIFEST_SUFFIX}`;
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : -1;
}

function sanitizeCounts(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const counts: Record<string, number> = {};
  let keys = 0;
  for (const [table, value] of Object.entries(raw as Record<string, unknown>)) {
    if (keys >= 80) break;
    const count = finiteCount(value);
    if (count < 0) return null;
    counts[table.slice(0, 80)] = count;
    keys += 1;
  }
  return counts;
}

/** Valida el manifiesto; `null` si está incompleto o manipulado. */
export function parseCloudManifest(raw: unknown): CloudBackupManifest | null {
  let value = raw;
  if (value instanceof Uint8Array) value = fromUtf8(value);
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const day = normalizeCloudDay(source.day);
  const counts = sanitizeCounts(source.counts);
  if (!day || !counts) return null;
  if (source.version !== CLOUD_BACKUP_MANIFEST_VERSION) return null;
  const bytes = finiteCount(source.bytes);
  const tables = finiteCount(source.tables);
  const totalRows = finiteCount(source.totalRows);
  const latestSeq = finiteCount(source.latestSeq);
  const schemaVersion = finiteCount(source.schemaVersion);
  if (bytes <= 0 || tables < 0 || totalRows < 0 || latestSeq < 0 || schemaVersion < 0) return null;
  if (typeof source.sha256 !== "string" || !SHA_PATTERN.test(source.sha256)) return null;
  if (typeof source.contentHash !== "string" || !SHA_PATTERN.test(source.contentHash)) return null;
  if (typeof source.createdAt !== "string" || !Number.isFinite(Date.parse(source.createdAt))) return null;
  if (typeof source.companyId !== "string" || !source.companyId) return null;
  if (typeof source.deviceId !== "string" || !source.deviceId) return null;
  return {
    version: CLOUD_BACKUP_MANIFEST_VERSION,
    day,
    bytes,
    sha256: source.sha256,
    contentHash: source.contentHash,
    tables,
    counts,
    totalRows,
    latestSeq,
    schemaVersion,
    companyId: source.companyId.slice(0, 80),
    deviceId: source.deviceId.slice(0, 80),
    createdAt: source.createdAt,
    tool: typeof source.tool === "string" ? source.tool.slice(0, 120) : ""
  };
}

/* ------------------------------------------------------------------ */
/* Utilidades internas                                                 */
/* ------------------------------------------------------------------ */

function safeNow(now?: () => string): string {
  try {
    const value = now ? now() : new Date().toISOString();
    return Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function describeError(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 300);
  if (error instanceof Error && error.message) return error.message.slice(0, 300);
  return fallback;
}

function defaultOnline(): boolean {
  try {
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    return !nav || nav.onLine !== false;
  } catch {
    return true;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function withRetry<T>(
  attempts: number,
  sleep: (ms: number) => Promise<void>,
  run: (attempt: number) => Promise<T>,
  isOk: (result: T) => boolean
): Promise<{ result: T; attempts: number }> {
  const max = Math.max(1, Math.trunc(attempts));
  let last: T | null = null;
  for (let attempt = 1; attempt <= max; attempt += 1) {
    try {
      const result = await run(attempt);
      last = result;
      if (isOk(result)) return { result, attempts: attempt };
    } catch (error) {
      last = { ok: false, error: describeError(error, "Fallo de red.") } as unknown as T;
    }
    if (attempt < max) {
      // 600 ms → 1.2 s: un reintento no debe parecer un cuelgue en caja.
      try {
        await sleep(600 * Math.pow(2, attempt - 1));
      } catch {
        // Una espera inyectada que falla no debe romper el ciclo.
      }
    }
  }
  return { result: last as T, attempts: max };
}

/* ------------------------------------------------------------------ */
/* Gerente                                                             */
/* ------------------------------------------------------------------ */

export function createCloudBackupManager(deps: CloudBackupManagerDeps): CloudBackupManager {
  const companyIdRaw = typeof deps.companyId === "string" ? deps.companyId.trim() : "";
  const companyId = companyIdRaw || null;
  const deviceId = normalizeCloudSegment(deps.deviceId, "equipo");
  const now = deps.now;
  const sleep = deps.sleep ?? defaultSleep;
  const isOnline = deps.isOnline ?? defaultOnline;
  const storage = deps.storage === undefined ? defaultStateStorage() : deps.storage;
  const maxBytes =
    typeof deps.maxBytes === "number" && Number.isFinite(deps.maxBytes) && deps.maxBytes > 0
      ? Math.trunc(deps.maxBytes)
      : CLOUD_BACKUP_MAX_BYTES;
  const maxAttempts =
    typeof deps.maxAttempts === "number" && Number.isFinite(deps.maxAttempts) && deps.maxAttempts > 0
      ? Math.trunc(deps.maxAttempts)
      : CLOUD_BACKUP_MAX_ATTEMPTS;
  const retentionOptions = deps.retention ?? {};
  const tool = deps.tool || "PALMYRA POS";

  const enabled = (): boolean => Boolean(companyId) && Boolean(deps.transport);

  function state(): CloudBackupState {
    if (!companyId) return emptyState();
    return readCloudBackupState(storage, companyId);
  }

  function patchState(patch: Partial<CloudBackupState>): CloudBackupState {
    if (!companyId) return emptyState();
    const next = { ...readCloudBackupState(storage, companyId), ...patch };
    return writeCloudBackupState(storage, companyId, next);
  }

  function record(ms: number, ok: boolean): void {
    try {
      deps.recordRequest?.("backup/cloud", { ms, ok });
    } catch {
      // La contabilidad nunca decide el resultado del respaldo.
    }
  }

  async function buildSnapshot(passphrase: string): Promise<CloudSnapshot> {
    if (deps.snapshot) return deps.snapshot(passphrase);
    if (!deps.getDriver) throw new Error("No hay almacén local para respaldar.");
    const driver = await deps.getDriver();
    const result = await createBackupResult({
      driver,
      passphrase,
      meta: { app: "palmyra", version: tool, kind: "nube" }
    });
    return { bytes: result.bytes, summary: result.summary };
  }

  /** Manifiestos del prefijo empresa/equipo (por nombre, no por contenido). */
  async function fetchManifests(): Promise<Array<{ manifest: CloudBackupManifest; path: string }>> {
    if (!companyId || !deps.transport) return [];
    const prefix = cloudBackupPrefix(companyId, deviceId);
    let listing: CloudStorageEntry[] = [];
    try {
      listing = await deps.transport.list(prefix);
    } catch {
      return [];
    }
    const found: Array<{ manifest: CloudBackupManifest; path: string }> = [];
    for (const entry of Array.isArray(listing) ? listing : []) {
      const name = typeof entry?.name === "string" ? entry.name : "";
      if (!name.endsWith(CLOUD_BACKUP_MANIFEST_SUFFIX)) continue;
      const path =
        typeof entry.path === "string" && entry.path
          ? entry.path
          : `${prefix}/${name}`;
      // Solo el prefijo de ESTA empresa y equipo: nada de rutas ajenas.
      if (!path.startsWith(`${prefix}/`)) continue;
      try {
        const downloaded = await deps.transport.download(path);
        if (!downloaded?.ok || !downloaded.bytes) continue;
        const manifest = parseCloudManifest(downloaded.bytes);
        if (manifest) found.push({ manifest, path });
      } catch {
        // Un manifiesto ilegible no invalida los demás.
      }
    }
    return found;
  }

  async function listCloudBackups(): Promise<CloudBackupDay[]> {
    if (!companyId) return [];
    try {
      const found = await fetchManifests();
      return found
        .filter((item) => item.manifest.companyId === companyId)
        .map((item) => ({
          day: item.manifest.day,
          createdAt: item.manifest.createdAt,
          bytes: item.manifest.bytes,
          totalRows: item.manifest.totalRows,
          tables: item.manifest.tables,
          sha256: item.manifest.sha256
        }))
        .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
    } catch {
      return [];
    }
  }

  async function applyRetention(
    manifests: CloudBackupManifest[],
    reference: string
  ): Promise<string[]> {
    if (!companyId || !deps.transport) return [];
    const entries = manifests
      .map((manifest) => ({
        id: manifest.day,
        createdAt: manifest.createdAt,
        day: manifest.day
      }))
      .filter((entry) => Number.isFinite(Date.parse(entry.createdAt)));

    const plan = pruneBackups(entries, reference, retentionOptions);

    // Nunca se borra el respaldo recién subido ni los dos más recientes.
    const protectedDays = new Set(
      entries
        .slice()
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, Math.max(CLOUD_BACKUP_MIN_KEPT, 1))
        .map((entry) => entry.day)
    );

    const removed: string[] = [];
    for (const stale of plan.remove) {
      if (protectedDays.has(stale.day)) continue;
      const paths = [
        cloudSnapshotPath(companyId, deviceId, stale.day),
        cloudManifestPath(companyId, deviceId, stale.day)
      ];
      let result: { ok: boolean; removed?: string[] } | null = null;
      try {
        result = await deps.transport.remove(paths);
      } catch {
        result = null;
      }
      if (result?.ok) {
        removed.push(...(Array.isArray(result.removed) && result.removed.length ? result.removed : paths));
      }
    }
    return removed;
  }

  async function backupNow(passphrase: string): Promise<CloudBackupOutcome> {
    const startedAt = Date.now();
    try {
      if (!companyId) {
        return { ok: false, reason: "disabled", error: "Inicia sesión para respaldar en la nube." };
      }
      const transport = deps.transport;
      if (!transport) {
        return { ok: false, reason: "no_transport", error: "La nube no está configurada en este equipo." };
      }
      if (!isOnline()) {
        // Offline es lo normal en caja: se espera, no se falla ni se avisa en rojo.
        return {
          ok: false,
          skipped: true,
          reason: "offline",
          error: "Sin conexión: el respaldo en la nube se reintentará al volver internet."
        };
      }

      const at = safeNow(now);
      const day = dayOf(at);

      let snapshot: CloudSnapshot;
      try {
        snapshot = await buildSnapshot(passphrase);
      } catch (error) {
        const message = describeError(error, "No se pudo crear el respaldo cifrado.");
        patchState({ lastError: message });
        return { ok: false, reason: "no_snapshot", error: message };
      }

      const bytes = snapshot?.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        const message = "El respaldo salió vacío; no se subió nada.";
        patchState({ lastError: message });
        return { ok: false, reason: "no_snapshot", error: message };
      }
      if (bytes.length > maxBytes) {
        const message = `El respaldo supera el límite de ${Math.round(maxBytes / (1024 * 1024))} MB.`;
        patchState({ lastError: message });
        return { ok: false, reason: "too_large", day, bytes: bytes.length, error: message };
      }

      const fileSha = await sha256Hex(bytes);
      const existing = (await fetchManifests()).find((item) => item.manifest.day === day);
      if (
        existing &&
        (existing.manifest.sha256 === fileSha || existing.manifest.contentHash === snapshot.summary.hash)
      ) {
        // Mismo día y mismos datos: no hay nada nuevo que subir.
        patchState({
          lastUploadAt: at,
          lastDay: day,
          lastBytes: existing.manifest.bytes,
          lastSha256: existing.manifest.sha256,
          lastError: null
        });
        record(Date.now() - startedAt, true);
        return {
          ok: true,
          skipped: true,
          reason: "deduplicated",
          day,
          path: cloudSnapshotPath(companyId, deviceId, day),
          bytes: existing.manifest.bytes,
          sha256: existing.manifest.sha256
        };
      }

      const snapshotPath = cloudSnapshotPath(companyId, deviceId, day);
      const uploaded = await withRetry(
        maxAttempts,
        sleep,
        () => transport.upload(snapshotPath, bytes, CONTENT_TYPE_SNAPSHOT),
        (result) => result?.ok === true
      );
      if (uploaded.result?.ok !== true) {
        const message = describeError(uploaded.result?.error, "No se pudo subir el respaldo a la nube.");
        patchState({ lastError: message });
        record(Date.now() - startedAt, false);
        return { ok: false, reason: "upload_failed", day, path: snapshotPath, error: message };
      }

      const manifest: CloudBackupManifest = {
        version: CLOUD_BACKUP_MANIFEST_VERSION,
        day,
        bytes: bytes.length,
        sha256: fileSha,
        contentHash: snapshot.summary.hash,
        tables: Object.values(snapshot.summary.counts).filter((count) => count > 0).length,
        counts: { ...snapshot.summary.counts },
        totalRows: snapshot.summary.totalRows,
        latestSeq: snapshot.summary.latestSeq,
        schemaVersion: snapshot.summary.schemaVersion,
        companyId,
        deviceId,
        createdAt: snapshot.summary.createdAt || at,
        tool
      };
      const manifestPath = cloudManifestPath(companyId, deviceId, day);
      const manifestBytes = utf8(JSON.stringify(manifest));
      const wroteManifest = await withRetry(
        maxAttempts,
        sleep,
        () => transport.upload(manifestPath, manifestBytes, CONTENT_TYPE_MANIFEST),
        (result) => result?.ok === true
      );
      if (wroteManifest.result?.ok !== true) {
        const message = describeError(
          wroteManifest.result?.error,
          "El respaldo subió pero su manifiesto no; se descartó para no dejar un archivo huérfano."
        );
        try {
          await transport.remove([snapshotPath]);
        } catch {
          // Best-effort: la retención lo recogerá cuando el manifiesto no exista.
        }
        patchState({ lastError: message });
        record(Date.now() - startedAt, false);
        return { ok: false, reason: "manifest_failed", day, path: snapshotPath, error: message };
      }

      patchState({
        lastUploadAt: at,
        lastDay: day,
        lastBytes: bytes.length,
        lastSha256: fileSha,
        lastError: null
      });
      record(Date.now() - startedAt, true);

      let removed: string[] = [];
      try {
        const manifests = (await fetchManifests()).map((item) => item.manifest);
        removed = await applyRetention(manifests, at);
      } catch {
        // La retención es bookkeeping: el respaldo ya está a salvo en la nube.
      }

      return {
        ok: true,
        day,
        path: snapshotPath,
        bytes: bytes.length,
        sha256: fileSha,
        ...(removed.length ? { removed } : {})
      };
    } catch (error) {
      const message = describeError(error, "No se pudo completar el respaldo en la nube.");
      try {
        patchState({ lastError: message });
      } catch {
        // Nunca lanzar desde el respaldo.
      }
      record(Date.now() - startedAt, false);
      return { ok: false, reason: "upload_failed", error: message };
    }
  }

  function failureReason(error: unknown): CloudRestoreFailure {
    if (error instanceof BackupError) {
      switch (error.code) {
        case "invalid_passphrase":
        case "decrypt_failed":
          return "wrong_passphrase";
        case "schema_too_new":
          return "schema_too_new";
        case "integrity_failed":
        case "invalid_format":
        case "unsupported_version":
          return "corrupt";
        default:
          return "restore_failed";
      }
    }
    return "restore_failed";
  }

  async function restoreCloudBackup(input: CloudRestoreInput): Promise<CloudRestoreOutcome> {
    const at = safeNow(now);
    const fail = (reason: CloudRestoreFailure, error: string, day?: string): CloudRestoreOutcome => {
      if (companyId) patchState({ lastRestoreAt: at, lastRestoreDay: day ?? null, lastRestoreResult: "failed" });
      return { ok: false, reason, error, ...(day ? { day } : {}) };
    };

    try {
      if (!companyId) return fail("disabled", "Inicia sesión para restaurar desde la nube.");
      const transport = deps.transport;
      if (!transport) return fail("no_transport", "La nube no está configurada en este equipo.");
      if (!input || input.confirm !== true) {
        return fail("confirmation_required", "Confirma la restauración escribiendo RESTAURAR.");
      }
      const day = normalizeCloudDay(input.day);
      if (!day) return fail("invalid_day", "Elige una fecha de respaldo válida.");
      if (!isOnline()) return fail("download_failed", "Sin conexión: no se puede descargar el respaldo.", day);
      if (!passphraseLooksUsable(input.passphrase)) {
        return fail("wrong_passphrase", "Escribe la frase del respaldo (mínimo 8 caracteres).", day);
      }

      const found = await fetchManifests();
      let target = found.find((item) => item.manifest.day === day) ?? null;
      if (!target) {
        // El listado pudo fallar por red. Se intenta el manifiesto exacto para
        // distinguir «no existe» de «no se pudo descargar».
        let direct: { ok: boolean; bytes?: Uint8Array; error?: string } | null = null;
        try {
          direct = await transport.download(cloudManifestPath(companyId, deviceId, day));
        } catch (error) {
          return fail(
            "download_failed",
            describeError(error, "No se pudo leer el manifiesto del respaldo en la nube."),
            day
          );
        }
        if (!direct?.ok || !direct.bytes) {
          const message = direct?.error ?? "";
          if (!message || looksMissingObject(message)) {
            return fail("not_found", `No hay un respaldo de la nube para el ${day}.`, day);
          }
          return fail("download_failed", message, day);
        }
        const parsed = parseCloudManifest(direct.bytes);
        if (!parsed) return fail("corrupt", "El manifiesto del respaldo está dañado.", day);
        target = { manifest: parsed, path: cloudManifestPath(companyId, deviceId, day) };
      }
      const manifest = target.manifest;
      // Antes de descargar: el manifiesto debe ser de ESTA empresa.
      if (manifest.companyId !== companyId) {
        return fail("foreign_company", "Ese respaldo pertenece a otra empresa; no se descargó.", day);
      }

      const downloaded = await transport.download(cloudSnapshotPath(companyId, deviceId, day));
      const bytes = downloaded?.bytes;
      if (!downloaded?.ok || !(bytes instanceof Uint8Array) || bytes.length === 0) {
        return fail(
          "download_failed",
          describeError(downloaded?.error, "No se pudo descargar el respaldo de la nube."),
          day
        );
      }
      if (bytes.length !== manifest.bytes) {
        return fail(
          "size_mismatch",
          `El archivo descargado tiene ${bytes.length} bytes y el manifiesto declara ${manifest.bytes}.`,
          day
        );
      }
      const actualSha = await sha256Hex(bytes);
      if (actualSha !== manifest.sha256) {
        return fail("checksum_mismatch", "El SHA-256 del archivo no coincide con el manifiesto.", day);
      }

      // La frase y el contenido se verifican aquí; nada se escribe todavía.
      let inspected: Awaited<ReturnType<typeof inspectBackup>>;
      try {
        inspected = await inspectBackup({ bytes, passphrase: input.passphrase });
      } catch (error) {
        const reason = failureReason(error);
        const message =
          reason === "wrong_passphrase"
            ? "La frase no coincide con este respaldo."
            : describeError(error, "El respaldo está dañado o es incompatible.");
        return fail(reason, message, day);
      }

      if (inspected.hash !== manifest.contentHash) {
        return fail("corrupt", "El contenido del respaldo no coincide con su manifiesto.", day);
      }
      // Conteos del manifiesto contra lo descifrado, ANTES de aplicar.
      for (const [table, declared] of Object.entries(manifest.counts)) {
        if ((inspected.counts[table] ?? 0) !== declared) {
          return fail(
            "row_count_mismatch",
            `Los conteos no coinciden (${table}: ${inspected.counts[table] ?? 0} ≠ ${declared}). No se escribió nada.`,
            day
          );
        }
      }
      if (inspected.totalRows !== manifest.totalRows) {
        return fail(
          "row_count_mismatch",
          `El total de filas no coincide (${inspected.totalRows} ≠ ${manifest.totalRows}). No se escribió nada.`,
          day
        );
      }

      if (!deps.getDriver) return fail("no_driver", "No hay almacén local donde restaurar.", day);
      let driver: LocalDbDriver;
      try {
        driver = await deps.getDriver();
      } catch {
        return fail("no_driver", "No se pudo abrir el almacén local de este equipo.", day);
      }

      let report: Awaited<ReturnType<typeof restoreBackup>>;
      try {
        report = await restoreBackup({
          bytes,
          passphrase: input.passphrase,
          driver,
          mutation: { origin_device: "restauracion-nube" }
        });
      } catch (error) {
        return fail(failureReason(error), describeError(error, "No se pudo aplicar el respaldo."), day);
      }

      patchState({
        lastRestoreAt: at,
        lastRestoreDay: day,
        lastRestoreResult: "ok",
        lastError: null
      });
      return {
        ok: true,
        day,
        applied: {
          createdAt: report.createdAt,
          totalRows: report.totalRows,
          written: report.written,
          removed: report.removed
        }
      };
    } catch (error) {
      return fail("restore_failed", describeError(error, "No se pudo restaurar desde la nube."));
    }
  }

  return {
    companyId,
    isEnabled: enabled,
    state,
    backupNow,
    listCloudBackups,
    restoreCloudBackup
  };
}

function passphraseLooksUsable(value: unknown): boolean {
  return typeof value === "string" && value.length >= 8 && value.length <= 1024;
}

/** Mensajes con los que Storage avisa de un objeto ausente (no de un corte). */
function looksMissingObject(message: string): boolean {
  return /not.?found|404|no such object|does not exist/i.test(message);
}

/* ------------------------------------------------------------------ */
/* Transporte Supabase (reutiliza el cliente ya autenticado)           */
/* ------------------------------------------------------------------ */

function storageMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.slice(0, 300);
  }
  return fallback;
}

function uploadBody(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Adapta `supabase.storage` al transporte del respaldo. Nunca lanza: los fallos
 * se devuelven como `{ok:false}` para que el ciclo diario decida reintentar.
 */
export function createSupabaseCloudTransport(
  client: SupabaseClient,
  bucket: string = CLOUD_BACKUP_BUCKET
): CloudStorageTransport {
  const from = () => {
    if (!client?.storage || typeof client.storage.from !== "function") {
      throw new Error("El cliente no ofrece almacenamiento.");
    }
    return client.storage.from(bucket);
  };

  return {
    async list(prefix) {
      try {
        const { data, error } = await from().list(prefix, {
          limit: 200,
          sortBy: { column: "name", order: "asc" }
        });
        if (error) return [];
        return (Array.isArray(data) ? data : [])
          .filter((item) => item && typeof item.name === "string" && item.name.length > 0)
          .map((item) => ({
            path: `${prefix}/${item.name}`,
            name: item.name,
            size: Number((item.metadata as { size?: unknown } | null)?.size ?? 0) || undefined,
            updatedAt: (item as { updated_at?: string | null }).updated_at ?? null
          }));
      } catch {
        return [];
      }
    },

    async upload(path, bytes, contentType) {
      try {
        const { error } = await from().upload(path, uploadBody(bytes), {
          upsert: true,
          contentType: contentType ?? CONTENT_TYPE_SNAPSHOT,
          cacheControl: "0"
        });
        return error ? { ok: false, error: storageMessage(error, "No se pudo subir el archivo.") } : { ok: true };
      } catch (error) {
        return { ok: false, error: storageMessage(error, "No se pudo subir el archivo.") };
      }
    },

    async download(path) {
      try {
        const { data, error } = await from().download(path);
        if (error || !data) {
          return { ok: false, error: storageMessage(error, "No se pudo descargar el archivo.") };
        }
        const buffer = await data.arrayBuffer();
        return { ok: true, bytes: new Uint8Array(buffer) };
      } catch (error) {
        return { ok: false, error: storageMessage(error, "No se pudo descargar el archivo.") };
      }
    },

    async remove(paths) {
      try {
        const { error } = await from().remove(paths);
        return error
          ? { ok: false, error: storageMessage(error, "No se pudo borrar el archivo.") }
          : { ok: true, removed: paths };
      } catch (error) {
        return { ok: false, error: storageMessage(error, "No se pudo borrar el archivo.") };
      }
    }
  };
}

/** Retención declarada, para textos de la interfaz. */
export const CLOUD_BACKUP_RETENTION = {
  daily: BACKUP_DAILY_LIMIT,
  weekly: BACKUP_WEEKLY_LIMIT
} as const;
