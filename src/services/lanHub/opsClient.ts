/**
 * Cliente de operaciones del hub LAN.
 *
 * El hub es el único escritor: los equipos emparejados solo proponen lotes de
 * operaciones idempotentes por `actionId`. Este módulo arma el sobre, firma con
 * el helper de `auth.ts` (misma cadena canónica y mismas cabeceras que el
 * servidor), reintenta con backoff acotado únicamente ante red/5xx y traduce el
 * acuse del hub a un estado por operación.
 *
 * Notas de idempotencia:
 * - El `actionId` lo pone quien llama y nunca se reescribe ni se regenera entre
 *   reintentos: reintentar es reenviar exactamente la misma propuesta.
 * - El hub responde `duplicate` cuando ya aplicó ese `actionId`; eso es éxito,
 *   no un conflicto, porque el estado final es el deseado.
 * - Cada intento se firma con un nonce nuevo (el hub recuerda nonces), pero el
 *   cuerpo y los `actionId` permanecen intactos.
 */
import { createHubRequestSigner } from "./client";
import { HUB_AUTH_HEADERS } from "./shared";
import { HUB_ROUTES, type HubOpsResponse } from "./protocol";
import type { LocalRow, LocalTable } from "../localDb/contract";

/**
 * Operación propuesta al hub. Misma forma que aplica el handler v1
 * (`table` + filas completas + ids a borrar): el hub valida y decide.
 */
export interface HubOperation {
  actionId: string;
  table: LocalTable;
  rows: LocalRow[];
  deletes: string[];
}

export type HubOpOutcomeStatus = "accepted" | "duplicate" | "rejected";

/** Acuse por operación. `error` solo aparece cuando el hub la rechazó. */
export interface HubOpOutcome {
  actionId: string;
  status: HubOpOutcomeStatus;
  error?: string;
}

export type HubOpsBatchResult =
  | {
      ok: true;
      results: HubOpOutcome[];
      latestSeq: number;
      serverTime: string;
    }
  | {
      ok: false;
      /** Código del hub (`unauthorized`, `device_mismatch`) o local (`network_error`, `timeout`). */
      error: string;
      /**
       * true si la propuesta pudo no haberse aplicado y conviene reenviar el
       * mismo lote con los mismos `actionId`. Un 4xx no se reintenta.
       */
      retryable: boolean;
    };

export interface HubOpsClientOptions {
  /** Raíz del hub, p. ej. `http://192.168.1.10:48900`; admite barra final. */
  baseUrl: string;
  /** Token entregado al emparejar; nunca viaja en la petición. */
  token: string;
  /** Identificador del equipo; debe coincidir con el del token. */
  deviceId: string;
  fetchImpl?: typeof fetch;
  /** Reloj inyectable para firmar en pruebas. */
  now?: () => number;
  /** Espera inyectable: las pruebas la sustituyen para no dormir de verdad. */
  sleep?: (ms: number) => Promise<void>;
  /** Intentos totales del lote (por defecto 3). */
  maxAttempts?: number;
  /** Primer retardo del backoff en ms (por defecto 250). */
  baseDelayMs?: number;
  /** Tope del retardo en ms (por defecto 2000). */
  maxDelayMs?: number;
  /** Corte por intento en ms (por defecto 15000). */
  timeoutMs?: number;
}

