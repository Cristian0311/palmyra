/**
 * Resistencia de un equipo emparejado a la caída del hub LAN.
 *
 * El hub es el único escritor del negocio, pero un punto de venta no puede
 * dejar de vender porque el hub esté apagado: durante 72 h se sigue operando en
 * local y las operaciones esperan en el outbox. Pasado ese plazo el equipo pasa
 * a modo solo lectura (se puede consultar y exportar, no escribir) para que la
 * divergencia con el hub no crezca sin límite.
 *
 * Estado mínimo persistido (`palmyra_hub_resilience_v1`):
 * - `lastContactAt`: última vez que el hub respondió algo (push o pull).
 * - `lastSuccessAt`: último acuse correcto del hub.
 * - `lastFailureAt`: último fallo de red observado.
 *
 * El plazo se mide siempre desde `lastContactAt`, nunca desde el arranque: un
 * equipo que nunca habló con el hub (recién emparejado, restaurado de un
 * respaldo parcial) no queda bloqueado por falta de historial.
 *
 * `buildReadOnlyExport` es la salida de emergencia del modo solo lectura: un
 * volcado JSON de las tablas de negocio de la empresa, sin filas internas del
 * hub ni secretos.
 */
import type { LocalDbDriver, LocalRow, LocalTable } from "../localDb/contract";
import { LOCAL_DB_TABLE_NAMES } from "../localDb/schema";

/** Plazo máximo operando sin contacto con el hub. */
export const HUB_OFFLINE_LIMIT_MS = 72 * 60 * 60 * 1000;

/** Un contacto más reciente que esto se considera "en línea" para la UI. */
export const HUB_CONTACT_FRESH_MS = 2 * 60 * 1000;

export const HUB_RESILIENCE_KEY = "palmyra_hub_resilience_v1";

/** Almacén mínimo de clave/valor; sirve `localStorage` adaptado o uno en memoria. */
export interface HubResilienceStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export type HubResilienceMode = "online" | "offline_ok" | "read_only";

export interface HubResilienceState {
  mode: HubResilienceMode;
  /** Último contacto confirmado; null si nunca hubo. */
  lastContactAt: number | null;
  /** Tiempo transcurrido desde ese contacto (0 si no hay historial). */
  offlineMs: number;
  /** Margen restante antes de solo lectura (el plazo completo sin historial). */
  remainingMs: number;
  limitMs: number;
}

export interface HubWriteGate {
  allowed: boolean;
  reason: "ok" | "offline_limit";
}

interface ResilienceRecord {
  lastContactAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

function emptyRecord(): ResilienceRecord {
  return { lastContactAt: null, lastSuccessAt: null, lastFailureAt: null };
}

/* ------------------------------------------------------------------ */
/* Almacén                                                             */
/* ------------------------------------------------------------------ */

let explicitStore: HubResilienceStore | null = null;
let browserStoreCache: HubResilienceStore | null = null;
let browserStoreResolved = false;
/** Respaldo en memoria: el estado nunca se pierde dentro de la ejecución. */
let memory: ResilienceRecord = emptyRecord();

function createBrowserStore(): HubResilienceStore | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return null;
    // Se comprueba una lectura real: en modo privado la propiedad existe pero
    // cualquier acceso lanza.
    storage.getItem(HUB_RESILIENCE_KEY);
    return {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      delete: (key) => storage.removeItem(key)
    };
  } catch {
    return null;
  }
}

function activeStore(): HubResilienceStore | null {
  if (explicitStore) return explicitStore;
  if (!browserStoreResolved) {
    browserStoreCache = createBrowserStore();
    browserStoreResolved = true;
  }
  return browserStoreCache;
}

