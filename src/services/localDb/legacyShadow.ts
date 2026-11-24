/**
 * Escritura en sombra del estado legado hacia el almacén normalizado.
 *
 * Durante la convivencia, el JSON de Zustand sigue siendo la fuente de verdad
 * del dispositivo y este módulo lo refleja en SQLite/IndexedDB. El reflejo es
 * incremental: solo se escriben filas cuyo contenido de negocio cambió, de
 * modo que el journal de cambios —y con él la subida a la nube— no se inunda
 * con reescrituras idénticas cada vez que la UI guarda el estado completo.
 *
 * Reglas:
 * - Las filas conservan su versión local y la incrementan al cambiar.
 * - Los libros de solo anexado (ventas, líneas, pagos, caja, inventario y
 *   anulaciones) nunca se reescriben ni se borran: si el JSON legado cambia una
 *   fila existente, la reescritura se descarta y se avisa con un código estable.
 * - Un id que desaparece del JSON legado se elimina solo si la fila guardada
 *   sigue siendo exactamente la que escribió esta capa; si el hub o la nube la
 *   modificaron, se conserva y se deja de seguir.
 * - Una venta que desaparece del JSON no se borra: se anula con una fila nueva
 *   en `sale_voids` (motivo `legacy_removed`) y sus líneas y pagos se conservan.
 * - Si algo falla, no se toca el índice: la siguiente pasada reintenta.
 */
import { isAppendOnly } from "./appendOnly";
import type { LocalDbDriver, LocalDbTransaction, LocalRow, LocalTable } from "./contract";
import {
  LEGACY_TABLE_MAP,
  importLegacyState,
  unwrapLegacyState,
  type ImportReport
} from "./importLegacy";
import { SALE_VOID_REASONS, isSaleVoided, recordSaleVoid } from "./saleLifecycle";
import { LOCAL_DB_TABLE_NAMES } from "./schema";
import { emptyShadowIndex, type ShadowIndexData, type ShadowIndexStore } from "./shadowIndex";

export interface LegacyShadowOptions {
  driver: LocalDbDriver;
  companyId: string;
  originDevice: string;
  index: ShadowIndexStore;
  now?: () => string;
}

export interface LegacyShadowReport {
  /** False cuando el JSON no cambió desde la última pasada exitosa. */
  rawChanged: boolean;
  written: Record<string, number>;
  removed: Record<string, number>;
  /** Filas de solo anexado cuya reescritura se descartó, por tabla. */
  skipped: Record<string, number>;
  /** Ventas anuladas en esta pasada porque desaparecieron del JSON. */
  voided: string[];
  unchanged: number;
  warnings: string[];
  import: ImportReport | null;
}

export interface LegacyShadowWriter {
  /** Serializa las pasadas: una importación nunca se solapa con otra. */
  sync(raw: string | null): Promise<LegacyShadowReport | null>;
}

/** Filas por escritura: un lote enorme bloquea el puente IPC sin necesidad. */
const WRITE_CHUNK = 400;

const COMPANIES: LocalTable = "companies";
const COMPANY_SETTINGS: LocalTable = "company_settings";

/** Filas sintéticas que no vienen del JSON legado pero el hub necesita. */
const SYNTHETIC_TABLES: LocalTable[] = [COMPANIES, COMPANY_SETTINGS];

/** Libro de anulaciones: esta capa solo anexa filas, nunca las indexa ni las borra. */
const SALE_VOIDS = "sale_voids" as LocalTable;

/**
 * Tablas ajenas al JSON legado que una pasada no debe podar: su índice se
 * conserva intacto para no perder el rastro de lo ya anulado.
 */
const EXTERNALLY_MANAGED: ReadonlySet<string> = new Set([SALE_VOIDS]);

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** JSON estable: el orden de las claves no altera la huella. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    "{" +
    keys.map((key) => JSON.stringify(key) + ":" + stableStringify(record[key])).join(",") +
    "}"
  );
}

/** Huella del contenido de negocio, sin los campos que esta capa reescribe. */
export function shadowRowHash(row: LocalRow): string {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "version" || key === "updated_at" || key === "origin_device") continue;
    copy[key] = value;
  }
  const text = stableStringify(copy);
  return fnv1a(text) + ":" + text.length.toString(36);
}

function safeParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function companyRows(
  source: Record<string, unknown>,
  companyId: string,
  originDevice: string,
  at: string
): Record<string, LocalRow[]> {
  const config =
    source.storeConfig && typeof source.storeConfig === "object" && !Array.isArray(source.storeConfig)
      ? (source.storeConfig as Record<string, unknown>)
      : {};
  const name = typeof config.storeName === "string" ? config.storeName : "";

  return {
    [COMPANIES]: [
      {
        id: companyId,
        company_id: companyId,
        version: 1,
        updated_at: at,
        origin_device: originDevice,
        deleted_at: null,
        name
      }
    ],
    [COMPANY_SETTINGS]: [
      {
        id: companyId,
        company_id: companyId,
        version: 1,
        updated_at: at,
        origin_device: originDevice,
        deleted_at: null,
        store_name: name,
        config
      }
    ]
  };
}

