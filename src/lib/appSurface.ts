/**
 * Superficie donde se está ejecutando PALMYRA.
 *
 * Decisión de producto: la web (pestaña del navegador) sirve solo para
 * registro, cuenta, plan y descarga. El punto de venta y la operación corren en
 * la app instalada (Windows o APK) y en el desarrollo local. Los shells
 * instalados cargan desde 127.0.0.1, así que se reconocen por su shell y no por
 * el host.
 *
 * Este módulo es puro a propósito: `detectAppSurface` no toca `window` ni
 * `navigator`, así que se puede probar en Node y reutilizar donde haga falta.
 */

export type AppSurface = "dev" | "desktop" | "android-app" | "pwa" | "web-tab";

export type AppSurfaceInput = {
  userAgent: string;
  hostname: string;
  /** `display-mode: standalone` o el `navigator.standalone` de iOS. */
  standalone?: boolean;
  /** Build de desarrollo (`import.meta.env.DEV`). */
  dev?: boolean;
  /** Puente nativo presente (`window.PALMYRA_NATIVE` o UA `PALMYRAApp/`). */
  isNativeBridge?: boolean;
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

const ELECTRON_USER_AGENT = /\bElectron\//i;
const PALMYRA_APP_USER_AGENT = /PALMYRAApp\//i;

function normalizeHostname(hostname: string): string {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    // Los literales IPv6 llegan a veces entre corchetes: `[::1]`.
    .replace(/^\[|\]$/g, "");
}

/**
 * Orden de prioridad: dev (build) → desktop → android-app → dev (localhost) →
 * pwa → web-tab.
 *
 * Las apps instaladas cargan desde 127.0.0.1, así que su shell se reconoce
 * ANTES que el host local: si no, la app de escritorio y el APK se tomarían por
 * "dev" y quedarían detrás de la pantalla de descarga.
 */
export function detectAppSurface(input: AppSurfaceInput): AppSurface {
  const hostname = normalizeHostname(input.hostname);
  if (input.dev === true) return "dev";

  const userAgent = String(input.userAgent || "");
  if (ELECTRON_USER_AGENT.test(userAgent)) return "desktop";

  if (input.isNativeBridge === true || PALMYRA_APP_USER_AGENT.test(userAgent)) return "android-app";

  if (LOCAL_HOSTNAMES.has(hostname)) return "dev";

  if (input.standalone === true) return "pwa";

  return "web-tab";
}

const SURFACE_LABELS: Record<AppSurface, string> = {
  dev: "Desarrollo local",
  desktop: "Aplicación de escritorio",
  "android-app": "Aplicación Android",
  pwa: "PWA instalada",
  "web-tab": "Navegador web (pestaña)",
};

/** Etiqueta corta en español para diagnóstico y pantallas de estado. */
export function describeAppSurface(surface: AppSurface): string {
  return SURFACE_LABELS[surface] ?? SURFACE_LABELS["web-tab"];
}

/** El POS solo puede operar fuera de una pestaña de navegador. */
export function canRunPos(surface: AppSurface): boolean {
  return surface !== "web-tab";
}

/**
 * Ruta a la que se entra después del registro o del inicio de sesión.
 *
 * Solo la pestaña web queda fuera de la operación y va a la pantalla de
 * descarga; las apps instaladas y el desarrollo local entran directo al
 * sistema.
 */
export function entryPathForSurface(surface: AppSurface = currentAppSurface()): string {
  return surface === "web-tab" ? "/download" : "/";
}

/**
 * Restos del antiguo permiso «Continuar en local»: builds anteriores guardaban
 * el desbloqueo de la pestaña en sessionStorage. Ya no existe ninguna vía que
 * lo active y se purga al terminar un acceso o un registro.
 */
const DEV_APP_UNLOCK_KEY = "palmyra:dev-app-unlocked";

export function lockDevAppSurface(): void {
  try { window.sessionStorage.removeItem(DEV_APP_UNLOCK_KEY); } catch { /* modo privado sin sessionStorage */ }
}

type StandaloneNavigator = Navigator & { standalone?: boolean };

/**
 * Lee el entorno actual sin asumir DOM. En contextos sin `window` (SSR,
 * pruebas en Node) devuelve "dev": no hay superficie que bloquear y es preferible
 * no dejar una interfaz muerta.
 */
export function currentAppSurface(): AppSurface {
  if (typeof window === "undefined") return "dev";

  const nav = typeof navigator === "undefined" ? undefined : (navigator as StandaloneNavigator);

  let hostname = "";
  try {
    hostname = window.location?.hostname || "";
  } catch {
    hostname = "";
  }

  let standalone = false;
  try {
    standalone = Boolean(
      window.matchMedia?.("(display-mode: standalone)").matches ||
        window.matchMedia?.("(display-mode: fullscreen)").matches ||
        nav?.standalone
    );
  } catch {
    standalone = false;
  }

  const nativeBridge = Boolean(
    (window as Window & { PALMYRA_NATIVE?: unknown }).PALMYRA_NATIVE
  );

  return detectAppSurface({
    userAgent: nav?.userAgent || "",
    hostname,
    standalone,
    dev: Boolean(import.meta.env?.DEV),
    isNativeBridge: nativeBridge,
  });
}
