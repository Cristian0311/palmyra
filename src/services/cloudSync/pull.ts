/**
 * Aplicador de cambios remotos: el sentido inverso del motor de subida.
 *
 * Este módulo no conoce la red ni Supabase: recibe filas ya descargadas y las
 * reconcilia con el almacén local aplicando last-writer-wins por
 * `(version, updated_at)`. Reglas que garantiza:
 *
 *  - Una fila remota más nueva que la local se escribe (upsert).
 *  - Una fila local más nueva nunca se pisa: se reporta como conflicto.
 *  - Un tombstone remoto nunca borra una fila local más nueva; se reporta como
 *    conflicto visible para que la pantalla decida.
 *  - Las filas de otra empresa se rechazan (aislamiento multiempresa).
 *  - Todo el lote se aplica en una sola transacción del driver y siempre por
 *    `tx.put`/`tx.remove`: nunca se llama al `driver` global dentro de la
 *    transacción.
 *  - `maxRows` limita las filas por lote; el resto queda como `deferred` para
 *    la siguiente pasada.
 *
 * Solo depende del contrato del almacén local (`localDb/contract`).
 */
import type {
  LocalDbDriver,
  LocalDbTransaction,
  LocalRow,
  LocalTable,
  MutationMeta
} from "../localDb/contract";

/** Tope por defecto de filas aplicadas en una transacción. */
export const DEFAULT_PULL_MAX_ROWS = 500;

/** Origen que se registra cuando el remoto no informa su dispositivo. */
const FALLBACK_ORIGIN = "cloud";

/**
 * Tablas que un pull puede escribir. Las tablas propias del dispositivo
 * (`outbox`, `hub_devices`, `hub_receipts`) quedan fuera: replicarlas desde la
 * nube rompería la cola local y el emparejamiento del hub.
 */
export const PULLABLE_TABLES: ReadonlySet<string> = new Set<string>([
  "companies",
  "company_settings",
  "warehouses",
  "products",
  "product_variants",
  "product_codes",
  "product_prices",
  "stock_movements",
  "stock_balances",
  "sales",
  "sale_items",
  "sale_payments",
  "cash_sessions",
  "cash_movements",
  "customers",
  "suppliers",
  "purchases",
  "purchase_items",
  "transfers",
  "transfer_items",
  "returns",
  "return_items",
  "quotes",
  "quote_items",
  "banks",
  "bank_movements",
  "inventory_audits",
  "inventory_audit_items",
  "ncf_sequences"
]);

/** ¿El pull puede escribir en esta tabla local? */
export function isPullableTable(table: string): boolean {
  return PULLABLE_TABLES.has(table);
}

/**
 * Cambio recibido del remoto.
 *
 * Un upsert trae `row` con `id`, `company_id` y `updated_at`; `version` es
 * opcional porque las tablas de negocio de la nube no llevan el contador local.
 * Sin `version`, el LWW se resuelve solo por `updated_at`. Un tombstone se marca
 * con `tombstone: true` y/o `deleted_at`; si no incluye la fila, basta con
 * `row_id` más la marca temporal (o `version`) para resolver el LWW.
 */
export interface RemotePullChange {
  table: LocalTable;
  /** Fila remota vigente; también puede ser un tombstone con `deleted_at`. */
  row?: LocalRow | null;
  /** Id cuando el tombstone no adjunta la fila completa. */
  row_id?: string;
  /** Marca explícita de borrado remoto. */
  tombstone?: boolean;
  /** Instante del borrado remoto; equivalente a `row.deleted_at`. */
  deleted_at?: string | null;
  /** Metadatos de un tombstone sin fila. */
  version?: number;
  updated_at?: string;
  origin_device?: string;
  company_id?: string;
}

export type PullSkipReason =
  | "blocked_table"
  | "missing_id"
  | "missing_row"
  | "invalid_row"
  | "missing_metadata"
  | "missing_local"
  | "already_deleted"
  | "duplicate";

export type PullConflictReason = "local_newer" | "tombstone_local_newer" | "foreign_company";

/** Decisión pura para un cambio remoto frente a la fila local vigente. */
export type RemoteDecision =
  | { action: "upsert"; table: LocalTable; row: LocalRow }
  | { action: "delete"; table: LocalTable; id: string; meta: MutationMeta }
  | { action: "conflict"; table: LocalTable; id: string; reason: PullConflictReason }
  | { action: "skip"; table: LocalTable; id: string; reason: PullSkipReason };

