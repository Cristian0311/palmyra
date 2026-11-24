/**
 * Transporte de descarga (nube → dispositivo) por cursor de tiempo.
 *
 * Complementa el motor de subida: pide solo la ventana de cambios posterior al
 * cursor persistido, la valida y la devuelve lista para el aplicador LWW de
 * `pull.ts`. Reglas que garantiza:
 *
 *  - La empresa de cada fila debe coincidir con la empresa pedida; cualquier
 *    fila ajena se descarta antes de tocar el almacén local.
 *  - Solo viajan tablas con destino local conocido (`isPullableTable`) y con
 *    el nombre local, no el nombre de la tabla cloud.
 *  - Ninguna fila supera `MAX_REMOTE_ROW_BYTES`; una fila gigante se descarta
 *    en lugar de reventar la cuota del almacén local.
 *  - Cursor compuesto: la ventana se pide un milisegundo antes del cursor para
 *    emular `>=` (el RPC filtra con `>` estricto) y las claves
 *    (`table`, `row_id`) ya vistas en la página se deduplican. Así dos filas con
 *    el mismo `updated_at` no quedan fuera, y una página llena de duplicados no
 *    hace girar el cursor en el mismo instante.
 *  - El cursor nunca retrocede: si la nube devuelve uno anterior al pedido se
 *    conserva el del dispositivo.
 *  - Nunca lanza: un fallo de red, una respuesta corrupta o un RPC ausente se
 *    devuelven como lote vacío con `error`.
 */
import type { LocalRow, LocalTable } from "../localDb/contract";
import { MATERIALIZE_MAP } from "./materializeMapping";
import { isPullableTable } from "./pull";
import type { CloudRpcClient, CloudRpcResult } from "./supabaseTransport";

export type RemoteChangeOp = "upsert" | "delete";

/** Un cambio remoto ya validado, con el nombre local de la tabla. */
export interface RemoteChange {
  table: LocalTable;
  rowId: string;
  op: RemoteChangeOp;
  row?: LocalRow;
  updatedAt: string;
}

export interface RemotePullRequest {
  companyId: string;
  /** `updated_at` del último cambio aplicado; `null` en la primera descarga. */
  cursor: string | null;
  limit?: number;
}

export interface RemotePullResult {
  changes: RemoteChange[];
  /** Cursor a persistir; `null` solo si el servidor no lo informa. */
  nextCursor: string | null;
  hasMore: boolean;
  /** Presente cuando el lote no se pudo obtener o validar. */
  error?: string;
  /** Filas descartadas por validación (empresa, tabla, tamaño, forma o duplicado). */
  rejected?: number;
}

export interface RemotePullTransport {
  pull(request: RemotePullRequest): Promise<RemotePullResult>;
}

export interface SupabasePullTransportOptions {
  client: CloudRpcClient | null;
  /** Nombre de la función SQL; coincide con la migración del pull. */
  rpcName?: string;
  now?: () => number;
  /** Días máximos de historial por descarga (seguridad). */
  maxDays?: number;
}

export const DEFAULT_PULL_RPC = "pull_cloud_changes";

/** La descarga se intenta como mucho una vez cada 30 minutos. */
export const PULL_INTERVAL_MS = 30 * 60 * 1000;

/** Filas por lote de descarga. */
export const PULL_BATCH = 500;

/** Tope duro de filas por petición (la migración lo vuelve a acotar). */
export const PULL_MAX_LIMIT = 1000;

/**
 * Ventana máxima de historial: un cursor más viejo se recorta a este horizonte.
 * El almacén local es la fuente de verdad; no se reconstruye historia antigua
 * en segundo plano (eso es trabajo del bootstrap/historial bajo demanda).
 */
export const PULL_MAX_DAYS = 7;

/** Tope por fila: por encima se descarta para no romper la cuota local. */
export const MAX_REMOTE_ROW_BYTES = 256 * 1024;

/** Nombre cloud → tabla local, derivado del contrato de materialización. */
const CLOUD_TO_LOCAL: ReadonlyMap<string, LocalTable> = buildCloudToLocal();

function buildCloudToLocal(): Map<string, LocalTable> {
  const map = new Map<string, LocalTable>();
  for (const local of Object.keys(MATERIALIZE_MAP) as LocalTable[]) {
    const spec = MATERIALIZE_MAP[local];
    if (!spec) continue;
    map.set(spec.table, local);
  }
  // Tablas sin destino de materialización (catálogo y ajustes) mantienen su
  // nombre cuando el contrato local ya usa el mismo identificador.
  map.set("companies", "companies");
  map.set("company_settings", "company_settings");
  return map;
}

