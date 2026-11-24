/**
 * Verificación estricta de la importación del estado legado.
 *
 * El importador (importLegacy) traduce el JSON de Zustand a lotes por tabla. Este
 * módulo responde a una única pregunta antes de dar el corte por bueno: ¿lo que
 * quedó escrito coincide exactamente con lo que el estado de origen describe?
 * Se comprueban conteos por tabla, suma de ventas, stock y una huella canónica
 * del contenido de negocio.
 *
 * Sirve igual para el JSON local y para un snapshot de la nube porque
 * unwrapLegacyState ya reconoce ambas formas ({ state } o el objeto plano).
 *
 * Atomicidad: depende del driver. SQLite (BEGIN/ROLLBACK) y memoria (snapshot)
 * revierten de verdad; IndexedDB solo serializa operaciones y no revierte lo ya
 * escrito, así que allí un fallo deja una importación parcial que la siguiente
 * pasada repara (las escrituras son upserts idempotentes del mismo estado).
 */
import {
  assertLocalRow,
  type LocalDbDriver,
  type LocalRow,
  type LocalTable,
  type QuerySpec
} from "./contract";
import { importLegacyState, type ImportMeta, type LegacyImportResult } from "./importLegacy";
import { LOCAL_DB_TABLE_NAMES } from "./schema";

export type ImportSource = "legacy_json" | "cloud_snapshot";

export interface ImportTableStatus {
  expected: number;
  actual: number;
}

export interface ImportVerificationReport {
  ok: boolean;
  source: ImportSource;
  tables: Record<string, ImportTableStatus>;
  totals: {
    expectedSalesTotal: number;
    actualSalesTotal: number;
    expectedStock: number;
    actualStock: number;
  };
  hash: { expected: string; actual: string };
  mismatches: string[];
}

/** Solo se necesita `query`: vale tanto el driver como la transacción abierta. */
interface TableReader {
  query<T extends LocalRow>(spec: QuerySpec): Promise<T[]>;
}

/**
 * Columnas que no forman parte del contenido de negocio: la capa de sombra las
 * reescribe en cada pasada, así que no pueden entrar en la huella.
 */
const VOLATILE_COLUMNS = new Set(["version", "updated_at", "origin_device", "deleted_at"]);

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/** Diferencia tolerada al comparar sumas de dinero/stock (doble IEEE-754). */
const SUM_EPSILON = 1e-6;

/**
 * JSON canónico: claves ordenadas y sin `undefined`, para que la huella no
 * dependa del orden de propiedades ni del motor que serializó la fila.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return (
    "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}"
  );
}

/** FNV-1a de 64 bits en hexadecimal (16 caracteres, estable entre plataformas). */
function fnv1a64(text: string): string {
  let hash = FNV64_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * FNV64_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function rowFingerprint(row: LocalRow): string {
  const business: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (VOLATILE_COLUMNS.has(key) || value === undefined) continue;
    business[key] = value;
  }
  return canonicalJson(business);
}

/**
 * Huella canónica del conjunto: FNV-1a/64 sobre las filas ordenadas por tabla e
 * id, serializadas con claves ordenadas y sin columnas volátiles.
 */
function canonicalHash(tables: Record<string, LocalRow[]>): string {
  const parts: string[] = [];
  for (const table of Object.keys(tables).sort()) {
    const rows = tables[table].slice().sort((left, right) => {
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    });
    for (const row of rows) parts.push(`${table}\u0000${row.id}\u0000${rowFingerprint(row)}`);
  }
  return fnv1a64(parts.join("\n"));
}

function sumField(rows: LocalRow[] | undefined, field: string): number {
  let total = 0;
  for (const row of rows ?? []) {
    const value = row[field];
    if (typeof value === "number" && Number.isFinite(value)) total += value;
  }
  return total;
}

function sameSum(expected: number, actual: number): boolean {
  return Math.abs(expected - actual) <= SUM_EPSILON;
}

/**
 * Lectura real por empresa. Se incluyen las empresas presentes en lo esperado
 * (el legado puede traer filas con companyId ajeno al de la importación) y las
 * filas borradas, porque el estado de origen también las describe.
 */
async function readActualRows(
  reader: TableReader,
  table: LocalTable,
  expected: LocalRow[],
  meta: ImportMeta
): Promise<LocalRow[]> {
  const companyIds = Array.from(new Set(expected.map((row) => row.company_id))).sort();
  const values = companyIds.length > 0 ? companyIds : [meta.companyId];
  return reader.query<LocalRow>({
    table,
    where: [{ field: "company_id", op: "in", value: values }],
    includeDeleted: true
  });
}

