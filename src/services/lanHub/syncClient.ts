/**
 * Sincronización del PC secundario contra el hub LAN.
 *
 * El hub es el escritor autoritativo de la empresa: aquí solo se leen los
 * cambios del journal (`GET /lan/v1/changes`) y se aplican al almacén
 * normalizado local. La petición se firma con `createHubClient` para no
 * duplicar la criptografía del protocolo.
 *
 * Regla de oro del cursor: se guarda únicamente después de que la transacción
 * local confirma, y nunca retrocede. Un fallo a mitad de página se reintenta
 * desde el mismo `since`, y las escrituras son idempotentes (upsert/borrado).
 */
import { createHubClient } from "./client";
import { HUB_DEFAULT_PAGE_LIMIT, HUB_MAX_PAGE_LIMIT, HUB_ROUTES } from "./protocol";
import { LOCAL_DB_TABLE_NAMES } from "../localDb/schema";
import {
  assertLocalRow,
  type ChangeOp,
  type LocalDbDriver,
  type LocalRow,
  type LocalTable
} from "../localDb/contract";
import type { CursorStore } from "../cloudSync/contract";

/** Tablas internas del hub: un cliente nunca las replica. */
const INTERNAL_TABLES = new Set<string>(["hub_devices", "hub_receipts"]);

/** Tope de páginas por llamada: evita monopolizar la red en un solo tick. */
export const DEFAULT_MAX_SYNC_PAGES = 10;

/** Un cambio del journal del hub, ya normalizado y con la fila vigente. */
export interface HubChange {
  seq: number;
  table: LocalTable;
  row_id: string;
  op: ChangeOp;
  company_id: string;
  updated_at: string;
  origin_device: string;
  /** Fila vigente; obligatoria en upserts y ausente en tombstones. */
  row?: LocalRow;
}

export interface HubChangesPage {
  changes: HubChange[];
  /** Último `seq` que el hub declara cubierto por la página. */
  cursor: number;
  /** Solo presente si el hub lo declaró; si falta se infiere por el tamaño. */
  hasMore?: boolean;
}

export interface FetchHubChangesInput {
  baseUrl: string;
  token: string;
  deviceId: string;
  /** Desde qué `seq` (exclusivo) leer; por defecto 0. */
  since?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
  /** Reloj inyectable para firmar; por defecto `Date.now`. */
  now?: () => number;
  timeoutMs?: number;
}

export interface ApplyHubChangesInput {
  driver: LocalDbDriver;
  companyId: string;
  changes: readonly HubChange[];
}

export interface ApplyHubChangesResult {
  /** Upserts escritos. */
  applied: number;
  /** Tombstones aplicados sobre una fila existente. */
  deleted: number;
  /** Filas descartadas: otra empresa, duplicados exactos o lápidas sin fila. */
  skipped: number;
  /** Filas locales conservadas por ser más nuevas que el cambio entrante. */
  conflicts: number;
  /**
   * Cota superior confirmada de la página (máximo `seq` procesado). Es lo que
   * el cursor puede avanzar como mucho tras esta llamada.
   */
  appliedThrough: number;
}

export interface PullHubChangesInput extends FetchHubChangesInput {
  driver: LocalDbDriver;
  companyId: string;
  /** Mismo contrato que la nube: `load`/`save` por empresa. */
  cursors: CursorStore;
  /** Páginas máximas en esta llamada; por defecto `DEFAULT_MAX_SYNC_PAGES`. */
  maxPages?: number;
}

export interface PullHubChangesResult {
  /** Cursor guardado al terminar (nunca menor que el inicial). */
  cursor: number;
  pages: number;
  applied: number;
  deleted: number;
  skipped: number;
  conflicts: number;
  /** `true` si quedan páginas para una próxima llamada. */
  hasMore: boolean;
}

export type HubSyncErrorCode = "invalid_response" | "invalid_change";

/** Error de datos del hub: siempre indica qué campo falló y nunca el token. */
export class HubSyncError extends Error {
  readonly code: HubSyncErrorCode;

