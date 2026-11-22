import { ADMIN_PRODUCT_VERSION } from "./productVersion";

declare const __ADMIN_BUILD__: string;
declare const __ADMIN_BUILT_AT__: string;

// Identificador del panel que está corriendo ahora mismo y del publicado en
// el servidor. Si difieren, hay una versión nueva desplegada.
export const ADMIN_BUILD = __ADMIN_BUILD__;
export const ADMIN_BUILT_AT = __ADMIN_BUILT_AT__;

const DISMISS_KEY = "palmyra_admin_update_dismissed_build";
const CHECK_MIN_GAP_MS = 60_000;
const CHECK_EVERY_MS = 4 * 60_000;

async function readPublishedBuild(): Promise<string | null> {
  try {
    const response = await fetch(`/version.json?_=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null) as { build?: unknown } | null;
    return typeof payload?.build === "string" ? payload.build : null;
  } catch {
    return null;
  }
}

export function startAdminUpdateWatcher(onUpdate: (build: string) => void): () => void {
  let stopped = false;
  let lastCheck = 0;

  const check = async (force = false) => {
    if (stopped) return;
    const now = Date.now();
    if (!force && now - lastCheck < CHECK_MIN_GAP_MS) return;
    lastCheck = now;
    const published = await readPublishedBuild();
    if (!published || published === ADMIN_BUILD) return;
    let dismissed = "";
    try { dismissed = sessionStorage.getItem(DISMISS_KEY) || ""; } catch { /* almacenamiento bloqueado */ }
    if (dismissed === published) return;
    onUpdate(published);
  };

  const interval = window.setInterval(() => void check(), CHECK_EVERY_MS);
  const onFocus = () => void check();
  const onVisible = () => { if (document.visibilityState === "visible") void check(); };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
  void check(true);

  return () => {
    stopped = true;
    window.clearInterval(interval);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export async function applyAdminUpdate(): Promise<void> {
  const reload = () => window.location.reload();
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.();
    if (!registrations) return reload();
    await Promise.all(registrations.map((registration) => registration.update().catch(() => undefined)));
    reload();
  } catch {
    reload();
  }
}

export function mountAdminUpdateBanner(build: string): void {
  if (document.getElementById("palmyra-admin-update")) return;
  const banner = document.createElement("div");
  banner.id = "palmyra-admin-update";
  banner.className = "admin-update-banner";
  banner.setAttribute("role", "status");
  banner.innerHTML = [
    `<div class="admin-update-banner__copy"><strong>Nueva versión ${ADMIN_PRODUCT_VERSION} del panel disponible</strong>`,
    "<span>Se publicó una actualización de la consola administrativa.</span></div>",
    '<div class="admin-update-banner__actions">',
    '<button type="button" data-action="reload">Recargar ahora</button>',
    '<button type="button" data-action="dismiss" aria-label="Descartar aviso">×</button>',
    "</div>",
  ].join("");
  banner.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action === "reload") applyAdminUpdate();
    if (action === "dismiss") {
      try { sessionStorage.setItem(DISMISS_KEY, build); } catch { /* almacenamiento bloqueado */ }
      banner.remove();
    }
  });
  document.body.appendChild(banner);
}