/** Núcleo común: calcula lo esperado con el importador y lo compara con el almacén. */
async function compareWithStore(
  reader: TableReader,
  batches: LegacyImportResult["batches"],
  meta: ImportMeta,
  source: ImportSource
): Promise<ImportVerificationReport> {
  const expectedTables: Record<string, LocalRow[]> = {};
  for (const [table, rows] of Object.entries(batches)) {
    if (rows && rows.length > 0) expectedTables[table] = rows;
  }

  const actualTables: Record<string, LocalRow[]> = {};
  const tables: Record<string, ImportTableStatus> = {};
  const mismatches: string[] = [];

  for (const table of Object.keys(expectedTables).sort()) {
    const expectedRows = expectedTables[table];
    const actualRows = await readActualRows(reader, table as LocalTable, expectedRows, meta);
    actualTables[table] = actualRows;
    tables[table] = { expected: expectedRows.length, actual: actualRows.length };
    if (expectedRows.length !== actualRows.length) {
      mismatches.push(
        `tabla ${table}: esperado ${expectedRows.length}, real ${actualRows.length}`
      );
    }
  }

  const expectedSalesTotal = sumField(expectedTables.sales, "total");
  const actualSalesTotal = sumField(actualTables.sales, "total");
  if (!sameSum(expectedSalesTotal, actualSalesTotal)) {
    mismatches.push(
      `ventas.total: esperado ${expectedSalesTotal}, real ${actualSalesTotal}`
    );
  }

  const expectedStock = sumField(expectedTables.stock_balances, "quantity");
  const actualStock = sumField(actualTables.stock_balances, "quantity");
  if (!sameSum(expectedStock, actualStock)) {
    mismatches.push(`inventario.quantity: esperado ${expectedStock}, real ${actualStock}`);
  }

  const expectedHash = canonicalHash(expectedTables);
  const actualHash = canonicalHash(actualTables);
  if (expectedHash !== actualHash) {
    mismatches.push(`hash: esperado ${expectedHash}, real ${actualHash}`);
  }

  return {
    ok: mismatches.length === 0,
    source,
    tables,
    totals: { expectedSalesTotal, actualSalesTotal, expectedStock, actualStock },
    hash: { expected: expectedHash, actual: actualHash },
    mismatches
  };
}

/**
 * Verifica sin escribir: recalcula los lotes del estado y los compara con lo que
 * el driver tiene guardado (incluidas filas borradas).
 */
export async function verifyImportedState(
  driver: LocalDbDriver,
  state: unknown,
  meta: ImportMeta,
  options: { source?: ImportSource } = {}
): Promise<ImportVerificationReport> {
  const { batches } = importLegacyState(state, meta);
  return compareWithStore(driver, batches, meta, options.source ?? "legacy_json");
}

/**
 * Importa y verifica de forma atómica: escribe los lotes y vuelve a leer dentro
 * de la misma transacción. Si el resultado no cuadra, lanza y el driver deshace
 * todo lo escrito por este intento (SQLite y memoria): nunca queda una
 * importación a medias.
 */
export async function applyVerifiedImport(
  driver: LocalDbDriver,
  state: unknown,
  meta: ImportMeta,
  options: { source?: ImportSource } = {}
): Promise<{ report: ImportVerificationReport; written: boolean }> {
  const { batches } = importLegacyState(state, meta);

  // Validación previa completa: una fila inválida aborta antes de escribir nada.
  for (const table of LOCAL_DB_TABLE_NAMES) {
    for (const row of batches[table] ?? []) assertLocalRow(table, row);
  }

  let report: ImportVerificationReport | null = null;
  await driver.transaction(async (tx) => {
    for (const table of LOCAL_DB_TABLE_NAMES) {
      const rows = batches[table];
      if (!rows || rows.length === 0) continue;
      await tx.put(table, rows);
    }
    const verification = await compareWithStore(
      tx,
      batches,
      meta,
      options.source ?? "legacy_json"
    );
    report = verification;
    if (!verification.ok) {
      throw new Error(
        `Importación no verificada: ${verification.mismatches.join("; ")}`
      );
    }
  });

  return { report: report as ImportVerificationReport, written: true };
}

/** Resumen de una línea para logs: tablas, conteos, sumas y huella; sin datos de clientes. */
export function formatVerificationReport(report: ImportVerificationReport): string {
  const expectedRows = Object.values(report.tables).reduce((sum, entry) => sum + entry.expected, 0);
  const actualRows = Object.values(report.tables).reduce((sum, entry) => sum + entry.actual, 0);
  const tables = Object.keys(report.tables)
    .sort()
    .map((table) => {
      const entry = report.tables[table];
      return `${table}:${entry.actual}/${entry.expected}`;
    })
    .join(",");
  return [
    `import_verify ${report.ok ? "ok" : "fail"}`,
    `source=${report.source}`,
    `tables=${Object.keys(report.tables).length}`,
    `rows=${actualRows}/${expectedRows}`,
    `sales_total=${report.totals.actualSalesTotal}/${report.totals.expectedSalesTotal}`,
    `stock=${report.totals.actualStock}/${report.totals.expectedStock}`,
    `hash=${report.hash.actual}/${report.hash.expected}`,
    `mismatches=${report.mismatches.length > 0 ? report.mismatches.join(" | ") : "-"}`,
    `[${tables}]`
  ].join(" ");
}
