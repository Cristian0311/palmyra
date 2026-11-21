import { useEffect } from 'react';
import { sendLanPresence } from '../services/lanPresence';

const HEARTBEAT_MS = 20_000;

/** Anuncia este equipo al servidor local para poder verlo en Red local. */
export function useLanPresence(warehouseName?: string | null) {
  useEffect(() => {
    let stopped = false;
    const beat = () => {
      if (stopped || !navigator.onLine) return;
      void sendLanPresence(warehouseName).catch(() => { /* el POS funciona sin LAN */ });
    };
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    window.addEventListener('online', beat);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('online', beat);
    };
  }, [warehouseName]);
}