/** Tabla local para un nombre cloud; `null` si no hay destino seguro. */
export function localTableForCloud(cloudTable: string): LocalTable | null {
  const local = CLOUD_TO_LOCAL.get(cloudTable);
  if (!local || !isPullableTable(local)) return null;
  return local;
}

export function createSupabasePullTransport(
  options: SupabasePullTransportOptions
): RemotePullTransport {
  const client = options.client;
  const rpcName = options.rpcName?.trim() || DEFAULT_PULL_RPC;
  const clock = options.now ?? (() => Date.now());
  const maxDays = positiveInt(options.maxDays, PULL_MAX_DAYS);

  function horizon(nowMs: number): string {
    return new Date(nowMs - maxDays * 86_400_000).toISOString();
  }

  return {
    async pull(request: RemotePullRequest): Promise<RemotePullResult> {
      const companyId = typeof request?.companyId === "string" ? request.companyId.trim() : "";
      const cursor = normalizeCursor(request?.cursor);
      if (!companyId) {
        return { changes: [], nextCursor: cursor, hasMore: false, error: "Empresa no identificada." };
      }
      if (!client) {
        return {
          changes: [],
          nextCursor: cursor,
          hasMore: false,
          error: "Supabase no está configurado"
        };
      }

      const limit = clampLimit(request?.limit);
      const nowMs = safeNow(clock);
      // Seguridad: nunca se pide una ventana anterior al horizonte permitido.
      const since = cursor && Date.parse(cursor) > Date.parse(horizon(nowMs)) ? cursor : horizon(nowMs);

      let response: CloudRpcResult;
      try {
        response = await client.rpc(rpcName, {
          p_company_id: companyId,
          // El RPC pagina con `updated_at > p_since`; se pide un milisegundo
          // antes para incluir las filas que comparten el cursor. Repetirlas es
          // inocuo: el LWW local las descarta y la clave ya vista se deduplica.
          p_since: inclusiveSince(since),
          p_limit: limit
        });
      } catch (error) {
        return {
          changes: [],
          nextCursor: cursor,
          hasMore: false,
          error: describeFailure(error)
        };
      }

      if (response?.error) {
        return {
          changes: [],
          nextCursor: cursor,
          hasMore: false,
          error: describeFailure(response.error)
        };
      }

      try {
        return settlePull(readPullPayload(response?.data, companyId, cursor, limit), cursor);
      } catch {
        return {
          changes: [],
          nextCursor: cursor,
          hasMore: false,
          error: "Respuesta de descarga inválida."
        };
      }
    }
  };
}

/**
 * Marca inferior inclusiva para un cursor dado.
 *
 * El RPC compara con `>` estricto; pedir `cursor - 1 ms` equivale a `>=` sin
 * cambiar la firma ni inventar parámetros que el servidor aún no acepta.
 */
export function inclusiveSince(at: string): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return at;
  return new Date(ms - 1).toISOString();
}

