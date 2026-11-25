/**
 * Diagnóstico de instalación.
 *
 * Responde a la pregunta de soporte «¿qué está instalado aquí y por qué no
 * arranca?» sin abrir herramientas: superficie (web, Android o Windows),
 * versión, origen del manifiesto de actualización, estado del service worker,
 * cachés, servidor local (shell Android o hub de escritorio), último error de
 * instalación y espacio usado.
 *
 * Reglas de privacidad: el informe solo lleva estados, versiones y tamaños.
 * Nunca cruzan tokens, claves, rutas privadas ni valores de localStorage; del
 * almacenamiento solo se conservan nombres de claves conocidas y bytes.
 *
 * Todas las dependencias del entorno son inyectables para poder probar el
 * contrato en Node. Ninguna función lanza: un entorno roto produce un informe
 * degradado con notas, nunca una pantalla en blanco.
 */
import { getNativeAppInfo, type NativeAppInfo } from "../../lib/nativeApp";
import { PRODUCT_VERSION } from "../../lib/productVersion";
import { formatStorageBytes } from "../pwaStorageHealth";
import { downloadGeneratedFile } from "../../utils/downloadFile";

/** Clave del último error de instalación (solo el nombre; jamás su valor). */
export const INSTALL_ERROR_KEY = "palmyra-install-last-error";

/** Manifiesto público del canal estable; no es un secreto. */
export const DEFAULT_UPDATE_MANIFEST_URL =
  "https://github.com/Cristian0311/palmyra/releases/latest/download/update-manifest.json";

/** Espera máxima al hub de escritorio antes de dar el estado por desconocido. */
export const DESKTOP_HUB_TIMEOUT_MS = 1500;

const MAX_ERROR_MESSAGE = 300;
const MAX_DETAIL = 220;
const MAX_ORIGIN = 300;
const MAX_CACHE_NAMES = 20;
const MAX_NOTES = 12;

export type InstallSurface = "web" | "android" | "windows" | "unknown";

export type InstallCheckState = "ok" | "warn" | "error" | "unknown";

export interface InstallCheck {
  id: string;
  label: string;
  state: InstallCheckState;
  detail: string;
}

export interface LastInstallError {
  message: string;
  at: string;
}

export interface InstallServiceWorkerInfo {
  registered: boolean;
  scope?: string;
  state?: string;
}

export interface InstallLocalServerInfo {
  kind: "android-shell" | "desktop-hub" | "node-web" | "none";
  state: "ready" | "unknown" | "error";
  detail: string;
}

/** Estado del almacén local: motor, esquema y tamaño. Sin rutas ni secretos. */
export interface InstallLocalDbInfo {
  state: "ready" | "error" | "unknown";
  driver: string;
  schemaVersion: number | null;
  sizeBytes: number | null;
  detail: string;
  lastError: string | null;
}

/** Último respaldo conocido: fecha local o de nube y su estado. */
export interface InstallLastBackupInfo {
  status: "ok" | "error" | "none";
  at: string | null;
  detail: string;
}

export interface InstallDiagnosticsReport {
  /** Momento de la recolección (ISO). Añadido para fechar el informe. */
  generatedAt: string;
  surface: InstallSurface;
  version: string;
  updateOrigin: string;
  serviceWorker: InstallServiceWorkerInfo;
  caches: string[];
  localServer: InstallLocalServerInfo;
  lastError: LastInstallError | null;
  storage: { usage?: number; quota?: number } | null;
  /** Base local (driver, esquema y tamaño) o null si no se recolectó. */
  localDb: InstallLocalDbInfo | null;
  /** Último respaldo (fecha y estado) o null si no se recolectó. */
  lastBackup: InstallLastBackupInfo | null;
  checks: InstallCheck[];
  notes: string[];
}

