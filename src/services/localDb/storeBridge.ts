/**
 * Puente reversible almacén normalizado → store legada (Zustand).
 *
 * El bucle del hub LAN escribe las filas de otros equipos en el almacén, pero
 * la UI sigue leyendo el JSON legado. Este módulo proyecta esas filas a las
 * colecciones de la store para que los cambios ajenos se vean sin reiniciar,
 * sin invertir la fuente de verdad: en modo sombra el JSON sigue mandando y la
 * escritura legado → filas continúa en legacyShadow.
 *
 * Política de conflicto (LWW controlado)
 * --------------------------------------
 * Cada fila aplicada deja una huella en memoria (`stamps`): versión, instante,
 * hash del contenido proyectado y dispositivo de origen. Una entidad entrante
 * solo se aplica si:
 *   1. su contenido difiere del que ya tiene la store (si es equivalente no se
 *      escribe: sería un re-render inútil y un eco para la sombra),
 *   2. cuando la entidad ya existe, hay evidencia de que es más nueva (versión
 *      mayor, o misma versión con `updated_at` posterior), y
 *   3. la store no divergió de la última proyección (una edición local aún no
 *      reflejada en el almacén se respeta).
 * Nunca se borra por ausencia: solo una lápida explícita (`snapshot.deleted` o
 * una fila con `deleted_at` en la API por filas) quita una entidad, y solo si
 * este puente ya la había proyectado. Nunca se tocan `currentUser`, la sesión,
 * los usuarios ni la configuración de acceso: el parche solo lleva colecciones
 * de negocio de la lista blanca.
 *
 * Por qué no oscila con la sombra
 * -------------------------------
 * legacyShadow deduplica con `shadowRowHash`, una huella por fila que ignora
 * `version`, `updated_at` y `origin_device`. Si la proyección conserva el
 * contenido de negocio (la prueba de ida y vuelta lo comprueba), la siguiente
 * pasada de la sombra reimporta exactamente las mismas filas y no escribe
 * nada. No hay ciclo A→B→A porque la equivalencia se decide por contenido, no
 * por llegada de lotes.
 *
 * Apagado: VITE_LOCAL_DB_APPLY_REMOTE=0 (activo por defecto). Reversible en
 * caliente: solo afecta a escrituras futuras de la store.
 */
import type { ReturnItem } from "../../types";
import type { LocalTable } from "./contract";
import type { LocalDbSourceEnv } from "./cutover";
import type { LocalDbSnapshot } from "./bootHydration";
import { fnv1a, stableStringify } from "./legacyShadow";
import {
  branchFromRow,
  cashSessionFromRow,
  customerFromRow,
  inventoryFromRow,
  productFromRow,
  rowToEntityFields,
  supplierFromRow,
  transactionFromRow,
  transferFromRow
} from "./repositories";

/** Colecciones de la store que este puente puede reescribir. */
export type BridgeCollection =
  | "products"
  | "inventory"
  | "customers"
  | "suppliers"
  | "transactions"
  | "cashSessions"
  | "branches"
  | "returns"
  | "transfers";

const APPLY_ENV_KEY = "VITE_LOCAL_DB_APPLY_REMOTE";

/** Tabla del almacén que alimenta cada colección de la store. */
const COLLECTION_TABLES: Record<BridgeCollection, LocalTable> = {
  products: "products",
  inventory: "stock_balances",
  customers: "customers",
  suppliers: "suppliers",
  transactions: "sales",
  cashSessions: "cash_sessions",
  branches: "warehouses",
  returns: "returns",
  transfers: "transfers"
};

const SNAPSHOT_COLLECTIONS: BridgeCollection[] = [
  "products",
  "inventory",
  "customers",
  "suppliers",
  "transactions",
  "cashSessions",
  "branches",
  "returns",
  "transfers"
];

