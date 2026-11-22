import { lazy, type ComponentType } from "react";

// Una consola abierta con HTML viejo puede pedir un chunk que el despliegue
// nuevo ya eliminó. Sin recuperación, la sección queda en blanco. Se reintenta
// una vez y, si vuelve a fallar, se recarga con protección de sessionStorage.
const LAZY_RELOAD_KEY = "palmyra_admin_lazy_reload";
const PRELOAD_RELOAD_KEY = "palmyra_admin_preload_reload";

function guardedReload(key: string, windowMs: number) {
  if (typeof window === "undefined") return false;
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
  try {
    const last = Number(window.sessionStorage.getItem(key) || "0");
    if (last && Date.now() - last < windowMs) return false;
    window.sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

export function lazyWithRetry<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (firstError) {
      console.warn("[PALMYRA ADMIN] Sección no cargada; reintentando una vez…", firstError);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    try {
      return await factory();
    } catch (retryError) {
      console.error("[PALMYRA ADMIN] La sección sigue sin cargar tras reintentar.", retryError);
      if (guardedReload(LAZY_RELOAD_KEY, 60_000)) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
      }
      throw retryError;
    }
  });
}

export function installAdminChunkRecovery() {
  if (typeof window === "undefined") return;
  window.addEventListener("vite:preloadError", (event) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    if (guardedReload(PRELOAD_RELOAD_KEY, 30_000)) event.preventDefault();
  });
}
