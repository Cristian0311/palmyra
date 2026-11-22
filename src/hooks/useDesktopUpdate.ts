import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDesktopUpdater,
  normalizeDesktopUpdateState,
  type DesktopUpdateInstallResult,
  type DesktopUpdateState,
} from "../lib/desktopUpdate";

export type DesktopUpdateController = {
  /** true solo dentro del shell Electron con preload disponible. */
  supported: boolean;
  state: DesktopUpdateState | null;
  install: () => Promise<DesktopUpdateInstallResult>;
  retry: () => Promise<void>;
  checkNow: () => Promise<void>;
};

const FOCUS_REFRESH_MS = 5 * 60_000;

/**
 * Estado de la actualización de escritorio (electron-updater).
 *
 * La instantánea inicial se pide al montar, así un estado alcanzado antes de
 * que React exista (la app recién abierta) no se pierde. Luego se mantiene con
 * los eventos del proceso principal y se revalida al volver al foco.
 */
export function useDesktopUpdate(): DesktopUpdateController {
  const bridgeRef = useRef(getDesktopUpdater());
  const [state, setState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    let active = true;

    const apply = (next: DesktopUpdateState | null) => {
      if (active && next) setState(next);
    };
    const refresh = () => {
      bridge
        .getState()
        .then((next) => apply(normalizeDesktopUpdateState(next)))
        .catch(() => {});
    };

    refresh();
    const unsubscribe = bridge.onState((raw) => apply(normalizeDesktopUpdateState(raw)));
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, FOCUS_REFRESH_MS);

    return () => {
      active = false;
      try { unsubscribe(); } catch {}
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, []);

  const install = useCallback(async (): Promise<DesktopUpdateInstallResult> => {
    const bridge = bridgeRef.current;
    if (!bridge) return { ok: false, error: "Esta instalación no permite actualizar desde la app." };
    return bridge.install();
  }, []);

  const retry = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const downloaded = await bridge.download();
    if (downloaded) {
      setState(normalizeDesktopUpdateState(downloaded));
      return;
    }
    const checked = await bridge.check();
    if (checked) setState(normalizeDesktopUpdateState(checked));
  }, []);

  const checkNow = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const checked = await bridge.check();
    if (checked) setState(normalizeDesktopUpdateState(checked));
  }, []);

  return { supported: Boolean(bridgeRef.current), state, install, retry, checkNow };
}
