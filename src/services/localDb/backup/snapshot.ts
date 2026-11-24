import {
  assertLocalRow,
  type LocalDbDriver,
  type LocalRow,
  type LocalTable,
  type MutationMeta
} from "../contract";
import { LOCAL_DB_TABLE_NAMES, LOCAL_DB_VERSION } from "../schema";

/**
 * Lectura y escritura de la foto completa del almacén local.
 *
 * Solo usa el contrato del driver, así que el mismo respaldo sirve para
 * IndexedDB, SQLite (escritorio y Android) y memoria. Se incluyen las filas con
 * `deleted_at` para que la restauración reproduzca el estado exacto y no reviva
 * registros que ya estaban borrados.
 */

export interface BackupSnapshot {
  schemaVersion: number;
  latestSeq: number;
  tables: Record<string, LocalRow[]>;
  counts: Record<string, number>;
  totalRows: number;
}

export interface ApplySnapshotReport {
  written: number;
  removed: number;
}

/** Lotes pequeños: cada fila SQLite viaja como una sentencia con varios parámetros. */
const PUT_CHUNK = 100;
const REMOVE_CHUNK = 500;

function byId(a: LocalRow, b: LocalRow): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Lee todas las tablas del contrato con una copia ordenada por id. */
export async function readBackupSnapshot(driver: LocalDbDriver): Promise<BackupSnapshot> {
  const tables: Record<string, LocalRow[]> = {};
  const counts: Record<string, number> = {};
  let totalRows = 0;

  for (const table of LOCAL_DB_TABLE_NAMES) {
    const rows = await driver.query<LocalRow>({ table, includeDeleted: true });
    const copy = rows.map((row) => ({ ...row })).sort(byId);
    tables[table] = copy;
    counts[table] = copy.length;
    totalRows += copy.length;
  }

  return {
    schemaVersion: LOCAL_DB_VERSION,
    latestSeq: await driver.latestSeq(),
    tables,
    counts,
    totalRows
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

/**
 * Aplica la foto dentro de UNA transacción del driver: si algo falla, el
 * almacén queda como estaba. Las filas nuevas se escriben conservando versión,
 * fecha y origen originales; solo se borran las que no existen en el respaldo.
 *
 * Matiz por motor: en SQLite es un COMMIT real. En IndexedDB el contrato
 * serializa la transacción (no hay atomicidad entre almacenes), así que una
 * caída a mitad de la restauración puede dejar la foto parcial; el panel avisa
 * de que hay que recargar y el respaldo se rechaza antes de escribir si no
 * cuadra el hash, el esquema o los conteos.
 */
export async function applyBackupSnapshot(
  driver: LocalDbDriver,
  snapshot: BackupSnapshot,
  mutation: MutationMeta
): Promise<ApplySnapshotReport> {
  let written = 0;
  let removed = 0;

  await driver.transaction(async (tx) => {
    for (const table of LOCAL_DB_TABLE_NAMES) {
      const target = snapshot.tables[table] ?? [];
      const backupIds = new Set(target.map((row) => row.id));

      const current = await tx.query<LocalRow>({
        table: table as LocalTable,
        includeDeleted: true
      });
      const stale = current.map((row) => row.id).filter((id) => !backupIds.has(id));
      for (const batch of chunk(stale, REMOVE_CHUNK)) {
        await tx.remove(table as LocalTable, batch, mutation);
        removed += batch.length;
      }

      for (const batch of chunk(target, PUT_CHUNK)) {
        // Valida cada fila antes de escribir: un respaldo corrupto no entra.
        for (const row of batch) assertLocalRow(table as LocalTable, row);
        written += await tx.put(table as LocalTable, batch);
      }
    }
  });

  return { written, removed };
}
