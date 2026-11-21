import { useEffect } from 'react';
import { runAutoRateSync } from '../services/autoExchangeRate';

const CHECK_MS = 5 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 6000;

/** Revisa la cotización de elTOQUE mientras la aplicación permanezca abierta. */
export function useAutoRateSync() {
  useEffect(() => {
    const run = () => {
      if (document.visibilityState === 'hidden' || !navigator.onLine) return;
      void runAutoRateSync().catch(() => { /* la fuente es opcional */ });
    };
    const initial = window.setTimeout(run, FIRST_CHECK_DELAY_MS);
    const timer = window.setInterval(run, CHECK_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
