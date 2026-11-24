import { useEffect } from 'react';
import { sendLanPresence } from '../services/lanPresence';
import { canUseLanPresence } from '../services/lanHost';
import { LAN_HUB_ENABLED } from '../services/lanHub/protocol';

const HEARTBEAT_MS = 20_000;

/** Anuncia este equipo al servidor local para poder verlo en Red local. */
export function useLanPresence(warehouseName?: string | null) {
  useEffect(() => {
    if (!LAN_HUB_ENABLED || !canUseLanPresence()) return;
    let stopped = false;
    const beat = () => {
      // La LAN funciona sin internet: no se exige navigator.onLine.
      if (stopped) return;
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
