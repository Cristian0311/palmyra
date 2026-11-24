import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAppUpdateRuntime,
  type AppUpdateRuntime,
  type AppUpdateState
} from "../services/updates/runtime";

/**
 * Conecta el runtime de actualizaciones con React.
 *
 * El runtime es ÚNICO por módulo: Layout (aviso OTA), el Centro de
 * actualizaciones en Ajustes y cualquier otro consumidor comparten estado y
 * cadencia, así que nunca hay dos comprobaciones simultáneas ni dos avisos
 * distintos. La cadencia de 24 h la impone el cliente; aquí solo se dispara
 * una comprobación al montar y cuando la app vuelve a primer plano o a tener
 * red, sin temporizadores propios.
 */

let sharedRuntime: AppUpdateRuntime | null = null;

/** Runtime compartido (se crea en el primer uso, nunca al importar). */
export function getAppUpdateRuntime(): AppUpdateRuntime {
  if (!sharedRuntime) sharedRuntime = createAppUpdateRuntime();
  return sharedRuntime;
}

export interface AppUpdateController {
  state: AppUpdateState;
  /** Fuerza una comprobación (ignora la cadencia de 24 h). */
  checkNow: () => Promise<AppUpdateState>;
  /** Descarta esta versión (persiste y oculta los avisos). */
  dismiss: (version: string) => void;
  isDismissed: (version: string) => boolean;
}

export function useAppUpdateRuntime(): AppUpdateController {
  const runtimeRef = useRef<AppUpdateRuntime | null>(null);
  if (runtimeRef.current === null) runtimeRef.current = getAppUpdateRuntime();
  const runtime = runtimeRef.current;

  const [state, setState] = useState<AppUpdateState>(() => runtime.state);

  useEffect(() => {
    // El estado puede haber cambiado antes del primer render (p. ej. otra
    // pantalla ya comprobó): se sincroniza al suscribirse.
    setState(runtime.state);
    let active = true;
    const unsubscribe = runtime.subscribe((next) => {
      if (active) setState(next);
    });

    void runtime.check(false);

    const onVisibility = () => {
      if (document.visibilityState === "visible") void runtime.check(false);
    };
    const onOnline = () => {
      void runtime.check(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);

    return () => {
      active = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [runtime]);

  const checkNow = useCallback(() => runtime.check(true), [runtime]);
  const dismiss = useCallback((version: string) => runtime.dismiss(version), [runtime]);
  const isDismissed = useCallback((version: string) => runtime.isDismissed(version), [runtime]);

  return { state, checkNow, dismiss, isDismissed };
}