export interface PullConflict {
  table: string;
  id: string;
  reason: PullConflictReason;
}

export interface PullReport {
  /** Filas escritas por tabla (upserts + borrados aplicados). */
  applied: Record<string, number>;
  /** Cambios descartados sin conflicto (duplicados, inválidos, ya borrados). */
  skipped: number;
  /** Cambios que conservaron el dato local; quedan visibles para el usuario. */
  conflicts: PullConflict[];
  /** Cambios que excedieron `maxRows` y esperan al siguiente lote. */
  deferred: number;
}

export interface PlanRemoteChangesOptions {
  localDriver: LocalDbDriver;
  changes: RemotePullChange[];
  /** Empresa dueña del almacén local; toda fila ajena se rechaza. */
  companyId: string;
  /** Filas máximas por transacción (por defecto `DEFAULT_PULL_MAX_ROWS`). */
  maxRows?: number;
}

/**
 * Compara frescura entre la fila local y la remota.
 *
 * Devuelve `> 0` si la remota es más nueva, `< 0` si lo es la local y `0` si no
 * hay diferencia apreciable. `version` manda; `updated_at` desempata. Si el
 * remoto no informa `version` (tombstone ligero) se compara solo la marca de
 * tiempo, para no bloquear borrados legítimos.
 */
export function compareFreshness(
  local: Pick<LocalRow, "version" | "updated_at">,
  remote: { version?: number; updated_at?: string }
): number {
  const localVersion = Number.isFinite(local.version) ? local.version : 0;
  const remoteVersion = Number.isFinite(remote.version) ? (remote.version as number) : null;
  if (remoteVersion !== null && remoteVersion !== localVersion) {
    return remoteVersion > localVersion ? 1 : -1;
  }
  const localTime = parseTime(local.updated_at);
  const remoteTime = parseTime(remote.updated_at);
  if (localTime !== null && remoteTime !== null) {
    if (remoteTime === localTime) return 0;
    return remoteTime > localTime ? 1 : -1;
  }
  // ISO completos ordenan lexicográficamente aunque el parseo falle.
  const left = typeof local.updated_at === "string" ? local.updated_at : "";
  const right = typeof remote.updated_at === "string" ? remote.updated_at : "";
  if (!left || !right || left === right) return 0;
  return right > left ? 1 : -1;
}

/**
 * Decide qué hacer con un cambio remoto. Es puro: no toca el driver y puede
 * probarse con filas en memoria.
 */
export function resolveRemoteChange(
  change: RemotePullChange,
  companyId: string,
  local: LocalRow | null
): RemoteDecision {
  const table = change.table;
  const remoteRow = change.row ?? null;
  const id = remoteRow?.id ?? change.row_id ?? "";

  if (!PULLABLE_TABLES.has(table)) {
    return { action: "skip", table, id, reason: "blocked_table" };
  }
  if (!id) {
    return { action: "skip", table, id: "", reason: "missing_id" };
  }

  // Aislamiento multiempresa: se revisa antes que la forma de la fila para que
  // una fila ajena nunca llegue a escribirse.
  const declaredCompany = remoteRow
    ? toText(remoteRow.company_id) || toText(change.company_id)
    : toText(change.company_id);
  if (declaredCompany && declaredCompany !== companyId) {
    return { action: "conflict", table, id, reason: "foreign_company" };
  }

  const deletedAt = change.deleted_at ?? remoteRow?.deleted_at ?? null;
  const isTombstone = change.tombstone === true || Boolean(deletedAt);

  if (isTombstone) {
    const remoteVersion = remoteRow ? remoteRow.version : change.version;
    const remoteUpdatedAt = remoteRow?.updated_at ?? change.updated_at ?? deletedAt ?? "";
    if (!remoteUpdatedAt && !Number.isFinite(remoteVersion)) {
      // Sin versión ni fecha no se puede decidir sin arriesgar datos locales.
      return { action: "skip", table, id, reason: "missing_metadata" };
    }
    if (!local) {
      return { action: "skip", table, id, reason: "missing_local" };
    }
    if (local.deleted_at) {
      return { action: "skip", table, id, reason: "already_deleted" };
    }
    if (compareFreshness(local, { version: remoteVersion, updated_at: remoteUpdatedAt }) < 0) {
      // La fila local es más nueva que el borrado remoto: se conserva.
      return { action: "conflict", table, id, reason: "tombstone_local_newer" };
    }
    return {
      action: "delete",
      table,
      id,
      meta: {
        company_id: declaredCompany || local.company_id || companyId,
        origin_device: remoteRow?.origin_device ?? change.origin_device ?? FALLBACK_ORIGIN,
        at: remoteUpdatedAt || undefined
      }
    };
  }

  if (!remoteRow) {
    return { action: "skip", table, id, reason: "missing_row" };
  }
  if (!isValidRow(remoteRow)) {
    return { action: "skip", table, id, reason: "invalid_row" };
  }

  if (!local) {
    return { action: "upsert", table, row: { ...remoteRow } };
  }

  const order = compareFreshness(local, remoteRow);
  if (order < 0) {
    return { action: "conflict", table, id, reason: "local_newer" };
  }
  if (order === 0) {
    // Misma versión y marca de tiempo: no hay nada que escribir.
    return { action: "skip", table, id, reason: "duplicate" };
  }
  return { action: "upsert", table, row: { ...remoteRow } };
}

