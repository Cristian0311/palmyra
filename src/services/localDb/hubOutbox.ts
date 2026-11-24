/**
 * Bandeja de salida hacia el hub LAN.
 *
 * La ruta caliente escribe directo en el almacén local (una transacción por
 * venta o movimiento de caja). Este módulo convierte el journal de cambios en
 * lotes de operaciones idempotentes para el hub: se lee con un cursor, se
 * agrupa por tabla y cada operación conserva un `actionId` determinista que
 * jamás se regenera. Reenviar el mismo lote es seguro porque el hub deduplica
 * por `actionId` y responde `duplicate`, que también es éxito.
 *
 * Decisiones:
 * - Un `upsert` genera una operación por fila con el estado actual; si la fila
 *   cambió varias veces en la ventana, se envía solo la última versión.
 * - Los borrados se agrupan por tabla (una operación por tabla), con los ids
 *   ordenados para que el lote sea reproducible byte a byte.
 * - Si una fila se creó y luego se borró dentro de la ventana, solo viaja el
 *   borrado; si se borró y se volvió a crear, solo viaja el alta.
 * - El cursor se guarda solo cuando el hub acusa el lote (`saveCursor`), de
 *   modo que un fallo de red se reintenta con los mismos `actionId`.
 */
import type { ChangeRecord, LocalDbDriver, LocalRow, LocalTable } from "./contract";
import type { HubOperation } from "../lanHub/opsClient";

/** Cursor persistible; cualquier almacén (memoria, IndexedDB, SQLite) sirve. */
export interface HubOutboxCursorStore {
  loadCursor(): Promise<number>;
  saveCursor(seq: number): Promise<void>;
}

export interface HubOutboxOptions {
  /** Equipo que propone las operaciones; forma parte del `actionId`. */
  deviceId: string;
  /** Cursor persistible; si falta se usa uno en memoria. */
  cursor?: HubOutboxCursorStore;
  /** Filtro opcional por empresa del almacén local. */
  companyId?: string;
  /**
   * Si se indica, solo se proponen cambios escritos por este equipo. Evita
   * devolver al hub filas que acaban de llegar por el pull: en tablas de solo
   * anexado esa eco sería un `append_only` y congelaría el cursor.
   */
  originDevice?: string;
  /** Tamaño de página por defecto (1…1000). */
  limit?: number;
}

export interface HubOutboxBatch {
  ops: HubOperation[];
  /** Secuencia desde la que debe continuar la próxima lectura. */
  nextSeq: number;
}

export interface HubOutbox {
  /**
   * Arma el siguiente lote. Sin argumentos parte del cursor guardado y no lo
   * mueve: el llamador confirma con `saveCursor(nextSeq)` cuando el hub acuse.
   */
  collect(sinceSeq?: number, limit?: number): Promise<HubOutboxBatch>;
  loadCursor(): Promise<number>;
  saveCursor(seq: number): Promise<void>;
}

export const HUB_OUTBOX_DEFAULT_LIMIT = 200;
export const HUB_OUTBOX_MAX_LIMIT = 1000;

/** Distingue operaciones del mismo lote sin depender del orden de llegada. */
const DELETE_SEGMENT = "deleted";

/**
 * `actionId` determinista. No se recorta ni se regenera: el mismo
 * (equipo, tabla, fila, secuencia) produce siempre la misma cadena.
 */
export function operationActionId(
  deviceId: string,
  table: LocalTable,
  rowId: string,
  seq: number
): string {
  return `${deviceId}:${table}:${rowId}:${seq}`;
}

/** `actionId` de un grupo de borrados: se ancla a la primera secuencia. */
export function deleteGroupActionId(deviceId: string, table: LocalTable, firstSeq: number): string {
  return `${deviceId}:${table}:${DELETE_SEGMENT}:${firstSeq}`;
}

export function createMemoryCursorStore(initial = 0): HubOutboxCursorStore {
  let current = Number.isFinite(initial) && initial > 0 ? Math.floor(initial) : 0;
  return {
    async loadCursor() {
      return current;
    },
    async saveCursor(seq) {
      const next = Number.isFinite(seq) ? Math.floor(seq) : current;
      // El cursor nunca retrocede: repetir un lote no debe reabrir la ventana.
      if (next > current) current = next;
    }
  };
}

function clampLimit(value: number | undefined, fallback: number): number {
  const base = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.min(HUB_OUTBOX_MAX_LIMIT, Math.max(1, base));
}

function normalizeSeq(value: number | undefined): number | null {
  if (value === undefined || value === null) return null;
  const seq = Number(value);
  if (!Number.isFinite(seq) || seq < 0) return null;
  return Math.floor(seq);
}

interface PendingUpsert {
  table: LocalTable;
  rowId: string;
  seq: number;
}

