/**
 * Utilidades de red del cliente.
 *
 * Render (plan gratuito) suspende la instancia tras ~15 minutos sin tráfico y
 * el primer request puede tardar 30-60 s. Los `fetch` del proyecto no tenían
 * límite de tiempo ni reintento: una petición podía quedar colgada dejando la
 * pantalla esperando, o fallar a la primera y mostrar un error duro al usuario.
 *
 * Aquí se centraliza: tiempo máximo, un reintento exponencial con jitter solo
 * para fallos transitorios (red, timeout, 5xx y 429) y mensajes en español.
 * Las firmas son nuevas, así que ningún test existente cambia de contrato.
 */

export class HttpTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`La conexión tardó más de ${Math.round(timeoutMs / 1000)} s en responder.`);
    this.name = 'HttpTimeoutError';
  }
}

export type FetchRetryOptions = {
  /** Tiempo máximo por intento (incluye cuerpo). */
  timeoutMs?: number;
  /** Reintentos adicionales tras el primer intento. */
  retries?: number;
  /** Señal externa para cancelar (p. ej. desmontaje de un componente). */
  signal?: AbortSignal;
};

export const DEFAULT_FETCH_TIMEOUT_MS = 12_000;

/** Solo se reintenta lo que puede mejorar solo: red, timeout y errores de servidor. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Espera exponencial con jitter: evita que todas las cajas reintenten a la vez. */
export function retryDelayMs(attempt: number, baseMs = 400, maxMs = 5_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

function abortError(): Error {
  const error = new Error('La solicitud se canceló.');
  error.name = 'AbortError';
  return error;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  const external = init.signal;
  const forwardAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      clearTimeout(timer);
      throw abortError();
    }
    external.addEventListener('abort', forwardAbort, { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new HttpTimeoutError(timeoutMs);
    if (external?.aborted) throw abortError();
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * `fetch` con timeout y un reintento por defecto. Para operaciones no
 * idempotentes (POST que crea o mueve dinero) hay que pasar `retries: 0` o
 * dejar el reintento al motor de cola offline, que ya usa IDs idempotentes.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: FetchRetryOptions = {}
): Promise<Response> {
  const retries = Math.max(0, options.retries ?? 1);
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchWithTimeout(input, { ...init, signal: options.signal ?? init.signal }, timeoutMs);
      if (attempt < retries && isRetryableHttpStatus(response.status)) {
        // Liberar el cuerpo antes de reintentar para no retener la conexión.
        try { await response.body?.cancel(); } catch { /* sin cuerpo */ }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt + 1)));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= retries) throw error;
      if ((error as Error)?.name === 'AbortError') throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt + 1)));
    }
  }
}

export async function fetchJsonWithRetry<T = unknown>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: FetchRetryOptions = {}
): Promise<{ response: Response; body: T | null }> {
  const response = await fetchWithRetry(input, init, options);
  const body = await response.json().catch(() => null) as T | null;
  return { response, body };
}

/** Mensaje listo para el usuario: sin códigos, sin jerga técnica. */
export function describeNetworkError(error: unknown): string {
  if (error instanceof HttpTimeoutError || (error as Error)?.name === 'TimeoutError') {
    return 'El servidor tardó demasiado en responder. Se reintentará automáticamente.';
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'Sin conexión a Internet. El trabajo se guarda en este equipo y se enviará al reconectar.';
  }
  return 'No se pudo conectar con el servidor. Revisa tu conexión e inténtalo otra vez.';
}
