/**
 * Transporte real del motor de sincronización hacia Supabase.
 *
 * El cliente HTTP ya lleva la sesión y el token: este módulo no lee
 * credenciales ni sessionStorage. Solo serializa el lote con los nombres de
 * columna del journal local y valida el acuse antes de devolverlo al motor.
 */
import { getDeviceId } from "../lanPresence";
import type { LocalRow } from "../localDb/contract";
import type {
  CloudChange,
  CloudChangeBatch,
  CloudPushResult,
  CloudTransport
} from "./contract";

/** Respuesta mínima de `rpc`; el cliente real devuelve además count/status. */
export interface CloudRpcResult {
  data?: unknown;
  error?: unknown;
}

/**
 * Cliente estructural: basta con un objeto que exponga `rpc`. Así el
 * `SupabaseClient` real encaja sin arrastrar sus tipos al contrato.
 */
export interface CloudRpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>
  ): PromiseLike<CloudRpcResult> | CloudRpcResult;
}

/** Cambio con los nombres exactos del journal (snake_case), sin camelCase. */
export interface SerializedCloudChange {
  seq: number;
  table: string;
  row_id: string;
  op: "upsert" | "delete";
  row: LocalRow | null;
  deleted_at: string | null;
  /**
   * Equipo que asigna el `seq`. La bandeja remota tiene PK
   * (`company_id`, `origin_device`, `seq`): sin este campo, el `seq` de dos
   * equipos choca y el segundo lote se pierde en silencio.
   */
  origin_device: string;
}

export interface SupabaseTransportOptions {
  client: CloudRpcClient | null;
  /** Nombre de la función SQL; coincide con la migración de la bandeja. */
  rpcName?: string;
  /** Id de este equipo; por defecto el mismo que localDb usa en `origin_device`. */
  deviceId?: string;
}

export const DEFAULT_INGEST_RPC = "ingest_local_changes";

/** Tope del cursor en la migración: un bigint fuera de rango es un error. */
const MAX_CURSOR = 1_000_000_000_000;

let cachedOriginDevice: string | null = null;

/**
 * Id del equipo local, el mismo que localDb estampa en `origin_device`.
 * Se memoiza porque el valor no cambia en la sesión y leerlo una vez por
 * cambio del lote sería trabajo repetido.
 */
function localOriginDevice(): string {
  if (cachedOriginDevice !== null) return cachedOriginDevice;
  try {
    cachedOriginDevice = String(getDeviceId() ?? "").trim();
  } catch {
    cachedOriginDevice = "";
  }
  return cachedOriginDevice;
}

/**
 * Serializa un cambio con los nombres del journal.
 *
 * `origin_device` es el equipo que numera el `seq`, no el autor original de la
 * fila: un cambio aplicado desde otro equipo reenviaría un `seq` ajeno y
 * volvería a chocar contra su PK. Por eso nunca se toma `row.origin_device`.
 */
export function serializeChange(
  change: CloudChange,
  originDevice?: string
): SerializedCloudChange {
  return {
    seq: change.seq,
    table: change.table,
    row_id: change.rowId,
    op: change.op,
    // Los deletes no llevan fila; se envía null explícito para no omitir la clave.
    row: change.row ?? null,
    deleted_at: change.deletedAt ?? null,
    origin_device: (originDevice ?? "").trim() || localOriginDevice()
  };
}

export function createSupabaseCloudTransport(
  options: SupabaseTransportOptions
): CloudTransport {
  const client = options.client;
  const rpcName = options.rpcName?.trim() || DEFAULT_INGEST_RPC;
  const deviceId = options.deviceId?.trim() || "";

  return {
    async push(batch: CloudChangeBatch): Promise<CloudPushResult> {
      if (!client) throw new Error("Supabase no está configurado");

      const cursor = batch?.cursor;
      if (!Number.isInteger(cursor) || cursor < 0) {
        throw new Error("El lote de cambios no tiene un cursor válido.");
      }
      // Un cursor por encima del tope del servidor haría fallar el bigint.
      if (cursor > MAX_CURSOR) {
        throw new Error("El cursor del lote supera el límite permitido.");
      }

      let response: CloudRpcResult;
      try {
        response = await client.rpc(rpcName, {
          p_company_id: batch.companyId,
          p_cursor: cursor,
          p_changes: (batch.changes ?? []).map((change) => serializeChange(change, deviceId))
        });
      } catch (error) {
        throw new Error(describeRpcFailure(error));
      }

      if (response?.error) throw new Error(describeRpcFailure(response.error));

      return { acceptedThrough: readAcceptedThrough(response?.data, cursor) };
    }
  };
}

function readAcceptedThrough(data: unknown, cursor: number): number {
  const raw =
    data !== null && typeof data === "object"
      ? (data as { acceptedThrough?: unknown }).acceptedThrough
      : data;

  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Error("La nube devolvió un acuse inválido.");
  }
  if (raw < 0) {
    throw new Error("La nube devolvió un acuse inválido.");
  }
  if (raw > cursor) {
    throw new Error("La nube confirmó más cambios de los que se enviaron.");
  }
  return raw;
}

function describeRpcFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error !== null
          ? String((error as { message?: unknown }).message ?? "")
          : "";
  const clean = message.trim();
  return clean
    ? `No se pudo sincronizar con la nube: ${clean.slice(0, 300)}`
    : "No se pudo sincronizar con la nube.";
}