/** Almacén volátil para pruebas y como respaldo en entornos sin `localStorage`. */
export function createMemoryResilienceStore(): HubResilienceStore {
  const data = new Map<string, string>();
  return {
    get(key: string): string | null {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    set(key: string, value: string): void {
      data.set(key, value);
    },
    delete(key: string): void {
      data.delete(key);
    }
  };
}

/**
 * Sustituye el almacén (pruebas o un adaptador futuro). `null` vuelve al
 * `localStorage` del navegador. Limpia la copia en memoria para no mezclar
 * estados de almacenes distintos.
 */
export function configureHubResilienceStore(store: HubResilienceStore | null): void {
  explicitStore = store;
  memory = emptyRecord();
}

/** Deja el módulo como recién importado, conservando el almacén configurado. */
export function resetHubResilienceForTests(): void {
  memory = emptyRecord();
  const store = activeStore();
  if (!store) return;
  try {
    store.delete(HUB_RESILIENCE_KEY);
  } catch {
    // Un almacén roto no puede impedir el reinicio del estado en memoria.
  }
}

/* ------------------------------------------------------------------ */
/* Persistencia                                                        */
/* ------------------------------------------------------------------ */

function stamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function sanitizeRecord(raw: unknown): ResilienceRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Partial<ResilienceRecord>;
  return {
    lastContactAt: stamp(candidate.lastContactAt),
    lastSuccessAt: stamp(candidate.lastSuccessAt),
    lastFailureAt: stamp(candidate.lastFailureAt)
  };
}