/** Mínimo de la store que necesita el puente (compatible con Zustand). */
export interface BridgeStoreState {
  products?: readonly unknown[];
  inventory?: readonly unknown[];
  customers?: readonly unknown[];
  suppliers?: readonly unknown[];
  transactions?: readonly unknown[];
  cashSessions?: readonly unknown[];
  branches?: readonly unknown[];
  returns?: readonly unknown[];
  transfers?: readonly unknown[];
  /** Solo lo toca la API por filas (configuración de tienda). */
  storeConfig?: unknown;
}

export interface BridgeStore {
  getState(): BridgeStoreState;
  setState(patch: Record<string, unknown>): void;
}

export interface StoreBridgeResult {
  applied: number;
  skipped: number;
}

/** Metadatos de sincronización de una fila, tal como los entrega la hidratación. */
export interface SnapshotRowMeta {
  version: number;
  updatedAt: string;
  originDevice?: string;
}

export interface ApplyLocalSnapshotInput {
  /** Store destino; por defecto la registrada o la real de la app. */
  store?: BridgeStore | null;
  snapshot: LocalDbSnapshot;
  companyId: string;
  /** Dispositivo actual; se anota en la huella para diagnosticar ecos. */
  originDevice?: string;
  /**
   * true (por defecto): una entidad existente solo se pisa con evidencia de
   * ser más reciente. false: se pisa siempre que el contenido difiera (modo
   * forzado de soporte); nunca se borra por ausencia.
   */
  onlyNewer?: boolean;
  /** Instante para las huellas de borrado sin fecha propia. */
  now?: string;
  /** Permite inyectar el entorno en pruebas; por defecto import.meta.env. */
  env?: LocalDbSourceEnv;
}

/** Una fila del almacén que se proyecta a una colección de la store. */
export interface BridgedRow {
  table: LocalTable;
  row: LocalRowLike;
  /** Entidad ya reconstruida (venta con líneas, turno con movimientos). */
  entity?: unknown;
}

interface LocalRowLike {
  id: string;
  company_id?: string;
  version?: number;
  updated_at?: string;
  origin_device?: string;
  deleted_at?: string | null;
  [field: string]: unknown;
}

/** Tombstone explícito: única vía de borrado en la store. */
export interface BridgedTombstone {
  table: LocalTable;
  id: string;
  version?: number;
  updatedAt?: string;
}

export type DeletedIdInput = BridgedTombstone | string;

export interface ApplyLocalRowsInput {
  rows: readonly BridgedRow[];
  /** Lápidas explícitas. Formato `tabla:id` o un id suelto ya proyectado. */
  deletedIds?: readonly DeletedIdInput[];
  companyId: string;
  now?: string;
  store?: BridgeStore | null;
  env?: LocalDbSourceEnv;
}

interface BridgeStamp {
  version: number;
  updatedAt: string;
  /** Huella del contenido proyectado; detecta ediciones locales posteriores. */
  hash: string;
  /** Dispositivo que originó la fila aplicada (diagnóstico de ecos). */
  origin?: string;
  /** La fila se borró con una lápida: bloquea resurrecciones más viejas. */
  deleted?: boolean;
}

const EMPTY_RESULT: StoreBridgeResult = { applied: 0, skipped: 0 };

const RETURN_STATUSES = new Set(["pending", "approved", "rejected", "completed"]);

/**
 * Fila plana → ReturnItem. La devolución no tiene tablas hijas propias: el
 * importador guarda todos sus campos en la fila padre, así que la inversa
 * camelCase (rowToEntityFields) es fiel y no hay que inventar nada.
 */
export function returnFromRow(row: LocalRowLike): ReturnItem {
  const fields = rowToEntityFields(row as never);
  const status = asString(fields.status);
  return {
    ...fields,
    id: row.id,
    transactionId: asString(fields.transactionId),
    productId: asString(fields.productId),
    quantity: asNumber(fields.quantity),
    reason: asString(fields.reason),
    date: asString(fields.date),
    status: (RETURN_STATUSES.has(status) ? status : "pending") as ReturnItem["status"],
    type: fields.type === "warranty_exchange" ? "warranty_exchange" : "refund"
  } as ReturnItem;
}