/** La marca más reciente de una página: cursor del servidor o `updated_at`. */
function latestStamp(result: RemotePullResult): string | null {
  let latest = result.nextCursor && Number.isFinite(Date.parse(result.nextCursor)) ? Date.parse(result.nextCursor) : null;
  for (const change of result.changes) {
    const ms = Date.parse(change.updatedAt);
    if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/**
 * Cierra la página sin dejar el cursor girando en el mismo instante.
 *
 * Si la página llega llena pero todo su contenido está en la marca del cursor,
 * repetir la misma ventana devolvería exactamente los mismos duplicados: se
 * informa `hasMore: false` (no hay nada nuevo alcanzable) y se conserva la
 * marca, porque avanzar más allá saltaría filas sin haberse entregado.
 */
function settlePull(result: RemotePullResult, cursor: string | null): RemotePullResult {
  if (!result.hasMore) return result;
  const pageMax = latestStamp(result);
  const currentMs = cursor ? Date.parse(cursor) : Number.NaN;
  if (pageMax === null || !Number.isFinite(currentMs)) return result;
  if (Date.parse(pageMax) > currentMs) return result;
  return { ...result, hasMore: false };
}

/**
 * Valida la respuesta del RPC. Es puro: se prueba sin cliente ni red.
 *
 * `cursor` es el cursor vigente del dispositivo; el devuelto nunca es anterior.
 * Cada (`table`, `row_id`) viaja una sola vez por página: la ventana inclusiva
 * puede devolver filas ya vistas y aplicarlas dos veces no debe consumir cupo.
 */
export function readPullPayload(
  data: unknown,
  companyId: string,
  cursor: string | null,
  limit = PULL_BATCH
): RemotePullResult {
  const envelope = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (!envelope) {
    return { changes: [], nextCursor: cursor, hasMore: false, error: "Respuesta de descarga inválida." };
  }

  const rawChanges = Array.isArray(envelope.changes) ? envelope.changes : null;
  if (!rawChanges) {
    return { changes: [], nextCursor: cursor, hasMore: false, error: "Respuesta de descarga inválida." };
  }

  const nextCursor = readNextCursor(envelope, cursor);
  if (nextCursor === undefined) {
    // Un cursor ilegible no se inventa: se conserva el del dispositivo.
    return { changes: [], nextCursor: cursor, hasMore: false, error: "Cursor remoto inválido." };
  }

  const batchLimit = clampLimit(limit);
  const expectedCompany = companyId.trim();
  const changes: RemoteChange[] = [];
  const seen = new Set<string>();
  let accepted = 0;
  let rejected = 0;

  for (const raw of rawChanges) {
    if (accepted >= batchLimit) {
      rejected += 1;
      continue;
    }
    const parsed = parseRemoteChange(raw, expectedCompany);
    if ("reason" in parsed) {
      rejected += 1;
      continue;
    }
    accepted += 1;
    const key = changeKey(parsed.change.table, parsed.change.rowId);
    if (seen.has(key)) {
      rejected += 1;
      continue;
    }
    seen.add(key);
    changes.push(parsed.change);
  }

  // Truncado por el límite pedido: queda página, no solo duplicados.
  const truncated = accepted >= batchLimit && rawChanges.length > accepted;
  const hasMore = envelope.hasMore === true || truncated;
  return rejected > 0
    ? { changes, nextCursor, hasMore, rejected }
    : { changes, nextCursor, hasMore };
}

function changeKey(table: LocalTable, rowId: string): string {
  return `${table}:${rowId}`;
}

type ParsedChange = { change: RemoteChange } | { reason: string };

function parseRemoteChange(raw: unknown, companyId: string): ParsedChange {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { reason: "invalid_row" };
  const entry = raw as Record<string, unknown>;

  const cloudTable = typeof entry.table === "string" ? entry.table.trim() : "";
  const table = localTableForCloud(cloudTable);
  if (!table) return { reason: "blocked_table" };

  const row = asRow(entry.row);
  const rowId = toText(row?.id) || toText(entry.row_id) || toText(entry.rowId);
  if (!rowId) return { reason: "missing_id" };

  const updatedAt = toText(entry.updated_at) || toText(entry.updatedAt) || toText(row?.updated_at);
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) return { reason: "missing_metadata" };

  const op: RemoteChangeOp =
    entry.op === "delete" || row?.deleted_at ? "delete" : entry.op === "upsert" ? "upsert" : "upsert";
  if (entry.op !== undefined && entry.op !== "delete" && entry.op !== "upsert" && !row?.deleted_at) {
    return { reason: "invalid_op" };
  }

  const declaredCompany = toText(row?.company_id);
  if (!declaredCompany || declaredCompany !== companyId) return { reason: "foreign_company" };

  if (!row) return { reason: "missing_row" };
  if (byteLength(row) > MAX_REMOTE_ROW_BYTES) return { reason: "row_too_large" };

  const normalized: LocalRow = {
    ...row,
    id: rowId,
    company_id: declaredCompany,
    updated_at: updatedAt
  };
  return { change: { table, rowId, op, row: normalized, updatedAt } };
}

/** Lee `nextCursor` y lo compara con el vigente: nunca retrocede. */
function readNextCursor(envelope: Record<string, unknown>, current: string | null): string | null | undefined {
  const raw = envelope.nextCursor ?? envelope.next_cursor ?? envelope.cursor;
  if (raw === null || raw === undefined || raw === "") return current;
  const text = toText(raw);
  if (!text || !Number.isFinite(Date.parse(text))) return undefined;
  if (current && Date.parse(text) < Date.parse(current)) return current;
  return text;
}

function asRow(value: unknown): LocalRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as LocalRow;
}

function normalizeCursor(value: unknown): string | null {
  const text = toText(value);
  if (!text || !Number.isFinite(Date.parse(text))) return null;
  return text;
}

function clampLimit(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return PULL_BATCH;
  return Math.min(PULL_MAX_LIMIT, Math.max(1, parsed));
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeNow(clock: () => number): number {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function byteLength(value: unknown): number {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  try {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  } catch {
    // Sin TextEncoder se usa la longitud en caracteres (cota inferior).
  }
  return text.length;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error !== null
          ? String((error as { message?: unknown }).message ?? "")
          : "";
  const clean = message.replace(/\s+/g, " ").trim();
  return clean ? `No se pudo descargar de la nube: ${clean.slice(0, 300)}` : "No se pudo descargar de la nube.";
}
