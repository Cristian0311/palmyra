import type { SignedLease } from "./contract";

/**
 * Revocación de leases consultada a la Edge Function pública `revoke-lease`.
 *
 * El cliente solo envía `leaseId` (GET, sin datos personales) y recibe
 * `{ revoked, revokedAt?, reason? }`. La respuesta se cachea por leaseId para
 * no martillar la red en cada refresco.
 *
 * Regla de oro: un fallo de red NUNCA revoca. La revocación solo se aplica con
 * una respuesta 200 explícita con `revoked: true`; el resto de reglas de
 * licencia (firma, firmeza de reloj, vencimiento) siguen intactas.
 */

export type RevocationFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface LeaseRevocationResult {
  revoked: boolean;
  revokedAt?: string;
  reason?: string;
}

export interface CheckLeaseRevocationOptions {
  fetchImpl?: RevocationFetch;
  /** Base de las funciones, p. ej. `https://proj.supabase.co/functions/v1`. */
  baseUrl?: string | null;
  now?: () => number;
  /** Vigencia de la caché por leaseId. 0 desactiva la caché. */
  ttlMs?: number;
  /**
   * JWT del usuario autenticado. `revoke-lease` se despliega con
   * `verify_jwt = true`, así que sin token la pasarela responde 401 y la
   * revocación queda inoperativa (el cliente falla abierto).
   */
  accessToken?: string | null;
}

/** Una revocación se puede cachear un rato: no cambia de un minuto a otro. */
export const LEASE_REVOCATION_TTL_MS = 5 * 60 * 1000;

/** Tope defensivo del texto devuelto por el servidor. */
const MAX_REASON_LENGTH = 200;

interface RevocationCacheEntry {
  result: LeaseRevocationResult;
  expiresAt: number;
}

const cache = new Map<string, RevocationCacheEntry>();

/**
 * Consultas en vuelo por leaseId. Varios refrescos de licencia simultáneos
 * (arranque, evento online, temporizador) deben compartir un único GET: sin esto
 * cada refresco repetía la misma petición y, mientras el endpoint devolvía 401,
 * se multiplicaban los errores en el log de la plataforma.
 */
const inflight = new Map<string, Promise<LeaseRevocationResult>>();

/** Limpia la caché de revocaciones (pruebas, cambio de entorno). */
export function resetLeaseRevocationCache(): void {
  cache.clear();
  inflight.clear();
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * Base de la función: la explícita, o `VITE_SUPABASE_URL` + `/functions/v1`.
 * Sin base no se hace red (falla abierto).
 */
export function resolveRevocationBaseUrl(explicit?: string | null): string | null {
  if (typeof explicit === "string" && explicit.trim()) return trimBase(explicit.trim());
  try {
    const env = (
      import.meta as ImportMeta & { env?: { VITE_SUPABASE_URL?: unknown } }
    ).env;
    const url = env?.VITE_SUPABASE_URL;
    if (typeof url === "string" && url.trim()) {
      return `${trimBase(url.trim())}/functions/v1`;
    }
  } catch {
    // Sin import.meta.env (Node, pruebas) se usa solo la base explícita.
  }
  return null;
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function sanitizeIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function sanitizeReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, MAX_REASON_LENGTH);
}

/** Solo un `revoked: true` booleano cuenta; el resto es «no revocado». */
function parseRevocationPayload(payload: unknown): LeaseRevocationResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { revoked: false };
  }
  const record = payload as { revoked?: unknown; revokedAt?: unknown; reason?: unknown };
  if (record.revoked !== true) return { revoked: false };
  const revokedAt = sanitizeIsoDate(record.revokedAt);
  const reason = sanitizeReason(record.reason);
  return {
    revoked: true,
    ...(revokedAt ? { revokedAt } : {}),
    ...(reason ? { reason } : {})
  };
}

/**
 * Clave publicable para la cabecera `apikey`: la pasarela de funciones la exige
 * junto al JWT. Sin entorno (Node, pruebas) devuelve null y se omite la cabecera.
 */
function resolveRevocationApiKey(): string | null {
  try {
    const env = (
      import.meta as ImportMeta & { env?: { VITE_SUPABASE_ANON_KEY?: unknown } }
    ).env;
    const key = env?.VITE_SUPABASE_ANON_KEY;
    if (typeof key === "string" && key.trim()) return key.trim();
  } catch {
    // Sin import.meta.env se omite la cabecera.
  }
  return null;
}

async function requestRevocation(
  leaseId: string,
  baseUrl: string,
  options: CheckLeaseRevocationOptions,
  atMs: number,
  ttlMs: number
): Promise<LeaseRevocationResult> {
  const notRevoked: LeaseRevocationResult = { revoked: false };
  const fetchImpl: RevocationFetch =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = `${baseUrl}/revoke-lease?leaseId=${encodeURIComponent(leaseId)}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = resolveRevocationApiKey();
  if (apiKey) headers.apikey = apiKey;
  const accessToken =
    typeof options.accessToken === "string" ? options.accessToken.trim() : "";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      headers
    });
  } catch {
    // Falla abierto: sin red no hay evidencia de revocación.
    return notRevoked;
  }

  if (!response.ok) return notRevoked;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return notRevoked;
  }

  const result = parseRevocationPayload(payload);
  // Un fallo (red, 401, cuerpo inválido) nunca se cachea: podría ocultar una
  // revocación real durante todo el TTL.
  if (ttlMs > 0) {
    cache.set(leaseId, { result, expiresAt: atMs + ttlMs });
  }
  return result;
}

/**
 * Consulta si el lease fue revocado. Nunca lanza: cualquier fallo (red,
 * respuesta inválida, fecha corrupta) se resuelve como «no revocado».
 */
export async function checkLeaseRevocation(
  lease: SignedLease | null,
  options: CheckLeaseRevocationOptions = {}
): Promise<LeaseRevocationResult> {
  const notRevoked: LeaseRevocationResult = { revoked: false };
  if (!lease || typeof lease.leaseId !== "string" || lease.leaseId.trim() === "") {
    return notRevoked;
  }
  const leaseId = lease.leaseId;

  const now = options.now ?? (() => Date.now());
  const atMs = safeNow(now);
  const ttlMs =
    typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs)
      ? Math.max(0, options.ttlMs)
      : LEASE_REVOCATION_TTL_MS;

  const cached = cache.get(leaseId);
  if (cached && atMs < cached.expiresAt) return cached.result;

  const pending = inflight.get(leaseId);
  if (pending) return pending;

  const baseUrl = resolveRevocationBaseUrl(options.baseUrl);
  if (!baseUrl) return notRevoked;

  const task = requestRevocation(leaseId, baseUrl, options, atMs, ttlMs);
  inflight.set(leaseId, task);
  const release = (): void => {
    if (inflight.get(leaseId) === task) inflight.delete(leaseId);
  };
  void task.then(release, release);
  return task;
}
