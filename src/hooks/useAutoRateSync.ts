import { useEffect } from 'react';
import { runAutoRateSync } from '../services/autoExchangeRate';
import { getHubSession } from '../services/lanHub/session';

/**
 * Cadencia pedida por el dueño: las consultas de tasa se hacen cada 20
 * minutos. El hub LAN conserva su propia cadencia interna (45 min).
 */
export const AUTO_RATE_CHECK_MS = 20 * 60 * 1000;
/** Reintento de la LAN mientras el hub no responda (no toca Internet). */
export const AUTO_RATE_HUB_RETRY_MS = 10 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 6000;

/** Contexto de la decisión; `visibility` es `document.visibilityState`. */
export interface AutoRateRunState {
  /** `document.visibilityState`; solo se bloquea con `hidden`. */
  visibility?: string | null;
  /** `navigator.onLine`; sin `navigator` se asume red disponible. */
  online: boolean;
  /** Hay una sesión persistida con el hub LAN (`getHubSession`). */
  hasHubSession: boolean;
}

/**
 * Decisión pura y testeable: solo se consulta la tasa con la pestaña visible y
 * cuando hay Internet O una sesión con el hub LAN. Un cliente de la red local
 * sin salida a Internet igual pide su tasa al hub.
 */
export function shouldRunAutoRates(state: AutoRateRunState): boolean {
  if (!state) return false;
  if (state.visibility === 'hidden') return false;
  return state.online === true || state.hasHubSession === true;
}

/** `navigator` puede no existir (SSR/pruebas); sin él se asume red disponible. */
function isOnline(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return true;
  return navigator.onLine;
}

/** Sesión de hub disponible; indexado/privado puede fallar y se trata como «sin hub». */
async function readHasHubSession(): Promise<boolean> {
  try {
    return (await getHubSession()) !== null;
  } catch {
    return false;
  }
}

/**
 * Revisa la cotización mientras la aplicación permanezca abierta.
 *
 * - Corre si hay red o si el equipo está emparejado con un hub LAN.
 * - No trabaja con la pestaña oculta.
 * - Revisa cada 45 min (la cadencia del hub) y refresca al volver `online`.
 * - Si hay sesión de hub, reintenta la LAN cada 10 min aunque
 *   `navigator.onLine` siga en false (la LAN no necesita Internet).
 */
export function useAutoRateSync() {
  useEffect(() => {
    let disposed = false;

    /**
     * Un solo intento: visible y (red o hub). `requireHub` es el reintento de
     * los 10 minutos, que solo tiene sentido si el equipo sigue emparejado.
     */
    const attempt = async (requireHub: boolean) => {
      if (disposed || document.visibilityState === 'hidden') return;
      const hasHubSession = await readHasHubSession();
      if (disposed || (requireHub && !hasHubSession)) return;
      if (!shouldRunAutoRates({ visibility: document.visibilityState, online: isOnline(), hasHubSession })) return;
      void runAutoRateSync().catch(() => { /* la fuente es opcional */ });
    };

    const run = () => attempt(false);
    const runHubRetry = () => attempt(true);

    const initial = window.setTimeout(() => { void run(); }, FIRST_CHECK_DELAY_MS);
    const timer = window.setInterval(() => { void run(); }, AUTO_RATE_CHECK_MS);
    const hubTimer = window.setInterval(() => { void runHubRetry(); }, AUTO_RATE_HUB_RETRY_MS);
    const onOnline = () => { void run(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void run(); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.clearInterval(hubTimer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