  constructor(code: HubSyncErrorCode, message: string) {
    super(message);
    this.name = "HubSyncError";
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function invalidChange(index: number, reason: string): never {
  throw new HubSyncError(
    "invalid_change",
    `El cambio #${index + 1} del hub LAN no es válido: ${reason}`
  );
}

function cursorValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HubSyncError("invalid_response", "El hub LAN no devolvió un cursor válido");
  }
  return value;
}

/**
 * Valida un cambio del cable y lo normaliza. Se usa tanto al leer la respuesta
 * como al aplicar, porque `applyHubChanges` es una API pública y no debe
 * fiarse de quien la invoque.
 */
function parseChange(raw: unknown, index: number): HubChange {
  const record = asRecord(raw);
  if (!record) invalidChange(index, "no es un objeto");

  const seq = record.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    invalidChange(index, "seq ausente o inválido");
  }

  const tableName = nonEmptyString(record.table);
  if (!tableName || !(LOCAL_DB_TABLE_NAMES as string[]).includes(tableName)) {
    invalidChange(index, `tabla desconocida (${String(record.table)})`);
  }
  const table = tableName as LocalTable;
  if (INTERNAL_TABLES.has(table)) invalidChange(index, `la tabla ${table} es interna del hub`);

  const rowId = nonEmptyString(record.row_id);
  if (!rowId) invalidChange(index, "row_id ausente");

  const op = record.op;
  if (op !== "upsert" && op !== "delete") invalidChange(index, "op desconocida");

  const companyId = nonEmptyString(record.company_id);
  if (!companyId) invalidChange(index, "company_id ausente");

  const updatedAt = nonEmptyString(record.updated_at);
  if (!updatedAt) invalidChange(index, "updated_at ausente");

  if (typeof record.origin_device !== "string") invalidChange(index, "origin_device ausente");

  const change: HubChange = {
    seq: seq as number,
    table,
    row_id: rowId,
    op,
    company_id: companyId,
    updated_at: updatedAt,
    origin_device: record.origin_device
  };

  if (op === "upsert") {
    const rowRecord = asRecord(record.row);
    if (!rowRecord) invalidChange(index, "un upsert llegó sin fila");
    if (rowRecord.id !== rowId) invalidChange(index, "el id de la fila no coincide con row_id");
    if (rowRecord.company_id !== companyId) {
      invalidChange(index, "el company_id de la fila no coincide con el del cambio");
    }
    if (rowRecord.deleted_at !== null && typeof rowRecord.deleted_at !== "string") {
      invalidChange(index, "deleted_at inválido");
    }
    if (typeof rowRecord.origin_device !== "string") invalidChange(index, "origin_device de la fila ausente");
    try {
      assertLocalRow(table, rowRecord);
    } catch (error) {
      invalidChange(index, error instanceof Error ? error.message : "fila inválida");
    }
    change.row = { ...(rowRecord as LocalRow) };
  }

  return change;
}

/** Sobres `{ok, changes, cursor}`; tolera `latestSeq` como alias de cursor. */
function parseEnvelope(payload: unknown): HubChangesPage {
  const record = asRecord(payload);
  if (!record) {
    throw new HubSyncError("invalid_response", "El hub LAN no devolvió un objeto JSON");
  }
  if (record.ok !== undefined && typeof record.ok !== "boolean") {
    throw new HubSyncError("invalid_response", "El hub LAN devolvió un `ok` que no es booleano");
  }
  if (record.ok === false) {
    const code = nonEmptyString(record.error) ?? "desconocido";
    throw new HubSyncError("invalid_response", `El hub LAN rechazó la lectura de cambios (${code})`);
  }
  if (!Array.isArray(record.changes)) {
    throw new HubSyncError("invalid_response", "El hub LAN no incluyó la lista de cambios");
  }
  // `cursor` manda; `latestSeq` solo se acepta como alias del handler v1.
  const cursor = cursorValue(record.cursor !== undefined ? record.cursor : record.latestSeq);
  const changes = record.changes.map((change, index) => parseChange(change, index));

  const page: HubChangesPage = { changes, cursor };
  if (typeof record.hasMore === "boolean") page.hasMore = record.hasMore;
  return page;
}

