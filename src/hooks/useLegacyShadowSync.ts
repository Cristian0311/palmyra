import { useEffect } from "react";
import { canRunPos, currentAppSurface } from "../lib/appSurface";
import { createLegacyShadowWriter, type LegacyShadowWriter } from "../services/localDb/legacyShadow";
import { writeLegacyBackup } from "../services/localDb/jsonRetention";
import { getRuntimeDriver } from "../services/localDb/runtimeDriver";
import { createShadowIndexStore } from "../services/localDb/shadowIndex";
import { getDeviceId } from "../services/lanPresence";
import { getPalmyraLocalScope, getPalmyraScopedStorageKey } from "../services/localScope";
import {
  readLocalStateStorage,
  subscribeLocalStateStorage
} from "../services/localStateStorage";

/**
 * Mantiene el almacén normalizado al día con el JSON legado.
 *
 * La UI guarda el estado completo cada vez que cambia; aquí se agrupan esas
 * escrituras y se reflejan solo las filas distintas. En la web de registro no
 * se ejecuta porque no hay negocio que reflejar.
 */
const DEBOUNCE_MS = 2500;

export function useLegacyShadowSync(companyId?: string | null): void {
  useEffect(() => {
    const target = companyId || getPalmyraLocalScope()?.companyId;
    if (!target) return;
    if (!canRunPos(currentAppSurface())) return;

    let cancelled = false;
    let timer: number | null = null;
    let pending: string | null = null;
    let unsubscribe: (() => void) | null = null;
    let writer: LegacyShadowWriter | null = null;

    const flush = (): void => {
      if (!writer || pending === null) return;
      const raw = pending;
      pending = null;
      void writer.sync(raw).catch(() => {
        // El JSON legado sigue siendo la fuente; se reintenta en el próximo guardado.
      });
    };

    const schedule = (): void => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        flush();
      }, DEBOUNCE_MS);
    };

    void (async () => {
      try {
        const driver = await getRuntimeDriver();
        if (cancelled) return;
        writer = createLegacyShadowWriter({
          driver,
          companyId: target,
          originDevice: getDeviceId(),
          index: createShadowIndexStore(
            getPalmyraScopedStorageKey("palmyra_legacy_shadow_v1") ?? target
          )
        });
        const initial = await readLocalStateStorage();
        // Respaldo diario del JSON legado (uno por día, retención de 30 días);
        // es una red de seguridad: cualquier fallo se ignora en silencio.
        try {
          writeLegacyBackup(initial);
        } catch {
          // Sin almacenamiento o sin cuota el ciclo de sombra sigue igual.
        }
        if (cancelled) return;
        if (initial) await writer.sync(initial);
        if (cancelled) return;
        unsubscribe = subscribeLocalStateStorage((raw) => {
          pending = raw;
          schedule();
        });
      } catch {
        // Sin almacén local la app trabaja solo con el JSON legado.
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [companyId]);
}
