/**
 * Informe de diagnóstico de la app de escritorio.
 *
 * Es puro: recibe una instantánea (aunque llegue incompleta, nula o corrupta)
 * y devuelve datos saneados listos para mostrar o copiar. Nunca incluye rutas
 * completas, códigos de emparejamiento, IDs de empresa ni tokens: este texto
 * viaja por chat o correo hasta soporte, fuera del control del negocio.
 */
import {
  DESKTOP_UPDATE_STATUS_LABELS,
  type DesktopUpdateStatus
} from "./desktopUpdate";

export type DesktopDbReport = {
  ready: boolean;
  driver: "sqljs" | "unavailable";
  schemaVersion: number;
  sizeMb: number;
  file: string;
  lastWriteAt: string;
  error: string;
};

export type DesktopHubReport = {
  enabled: boolean;
  running: boolean;
  address: string;
  pairingActive: boolean;
  pairingExpiresAt: string;
  error: string;
};

export type DesktopUpdaterReport = {
  status: DesktopUpdateStatus;
  currentVersion: string;
  version: string;
  percent: number;
  message: string;
  error: string;
  updatedAt: string;
};

export type DesktopReport = {
  appVersion: string;
  generatedAt: string;
  db: DesktopDbReport;
  hub: DesktopHubReport;
  updater: DesktopUpdaterReport;
};

export type DesktopReportInput = {
  appVersion?: unknown;
  generatedAt?: unknown;
  db?: unknown;
  hub?: unknown;
  updater?: unknown;
};