function readRecord(): ResilienceRecord {
  const store = activeStore();
  if (!store) return { ...memory };
  let raw: string | null = null;
  try {
    raw = store.get(HUB_RESILIENCE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return { ...memory };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const record = sanitizeRecord(parsed);
  if (!record) return { ...memory };
  memory = { ...record };
  return record;
}

function writeRecord(next: ResilienceRecord): void {
  memory = { ...next };
  const store = activeStore();
  if (!store) return;
  try {
    store.set(HUB_RESILIENCE_KEY, JSON.stringify(memory));
  } catch {
    // Cuota o modo privado: la copia en memoria mantiene el estado en curso.
  }
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

/**
 * Anota un contacto correcto con el hub. Se llama en cada push y pull que el
 * hub acuse; también reinicia el plazo de 72 h.
 */
export function recordHubContact(at?: number): void {
  const now = stamp(at) ?? Date.now();
  const current = readRecord();
  writeRecord({
    // Monótono: un reloj que retrocede no puede "rejuvenecer" el contacto.
    lastContactAt: current.lastContactAt === null ? now : Math.max(current.lastContactAt, now),
    lastSuccessAt: now,
    lastFailureAt: current.lastFailureAt
  });
}

/**
 * Anota un fallo de red. No mueve `lastContactAt`: el plazo se mide desde el
 * último contacto real, no desde el último intento.
 */
export function markHubUnreachable(at?: number): void {
  const now = stamp(at) ?? Date.now();
  const current = readRecord();
  writeRecord({
    lastContactAt: current.lastContactAt,
    lastSuccessAt: current.lastSuccessAt,
    lastFailureAt: current.lastFailureAt === null ? now : Math.max(current.lastFailureAt, now)
  });
}

function clampElapsed(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** Estado actual del enlace con el hub, listo para pintar en la UI. */
export function getHubResilienceState(now?: number): HubResilienceState {
  const at = stamp(now) ?? Date.now();
  const record = readRecord();
  if (record.lastContactAt === null) {
    // Sin historial no hay nada que vencer: un equipo recién emparejado nunca
    // arranca en solo lectura.
    return {
      mode: "offline_ok",
      lastContactAt: null,
      offlineMs: 0,
      remainingMs: HUB_OFFLINE_LIMIT_MS,
      limitMs: HUB_OFFLINE_LIMIT_MS
    };
  }
  const offlineMs = clampElapsed(at - record.lastContactAt);
  const remainingMs = Math.max(0, HUB_OFFLINE_LIMIT_MS - offlineMs);
  const failedSinceContact =
    record.lastFailureAt !== null && record.lastFailureAt > record.lastContactAt;
  const mode: HubResilienceMode =
    offlineMs >= HUB_OFFLINE_LIMIT_MS
      ? "read_only"
      : failedSinceContact || offlineMs > HUB_CONTACT_FRESH_MS
        ? "offline_ok"
        : "online";
  return { mode, lastContactAt: record.lastContactAt, offlineMs, remainingMs, limitMs: HUB_OFFLINE_LIMIT_MS };
}

/** Puerta única de escritura hacia el hub. A las 72 h exactas ya cierra. */
export function canWriteToHub(now?: number): HubWriteGate {
  const state = getHubResilienceState(now);
  return state.mode === "read_only"
    ? { allowed: false, reason: "offline_limit" }
    : { allowed: true, reason: "ok" };
}

/* ------------------------------------------------------------------ */
/* Exportación de solo lectura                                         */
/* ------------------------------------------------------------------ */

export const HUB_READONLY_EXPORT_FORMAT = "palmyra-readonly-export-v1";

/** Tablas internas del hub y la bandeja: nunca salen en una exportación. */
const EXPORT_EXCLUDED_TABLES = new Set<string>(["hub_devices", "hub_receipts", "outbox"]);

/** Página de lectura: baja a propósito para servir a cualquier driver. */
const EXPORT_PAGE_SIZE = 200;
/** Techo de páginas (400 000 filas) para no girar sin fin en un driver roto. */
const EXPORT_MAX_PAGES = 2_000;

export interface HubReadOnlyExportOptions {
  companyId: string;
  /** Subconjunto de tablas; por defecto todas las de negocio. */
  tables?: LocalTable[];
}

export interface HubReadOnlyExport {
  format: typeof HUB_READONLY_EXPORT_FORMAT;
  createdAt: string;
  companyId: string;
  counts: Record<string, number>;
  rows: Record<string, LocalRow[]>;
}

function exportTables(requested?: LocalTable[]): LocalTable[] {
  const known = new Set<string>(LOCAL_DB_TABLE_NAMES);
  const base: LocalTable[] =
    Array.isArray(requested) && requested.length > 0
      ? requested.filter((table) => known.has(table))
      : LOCAL_DB_TABLE_NAMES;
  const seen = new Set<string>();
  const result: LocalTable[] = [];
  for (const table of base) {
    if (EXPORT_EXCLUDED_TABLES.has(table) || seen.has(table)) continue;
    seen.add(table);
    result.push(table);
  }
  return result;
}

/**
 * Lee una tabla completa de la empresa, incluidas las filas borradas (un
 * respaldo sin lápidas no permite restaurar el estado real).
 *
 * El contrato no garantiza que un driver respete un `limit` grande, así que se
 * pagina por `id` ascendente con `offset` hasta que una página llega vacía (el
 * final de la tabla no se deduce del tamaño de la página: un driver puede
 * recortarla). Si el driver ignorase el offset, el último id de la página se
 * repite y la lectura corta en lugar de dar vueltas.
 */
async function readCompanyTable(
  driver: LocalDbDriver,
  table: LocalTable,
  companyId: string
): Promise<LocalRow[]> {
  const rows: LocalRow[] = [];
  let previousLastId = "";
  for (let pageIndex = 0; pageIndex < EXPORT_MAX_PAGES; pageIndex += 1) {
    const page = await driver.query<LocalRow>({
      table,
      where: [{ field: "company_id", op: "eq", value: companyId }],
      orderBy: { field: "id", direction: "asc" },
      limit: EXPORT_PAGE_SIZE,
      offset: rows.length,
      includeDeleted: true
    });
    if (page.length === 0) break;
    for (const row of page) rows.push({ ...row });
    const lastId = page[page.length - 1]?.id ?? "";
    if (lastId === previousLastId) break;
    previousLastId = lastId;
  }
  return rows;
}

/**
 * Volcado JSON de la empresa para seguir trabajando cuando el equipo está en
 * solo lectura. No incluye equipos emparejados (tokens), recibos del hub ni la
 * bandeja de salida.
 */
export async function buildReadOnlyExport(
  driver: LocalDbDriver,
  options: HubReadOnlyExportOptions
): Promise<HubReadOnlyExport> {
  const companyId = typeof options?.companyId === "string" ? options.companyId.trim() : "";
  if (!companyId) throw new Error("La exportación de solo lectura necesita una empresa");
  await driver.ready();

  const rows: Record<string, LocalRow[]> = {};
  const counts: Record<string, number> = {};
  for (const table of exportTables(options.tables)) {
    const tableRows = await readCompanyTable(driver, table, companyId);
    rows[table] = tableRows;
    counts[table] = tableRows.length;
  }

  return {
    format: HUB_READONLY_EXPORT_FORMAT,
    createdAt: new Date().toISOString(),
    companyId,
    counts,
    rows
  };
}