const CONVERTERS: Partial<
  Record<LocalTable, { collection: BridgeCollection; convert: (row: never) => unknown }>
> = {
  products: { collection: "products", convert: productFromRow as (row: never) => unknown },
  stock_balances: { collection: "inventory", convert: inventoryFromRow as (row: never) => unknown },
  customers: { collection: "customers", convert: customerFromRow as (row: never) => unknown },
  suppliers: { collection: "suppliers", convert: supplierFromRow as (row: never) => unknown },
  sales: { collection: "transactions", convert: transactionFromRow as (row: never) => unknown },
  cash_sessions: {
    collection: "cashSessions",
    convert: cashSessionFromRow as (row: never) => unknown
  },
  warehouses: { collection: "branches", convert: branchFromRow as (row: never) => unknown },
  returns: { collection: "returns", convert: returnFromRow as (row: never) => unknown },
  transfers: { collection: "transfers", convert: transferFromRow as (row: never) => unknown }
};

const CONFIG_TABLES = new Set<LocalTable>(["company_settings", "companies"]);

let bridgeTarget: BridgeStore | null = null;
const stamps = new Map<string, BridgeStamp>();

// ---------------------------------------------------------------------------
// entorno, registro de la store y utilidades
// ---------------------------------------------------------------------------

function readEnv(env?: LocalDbSourceEnv): LocalDbSourceEnv {
  if (env) return env;
  try {
    return (import.meta as ImportMeta & { env?: LocalDbSourceEnv }).env ?? {};
  } catch {
    return {};
  }
}

/**
 * Kill switch del puente. Activo por defecto; '0' (o 'false'/'off'/'no') lo
 * apaga sin tocar el resto de la sincronización local.
 */
