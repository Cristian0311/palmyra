/**
 * Contrato de sincronización por cursores con la nube.
 *
 * El almacén local (localDb) es la fuente de verdad del dispositivo. La nube
 * solo recibe los cambios posteriores al último cursor confirmado, en lotes
 * pequeños y con presupuesto de solicitudes: nunca se reenvía el historial
 * completo en cada arranque.
 */
import type { LocalRow, LocalTable } from "../localDb/contract";

export type CloudOp = "upsert" | "delete";

/** Un cambio listo para viajar: la fila es la versión actual del almacén. */
export interface CloudChange {
  /** `seq` del journal local que originó el cambio. */
  seq: number;
  table: LocalTable;
  rowId: string;
  op: CloudOp;
  /** Fila vigente para upserts (incluye `deleted_at`). Ausente en deletes. */
  row?: LocalRow;
  /** Marca de borrado; permite al servidor ordenar tombstones. */
  deletedAt?: string | null;
}

/**
 * Lote enviado al servidor.
 *
 * `cursor` es el límite superior de la ventana leída (último `seq` incluido),
 * no el cursor de partida. El servidor debe confirmar `acceptedThrough` ≤ ese
 * valor; el cursor local solo avanza hasta lo confirmado.
 */
export interface CloudChangeBatch {
  companyId: string;
  cursor: number;
  changes: CloudChange[];
}

export interface CloudPushResult {
  /** Último `seq` confirmado por el servidor; nunca mayor que `batch.cursor`. */
  acceptedThrough: number;
}

export interface CloudTransport {
  push(batch: CloudChangeBatch): Promise<CloudPushResult>;
}

export interface CursorStore {
  load(companyId: string): Promise<number>;
  save(companyId: string, seq: number): Promise<void>;
}

/**
 * Cursor de descarga (`updated_at` del último cambio remoto aplicado).
 *
 * `updatedAt` es el instante (ms) de la última descarga correcta y sirve para
 * respetar el intervalo de 30 minutos incluso tras reiniciar la aplicación.
 * Un cursor ilegible debe reescribirse a `null` (re-ventana) y nunca a un valor
 * inventado: repetir una ventana es inocuo, saltarse cambios no.
 */
export interface PullCursorState {
  cursor: string | null;
  updatedAt: number | null;
}

export interface PullCursorStore {
  load(companyId: string): Promise<PullCursorState>;
  save(companyId: string, state: PullCursorState): Promise<void>;
}

export interface BudgetSnapshot {
  /** Solicitudes consumidas en el día indicado por la clave. */
  requests: number;
  /** Momento (ms) de la última solicitud aceptada; 0 si no hubo ninguna. */
  lastRequestAt: number;
}

export interface BudgetStore {
  load(dayKey: string): Promise<BudgetSnapshot>;
  save(dayKey: string, value: BudgetSnapshot): Promise<void>;
}

/** Filas por lote: suficiente para vaciar un turno sin saturar la red. */
export const DEFAULT_BATCH_SIZE = 200;

/** Una subida cada 15 minutos como mínimo. */
export const DEFAULT_MIN_INTERVAL_MS = 15 * 60 * 1000;

/** Presupuesto diario: 96 subidas/día equivalen a una cada 15 minutos. */
export const DEFAULT_MAX_REQUESTS_PER_DAY = 96;

/** Primer backoff tras un fallo; se duplica en cada intento fallido. */
export const DEFAULT_BACKOFF_MS = 30_000;

/** Tope del backoff: media hora, nunca bloquea más que el intervalo normal. */
export const MAX_BACKOFF_MS = 30 * 60 * 1000;