export interface HubOpsClient {
  readonly baseUrl: string;
  readonly deviceId: string;
  /** Envía un lote y devuelve un acuse por operación. */
  push(operations: HubOperation[]): Promise<HubOpsBatchResult>;
  /** Atajo de una sola operación; en un fallo de transporte queda como rechazada con el código. */
  pushOne(operation: HubOperation): Promise<HubOpOutcome>;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Marca interna para distinguir el corte por tiempo de un fallo de red. */
class OpsTimeoutError extends Error {}

interface AttemptSuccess {
  ok: true;
  response: HubOpsResponse;
}

interface AttemptFailure {
  ok: false;
  error: string;
  retryable: boolean;
}

type Attempt = AttemptSuccess | AttemptFailure;

/**
 * Guardas explícitas: el proyecto compila sin `strictNullChecks` y la
 * discriminación por `ok` no estrecha la unión por sí sola.
 */
function isAttemptFailure(candidate: Attempt): candidate is AttemptFailure {
  return candidate.ok === false;
}

function isBatchFailure(
  result: HubOpsBatchResult
): result is Extract<HubOpsBatchResult, { ok: false }> {
  return result.ok === false;
}

/** `accepted` y `duplicate` son éxito: el estado final ya es el propuesto. */
export function isHubOpSuccess(status: HubOpOutcomeStatus): boolean {
  return status !== "rejected";
}

function normalizeBaseUrl(raw: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new Error("La dirección del hub LAN es obligatoria");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("La dirección del hub LAN no es válida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("El hub LAN debe usar http o https");
  }
  if (url.username || url.password) {
    throw new Error("La dirección del hub LAN no debe incluir credenciales");
  }
  if (url.search || url.hash) {
    throw new Error("La dirección del hub LAN no debe incluir query ni fragmento");
  }
  return value.replace(/\/+$/, "");
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}

function numberOption(
  value: number | undefined,
  fallback: number,
  name: string,
  min: number,
  integer: boolean
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} debe ser ${integer ? "un entero" : "un número"} mayor o igual que ${min}`);
  }
  return value;
}

/** Código de error del sobre `{error: "code"}` del hub; cadena vacía si no lo hay. */
function hubErrorCode(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const code = (payload as { error?: unknown }).error;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Normaliza una propuesta. Se recorta el `actionId` una sola vez (el hub
 * también lo recorta) y desde ahí se conserva literal en todos los reintentos.
 */
function normalizeOperation(raw: unknown, index: number): HubOperation {
  const record = asRecord(raw);
  if (!record) throw new Error(`La operación ${index} del hub LAN no es válida`);
  const actionId = requireText(record.actionId, `La operación ${index} del hub LAN necesita un actionId`).trim();
  const table = requireText(record.table, `La operación ${index} del hub LAN necesita una tabla`).trim();
  const rowsRaw = record.rows === undefined ? [] : record.rows;
  const deletesRaw = record.deletes === undefined ? [] : record.deletes;
  if (!Array.isArray(rowsRaw) || !Array.isArray(deletesRaw)) {
    throw new Error(`La operación ${index} del hub LAN tiene filas o borrados inválidos`);
  }
  const deletes = deletesRaw.map((id) =>
    requireText(id, `La operación ${index} del hub LAN tiene un id de borrado inválido`).trim()
  );
  return { actionId, table: table as LocalTable, rows: rowsRaw as LocalRow[], deletes };
}

function mapStatus(raw: unknown): HubOpOutcomeStatus | null {
  if (raw === "applied" || raw === "accepted") return "accepted";
  if (raw === "duplicate") return "duplicate";
  if (raw === "rejected") return "rejected";
  return null;
}

/** Traduce el sobre del hub a un estado por operación, en el orden enviado. */
function mapOutcomes(operations: HubOperation[], payload: Record<string, unknown>): HubOpOutcome[] {
  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  const byAction = new Map<string, Record<string, unknown>>();
  for (const raw of rawResults) {
    const result = asRecord(raw);
    const actionId = result ? requireTextQuiet(result.actionId) : "";
    if (result && actionId) byAction.set(actionId, result);
  }

  return operations.map((operation) => {
    const result = byAction.get(operation.actionId);
    const status = result ? mapStatus(result.status) : null;
    if (!result || !status) {
      // El hub respondió pero sin acuse para esta operación: no se puede
      // asumir aplicada, así que queda rechazada con un código explícito.
      return { actionId: operation.actionId, status: "rejected", error: "missing_result" };
    }
    if (status === "rejected") {
      const error = typeof result.error === "string" && result.error.trim() ? result.error.trim() : "rejected";
      return { actionId: operation.actionId, status, error };
    }
    return { actionId: operation.actionId, status };
  });
}

function requireTextQuiet(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createHubOpsClient(options: HubOpsClientOptions): HubOpsClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token = requireText(options.token, "Falta el token del equipo para el hub LAN");
  const deviceId = requireText(options.deviceId, "Falta el identificador del equipo para el hub LAN");
  const clock = options.now ?? (() => Date.now());
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = numberOption(options.maxAttempts, DEFAULT_ATTEMPTS, "maxAttempts", 1, true);
  const baseDelayMs = numberOption(options.baseDelayMs, DEFAULT_BASE_DELAY_MS, "baseDelayMs", 0, false);
  const maxDelayMs = numberOption(options.maxDelayMs, DEFAULT_MAX_DELAY_MS, "maxDelayMs", 0, false);
  const timeoutMs = numberOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 1, false);
  const url = baseUrl + HUB_ROUTES.ops;
  // WebCrypto comparte cadena canónica con el hub y no arrastra node:crypto.
  const signer = createHubRequestSigner(token);

  /** Backoff exponencial acotado: base, 2·base, 4·base… sin pasar del tope. */
  function delayFor(failedAttempt: number): number {
    return Math.min(maxDelayMs, baseDelayMs * 2 ** (failedAttempt - 1));
  }

  async function attemptOnce(bodyText: string): Promise<Attempt> {
    const timestamp = clock();
    if (!Number.isFinite(timestamp)) {
      return { ok: false, error: "invalid_clock", retryable: false };
    }
    // Nonce nuevo por intento (anti-replay del hub), cuerpo y actionId intactos.
    const nonce = signer.nonce();
    let signature: string;
    try {
      signature = await signer.sign("POST", HUB_ROUTES.ops, timestamp, nonce, bodyText);
    } catch {
      return { ok: false, error: "signing_unavailable", retryable: false };
    }

    const headers: Record<string, string> = {
      [HUB_AUTH_HEADERS.device]: deviceId,
      [HUB_AUTH_HEADERS.timestamp]: String(timestamp),
      [HUB_AUTH_HEADERS.nonce]: nonce,
      [HUB_AUTH_HEADERS.signature]: signature,
      accept: "application/json",
      "content-type": "application/json"
    };

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          // El fetch ya terminó; el aborto sobra.
        }
        reject(new OpsTimeoutError("timeout"));
      }, timeoutMs);
    });

    let response: Response;
    try {
      response = await Promise.race([
        doFetch(url, {
          method: "POST",
          headers,
          body: bodyText,
          signal: controller?.signal,
          cache: "no-store"
        }),
        timeout
      ]);
    } catch (error) {
      // Solo red o tiempo agotado: la operación pudo aplicarse o no.
      if (error instanceof OpsTimeoutError) return { ok: false, error: "timeout", retryable: true };
      return { ok: false, error: "network_error", retryable: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const text = await response.text().catch(() => "");
    let payload: unknown = null;
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const code = hubErrorCode(payload) || `http_${response.status}`;
      // 5xx es transitorio; 4xx (incluido 401) no se reintenta nunca.
      return { ok: false, error: code, retryable: response.status >= 500 && response.status <= 599 };
    }

    const record = asRecord(payload);
    if (!record) {
      return { ok: false, error: "invalid_response", retryable: false };
    }
    return { ok: true, response: record as unknown as HubOpsResponse };
  }

  async function run(operations: HubOperation[]): Promise<HubOpsBatchResult> {
    if (operations.length === 0) {
      return { ok: true, results: [], latestSeq: 0, serverTime: "" };
    }

    let bodyText: string;
    try {
      bodyText = JSON.stringify({
        deviceId,
        ops: operations.map((operation) => ({
          actionId: operation.actionId,
          table: operation.table,
          rows: operation.rows,
          deletes: operation.deletes
        }))
      });
    } catch {
      // Payload no serializable (ciclos, BigInt): no tiene sentido firmarlo.
      return { ok: false, error: "invalid_payload", retryable: false };
    }

    let failure: AttemptFailure = { ok: false, error: "network_error", retryable: true };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await attemptOnce(bodyText);
      if (!isAttemptFailure(outcome)) {
        const response = outcome.response;
        return {
          ok: true,
          results: mapOutcomes(operations, asRecord(response) ?? {}),
          latestSeq: Number.isFinite(response.latestSeq) ? Number(response.latestSeq) : 0,
          serverTime: typeof response.serverTime === "string" ? response.serverTime : ""
        };
      }
      failure = outcome;
      if (!outcome.retryable || attempt >= maxAttempts) break;
      await sleep(delayFor(attempt));
    }
    return failure;
  }

  return {
    baseUrl,
    deviceId,

    push(operations: HubOperation[]): Promise<HubOpsBatchResult> {
      if (!Array.isArray(operations)) {
        return Promise.reject(new Error("Las operaciones del hub LAN deben ser una lista"));
      }
      let normalized: HubOperation[];
      try {
        normalized = operations.map((operation, index) => normalizeOperation(operation, index));
      } catch (error) {
        return Promise.reject(error);
      }
      return run(normalized);
    },

    async pushOne(operation: HubOperation): Promise<HubOpOutcome> {
      let normalized: HubOperation;
      try {
        normalized = normalizeOperation(operation, 0);
      } catch (error) {
        return Promise.reject(error);
      }
      const batch = await run([normalized]);
      if (!isBatchFailure(batch)) {
        return batch.results[0] ?? { actionId: normalized.actionId, status: "rejected", error: "missing_result" };
      }
      // Sin acuse no se puede afirmar que se aplicó: se informa el código y se
      // reenvía con el mismo actionId (el hub deduplica si ya la aplicó).
      return { actionId: normalized.actionId, status: "rejected", error: batch.error };
    }
  };
}
