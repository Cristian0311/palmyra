/**
 * Lectura del journal del hub para el canal SSE.
 *
 * Reproduce la forma que `handler.ts` sirve en `GET /lan/v1/changes` —cada
 * registro con su fila vigente, convertido a `delete` cuando la fila ya no
 * existe o no pertenece a la empresa— pero sin pasar por el handler: así el
 * stream puede reconsultar el journal durante horas sin volver a firmar ni
 * consumir nonces. Es puro respecto al transporte (no conoce HTTP, cabeceras ni
 * firmas) y no expone filas de tablas internas del hub.
 */
import type { ChangeRecord, LocalDbDriver, LocalRow, LocalTable } from "../localDb/contract";
import {
  HUB_DEFAULT_PAGE_LIMIT,
  HUB_MAX_PAGE_LIMIT,
  type HubChangesResponse
} from "./protocol";

/** Tablas internas del hub: el journal las registra, pero su fila no se sirve. */
const INTERNAL_TABLES = new Set<LocalTable>(["hub_devices", "hub_receipts"]);

export interface ChangeFeedInput {
  /** Empresa dueña del hub; los registros de otra empresa se sirven como borrado. */
  companyId: string;
  /** Cursor exclusivo; por defecto 0. */
  since?: number;
  /** Tope de filas; por defecto `HUB_DEFAULT_PAGE_LIMIT`. */
  limit?: number;
  /** Reloj inyectable para pruebas; por defecto `Date.now`. */
  now?: () => number;
}

/** Cambio del cable: la fila vigente viaja junto al registro, como en el handler. */
export type EnrichedChangeRecord = ChangeRecord & { row?: LocalRow };

function safeSince(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function safeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return HUB_DEFAULT_PAGE_LIMIT;
  return Math.min(HUB_MAX_PAGE_LIMIT, Math.max(1, Math.floor(value)));
}

/**
 * Devuelve una página del journal lista para el cable: `changes`, `latestSeq`,
 * `serverTime` y `hasMore`. Los upserts llevan `row` solo si la fila sigue
 * vigente y es de la empresa; en cualquier otro caso se degradan a `delete`
 * (lápida) para que un equipo que se incorpora tarde no resucite datos.
 */
export async function readChangeFeed(
  driver: LocalDbDriver,
  input: ChangeFeedInput
): Promise<HubChangesResponse> {
  const companyId = typeof input?.companyId === "string" ? input.companyId.trim() : "";
  if (!companyId) throw new Error("readChangeFeed requiere companyId");
  const since = safeSince(input.since);
  const limit = safeLimit(input.limit);
  const clock = input.now ?? (() => Date.now());

  const changes = await driver.changes(since, limit);
  const latestSeq = await driver.latestSeq();
  const last = changes[changes.length - 1];
  const hasMore = changes.length === limit && Boolean(last) && last.seq < latestSeq;

  const enriched: EnrichedChangeRecord[] = [];
  for (const change of changes) {
    if (change.op === "delete") {
      enriched.push(change);
      continue;
    }
    // Ni las tablas internas ni otra empresa deben entregar su fila.
    if (change.company_id !== companyId || INTERNAL_TABLES.has(change.table)) {
      enriched.push({ ...change, op: "delete" });
      continue;
    }
    let row: LocalRow | null = null;
    try {
      row = await driver.get<LocalRow>(change.table, change.row_id);
    } catch {
      row = null;
    }
    if (!row || row.deleted_at || row.company_id !== companyId) {
      enriched.push({ ...change, op: "delete" });
    } else {
      enriched.push({ ...change, row });
    }
  }

  return {
    changes: enriched,
    latestSeq,
    serverTime: new Date(clock()).toISOString(),
    hasMore
  };
}