export function isLocalDbRemoteApplyEnabled(env?: LocalDbSourceEnv): boolean {
  const value = String(readEnv(env)[APPLY_ENV_KEY] ?? "").trim().toLowerCase();
  if (!value) return true;
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

/** Registra la store de producción (o una de pruebas) para la proyección. */
export function setStoreBridgeTarget(store: BridgeStore | null): void {
  bridgeTarget = store;
}

async function resolveBridgeTarget(): Promise<BridgeStore | null> {
  if (bridgeTarget) return bridgeTarget;
  try {
    // Importación diferida: la store importa medio dominio y no debe entrar en
    // el grafo estático del almacén (mismo criterio que bootHydration).
    const module = await import("../../store/useStore");
    bridgeTarget = module.useStore as unknown as BridgeStore;
    return bridgeTarget;
  } catch {
    return null;
  }
}

/** Limpia huellas y destino; pensado para pruebas y cambios de empresa. */
export function resetStoreBridgeForTests(): void {
  stamps.clear();
  bridgeTarget = null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function instant(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Huella estable de una entidad de la store (sin depender del orden de claves). */
export function bridgeEntityHash(entity: unknown): string {
  return fnv1a(stableStringify(entity));
}

function stampKey(companyId: string, table: LocalTable, id: string): string {
  return `${companyId}|${table}|${id}`;
}

function rowVersion(row: { version?: unknown }): number {
  const value = Number(row?.version);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function isNewerThan(meta: SnapshotRowMeta | null, stamp: BridgeStamp): boolean {
  if (!meta) return false;
  if (meta.version !== stamp.version) return meta.version > stamp.version;
  return instant(meta.updatedAt) > instant(stamp.updatedAt);
}

function stampOf(meta: SnapshotRowMeta | null, hash: string, origin?: string): BridgeStamp {
  return {
    version: meta ? meta.version : 1,
    updatedAt: meta ? meta.updatedAt : new Date(0).toISOString(),
    hash,
    ...(origin ? { origin } : {})
  };
}

function entityId(entity: unknown): string {
  const record = asObject(entity);
  return typeof record?.id === "string" ? record.id : "";
}

/** Clave compuesta del inventario: el nivel legado puede no tener id. */
function inventoryKey(level: unknown): string {
  const record = asObject(level);
  if (!record) return "";
  const productId = typeof record.productId === "string" ? record.productId : "";
  const branchId =
    (typeof record.branchId === "string" && record.branchId) ||
    (typeof record.warehouseId === "string" && record.warehouseId) ||
    "default";
  const variant = typeof record.variantLabel === "string" ? record.variantLabel : "";
  return `${productId}:${branchId}:${variant}`;
}

function findIndex(collection: BridgeCollection, list: readonly unknown[], entity: unknown): number {
  if (collection === "inventory") {
    const targetId = entityId(entity);
    const targetKey = inventoryKey(entity);
    return list.findIndex((item) => {
      if (targetId && entityId(item) === targetId) return true;
      return inventoryKey(item) === targetKey;
    });
  }
  const targetId = entityId(entity);
  if (!targetId) return -1;
  return list.findIndex((item) => entityId(item) === targetId);
}

function isTombstoneRow(row: LocalRowLike): boolean {
  return typeof row.deleted_at === "string" && row.deleted_at.length > 0;
}

/** Metadatos de una entidad que los trae embebidos (snapshots de pruebas). */
function entityMeta(entity: unknown): SnapshotRowMeta | null {
  const record = asObject(entity);
  if (!record) return null;
  const updatedAt = asString(record.updatedAt) || asString(record.updated_at);
  const version = rowVersion(record);
  if (!updatedAt && version === 1) return null;
  return { version, updatedAt };
}

function snapshotMeta(
  snapshot: LocalDbSnapshot,
  table: LocalTable,
  id: string
): SnapshotRowMeta | null {
  const tableMeta = snapshot?.sync?.[table];
  if (!tableMeta || !id) return null;
  const meta = tableMeta[id];
  if (!meta) return null;
  return {
    version: rowVersion(meta),
    updatedAt: asString(meta.updatedAt),
    ...(typeof meta.originDevice === "string" ? { originDevice: meta.originDevice } : {})
  };
}

// ---------------------------------------------------------------------------
// fusión por colección (núcleo compartido por ambas puertas)
// ---------------------------------------------------------------------------

interface MergeContext {
  companyId: string;
  state: BridgeStoreState;
  lists: Map<BridgeCollection, unknown[]>;
  dirty: Set<BridgeCollection>;
  /** Claves fuera de las colecciones (solo la configuración de tienda). */
  extra: Record<string, unknown>;
  result: StoreBridgeResult;
  onlyNewer: boolean;
  originDevice?: string;
}

function createContext(
  store: BridgeStore,
  companyId: string,
  onlyNewer: boolean,
  originDevice?: string
): MergeContext {
  return {
    companyId,
    state: store.getState() ?? {},
    lists: new Map(),
    dirty: new Set(),
    extra: {},
    result: { applied: 0, skipped: 0 },
    onlyNewer,
    originDevice
  };
}

function getList(ctx: MergeContext, collection: BridgeCollection): unknown[] {
  let list = ctx.lists.get(collection);
  if (!list) {
    const current = (ctx.state as Record<string, unknown>)[collection];
    list = Array.isArray(current) ? current.slice() : [];
    ctx.lists.set(collection, list);
  }
  return list;
}

function tombstoneKey(ctx: MergeContext, table: LocalTable, id: string): string {
  return stampKey(ctx.companyId, table, id);
}

/**
 * Aplica (o descarta) una entidad en su colección.
 *
 * Reglas, en orden: contenido equivalente → nada; sin metadatos y ya existente
 * → nada (no se degrada sin evidencia); edición local divergente → nada; fila
 * no más nueva que la última proyectada → nada. Solo entonces se escribe la
 * entrada, se refresca la huella y se marca la colección como sucia.
 */
function mergeEntity(
  ctx: MergeContext,
  collection: BridgeCollection,
  table: LocalTable,
  entity: unknown,
  meta: SnapshotRowMeta | null
): void {
  const hash = bridgeEntityHash(entity);
  const list = getList(ctx, collection);
  const index = findIndex(collection, list, entity);
  const id = entityId(entity) || inventoryKey(entity);
  const key = tombstoneKey(ctx, table, id);
  const stamp = stamps.get(key);
  const currentHash = index >= 0 ? bridgeEntityHash(list[index]) : "";

  // Contenido idéntico: no se escribe (anti-render y anti-eco con la sombra).
  if (index >= 0 && currentHash === hash) {
    if (meta && (!stamp || isNewerThan(meta, stamp))) {
      stamps.set(key, stampOf(meta, hash, ctx.originDevice));
    }
    ctx.result.skipped += 1;
    return;
  }

  // Sin metadatos no se puede demostrar frescura: solo se admiten altas.
  if (!meta && ctx.onlyNewer && index >= 0) {
    ctx.result.skipped += 1;
    return;
  }

  // La store divergió de lo último proyectado: hay trabajo local sin reflejar
  // en el almacén; no se pisa (no degradación).
  if (stamp && !stamp.deleted && index >= 0 && stamp.hash && currentHash !== stamp.hash) {
    ctx.result.skipped += 1;
    return;
  }

  if (stamp && ctx.onlyNewer && !isNewerThan(meta, stamp)) {
    ctx.result.skipped += 1;
    return;
  }

  if (index >= 0) list[index] = entity;
  else list.push(entity);
  stamps.set(key, stampOf(meta, hash, ctx.originDevice));
  ctx.dirty.add(collection);
  ctx.result.applied += 1;
}

/**
 * Borrado explícito. Solo actúa sobre ids que este puente ya proyectó y que
 * una lápida más nueva declara eliminados; la ausencia en el snapshot nunca
 * llega hasta aquí.
 */
function applyTombstone(
  ctx: MergeContext,
  table: LocalTable,
  collection: BridgeCollection,
  id: string,
  meta: SnapshotRowMeta | null,
  fallbackAt: string
): void {
  if (!id) {
    ctx.result.skipped += 1;
    return;
  }
  const key = tombstoneKey(ctx, table, id);
  const stamp = stamps.get(key);
  // Nunca se proyectó esta fila: borrarla podría destruir un dato local.
  if (!stamp) {
    ctx.result.skipped += 1;
    return;
  }
  const incoming = meta ?? { version: stamp.version, updatedAt: fallbackAt };
  if (stamp.deleted || !isNewerThan(incoming, stamp)) {
    ctx.result.skipped += 1;
    return;
  }
  const list = getList(ctx, collection);
  const index = list.findIndex((item) => entityId(item) === id);
  if (index < 0) {
    stamps.set(key, { ...stamp, hash: "", deleted: true, updatedAt: incoming.updatedAt });
    ctx.result.skipped += 1;
    return;
  }
  list.splice(index, 1);
  ctx.dirty.add(collection);
  stamps.set(key, {
    version: incoming.version,
    updatedAt: incoming.updatedAt,
    hash: "",
    deleted: true,
    ...(ctx.originDevice ? { origin: ctx.originDevice } : {})
  });
  ctx.result.applied += 1;
}

/** Publica una sola vez las colecciones tocadas; nunca otras claves. */
function publish(ctx: MergeContext, store: BridgeStore): StoreBridgeResult {
  const patch: Record<string, unknown> = { ...ctx.extra };
  for (const collection of ctx.dirty) patch[collection] = getList(ctx, collection);
  if (Object.keys(patch).length > 0) {
    try {
      store.setState(patch);
    } catch {
      // Una store rota no debe romper el bucle del hub: se reintenta al refrescar.
      return { applied: 0, skipped: ctx.result.applied + ctx.result.skipped };
    }
  }
  return ctx.result;
}

// ---------------------------------------------------------------------------
// API pública: snapshot hidratado → store
// ---------------------------------------------------------------------------

function snapshotEntityCount(snapshot: LocalDbSnapshot | undefined): number {
  if (!snapshot) return 0;
  let total = 0;
  for (const collection of SNAPSHOT_COLLECTIONS) {
    const list = (snapshot as unknown as Record<string, unknown>)[collection];
    if (Array.isArray(list)) total += list.length;
  }
  for (const ids of Object.values(snapshot.deleted ?? {})) {
    if (Array.isArray(ids)) total += ids.length;
  }
  return total;
}

/**
 * Fusiona por colección un snapshot ya hidratado. Solo gana la entrada con
 * `updated_at` más reciente (o la que aún no existe en la store); nunca se
 * elimina nada por ausencia y nunca se toca `currentBranchId`, `currentUser`
 * ni la sesión. `storeConfig` solo se rellena cuando la store no tiene ninguna
 * (un almacén recién hidratado): si ya existe, se respeta tal cual para no
 * pisar configuración local. Devuelve cuántas entradas se aplicaron y cuántas
 * se descartaron.
 */
export function applyLocalSnapshotToStore(input: ApplyLocalSnapshotInput): StoreBridgeResult {
  const total = snapshotEntityCount(input?.snapshot);
  if (!isLocalDbRemoteApplyEnabled(input?.env)) {
    return { applied: 0, skipped: total };
  }
  const companyId = String(input?.companyId ?? "").trim();
  const store = input?.store ?? bridgeTarget;
  const snapshot = input?.snapshot;
  if (!companyId || !store || !snapshot) return { applied: 0, skipped: total };

  const ctx = createContext(store, companyId, input.onlyNewer !== false, input.originDevice);
  const fallbackAt = typeof input.now === "string" && input.now ? input.now : new Date().toISOString();

  for (const collection of SNAPSHOT_COLLECTIONS) {
    const table = COLLECTION_TABLES[collection];
    const list = (snapshot as unknown as Record<string, unknown>)[collection];
    if (!Array.isArray(list)) continue;
    for (const entity of list) {
      if (!entity || typeof entity !== "object") {
        ctx.result.skipped += 1;
        continue;
      }
      const id = entityId(entity) || inventoryKey(entity);
      const meta = snapshotMeta(snapshot, table, id) ?? entityMeta(entity);
      mergeEntity(ctx, collection, table, entity, meta);
    }
  }

  // Lápidas explícitas: único camino de borrado, y solo sobre lo ya proyectado.
  for (const [table, ids] of Object.entries(snapshot.deleted ?? {})) {
    const spec = CONVERTERS[table as LocalTable];
    if (!spec || !Array.isArray(ids)) continue;
    for (const id of ids) {
      applyTombstone(ctx, table as LocalTable, spec.collection, id, snapshotMeta(snapshot, table as LocalTable, id), fallbackAt);
    }
  }

  // Configuración de tienda solo de relleno: sin ella la sombra leería un JSON
  // sin `companies`/`company_settings` y reescribiría ambas tablas sintéticas en
  // cada pasada. Si la store ya tiene configuración, no se toca (edición local)
  // y no cuenta como entrada aplicada.
  const incomingConfig = asObject(snapshot.storeConfig);
  const currentConfig = asObject(ctx.state.storeConfig);
  if (incomingConfig && Object.keys(incomingConfig).length > 0) {
    if (!currentConfig || Object.keys(currentConfig).length === 0) {
      ctx.extra.storeConfig = incomingConfig;
    }
  }

  return publish(ctx, store);
}

// ---------------------------------------------------------------------------
// API pública: filas del almacén → store (journal del hub, compatibilidad)
// ---------------------------------------------------------------------------

function configProjection(
  settings: LocalRowLike | null,
  company: LocalRowLike | null
): Record<string, unknown> | null {
  const settingsRecord = settings ? asObject(settings.config) : null;
  const projected: Record<string, unknown> = settingsRecord ? { ...settingsRecord } : {};
  const storeName =
    (settingsRecord && typeof settingsRecord.storeName === "string" && settingsRecord.storeName) ||
    (settings && typeof settings.store_name === "string" && settings.store_name) ||
    (company && typeof company.name === "string" && company.name) ||
    "";
  if (storeName) projected.storeName = storeName;
  // Sin fila de configuración no se puede reconstruir address/phone: no se toca.
  if (!settingsRecord) return null;
  return projected;
}

function pickKeys(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = asObject(source) ?? {};
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in record) picked[key] = record[key];
  }
  return picked;
}

function rowMeta(row: LocalRowLike): SnapshotRowMeta {
  return {
    version: rowVersion(row),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
    ...(typeof row.origin_device === "string" ? { originDevice: row.origin_device } : {})
  };
}

/**
 * Proyecta un lote de filas del almacén (con sus lápidas) a la store.
 * Se conserva para el camino por filas: el hub conoce los ids tocados y puede
 * entregar solo esos, incluidos los borrados explícitos.
 */
export function applyLocalRowsToStore(input: ApplyLocalRowsInput): StoreBridgeResult {
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  const deletions = Array.isArray(input?.deletedIds) ? input.deletedIds : [];
  const total = rows.length + deletions.length;

  if (!isLocalDbRemoteApplyEnabled(input?.env)) {
    return { applied: 0, skipped: total };
  }
  const companyId = String(input?.companyId ?? "").trim();
  const store = input?.store ?? bridgeTarget;
  if (!companyId || !store) return { applied: 0, skipped: total };

  const ctx = createContext(store, companyId, true);
  const fallbackAt = typeof input.now === "string" && input.now ? input.now : new Date().toISOString();
  const originDevice = ctx.originDevice;

  const resolveDeletion = (
    entry: DeletedIdInput
  ): { table: LocalTable | null; id: string; meta: SnapshotRowMeta | null } => {
    if (typeof entry === "string") {
      const separator = entry.indexOf(":");
      const candidate = separator > 0 ? (entry.slice(0, separator) as LocalTable) : null;
      if (candidate && (CONVERTERS[candidate] || CONFIG_TABLES.has(candidate))) {
        return { table: candidate, id: entry.slice(separator + 1), meta: null };
      }
      // Id suelto: solo se borra de la tabla donde ya exista una huella.
      for (const key of stamps.keys()) {
        const parts = key.split("|");
        if (parts.length === 3 && parts[0] === companyId && parts[2] === entry) {
          return {
            table: parts[1] as LocalTable,
            id: entry,
            meta: { version: stamps.get(key)!.version, updatedAt: fallbackAt }
          };
        }
      }
      return { table: null, id: entry, meta: null };
    }
    if (entry && typeof entry === "object") {
      const id = String(entry.id ?? "");
      const version = Number(entry.version);
      // Sin versión explícita se hereda la de la huella y decide la fecha: una
      // lápida del mismo lote no debe descartarse por "parecer" más vieja.
      const known = stamps.get(stampKey(companyId, entry.table, id));
      return {
        table: entry.table,
        id,
        meta: {
          version: Number.isFinite(version) && version > 0 ? version : known ? known.version : 1,
          updatedAt: entry.updatedAt ?? fallbackAt
        }
      };
    }
    return { table: null, id: "", meta: null };
  };

  // Primero las lápidas explícitas: liberan ids que el lote pudiera traer vivas.
  for (const entry of deletions) {
    const resolved = resolveDeletion(entry);
    const spec = resolved.table ? CONVERTERS[resolved.table] : null;
    if (!spec) {
      ctx.result.skipped += 1;
      continue;
    }
    applyTombstone(ctx, resolved.table!, spec.collection, resolved.id, resolved.meta, fallbackAt);
  }

  const grouped = new Map<LocalTable, BridgedRow[]>();
  for (const entry of rows) {
    if (!entry || !entry.table || !entry.row) {
      ctx.result.skipped += 1;
      continue;
    }
    const bucket = grouped.get(entry.table) ?? [];
    bucket.push(entry);
    grouped.set(entry.table, bucket);
  }

  let settingsRow: LocalRowLike | null = null;
  let companyRow: LocalRowLike | null = null;

  for (const [table, bucket] of grouped) {
    if (table === "company_settings" || table === "companies") {
      for (const entry of bucket) {
        const row = entry.row;
        if (row.company_id && row.company_id !== companyId) {
          ctx.result.skipped += 1;
          continue;
        }
        if (isTombstoneRow(row)) {
          ctx.result.skipped += 1;
          continue;
        }
        if (table === "company_settings" && (!settingsRow || row.id === companyId)) settingsRow = row;
        if (table === "companies" && (!companyRow || row.id === companyId)) companyRow = row;
      }
      continue;
    }

    const spec = CONVERTERS[table];
    if (!spec) {
      ctx.result.skipped += bucket.length;
      continue;
    }

    for (const entry of bucket) {
      const row = entry.row;
      if (row.company_id && row.company_id !== companyId) {
        ctx.result.skipped += 1;
        continue;
      }
      if (isTombstoneRow(row)) {
        // Una fila con deleted_at es una lápida explícita, no una entidad.
        applyTombstone(ctx, table, spec.collection, row.id, rowMeta({
          ...row,
          version: rowVersion(row),
          updated_at: typeof row.deleted_at === "string" ? row.deleted_at : fallbackAt
        }), fallbackAt);
        continue;
      }

      const entity = entry.entity ?? spec.convert(row as never);
      if (!entity) {
        ctx.result.skipped += 1;
        continue;
      }
      mergeEntity(ctx, spec.collection, table, entity, rowMeta(row));
    }
  }

  // Configuración de la empresa: se fusiona, nunca se reemplaza a ciegas y
  // nunca se toca si el lote no trae filas de configuración.
  if (settingsRow || companyRow) {
    const projected = configProjection(settingsRow, companyRow);
    const key = stampKey(companyId, "company_settings", companyId);
    const stamp = stamps.get(key);
    const row = (settingsRow ?? companyRow)!;
    if (!projected) {
      ctx.result.skipped += 1;
    } else {
      const hash = bridgeEntityHash(projected);
      const currentConfig = asObject(ctx.state.storeConfig) ?? {};
      const currentHash = bridgeEntityHash(pickKeys(currentConfig, Object.keys(projected)));
      if (currentHash === hash) {
        if (!stamp || isNewerThan(rowMeta(row), stamp)) stamps.set(key, stampOf(rowMeta(row), hash, originDevice));
        ctx.result.skipped += 1;
      } else if (stamp && !isNewerThan(rowMeta(row), stamp)) {
        ctx.result.skipped += 1;
      } else {
        const next: Record<string, unknown> = { ...currentConfig, ...projected };
        // StoreConfig mínimo que la UI asume presente.
        if (typeof next.address !== "string") next.address = "";
        if (typeof next.phone !== "string") next.phone = "";
        if (typeof next.storeName !== "string") next.storeName = "";
        ctx.extra.storeConfig = next;
        stamps.set(key, stampOf(rowMeta(row), hash, originDevice));
        ctx.result.applied += 1;
      }
    }
  }

  return publish(ctx, store);
}

// ---------------------------------------------------------------------------
// compatibilidad
// ---------------------------------------------------------------------------

/**
 * Alias histórico. El refresco real (hidratar + debounce + evento) vive en
 * bootHydration; se importa de forma diferida para no crear un ciclo estático
 * entre ambos módulos.
 */
export async function refreshStoreFromLocalDb(
  companyId: string,
  options: {
    reason?: string;
    driver?: unknown;
    store?: BridgeStore | null;
    env?: LocalDbSourceEnv;
    now?: () => string;
  } = {}
): Promise<StoreBridgeResult> {
  try {
    const module = await import("./bootHydration");
    return await module.refreshStoreFromLocalDb(companyId, options as never);
  } catch {
    return EMPTY_RESULT;
  }
}