const MAX_DETAIL = 300;
const MAX_VERSION = 40;
const MAX_HOST = 120;
const MAX_FILE = 120;
const DASH = "—";
const BYTES_PER_MB = 1024 * 1024;

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function readText(value: unknown, max = MAX_DETAIL): string {
  if (typeof value !== "string") return "";
  return value.replace(/^["']|["']$/g, "").trim().slice(0, max);
}

function readPositiveInt(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** ISO a partir de epoch ms o de una fecha ya formateada; '' si no es válida. */
function isoFrom(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

const TRAILING_PUNCTUATION = /[.,;:)\]}>"'`]+$/;

/**
 * Solo el nombre del archivo. Se usa tanto para `db.file` como para el texto
 * del portapapeles, así que jamás puede devolver un tramo con separadores.
 */
export function desktopFileBasename(filePath: unknown, max = MAX_FILE): string {
  const raw = readText(filePath, 500);
  if (!raw) return "";
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  const last = segments.length ? segments[segments.length - 1] : "";
  return last.replace(TRAILING_PUNCTUATION, "").trim().slice(0, max);
}

// Los textos de error del sistema suelen traer la ruta completa del archivo.
// En un informe que sale del negocio se sustituye por un marcador neutro.
const WINDOWS_PATH = /[A-Za-z]:\\[^\r\n"'<>|]*/g;
const POSIX_PATH = /\/(?:Users|home|root|var|tmp|opt|usr|private|etc)\/[^\r\n"'<>|]*/g;
const FILE_URL = /file:\/\/[^\s"'<>]+/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;

function scrubText(value: unknown, max = MAX_DETAIL): string {
  const raw = readText(value, max * 4);
  if (!raw) return "";
  const scrubbed = raw
    .replace(FILE_URL, "[ruta]")
    .replace(WINDOWS_PATH, "[ruta]")
    .replace(POSIX_PATH, "[ruta]")
    .replace(UUID, "[id]")
    .replace(LONG_TOKEN, "[redactado]");
  return scrubbed.slice(0, max);
}

function isUpdateStatus(value: string): value is DesktopUpdateStatus {
  return Object.prototype.hasOwnProperty.call(DESKTOP_UPDATE_STATUS_LABELS, value);
}

function readUpdaterStatus(value: unknown): DesktopUpdateStatus {
  const raw = readText(value, MAX_VERSION);
  return isUpdateStatus(raw) ? raw : "idle";
}

function readAddress(hostValue: unknown, portValue: unknown): string {
  const rawHost = readText(hostValue, MAX_HOST);
  if (!rawHost) return "";
  const host = rawHost
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split("/")[0]
    .trim();
  if (!host) return "";
  const port = Math.min(65535, readPositiveInt(portValue));
  return port > 0 ? `${host}:${port}` : "";
}

function buildDb(rawValue: unknown): DesktopDbReport {
  const raw = asRecord(rawValue);
  const ready = raw?.ready === true;
  const sizeBytes = readPositiveInt(raw?.sizeBytes);
  const schemaVersion = readPositiveInt(raw?.schemaVersion);
  return {
    ready,
    driver: raw?.driver === "sqljs" ? "sqljs" : "unavailable",
    schemaVersion,
    sizeMb: Math.round((sizeBytes / BYTES_PER_MB) * 10) / 10,
    file: desktopFileBasename(raw?.filePath ?? raw?.file),
    lastWriteAt: isoFrom(raw?.lastWriteAt),
    error: scrubText(raw?.lastError ?? raw?.error)
  };
}

function buildHub(rawValue: unknown, generatedAtMs: number): DesktopHubReport {
  const raw = asRecord(rawValue);
  const running = raw?.running === true;
  const pairingCode = readText(raw?.pairingCode, MAX_VERSION);
  const pairingExpiresAt = isoFrom(raw?.pairingExpiresAt);
  const expiresMs = pairingExpiresAt ? Date.parse(pairingExpiresAt) : Number.NaN;
  return {
    enabled: raw?.enabled === true,
    running,
    address: readAddress(raw?.host, raw?.port),
    // Un código sin caducidad conocida no se considera vigente.
    pairingActive:
      generatedAtMs > 0 &&
      running &&
      Boolean(pairingCode) &&
      Number.isFinite(expiresMs) &&
      expiresMs > generatedAtMs,
    pairingExpiresAt,
    error: scrubText(raw?.lastError ?? raw?.error)
  };
}

function buildUpdater(rawValue: unknown): DesktopUpdaterReport {
  const raw = asRecord(rawValue);
  return {
    status: readUpdaterStatus(raw?.status),
    currentVersion: readText(raw?.currentVersion, MAX_VERSION),
    version: readText(raw?.version, MAX_VERSION),
    percent: Math.min(100, readPositiveInt(raw?.percent)),
    message: scrubText(raw?.message),
    error: scrubText(raw?.error),
    updatedAt: isoFrom(raw?.updatedAt)
  };
}

export function buildDesktopReport(input?: DesktopReportInput | null): DesktopReport {
  const source = asRecord(input) ?? {};
  const generatedAt = isoFrom(source.generatedAt);
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : 0;
  return {
    appVersion: readText(source.appVersion, MAX_VERSION),
    generatedAt,
    db: buildDb(source.db),
    hub: buildHub(source.hub, generatedAtMs),
    updater: buildUpdater(source.updater)
  };
}

function formatMoment(iso: unknown): string {
  const normalized = isoFrom(iso);
  if (!normalized) return DASH;
  const date = new Date(normalized);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function formatSize(ready: boolean, sizeMb: unknown): string {
  const parsed = Number(sizeMb);
  if (!Number.isFinite(parsed)) return DASH;
  if (!ready && parsed <= 0) return DASH;
  return `${Math.max(0, parsed).toFixed(1)} MB`;
}

function formatHubState(hub: RawRecord): string {
  if (hub.running === true) return "Activa";
  return hub.enabled === true ? "Inactiva (desactivada)" : "Inactiva";
}

/** Texto plano en español, listo para pegar en un chat de soporte. */
export function formatReportForClipboard(
  report?: DesktopReport | null
): string {
  const source = asRecord(report) ?? {};
  const db = asRecord(source.db) ?? {};
  const hub = asRecord(source.hub) ?? {};
  const updater = asRecord(source.updater) ?? {};

  const appVersion = readText(source.appVersion, MAX_VERSION) || DASH;
  const dbReady = db.ready === true;
  const schemaVersion = readPositiveInt(db.schemaVersion);
  const updaterStatus = readUpdaterStatus(updater.status);
  const percent = Math.min(100, readPositiveInt(updater.percent));

  const lines = [
    "PALMYRA · diagnóstico",
    `Versión: ${appVersion}`,
    `Fecha: ${formatMoment(source.generatedAt)}`,
    "",
    "BASE LOCAL",
    `  Estado: ${dbReady ? "Listo" : "No disponible"}`,
    `  Motor: ${db.driver === "sqljs" ? "SQLite (sql.js)" : "No disponible"}`,
    `  Tamaño: ${formatSize(dbReady, db.sizeMb)}`,
    `  Esquema: ${dbReady && schemaVersion > 0 ? `v${schemaVersion}` : DASH}`,
    `  Archivo: ${desktopFileBasename(db.file) || DASH}`,
    `  Última escritura: ${formatMoment(db.lastWriteAt)}`,
    `  Último error: ${scrubText(db.error) || DASH}`,
    "",
    "RED LOCAL",
    `  Estado: ${formatHubState(hub)}`,
    `  Dirección: ${scrubText(hub.address, MAX_HOST) || DASH}`,
    `  Emparejamiento: ${
      hub.pairingActive === true
        ? `vigente hasta ${formatMoment(hub.pairingExpiresAt)}`
        : "sin código vigente"
    }`,
    `  Último error: ${scrubText(hub.error) || DASH}`,
    "",
    "ACTUALIZADOR",
    `  Estado: ${DESKTOP_UPDATE_STATUS_LABELS[updaterStatus]}`,
    `  Versión actual: ${readText(updater.currentVersion, MAX_VERSION) || DASH}`,
    `  Versión nueva: ${readText(updater.version, MAX_VERSION) || DASH}`,
    `  Progreso: ${percent} %`,
    `  Mensaje: ${scrubText(updater.message) || DASH}`,
    `  Último error: ${scrubText(updater.error) || DASH}`,
    `  Actualizado: ${formatMoment(updater.updatedAt)}`
  ];

  return lines.join("\n");
}