function integerOption(
  value: number | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} debe ser un número entero`);
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Trae y valida una página de cambios. Cualquier anomalía en el sobre lanza
 * `HubSyncError` y no se escribe nada: el cursor se queda donde estaba.
 */
export async function fetchHubChanges(input: FetchHubChangesInput): Promise<HubChangesPage> {
  if (!input || typeof input !== "object") {
    throw new Error("Faltan los datos para consultar los cambios del hub LAN");
  }
  const since = integerOption(input.since, 0, "since", 0, Number.MAX_SAFE_INTEGER);
  const limit = integerOption(input.limit, HUB_DEFAULT_PAGE_LIMIT, "limit", 1, HUB_MAX_PAGE_LIMIT);

  const client = createHubClient({
    baseUrl: input.baseUrl,
    deviceId: input.deviceId,
    token: input.token,
    fetchImpl: input.fetchImpl,
    now: input.now,
    timeoutMs: input.timeoutMs
  });

  const payload = await client.request<unknown>(
    "GET",
    `${HUB_ROUTES.changes}?since=${since}&limit=${limit}`
  );
  return parseEnvelope(payload);
}

/**
 * Aplica upserts y tombstones en una sola transacción.
 *
 * Solo se usan `tx.get`/`tx.put`/`tx.remove`: llamar a `driver.put` fuera de la
 * transacción rompería la atomicidad y el journal quedaría a medias. Una fila
 * de otra empresa se descarta, y una fila local más nueva gana (conflicto) para
 * que una réplica tardía del hub no pise trabajo de este equipo.
 */
export async function applyHubChanges(
  input: ApplyHubChangesInput
): Promise<ApplyHubChangesResult> {
  if (!input || typeof input !== "object") {
    throw new Error("Faltan los datos para aplicar los cambios del hub LAN");
  }
  const driver = input.driver;
  if (!driver || typeof driver.transaction !== "function") {
    throw new Error("Falta el almacén local para aplicar los cambios del hub LAN");
  }
  const companyId = nonEmptyString(input.companyId);
  if (!companyId) throw new Error("Falta la empresa para aplicar los cambios del hub LAN");
  if (!Array.isArray(input.changes)) {
    throw new Error("Los cambios del hub LAN deben ser una lista");
  }

  // Validación completa antes de abrir la transacción: una página corrupta no
  // deja escrituras parciales ni avanza el cursor.
  const parsed = input.changes.map((change, index) => parseChange(change, index));

  const summary: ApplyHubChangesResult = {
    applied: 0,
    deleted: 0,
    skipped: 0,
    conflicts: 0,
    appliedThrough: 0
  };
  for (const change of parsed) {
    summary.appliedThrough = Math.max(summary.appliedThrough, change.seq);
  }

  await driver.transaction(async (tx) => {
    for (const change of parsed) {
      // Primera defensa multiempresa: un journal ajeno no debe tocar el almacén.
      if (change.company_id !== companyId) {
        summary.skipped += 1;
        continue;
      }

      const local = await tx.get<LocalRow>(change.table, change.row_id);
      // Colisión de id con una fila de otra empresa: no se toca jamás.
      if (local && local.company_id !== companyId) {
        summary.skipped += 1;
        continue;
      }

      if (change.op === "delete") {
        if (!local) {
          // Lápida de una fila que este equipo nunca tuvo: nada que borrar.
          summary.skipped += 1;
          continue;
        }
        if (instant(local.updated_at) > instant(change.updated_at)) {
          summary.conflicts += 1;
          continue;
        }
        await tx.remove(change.table, [change.row_id], {
          company_id: companyId,
          origin_device: change.origin_device,
          at: change.updated_at
        });
        summary.deleted += 1;
        continue;
      }

      const row = change.row as LocalRow;
      if (local) {
        // La versión local manda: last-writer-wins controlado por `version`.
        if (local.version > row.version) {
          summary.conflicts += 1;
          continue;
        }
        if (
          local.version === row.version &&
          instant(local.updated_at) > instant(row.updated_at)
        ) {
          summary.conflicts += 1;
          continue;
        }
        // Misma versión e instante: es la misma fila y reescribirla solo
        // ensuciaría el journal local.
        if (local.version === row.version && instant(local.updated_at) === instant(row.updated_at)) {
          summary.skipped += 1;
          continue;
        }
      }

      await tx.put(change.table, [row]);
      summary.applied += 1;
    }
  });

  return { ...summary };
}

function nextCursor(current: number, page: HubChangesPage, appliedThrough: number): number {
  if (appliedThrough > current) return appliedThrough;
  // Página vacía: el hub confirmó que no queda nada por encima del cursor.
  if (page.changes.length === 0 && page.cursor > current) return page.cursor;
  return current;
}

async function loadCursor(cursors: CursorStore, companyId: string): Promise<number> {
  const stored = await cursors.load(companyId);
  return typeof stored === "number" && Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
}

/**
 * Recorre páginas hasta agotar el journal o alcanzar el tope.
 *
 * El cursor se persiste tras cada página confirmada, así un corte de red en la
 * página N no obliga a repetir las anteriores.
 */
export async function pullHubChanges(
  input: PullHubChangesInput
): Promise<PullHubChangesResult> {
  if (!input || typeof input !== "object") {
    throw new Error("Faltan los datos para sincronizar con el hub LAN");
  }
  const companyId = nonEmptyString(input.companyId);
  if (!companyId) throw new Error("Falta la empresa para sincronizar con el hub LAN");
  if (!input.driver || typeof input.driver.transaction !== "function") {
    throw new Error("Falta el almacén local para sincronizar con el hub LAN");
  }
  const cursors = input.cursors;
  if (!cursors || typeof cursors.load !== "function" || typeof cursors.save !== "function") {
    throw new Error("Falta el almacén de cursores del hub LAN");
  }

  const limit = integerOption(input.limit, HUB_DEFAULT_PAGE_LIMIT, "limit", 1, HUB_MAX_PAGE_LIMIT);
  const maxPages = integerOption(input.maxPages, DEFAULT_MAX_SYNC_PAGES, "maxPages", 1, 1000);

  let cursor = await loadCursor(cursors, companyId);
  const result: PullHubChangesResult = {
    cursor,
    pages: 0,
    applied: 0,
    deleted: 0,
    skipped: 0,
    conflicts: 0,
    hasMore: false
  };

  while (result.pages < maxPages) {
    const page = await fetchHubChanges({
      baseUrl: input.baseUrl,
      token: input.token,
      deviceId: input.deviceId,
      since: cursor,
      limit,
      fetchImpl: input.fetchImpl,
      now: input.now,
      timeoutMs: input.timeoutMs
    });
    result.pages += 1;

    const outcome = await applyHubChanges({
      driver: input.driver,
      companyId,
      changes: page.changes
    });
    result.applied += outcome.applied;
    result.deleted += outcome.deleted;
    result.skipped += outcome.skipped;
    result.conflicts += outcome.conflicts;

    // Solo se avanza hasta lo que la transacción acaba de confirmar.
    const next = nextCursor(cursor, page, outcome.appliedThrough);
    const advanced = next > cursor;
    if (advanced) {
      await cursors.save(companyId, next);
      cursor = next;
      result.cursor = cursor;
    }

    result.hasMore =
      page.hasMore === true || (page.hasMore === undefined && page.changes.length >= limit);
    if (!result.hasMore) break;
    // Sin avance, repetir la misma página sería un bucle: se corta y se avisa.
    if (!advanced) break;
  }

  return result;
}