/** Lo mínimo que necesita el diagnóstico de `localStorage`. */
export interface InstallStorage {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface ServiceWorkerRegistrationLike {
  scope?: string;
  active?: { state?: string } | null;
  waiting?: { state?: string } | null;
  installing?: { state?: string } | null;
}

export interface ServiceWorkerContainerLike {
  getRegistration?(): Promise<ServiceWorkerRegistrationLike | undefined | null>;
}

export interface NavigatorLike {
  serviceWorker?: ServiceWorkerContainerLike | null;
  storage?: { estimate?(): Promise<{ usage?: unknown; quota?: unknown }> } | null;
}

export interface CacheStorageLike {
  keys?(): Promise<string[]> | string[];
}

export interface DesktopHubLike {
  status(): unknown;
}

export interface InstallSurfaceDeps {
  /** Por defecto `getNativeAppInfo` (puente PALMYRA_NATIVE). */
  nativeInfo?: () => NativeAppInfo | null;
  /** `window`-like con los puentes del preload; por defecto el global real. */
  scope?: unknown;
}

export interface InstallOriginDeps {
  /** Variables de entorno de Vite; se inyectan en pruebas. */
  env?: Record<string, string | undefined> | null;
}

export interface InstallDiagnosticsDeps {
  surface?: InstallSurface;
  now?: () => Date;
  navigatorImpl?: NavigatorLike | null;
  cacheStorage?: CacheStorageLike | null;
  storage?: InstallStorage | null;
  env?: Record<string, string | undefined> | null;
  nativeInfo?: () => NativeAppInfo | null;
  desktopHub?: DesktopHubLike | null;
  /** `window`-like para detectar PALMYRA_NATIVE y los puentes de escritorio. */
  scope?: unknown;
  /** Tiempo máximo de espera al hub de escritorio (por defecto 1500 ms). */
  hubTimeoutMs?: number;
  /**
   * Estado ya medido de la base local. Se inyecta desde la interfaz
   * (`collectLocalDbState`); sin él el informe no incluye la comprobación.
   */
  localDb?: InstallLocalDbInfo | null;
  /** Último respaldo ya medido (`collectLastBackupState`). */
  lastBackup?: InstallLastBackupInfo | null;
}

export interface InstallCheckInput {
  /** `true` correcto, `false` incorrecto, `null`/`undefined` desconocido. */
  ok: boolean | null | undefined;
  /** Gravedad cuando el hecho no es correcto. Por defecto «warn». */
  severity?: "warn" | "error";
  /** Superficie donde se evalúa la comprobación. */
  surface?: InstallSurface;
  /** Superficies donde la comprobación tiene sentido; fuera se marca «unknown». */
  appliesTo?: readonly InstallSurface[];
}

const SURFACE_LABELS: Record<InstallSurface, string> = {
  web: "Web (navegador)",
  android: "Android (APK)",
  windows: "Windows (escritorio)",
  unknown: "Superficie desconocida"
};

const SERVER_KIND_LABELS: Record<InstallLocalServerInfo["kind"], string> = {
  "android-shell": "Shell Android",
  "desktop-hub": "Hub de escritorio",
  "node-web": "Servidor web",
  none: "Sin servidor local"
};

const CHECK_STATE_LABELS: Record<InstallCheckState, string> = {
  ok: "Correcto",
  warn: "Aviso",
  error: "Fallo",
  unknown: "Sin datos"
};

export function installSurfaceLabel(surface: InstallSurface): string {
  return SURFACE_LABELS[surface] ?? SURFACE_LABELS.unknown;
}

/* ------------------------------------------------------------------ */
/* Utilidades internas                                                 */
/* ------------------------------------------------------------------ */

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function safeNow(source: (() => Date) | undefined): Date {
  try {
    const value = source ? source() : new Date();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
  } catch {
    return new Date();
  }
}

/** Texto corto y plano: sin controles ni saltos de línea. */
function sanitizeText(value: unknown, max = MAX_DETAIL): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function toBytes(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function pushNote(notes: string[], note: string): void {
  if (notes.length >= MAX_NOTES) return;
  if (!notes.includes(note)) notes.push(note);
}

function formatMoment(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** Un ámbito de service worker no necesita query ni hash: se recortan. */
function sanitizeScope(value: unknown): string | null {
  const text = sanitizeText(value, 200);
  if (!text) return null;
  return sanitizeText(text.split(/[?#]/, 1)[0], 160);
}

function defaultScope(): unknown {
  try {
    if (typeof window !== "undefined") return window;
    if (typeof globalThis !== "undefined") return globalThis;
  } catch {
    // Entornos sin global utilizable.
  }
  return null;
}

function defaultNavigator(): NavigatorLike | null {
  try {
    return typeof navigator !== "undefined" ? (navigator as unknown as NavigatorLike) : null;
  } catch {
    return null;
  }
}

function defaultCacheStorage(): CacheStorageLike | null {
  try {
    return typeof caches !== "undefined" ? (caches as unknown as CacheStorageLike) : null;
  } catch {
    return null;
  }
}

function defaultStorage(): InstallStorage | null {
  try {
    if (typeof window === "undefined") return null;
    const storage = window.localStorage;
    return storage && typeof storage.getItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

/**
 * Variables de Vite. En Node `import.meta.env` no existe y la expresión con
 * encadenamiento opcional devuelve undefined en lugar de lanzar.
 */
function defaultEnv(): Record<string, string | undefined> {
  try {
    return (import.meta.env ?? {}) as unknown as Record<string, string | undefined>;
  } catch {
    return {};
  }
}

function readNativeInfo(source: (() => NativeAppInfo | null) | undefined): NativeAppInfo | null {
  try {
    return (source ?? getNativeAppInfo)() ?? null;
  } catch {
    return null;
  }
}

function readDesktopHub(scopeValue: unknown): DesktopHubLike | null {
  const record = asRecord(scopeValue);
  if (!record) return null;
  const hub = asRecord(record.palmyraDesktopHub);
  if (!hub || typeof hub.status !== "function") return null;
  return hub as unknown as DesktopHubLike;
}

/* ------------------------------------------------------------------ */
/* Superficie y origen de actualización                                */
/* ------------------------------------------------------------------ */

/** Android nativo → android; puentes del preload → windows; http(s) → web. */
export function detectInstallSurface(deps: InstallSurfaceDeps = {}): InstallSurface {
  try {
    const info = readNativeInfo(deps.nativeInfo);
    if (info) {
      const platform = String(info.platform || "").toLowerCase();
      if (!platform || platform.includes("android")) return "android";
    }

    const scope = asRecord(deps.scope !== undefined ? deps.scope : defaultScope());
    if (!scope) return "unknown";
    if (scope.palmyraDesktopUpdate || scope.palmyraDesktopDb) return "windows";

    const location = asRecord(scope.location);
    const protocol = typeof location?.protocol === "string" ? location.protocol.toLowerCase() : "";
    if (protocol === "http:" || protocol === "https:") return "web";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** URL pública del manifiesto de actualización; nunca se enmascara. */
export function getUpdateOrigin(deps: InstallOriginDeps = {}): string {
  try {
    const env = deps.env !== undefined && deps.env !== null ? deps.env : defaultEnv();
    const candidate = env ? env.VITE_UPDATE_MANIFEST_URL : undefined;
    return sanitizeText(candidate, MAX_ORIGIN) ?? DEFAULT_UPDATE_MANIFEST_URL;
  } catch {
    return DEFAULT_UPDATE_MANIFEST_URL;
  }
}

/* ------------------------------------------------------------------ */
/* Último error de instalación                                         */
/* ------------------------------------------------------------------ */

export function readLastInstallError(
  storage: InstallStorage | null = defaultStorage()
): LastInstallError | null {
  try {
    if (!storage || typeof storage.getItem !== "function") return null;
    const raw = storage.getItem(INSTALL_ERROR_KEY);
    if (!raw || typeof raw !== "string") return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const record = asRecord(parsed);
    if (!record) return null;

    const message = sanitizeText(record.message, MAX_ERROR_MESSAGE);
    if (!message) return null;

    const atText = sanitizeText(record.at, 60);
    if (!atText) return null;
    const ms = Date.parse(atText);
    if (!Number.isFinite(ms)) return null;

    return { message, at: new Date(ms).toISOString() };
  } catch {
    return null;
  }
}

/** Registra un error de instalación truncado. Nunca lanza ni guarda secretos. */
export function recordInstallError(
  message: string,
  storage: InstallStorage | null = defaultStorage()
): void {
  try {
    if (!storage || typeof storage.setItem !== "function") return;
    const text = sanitizeText(message, MAX_ERROR_MESSAGE) ?? "Error de instalación sin detalle.";
    const payload: LastInstallError = { message: text, at: new Date().toISOString() };
    storage.setItem(INSTALL_ERROR_KEY, JSON.stringify(payload));
  } catch {
    // Un almacenamiento lleno o bloqueado no debe romper la interfaz.
  }
}

/* ------------------------------------------------------------------ */
/* Clasificación de comprobaciones                                     */
/* ------------------------------------------------------------------ */

/** Traduce un hecho medido a estado visible. Pura y sin efectos. */
export function classifyInstallCheck(input: InstallCheckInput): InstallCheckState {
  try {
    if (input.appliesTo && input.surface && !input.appliesTo.includes(input.surface)) {
      return "unknown";
    }
    if (input.ok === true) return "ok";
    if (input.ok === false) return input.severity === "error" ? "error" : "warn";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/* ------------------------------------------------------------------ */
/* Recolección                                                         */
/* ------------------------------------------------------------------ */

async function readServiceWorker(nav: NavigatorLike | null): Promise<InstallServiceWorkerInfo> {
  try {
    const container = nav?.serviceWorker;
    if (!container || typeof container.getRegistration !== "function") {
      return { registered: false };
    }
    const registration = await container.getRegistration();
    if (!registration) return { registered: false };

    const scope = sanitizeScope(registration.scope);
    const state =
      sanitizeText(registration.active?.state, 40) ??
      sanitizeText(registration.waiting?.state, 40) ??
      sanitizeText(registration.installing?.state, 40);

    return {
      registered: true,
      ...(scope ? { scope } : {}),
      ...(state ? { state } : {})
    };
  } catch {
    return { registered: false };
  }
}

async function readCacheNames(cacheStorage: CacheStorageLike | null): Promise<string[]> {
  try {
    if (!cacheStorage || typeof cacheStorage.keys !== "function") return [];
    const raw = await cacheStorage.keys();
    if (!Array.isArray(raw)) return [];
    const names = raw
      .map((name) => sanitizeText(name, 120))
      .filter((name): name is string => Boolean(name));
    return Array.from(new Set(names)).sort().slice(0, MAX_CACHE_NAMES);
  } catch {
    return [];
  }
}

async function readStorageEstimate(
  nav: NavigatorLike | null
): Promise<{ usage?: number; quota?: number } | null> {
  try {
    const storage = nav?.storage;
    const estimate = storage?.estimate;
    if (!storage || typeof estimate !== "function") return null;
    const record = asRecord(await estimate.call(storage));
    if (!record) return null;
    const usage = toBytes(record.usage);
    const quota = toBytes(record.quota);
    if (usage === undefined && quota === undefined) return null;
    return {
      ...(usage !== undefined ? { usage } : {}),
      ...(quota !== undefined ? { quota } : {})
    };
  } catch {
    return null;
  }
}

type ProbeOutcome =
  | { kind: "ok"; value: unknown }
  | { kind: "error" }
  | { kind: "timeout" };

/** Consulta el hub con techo de tiempo; jamás deja una promesa rechazada. */
function probeHub(hub: DesktopHubLike, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    try {
      Promise.resolve(hub.status()).then(
        (value) => finish({ kind: "ok", value }),
        () => finish({ kind: "error" })
      );
    } catch {
      finish({ kind: "error" });
    }
  });
}

function interpretHubStatus(raw: unknown): InstallLocalServerInfo {
  const record = asRecord(raw);
  if (!record) {
    return {
      kind: "desktop-hub",
      state: "unknown",
      detail: "El hub devolvió una respuesta vacía."
    };
  }
  if (record.ok === false) {
    return {
      kind: "desktop-hub",
      state: "error",
      detail: sanitizeText(record.error) ?? "El hub reportó un error."
    };
  }
  const status = asRecord(record.status);
  if (!status) {
    return {
      kind: "desktop-hub",
      state: "unknown",
      detail: "El hub no informó su estado."
    };
  }
  if (status.running === true) {
    const host = sanitizeText(status.host, 80);
    const port = toBytes(status.port);
    const address = host ? `${host}${port ? `:${port}` : ""}` : "";
    return {
      kind: "desktop-hub",
      state: "ready",
      detail: address ? `Hub activo en ${address}.` : "Hub activo."
    };
  }
  const lastError = sanitizeText(status.lastError);
  return {
    kind: "desktop-hub",
    state: lastError ? "error" : "unknown",
    detail: lastError ?? "El hub está detenido."
  };
}

async function readLocalServer(
  surface: InstallSurface,
  deps: InstallDiagnosticsDeps,
  notes: string[]
): Promise<InstallLocalServerInfo> {
  if (surface === "android") {
    const scope = asRecord(deps.scope !== undefined ? deps.scope : defaultScope());
    const nativeBridge = scope ? scope.PALMYRA_NATIVE : null;
    return nativeBridge
      ? {
          kind: "android-shell",
          state: "ready",
          detail: "Puente nativo (PALMYRA_NATIVE) disponible."
        }
      : {
          kind: "android-shell",
          state: "error",
          detail: "No se detectó el puente nativo (PALMYRA_NATIVE)."
        };
  }

  if (surface === "windows") {
    let hub = deps.desktopHub;
    if (hub === undefined) {
      hub = readDesktopHub(deps.scope !== undefined ? deps.scope : defaultScope());
    }
    if (!hub || typeof hub.status !== "function") {
      return {
        kind: "desktop-hub",
        state: "unknown",
        detail: "El puente del hub no está disponible en esta ventana."
      };
    }

    const timeoutMs =
      typeof deps.hubTimeoutMs === "number" && Number.isFinite(deps.hubTimeoutMs) && deps.hubTimeoutMs > 0
        ? Math.floor(deps.hubTimeoutMs)
        : DESKTOP_HUB_TIMEOUT_MS;

    const outcome = await probeHub(hub, timeoutMs);
    if (outcome.kind === "timeout") {
      pushNote(notes, "El hub de escritorio no respondió dentro del tiempo de espera.");
      return {
        kind: "desktop-hub",
        state: "unknown",
        detail: `Sin respuesta del hub en ${(timeoutMs / 1000).toFixed(1)} s.`
      };
    }
    if (outcome.kind === "error") {
      return {
        kind: "desktop-hub",
        state: "error",
        detail: "No se pudo consultar el hub de escritorio."
      };
    }
    return interpretHubStatus(outcome.value);
  }

  if (surface === "web") {
    return {
      kind: "node-web",
      state: "unknown",
      detail: "La interfaz se sirve desde el servidor web del equipo; sin hub local en esta pestaña."
    };
  }

  return {
    kind: "none",
    state: "unknown",
    detail: "No se reconoce la superficie de instalación."
  };
}

function originState(origin: string): InstallCheckState {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" ? "ok" : "warn";
  } catch {
    return "error";
  }
}

interface CheckFacts {
  surface: InstallSurface;
  version: string;
  native: NativeAppInfo | null;
  updateOrigin: string;
  serviceWorker: InstallServiceWorkerInfo;
  caches: string[];
  cacheAvailable: boolean;
  localServer: InstallLocalServerInfo;
  lastError: LastInstallError | null;
  localDb: InstallLocalDbInfo | null;
  lastBackup: InstallLastBackupInfo | null;
}

function localDbDetail(info: InstallLocalDbInfo): string {
  const parts: string[] = [];
  if (info.driver) parts.push(info.driver);
  if (info.schemaVersion !== null && info.schemaVersion > 0) parts.push(`esquema v${info.schemaVersion}`);
  if (info.sizeBytes !== null && info.sizeBytes > 0) parts.push(formatStorageBytes(info.sizeBytes));
  if (info.detail) parts.push(info.detail);
  if (info.lastError) parts.push(`último error: ${info.lastError}`);
  return parts.length > 0 ? parts.join(" · ") : "Sin datos de la base local.";
}

function lastBackupDetail(info: InstallLastBackupInfo): string {
  const when = info.at ? formatMoment(info.at) : "sin fecha";
  const state =
    info.status === "ok" ? "correcto" : info.status === "error" ? "con fallo" : "sin respaldos";
  return `${when} · ${state}${info.detail ? ` · ${info.detail}` : ""}`;
}

function buildChecks(facts: CheckFacts): InstallCheck[] {
  const checks: InstallCheck[] = [];

  const versionOk = Boolean(facts.version) && facts.version !== "0.0.0";
  checks.push({
    id: "version",
    label: "Versión instalada",
    state: classifyInstallCheck({ ok: versionOk, severity: "warn" }),
    detail: versionOk
      ? facts.native
        ? `PALMYRA ${facts.version} · Shell ${facts.native.shellVersion || "—"} · OTA ${
            facts.native.ota ? "activo" : "inactivo"
          }`
        : `PALMYRA ${facts.version}`
      : `La compilación no informa su versión (${facts.version || "—"}).`
  });

  const origin = facts.updateOrigin;
  const originResult = originState(origin);
  checks.push({
    id: "update-origin",
    label: "Origen de actualización",
    state: originResult,
    detail:
      originResult === "ok"
        ? `Manifiesto en HTTPS: ${origin}`
        : originResult === "warn"
          ? `El manifiesto no usa HTTPS: ${origin}`
          : "La URL del manifiesto de actualización no es válida."
  });

  const swApplies = facts.surface === "web";
  const swOk = swApplies
    ? facts.serviceWorker.registered && (!facts.serviceWorker.state || facts.serviceWorker.state === "activated")
    : null;
  checks.push({
    id: "service-worker",
    label: "Service worker",
    state: classifyInstallCheck({ ok: swOk, severity: "warn" }),
    detail: !swApplies
      ? facts.surface === "android"
        ? "No aplica en la app Android instalada."
        : "No aplica en la aplicación de escritorio."
      : !facts.serviceWorker.registered
        ? "Sin service worker registrado: la app no abrirá sin conexión."
        : `Registrado${facts.serviceWorker.scope ? ` en ${facts.serviceWorker.scope}` : ""}${
            facts.serviceWorker.state ? ` · estado ${facts.serviceWorker.state}` : ""
          }.`
  });

  const cacheOk = facts.cacheAvailable ? facts.caches.length > 0 : null;
  checks.push({
    id: "cache",
    label: "Caché disponible",
    state: classifyInstallCheck({ ok: cacheOk, severity: "warn" }),
    detail: !facts.cacheAvailable
      ? "Este entorno no expone CacheStorage."
      : facts.caches.length > 0
        ? `${facts.caches.length} caché(s): ${facts.caches.slice(0, 3).join(", ")}${
            facts.caches.length > 3 ? "…" : ""
          }`
        : "Sin cachés de aplicación: la próxima carga descargará todo de nuevo."
  });

  checks.push({
    id: "local-server",
    label: "Servidor local",
    state: classifyInstallCheck({
      ok: facts.localServer.state === "ready" ? true : facts.localServer.state === "error" ? false : null,
      severity: "error"
    }),
    detail: `${SERVER_KIND_LABELS[facts.localServer.kind]} · ${facts.localServer.detail}`
  });

  checks.push({
    id: "last-error",
    label: "Último error de instalación",
    state: classifyInstallCheck({ ok: facts.lastError ? false : true, severity: "warn" }),
    detail: facts.lastError
      ? `${facts.lastError.message} (${formatMoment(facts.lastError.at)})`
      : "Sin errores registrados en esta instalación."
  });

  // Solo se añaden cuando la interfaz midió el estado: así el contrato del
  // servicio sigue siendo el mismo cuando se usa sin inyección (pruebas).
  if (facts.localDb) {
    checks.push({
      id: "local-db",
      label: "Base local",
      state: classifyInstallCheck({
        ok: facts.localDb.state === "ready" ? true : facts.localDb.state === "error" ? false : null,
        severity: "error"
      }),
      detail: localDbDetail(facts.localDb)
    });
  }

  if (facts.lastBackup) {
    checks.push({
      id: "last-backup",
      label: "Último respaldo",
      state: classifyInstallCheck({ ok: facts.lastBackup.status === "ok", severity: "warn" }),
      detail: lastBackupDetail(facts.lastBackup)
    });
  }

  return checks;
}

function surfaceNotes(surface: InstallSurface): string[] {
  switch (surface) {
    case "android":
      return [
        "La reparación borra cachés y el service worker de la WebView; la base local no se toca.",
        "Las actualizaciones llegan por el manifiesto firmado y el instalador del shell."
      ];
    case "windows":
      return [
        "El hub local y el actualizador se consultan a través del puente de escritorio.",
        "Si el hub no responde, revisa el puerto y el certificado en Red local."
      ];
    case "web":
      return [
        "La pestaña web solo gestiona cuenta, plan y descargas; la operación requiere la app instalada."
      ];
    default:
      return ["No se reconoce la superficie: revisa cómo se abrió la aplicación."];
  }
}

/**
 * Recolecta el informe completo. Nunca lanza: cada bloque falla contenido y
 * deja una nota en `notes`.
 */
export async function collectInstallDiagnostics(
  deps: InstallDiagnosticsDeps = {}
): Promise<InstallDiagnosticsReport> {
  const generatedAt = safeNow(deps.now).toISOString();
  const notes: string[] = [];

  let surface: InstallSurface = "unknown";
  let version = PRODUCT_VERSION;
  let updateOrigin = DEFAULT_UPDATE_MANIFEST_URL;
  let native: NativeAppInfo | null = null;
  let serviceWorker: InstallServiceWorkerInfo = { registered: false };
  let cacheNames: string[] = [];
  let cacheAvailable = false;
  let localServer: InstallLocalServerInfo = {
    kind: "none",
    state: "unknown",
    detail: "No se pudo determinar el servidor local."
  };
  let lastError: LastInstallError | null = null;
  let storageInfo: { usage?: number; quota?: number } | null = null;
  let localDb: InstallLocalDbInfo | null = null;
  let lastBackup: InstallLastBackupInfo | null = null;

  try {
    surface = deps.surface ?? detectInstallSurface({ nativeInfo: deps.nativeInfo, scope: deps.scope });
    native = readNativeInfo(deps.nativeInfo);
    version = sanitizeText(native?.webVersion, 40) ?? PRODUCT_VERSION;
    updateOrigin = getUpdateOrigin({ env: deps.env });

    const nav = deps.navigatorImpl !== undefined ? deps.navigatorImpl : defaultNavigator();
    const cacheStorage = deps.cacheStorage !== undefined ? deps.cacheStorage : defaultCacheStorage();
    const storage = deps.storage !== undefined ? deps.storage : defaultStorage();

    serviceWorker = await readServiceWorker(nav);
    cacheAvailable = Boolean(cacheStorage && typeof cacheStorage.keys === "function");
    cacheNames = await readCacheNames(cacheStorage);
    storageInfo = await readStorageEstimate(nav);
    lastError = readLastInstallError(storage);
    localServer = await readLocalServer(surface, deps, notes);
    // Ya medidos por la interfaz (base local y respaldo); aquí solo se copian.
    localDb = deps.localDb !== undefined ? deps.localDb : null;
    lastBackup = deps.lastBackup !== undefined ? deps.lastBackup : null;

    if (lastError) {
      pushNote(notes, "Hay un error de instalación registrado; usa «Reparar instalación» y vuelve a intentar.");
    }
    if (localDb?.state === "error") {
      pushNote(notes, "La base local reportó un error; abre «Recuperación guiada» antes de restablecer datos.");
    }
    if (lastBackup && lastBackup.status !== "ok") {
      pushNote(notes, "No hay un respaldo correcto reciente: crea uno cifrado antes de reparar o reinstalar.");
    }
    if (!storageInfo) {
      pushNote(notes, "El sistema no informa el espacio usado del dispositivo (storage.estimate).");
    }
  } catch {
    pushNote(notes, "El diagnóstico se interrumpió; se muestran solo los datos ya recogidos.");
  }

  for (const note of surfaceNotes(surface)) pushNote(notes, note);
  pushNote(notes, "El informe solo incluye estados, versiones y tamaños; nunca tokens, claves ni valores de almacenamiento.");

  const facts: CheckFacts = {
    surface,
    version,
    native,
    updateOrigin,
    serviceWorker,
    caches: cacheNames,
    cacheAvailable,
    localServer,
    lastError,
    localDb,
    lastBackup
  };

  return {
    generatedAt,
    surface,
    version,
    updateOrigin,
    serviceWorker,
    caches: cacheNames,
    localServer,
    lastError,
    storage: storageInfo,
    localDb,
    lastBackup,
    checks: buildChecks(facts),
    notes
  };
}

/* ------------------------------------------------------------------ */
/* Informe legible                                                     */
/* ------------------------------------------------------------------ */

function storageSummary(storage: { usage?: number; quota?: number } | null): string {
  if (!storage) return "No disponible";
  const usage = storage.usage !== undefined ? formatStorageBytes(storage.usage) : "—";
  const quota = storage.quota !== undefined ? formatStorageBytes(storage.quota) : "—";
  return `${usage} usados de ${quota}`;
}

function swSummary(sw: InstallServiceWorkerInfo): string {
  if (!sw.registered) return "No registrado";
  const parts = ["Registrado"];
  if (sw.state) parts.push(`estado ${sw.state}`);
  if (sw.scope) parts.push(`ámbito ${sw.scope}`);
  return parts.join(" · ");
}

/** Texto plano en español para copiar o descargar. Nunca contiene secretos. */
export function formatInstallDiagnostics(report: InstallDiagnosticsReport): string {
  const lines: string[] = [];
  lines.push("PALMYRA · Diagnóstico de instalación");
  lines.push(`Generado: ${formatMoment(report.generatedAt)}`);
  lines.push(`Superficie: ${installSurfaceLabel(report.surface)}`);
  lines.push(`Versión: ${report.version}`);
  lines.push(`Origen de actualización: ${report.updateOrigin}`);
  lines.push(`Service worker: ${swSummary(report.serviceWorker)}`);
  lines.push(
    `Cachés: ${report.caches.length > 0 ? `${report.caches.length} (${report.caches.join(", ")})` : "ninguna"}`
  );
  lines.push(
    `Servidor local: ${SERVER_KIND_LABELS[report.localServer.kind]} · ${
      report.localServer.state === "ready"
        ? "listo"
        : report.localServer.state === "error"
          ? "error"
          : "sin datos"
    } · ${report.localServer.detail}`
  );
  lines.push(
    `Último error: ${
      report.lastError ? `${report.lastError.message} (${formatMoment(report.lastError.at)})` : "sin errores registrados"
    }`
  );
  lines.push(`Almacenamiento: ${storageSummary(report.storage)}`);
  lines.push(
    `Base local: ${
      report.localDb
        ? `${report.localDb.state === "ready" ? "lista" : report.localDb.state === "error" ? "error" : "sin datos"} · ${localDbDetail(report.localDb)}`
        : "no incluida en este informe"
    }`
  );
  lines.push(
    `Último respaldo: ${report.lastBackup ? lastBackupDetail(report.lastBackup) : "no incluido en este informe"}`
  );

  lines.push("");
  lines.push("Comprobaciones:");
  for (const check of report.checks) {
    lines.push(`- [${CHECK_STATE_LABELS[check.state]}] ${check.label}: ${check.detail}`);
  }

  if (report.notes.length > 0) {
    lines.push("");
    lines.push("Notas:");
    for (const note of report.notes) lines.push(`- ${note}`);
  }

  lines.push("");
  lines.push("Sin tokens, claves ni valores de almacenamiento.");
  return lines.join("\n");
}

/** Nombre pedido por soporte: diagnostico-instalacion-YYYYMMDD-HHMM.txt */
export function installReportFileName(generatedAt: string): string {
  const ms = Date.parse(generatedAt);
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  const digits = date.toISOString().slice(0, 16).replace(/[^0-9]/g, "");
  return `diagnostico-instalacion-${digits.slice(0, 8)}-${digits.slice(8, 12)}.txt`;
}

/**
 * Guarda el informe en el equipo (navegador, APK y escritorio Electron).
 *
 * En el APK el contenido viaja por el puente nativo hacia Descargas públicas;
 * en navegador, PWA y escritorio se usa Blob + enlace con `download` y
 * Chromium lo entrega al gestor de descargas. Devuelve `ok: false` cuando el
 * entorno no permite crear la descarga; la interfaz ofrece entonces el texto.
 */
export function downloadInstallDiagnostics(
  report: InstallDiagnosticsReport
): { ok: boolean; fileName: string } {
  const fileName = installReportFileName(report.generatedAt);
  try {
    const saved = downloadGeneratedFile(
      new TextEncoder().encode(formatInstallDiagnostics(report)),
      fileName,
      "text/plain;charset=utf-8"
    );
    return { ok: saved, fileName };
  } catch {
    return { ok: false, fileName };
  }
}