interface PendingDeletes {
  table: LocalTable;
  ids: Set<string>;
  firstSeq: number;
  lastSeq: number;
}

/** Estado final de una fila dentro de la ventana leída. */
interface FinalState {
  table: LocalTable;
  rowId: string;
  seq: number;
  deleted: boolean;
}

export function createHubOutbox(driver: LocalDbDriver, options: HubOutboxOptions): HubOutbox {
  const deviceId = typeof options?.deviceId === "string" ? options.deviceId.trim() : "";
  if (!deviceId) throw new Error("El outbox del hub necesita un deviceId");
  const store = options.cursor ?? createMemoryCursorStore();
  const defaultLimit = clampLimit(options.limit, HUB_OUTBOX_DEFAULT_LIMIT);
  const companyId = typeof options.companyId === "string" ? options.companyId.trim() : "";
  const originDevice = typeof options.originDevice === "string" ? options.originDevice.trim() : "";

  async function collect(sinceSeq?: number, limit?: number): Promise<HubOutboxBatch> {
    const requested = normalizeSeq(sinceSeq);
    const from = requested === null ? await store.loadCursor() : requested;
    const pageSize = clampLimit(limit, defaultLimit);
    const changes = await driver.changes(from, pageSize);
    return buildBatch(changes, from);
  }

  async function buildBatch(changes: ChangeRecord[], from: number): Promise<HubOutboxBatch> {
    // Estado final por fila: la última operación de la ventana gana.
    const finalState = new Map<string, FinalState>();
    let nextSeq = from;

    for (const change of changes) {
      nextSeq = Math.max(nextSeq, change.seq);
      if (companyId && change.company_id !== companyId) continue;
      if (originDevice && change.origin_device !== originDevice) continue;
      const key = change.table + "\u0000" + change.row_id;
      finalState.set(key, {
        table: change.table,
        rowId: change.row_id,
        seq: change.seq,
        deleted: change.op === "delete"
      });
    }

    const upserts: PendingUpsert[] = [];
    const deletes = new Map<string, PendingDeletes>();

    for (const state of finalState.values()) {
      if (state.deleted) {
        const bucketKey = state.table;
        let group = deletes.get(bucketKey);
        if (!group) {
          group = { table: state.table, ids: new Set<string>(), firstSeq: state.seq, lastSeq: state.seq };
          deletes.set(bucketKey, group);
        }
        group.ids.add(state.rowId);
        group.firstSeq = Math.min(group.firstSeq, state.seq);
        group.lastSeq = Math.max(group.lastSeq, state.seq);
        continue;
      }
      upserts.push(state);
    }

    // Orden estable: primero por secuencia, luego por tabla e id.
    const sortedUpserts = upserts.slice().sort((a, b) =>
      a.seq !== b.seq
        ? a.seq - b.seq
        : a.table !== b.table
          ? a.table.localeCompare(b.table)
          : a.rowId.localeCompare(b.rowId)
    );

    const ops: HubOperation[] = [];
    for (const pending of sortedUpserts) {
      const row = await driver.get<LocalRow>(pending.table, pending.rowId);
      if (!row) {
        // La fila desapareció sin cambio de borrado en la ventana: se propone
        // borrarla para que el hub converja al mismo estado.
        const bucketKey = pending.table;
        let group = deletes.get(bucketKey);
        if (!group) {
          group = { table: pending.table, ids: new Set<string>(), firstSeq: pending.seq, lastSeq: pending.seq };
          deletes.set(bucketKey, group);
        }
        group.ids.add(pending.rowId);
        group.firstSeq = Math.min(group.firstSeq, pending.seq);
        group.lastSeq = Math.max(group.lastSeq, pending.seq);
        continue;
      }
      ops.push({
        actionId: operationActionId(deviceId, pending.table, pending.rowId, pending.seq),
        table: pending.table,
        rows: [row],
        deletes: []
      });
    }

    const sortedDeletes = Array.from(deletes.values()).sort((a, b) =>
      a.firstSeq !== b.firstSeq ? a.firstSeq - b.firstSeq : a.table.localeCompare(b.table)
    );
    for (const group of sortedDeletes) {
      if (group.ids.size === 0) continue;
      ops.push({
        actionId: deleteGroupActionId(deviceId, group.table, group.firstSeq),
        table: group.table,
        rows: [],
        deletes: Array.from(group.ids).sort((a, b) => a.localeCompare(b))
      });
      nextSeq = Math.max(nextSeq, group.lastSeq);
    }

    return { ops, nextSeq };
  }

  return {
    collect,
    loadCursor: () => store.loadCursor(),
    saveCursor: (seq: number) => store.saveCursor(seq)
  };
}