/** Colecciones legadas que alimentan cada tabla (normalmente una sola). */
function legacyKeysByTable(): Map<LocalTable, string[]> {
  const map = new Map<LocalTable, string[]>();
  for (const [legacyKey, table] of Object.entries(LEGACY_TABLE_MAP)) {
    const list = map.get(table) ?? [];
    list.push(legacyKey);
    map.set(table, list);
  }
  return map;
}

async function putChunked(tx: LocalDbTransaction, table: LocalTable, rows: LocalRow[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += WRITE_CHUNK) {
    await tx.put(table, rows.slice(offset, offset + WRITE_CHUNK));
  }
}

export function createLegacyShadowWriter(options: LegacyShadowOptions): LegacyShadowWriter {
  const clock = options.now ?? (() => new Date().toISOString());
  const legacyKeys = legacyKeysByTable();
  let chain: Promise<unknown> = Promise.resolve();

  async function run(raw: string | null): Promise<LegacyShadowReport | null> {
    if (!raw) return null;
    const parsed = safeParse(raw);
    if (parsed === null) {
      return {
        rawChanged: false,
        written: {},
        removed: {},
        skipped: {},
        voided: [],
        unchanged: 0,
        warnings: ["El estado legado no es un JSON válido (omitido)"],
        import: null
      };
    }

    const at = clock();
    const previous = await options.index.load();
    const rawHash = fnv1a(raw);
    if (previous.raw === rawHash) {
      return {
        rawChanged: false,
        written: {},
        removed: {},
        skipped: {},
        voided: [],
        unchanged: 0,
        warnings: [],
        import: null
      };
    }

    const source = unwrapLegacyState(parsed);
    const collectionHashes: Record<string, string> = {};
    for (const [legacyKey, value] of Object.entries(source)) {
      if (!Array.isArray(value) || !LEGACY_TABLE_MAP[legacyKey]) continue;
      collectionHashes[legacyKey] = fnv1a(stableStringify(value)) + ":" + value.length.toString(36);
    }

    const { batches, report } = importLegacyState(parsed, {
      companyId: options.companyId,
      originDevice: options.originDevice,
      now: at
    });
    const synthetic = companyRows(source, options.companyId, options.originDevice, at);

    const next: ShadowIndexData = { raw: rawHash, collections: collectionHashes, tables: {} };
    const written: Record<string, number> = {};
    const removed: Record<string, number> = {};
    const skipped: Record<string, number> = {};
    const warnings = report.warnings.slice();
    const voided: string[] = [];
    /** Ventas cuya fila desapareció del JSON y deben anularse tras el commit. */
    const voidCandidates: LocalRow[] = [];
    let unchanged = 0;

    await options.driver.transaction(async (tx) => {
      /** Anulaciones ya registradas; se carga una vez por pasada. */
      let knownVoids: LocalRow[] | null = null;
      const loadVoids = async (): Promise<LocalRow[]> => {
        if (!knownVoids) {
          knownVoids = await tx.query<LocalRow>({
            table: SALE_VOIDS,
            where: [{ field: "company_id", op: "eq", value: options.companyId }],
            includeDeleted: true
          });
        }
        return knownVoids;
      };

      for (const table of LOCAL_DB_TABLE_NAMES) {
        if (EXTERNALLY_MANAGED.has(table)) {
          // No nace del JSON legado: se conserva su índice tal cual para no
          // perder el rastro de anulaciones ya registradas.
          next.tables[table] = { ...(previous.tables[table] ?? {}) };
          continue;
        }
        const isSynthetic = SYNTHETIC_TABLES.includes(table);
        const rows = isSynthetic ? synthetic[table] ?? [] : batches[table] ?? [];
        const previousTable = previous.tables[table] ?? {};

        const keys = legacyKeys.get(table) ?? [];
        const collectionUnchanged =
          !isSynthetic &&
          keys.length > 0 &&
          keys.every(
            (key) =>
              collectionHashes[key] !== undefined && previous.collections[key] === collectionHashes[key]
          );

        if (collectionUnchanged) {
          // Nada cambió en esta colección: se conserva el índice tal cual.
          next.tables[table] = previousTable;
          unchanged += Object.keys(previousTable).length;
          continue;
        }

        const appendOnly = isAppendOnly(table);
        const tableIndex: Record<string, { h: string; v: number }> = {};
        const toWrite: LocalRow[] = [];
        let skippedRows = 0;

        for (const row of rows) {
          const hash = shadowRowHash(row);
          const stamp = previousTable[row.id];
          if (stamp && stamp.h === hash) {
            tableIndex[row.id] = stamp;
            unchanged += 1;
            continue;
          }
          // La versión parte de la fila almacenada: si el hub ya la actualizó,
          // la escritura local debe quedar por encima para no perderla por LWW.
          const stored = await tx.get<LocalRow>(table, row.id);
          if (appendOnly && (stored || stamp)) {
            // Solo anexado: una fila existente jamás se reescribe. Se conserva
            // el sello anterior para no atribuir a esta capa lo que no escribió
            // y se cuenta como no escrita: el libro quedó intacto.
            if (stamp) tableIndex[row.id] = stamp;
            unchanged += 1;
            skippedRows += 1;
            continue;
          }
          const version = Math.max(Number(stored?.version) || 0, stamp?.v ?? 0) + 1;
          toWrite.push({
            ...row,
            version,
            updated_at: at,
            origin_device: options.originDevice
          });
          tableIndex[row.id] = { h: hash, v: version };
        }

        if (skippedRows > 0) {
          skipped[table] = (skipped[table] ?? 0) + skippedRows;
          warnings.push(`append_only_skipped:${table}`);
        }

        if (toWrite.length > 0) {
          await putChunked(tx, table, toWrite);
          written[table] = toWrite.length;
        }

        const missing = Object.keys(previousTable).filter((id) => !tableIndex[id]);
        if (missing.length > 0) {
          const doomed: string[] = [];
          for (const id of missing) {
            const stored = await tx.get<LocalRow>(table, id);
            if (!stored) continue;
            // Solo se actúa si la fila sigue siendo la que dejó esta capa.
            if (shadowRowHash(stored) !== previousTable[id].h) continue;
            if (appendOnly) {
              // Los libros nunca se podan: la fila se conserva siempre.
              if (table === "sales") {
                // Una venta retirada del JSON se compensa con una anulación,
                // nunca con un borrado. El sello se mantiene para que la fila
                // siga indexada y la próxima pasada no repita la búsqueda.
                tableIndex[id] = previousTable[id];
                if (!isSaleVoided(await loadVoids(), id)) voidCandidates.push(stored);
              }
              continue;
            }
            doomed.push(id);
          }
          if (doomed.length > 0) {
            await tx.remove(table, doomed, {
              company_id: options.companyId,
              origin_device: options.originDevice,
              at
            });
            removed[table] = doomed.length;
          }
        }

        next.tables[table] = tableIndex;
      }
    });

    // Las anulaciones se registran después del commit: `recordSaleVoid` abre su
    // propia transacción y es idempotente por sí mismo. Si falla, el índice de
    // la venta no avanza y la siguiente pasada lo reintenta.
    let voidFailures = 0;
    for (const sale of voidCandidates) {
      const branchId =
        typeof sale.warehouse_id === "string" && sale.warehouse_id
          ? sale.warehouse_id
          : typeof sale.branch_id === "string" && sale.branch_id
            ? sale.branch_id
            : undefined;
      // Contrato compartido con el ciclo de vida de la venta: el id viaja en
      // `saleId` y la sucursal en `branchId`. Se adjunta además la fila
      // almacenada para que la anulación no dependa de que el llamador la
      // resuelva: ambas formas describen la misma venta.
      const voidInput = {
        driver: options.driver,
        companyId: options.companyId,
        deviceId: options.originDevice,
        saleId: sale.id,
        branchId,
        sale,
        reason: SALE_VOID_REASONS.legacy_removed,
        voidedAt: at,
        createdBy:
          typeof sale.user_id === "string" && sale.user_id ? sale.user_id : options.originDevice
      };
      try {
        await recordSaleVoid(voidInput);
        voided.push(sale.id);
      } catch {
        voidFailures += 1;
        warnings.push(`sale_void_failed:${sale.id}`);
      }
    }

    if (voided.length > 0) {
      // El índice aprende los ids reales que produjo el libro de anulaciones.
      const voidIndex: Record<string, { h: string; v: number }> = {
        ...(next.tables[SALE_VOIDS] ?? {})
      };
      const recorded = await options.driver.query<LocalRow>({
        table: SALE_VOIDS,
        where: [{ field: "company_id", op: "eq", value: options.companyId }],
        includeDeleted: true
      });
      for (const row of recorded) {
        if (!voided.some((saleId) => isSaleVoided([row], saleId))) continue;
        voidIndex[row.id] = { h: shadowRowHash(row), v: Number(row.version) || 0 };
      }
      next.tables[SALE_VOIDS] = voidIndex;
    }

    if (voidFailures > 0) {
      // La anulación pendiente no puede quedar invisible: se retrocede el
      // índice de las colecciones que alimentan ventas (y la huella global)
      // para que la próxima pasada vuelva a ver la venta ausente y reintente
      // el anexo. Nada escrito se pierde: la venta y sus líneas siguen ahí.
      next.raw = previous.raw;
      for (const [legacyKey, table] of Object.entries(LEGACY_TABLE_MAP)) {
        if (table !== "sales") continue;
        const before = previous.collections[legacyKey];
        if (before === undefined) delete next.collections[legacyKey];
        else next.collections[legacyKey] = before;
      }
    }

    // El índice solo avanza cuando la transacción confirmó.
    await options.index.save(next);

    return {
      rawChanged: true,
      written,
      removed,
      skipped,
      voided,
      unchanged,
      warnings,
      import: report
    };
  }

  return {
    sync(raw) {
      const task = chain.then(() => run(raw));
      chain = task.catch(() => undefined);
      return task;
    }
  };
}

export { emptyShadowIndex };
