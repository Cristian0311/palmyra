/**
 * "Despertar" del servidor.
 *
 * En Render gratuito la instancia se suspende y el primer request puede tardar
 * 30-60 s. Cuando la primera sonda supera los 8 s no se trata como error: se
 * publica el estado `waking` ("servidor despertando") y se reintenta UNA vez en
 * segundo plano, sin bloquear la UI ni el trabajo offline.
 *
 * Los consumidores de UI pueden suscribirse a `palmyra:server-wake` o leer
 * `document.documentElement.dataset.serverWake`, sin acoplarse a este módulo.
 */
import { fetchWithTimeout, HttpTimeoutError } from './http';

export type ServerWakeState = 'unknown' | 'awake' | 'waking' | 'unreachable';

export const SERVER_WAKE_EVENT = 'palmyra:server-wake';
export const SERVER_WAKING_MESSAGE = 'El servidor está despertando. Puede tardar hasta un minuto; puedes seguir trabajando mientras tanto.';
export const SERVER_AWAKE_MESSAGE = 'El servidor ya está listo.';
export const SERVER_UNREACHABLE_MESSAGE = 'No se pudo contactar con el servidor. Tu trabajo se guarda en este equipo y se enviará al reconectar.';

const FIRST_PROBE_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 2_500;
const RETRY_PROBE_TIMEOUT_MS = 30_000;

let state: ServerWakeState = 'unknown';
let warmup: Promise<ServerWakeState> | null = null;
let onlineListenerAttached = false;

export function getServerWakeState(): ServerWakeState {
  return state;
}

export function serverWakeMessage(current: ServerWakeState = state): string | null {
  if (current === 'waking') return SERVER_WAKING_MESSAGE;
  if (current === 'unreachable') return SERVER_UNREACHABLE_MESSAGE;
  return null;
}

function notify(message: string, type: 'info' | 'success' | 'warning') {
  // Import dinámico: este módulo se carga antes que React y no debe arrastrar
  // el store (ni sus dependencias) al arranque crítico.
  void import('../store/useStore')
    .then(({ useStore }) => { useStore.getState().addNotification?.(message, type); })
    .catch(() => { /* la UI es opcional: el evento ya se emitió */ });
}

function publish(next: ServerWakeState) {
  const previous = state;
  state = next;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.serverWake = next;
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SERVER_WAKE_EVENT, {
      detail: { state: next, message: serverWakeMessage(next) }
    }));
  }
  if (next === previous) return;
  if (next === 'waking') notify(SERVER_WAKING_MESSAGE, 'info');
  else if (next === 'unreachable' && previous === 'waking') notify(SERVER_UNREACHABLE_MESSAGE, 'warning');
  else if (next === 'awake' && previous === 'waking') notify(SERVER_AWAKE_MESSAGE, 'success');
}

type ProbeResult = 'ok' | 'timeout' | 'down';

async function probe(timeoutMs: number): Promise<ProbeResult> {
  try {
    // /healthz no toca la base de datos ni pide sesión: solo despierta la
    // instancia y confirma que el proceso responde.
    const response = await fetchWithTimeout('/healthz', {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    }, timeoutMs);
    return response.ok ? 'ok' : 'down';
  } catch (error) {
    return error instanceof HttpTimeoutError || (error as Error)?.name === 'TimeoutError' ? 'timeout' : 'down';
  }
}

function attachOnlineRetry() {
  if (onlineListenerAttached || typeof window === 'undefined') return;
  onlineListenerAttached = true;
  window.addEventListener('online', () => {
    if (state !== 'awake') void beginServerWarmup();
  });
}

/** Sonda de arranque. Nunca lanza y nunca bloquea el render. */
export function beginServerWarmup(): Promise<ServerWakeState> {
  if (warmup) return warmup;
  attachOnlineRetry();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // Sin red no hay nada que despertar: el flujo offline ya informa al usuario.
    state = 'unreachable';
    return Promise.resolve(state);
  }

  warmup = (async (): Promise<ServerWakeState> => {
    const first = await probe(FIRST_PROBE_TIMEOUT_MS);
    if (first === 'ok' || state === 'awake') {
      publish('awake');
      return 'awake';
    }
    // Solo un timeout se explica como "despertando"; un fallo inmediato suele
    // ser red/DNS y no debe prometer una espera que no se está produciendo.
    if (first === 'timeout') publish('waking');

    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    const second = await probe(RETRY_PROBE_TIMEOUT_MS);
    if (second === 'ok') {
      publish('awake');
      return 'awake';
    }
    publish('unreachable');
    return 'unreachable';
  })().finally(() => { warmup = null; });

  return warmup;
}

/** Reintento manual (p. ej. botón "Reintentar" de la UI). */
export function retryServerWarmup(): Promise<ServerWakeState> {
  return beginServerWarmup();
}