/**
 * Aplica un lote de cambios remotos en una única transacción.
 *
 * No lanza por filas inválidas o de otra empresa: esas se reportan. Solo una
 * falla del propio driver aborta la transacción completa (el driver restaura
 * su estado) y se propaga al llamador.
 */
export async function planRemoteChanges(
  options: PlanRemoteChangesOptions
): Promise<PullReport> {
  const companyId = toText(options.companyId);
  if (!companyId) {
    throw new Error("planRemoteChanges requiere companyId");
  }
  const driver = options.localDriver;
  const limit = normalizeLimit(options.maxRows);
  const batch = options.changes.slice(0, limit);
  const report: PullReport = {
    applied: {},
    skipped: 0,
    conflicts: [],
    deferred: options.changes.length - batch.length
  };

  await driver.ready();

  await driver.transaction(async (tx: LocalDbTransaction) => {
    for (const change of batch) {
      const pullable = PULLABLE_TABLES.has(change.table);
      const id = change.row?.id ?? change.row_id ?? "";
      // Se lee dentro de la transacción: el lote ve sus propias escrituras y
      // dos cambios sobre la misma fila se resuelven en orden.
      const local = pullable && id ? await tx.get<LocalRow>(change.table, id) : null;
      const decision = resolveRemoteChange(change, companyId, local);

      switch (decision.action) {
        case "upsert":
          await tx.put(decision.table, [normalizeRemoteRow(decision.row, local)]);
          countApplied(report, decision.table);
          break;
        case "delete":
          await tx.remove(decision.table, [decision.id], decision.meta);
          countApplied(report, decision.table);
          break;
        case "conflict":
          report.conflicts.push({
            table: decision.table,
            id: decision.id,
            reason: decision.reason
          });
          break;
        default:
          report.skipped += 1;
          break;
      }
    }
  });

  return report;
}

function countApplied(report: PullReport, table: LocalTable): void {
  report.applied[table] = (report.applied[table] ?? 0) + 1;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PULL_MAX_ROWS;
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Validación local equivalente a `assertLocalRow`, sin lanzar. */
function isValidRow(row: LocalRow): boolean {
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.company_id === "string" &&
    row.company_id.length > 0 &&
    (row.version === undefined || (typeof row.version === "number" && Number.isFinite(row.version))) &&
    typeof row.updated_at === "string" &&
    row.updated_at.length > 0
  );
}

/**
 * Completa una fila remota para el contrato local.
 *
 * Las tablas de negocio de la nube no llevan `version` ni `origin_device`: el
 * contador se deriva del local (o arranca en 1) y el origen se marca `cloud`.
 * El LWW sigue decidiéndose con `updated_at`, nunca con este contador.
 */
function normalizeRemoteRow(row: LocalRow, local: LocalRow | null): LocalRow {
  const localVersion = local && Number.isFinite(local.version) ? Math.floor(local.version) : 0;
  const remoteVersion = Number.isFinite(row.version) ? Math.floor(row.version as number) : 0;
  const version = Math.max(localVersion + 1, remoteVersion, 1);
  const origin =
    typeof row.origin_device === "string" && row.origin_device.trim() ? row.origin_device : FALLBACK_ORIGIN;
  return { ...row, version, origin_device: origin, deleted_at: row.deleted_at ?? null };
}
