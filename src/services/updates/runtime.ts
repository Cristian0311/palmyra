/**
 * Runtime de actualizaciones del renderer (PALMYRA).
 *
 * Une el manifiesto firmado (./manifest.ts, ./verify.ts y ./client.ts) con la
 * superficie real de esta instalación: versión web inyectada por Vite, shell
 * nativo de Android o escritorio Electron. Es código puro respecto a React:
 * estado observable, comprobaciones deduplicadas y descarte persistente; el
 * hook `useAppUpdateRuntime` solo lo conecta a la UI.
 *
 * Reglas de seguridad:
 *   - Sin URL de manifiesto o sin clave pública JWK el runtime queda
 *     `unconfigured` y NUNCA toca la red. No es un error: es un build sin canal
 *     de actualizaciones firmado.
 *   - El artefacto (URL y sha256) solo se publica cuando el cliente firmó la
 *     comprobación como `available`. Para no descargar el manifiesto dos veces,
 *     el `fetch` que se entrega al cliente captura los mismos bytes que el
 *     verificador aceptó y de ahí se leen los artefactos: la firma cubre
 *     exactamente esa copia, así que una URL inyectada por un proxy no puede
 *     colarse.
 *
 * Nada de este módulo tiene efectos al importarse: la red, el almacenamiento y
 * el reloj se tocan solo cuando se llama a `check`.
 */

import { getNativeAppInfo } from "../../lib/nativeApp";
import { PRODUCT_VERSION } from "../../lib/productVersion";
import {
  createUpdateClient,
  DEFAULT_UPDATE_INTERVAL_MS,
  MAX_MANIFEST_BYTES,
  type UpdateCheckResult,
  type UpdateCheckStorage,
  type UpdateClient
} from "./client";
import type { UpdateArtifact, UpdateManifestV1, UpdatePlatform } from "./manifest";
import { parseUpdateManifest } from "./manifest";
import { checkUpdatePublicJwk } from "./verify";
import bakedPublicKeyJson from "./update-public-key.json";

/** Variables de build leídas por Vite (nunca secretos: la JWK es pública). */
export const UPDATE_MANIFEST_URL_ENV = "VITE_UPDATE_MANIFEST_URL";
export const UPDATE_PUBLIC_JWK_ENV = "VITE_UPDATE_PUBLIC_JWK";

/** Manifiesto público del canal estable; el mismo que publica cada release. */
export const DEFAULT_UPDATE_MANIFEST_URL =
  "https://github.com/Cristian0311/palmyra/releases/latest/download/update-manifest.json";

/** Identificador estable del equipo (una sola vez por instalación). */
export const UPDATE_DEVICE_STORAGE_KEY = "palmyra-update-device";
/** Última comprobación válida, para respetar la cadencia de 24 h tras recargar. */
export const UPDATE_CHECK_STORAGE_KEY = "palmyra-update-check-v1";
/** Versión descartada por el usuario (clave histórica del aviso OTA). */
export const UPDATE_DISMISSED_STORAGE_KEY = "palmyra:ota-dismissed-version";

/** Motivo mostrable cuando el build no define el canal firmado. */
export const UPDATE_UNCONFIGURED_REASON =
  "Esta instalación no tiene configurado el canal de actualizaciones firmado. Descarga la versión más reciente desde la página oficial de PALMYRA.";

const MAX_DEVICE_ID_LENGTH = 200;
const MAX_MANIFEST_URL_LENGTH = 2048;

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

/** Identificador generado cuando no hay almacenamiento: se reutiliza siempre. */
let memoryDeviceId: string | null = null;

interface ViteEnvLike {
  env?: Record<string, unknown>;
}

function readEnvValue(name: string): string | null {
  try {
    // Bajo Node/pruebas `import.meta.env` no existe: cuenta como ausente.
    const env = (import.meta as ImportMeta & ViteEnvLike).env;
    const value = env ? env[name] : undefined;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * URL del manifiesto: `VITE_UPDATE_MANIFEST_URL` o el release oficial.
 * `envRaw` permite inyectar el valor en pruebas (null = forzar ausencia).
 */
export function getUpdateManifestUrl(envRaw?: string | null): string {
  const raw = envRaw === undefined ? readEnvValue(UPDATE_MANIFEST_URL_ENV) : envRaw;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed === "" || trimmed.length > MAX_MANIFEST_URL_LENGTH) return DEFAULT_UPDATE_MANIFEST_URL;
  return trimmed;
}

function cleanPublicJwk(value: unknown): JsonWebKey | null {
  const check = checkUpdatePublicJwk(value);
  if ("reason" in check) return null;
  const record = value as Record<string, unknown>;
  const jwk: JsonWebKey & { kid?: string } = {
    kty: "EC",
    crv: "P-256",
    x: String(record.x),
    y: String(record.y)
  };
  if (typeof record.kid === "string" && record.kid.trim() !== "") {
    jwk.kid = record.kid.trim();
  }
  return jwk;
}

/**
 * Clave pública ES256 (EC P-256) del manifiesto. Sin variable de entorno se usa
 * la clave estable incrustada en el build; un `envRaw` explícitamente null
 * desactiva el canal (pruebas y desarrollo), y un valor inválido no se sustituye
 * por la incrustada: preferimos quedarnos sin canal antes que verificar con una
 * clave dudosa.
 */
export function getUpdatePublicJwk(envRaw?: string | null): JsonWebKey | null {
  if (envRaw === null) return null;
  const raw = envRaw === undefined ? readEnvValue(UPDATE_PUBLIC_JWK_ENV) : envRaw;
  if (raw === null) return cleanPublicJwk(bakedPublicKeyJson);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return cleanPublicJwk(parsed);
}

function defaultStorage(): KeyValueStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    return candidate && typeof candidate.getItem === "function" ? candidate : null;
  } catch {
    // Un navegador en modo privado estricto lanza al leer localStorage.
    return null;
  }
}

function readStoredKey(storage: KeyValueStorage | null, key: string): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(key);
    return typeof value === "string" && value.trim() !== "" ? value : null;
  } catch {
    return null;
  }
}

function writeStoredKey(storage: KeyValueStorage | null, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Sin cuota o sin permisos: el valor se mantiene solo en memoria.
  }
}

function randomDeviceId(): string {
  const generator = (globalThis as { crypto?: Crypto }).crypto;
  if (generator && typeof generator.randomUUID === "function") {
    try {
      return generator.randomUUID();
    } catch {
      // Se intenta el respaldo hexadecimal.
    }
  }
  if (generator && typeof generator.getRandomValues === "function") {
    try {
      const bytes = new Uint8Array(16);
      generator.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      // Sin entropía: se usa el respaldo determinista.
    }
  }
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 12);
  return `palmyra-${stamp}-${noise}`;
}

/**
 * Identificador estable del equipo usado por el rollout. Se persiste en
 * `localStorage`; sin almacenamiento se genera una sola vez por módulo, así
 * que el rollout no cambia entre comprobaciones de la misma sesión.
 */
export function getUpdateDeviceId(storage?: KeyValueStorage): string {
  const store = storage ?? defaultStorage();
  const stored = readStoredKey(store, UPDATE_DEVICE_STORAGE_KEY);
  if (stored !== null && stored.length <= MAX_DEVICE_ID_LENGTH) {
    memoryDeviceId = stored;
    return stored;
  }
  if (memoryDeviceId !== null) {
    writeStoredKey(store, UPDATE_DEVICE_STORAGE_KEY, memoryDeviceId);
    return memoryDeviceId;
  }
  const generated = randomDeviceId();
  memoryDeviceId = generated;
  writeStoredKey(store, UPDATE_DEVICE_STORAGE_KEY, generated);
  return generated;
}

function hasAndroidShell(target: Window): boolean {
  const bridge = target.PALMYRA_NATIVE;
  return Boolean(bridge && typeof bridge.getInfo === "function");
}

function hasDesktopBridge(target: Window): boolean {
  const surface = target as Window & {
    palmyraDesktopUpdate?: unknown;
    palmyraDesktopDb?: unknown;
  };
  return Boolean(surface.palmyraDesktopUpdate || surface.palmyraDesktopDb);
}

/** Superficie real: shell Android, escritorio Electron o navegador. */
export function getUpdatePlatform(): UpdatePlatform {
  if (typeof window === "undefined") return "web";
  try {
    if (hasAndroidShell(window)) return "android";
    if (hasDesktopBridge(window)) return "windows";
  } catch {
    // `window` hostil cuenta como navegador.
  }
  return "web";
}

/**
 * Artefacto del manifiesto para esta plataforma; null si no lo publica.
 *
 * Android acepta además el paquete `web` (.zip): el shell instala exactamente
 * ese bundle (index.html + version.json) con `startUpdate`, así que un release
 * que solo publique el bundle web sigue pudiendo actualizar la tablet sin APK.
 * La copia devuelta se etiqueta como `android` para que la UI trate el paquete
 * como OTA nativo; URL, sha256 y bytes son los mismos que cubre la firma.
 */
export function selectUpdateArtifact(
  manifest: UpdateManifestV1 | null,
  platform: UpdatePlatform
): UpdateArtifact | null {
  if (!manifest || !Array.isArray(manifest.artifacts)) return null;
  const found = manifest.artifacts.find(
    (artifact) => artifact && artifact.platform === platform
  );
  if (found) return { ...found };
  if (platform === "android") {
    const bundle = manifest.artifacts.find(
      (artifact) =>
        artifact &&
        artifact.platform === "web" &&
        typeof artifact.name === "string" &&
        artifact.name.toLowerCase().endsWith(".zip")
    );
    if (bundle) return { ...bundle, platform: "android" };
  }
  return null;
}

/**
 * Almacén de la última comprobación (`UpdateCheckStorage`) sobre localStorage.
 * Un valor corrupto se trata como "nunca revisado": la cadencia se reinicia,
 * pero la app nunca deja de comprobar por un JSON roto.
 */
export function createRuntimeStorage(): UpdateCheckStorage {
  return {
    async load() {
      const store = defaultStorage();
      const raw = readStoredKey(store, UPDATE_CHECK_STORAGE_KEY);
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;
      const lastCheckAt = Number(record.lastCheckAt);
      if (!Number.isFinite(lastCheckAt) || lastCheckAt <= 0) return null;
      const lastStatus = typeof record.lastStatus === "string" ? record.lastStatus : "";
      return { lastCheckAt, lastStatus };
    },
    async save(value) {
      const store = defaultStorage();
      if (!store) return;
      const lastCheckAt = Number(value?.lastCheckAt);
      if (!Number.isFinite(lastCheckAt) || lastCheckAt <= 0) return;
      const lastStatus = typeof value?.lastStatus === "string" ? value.lastStatus : "";
      writeStoredKey(
        store,
        UPDATE_CHECK_STORAGE_KEY,
        JSON.stringify({ lastCheckAt, lastStatus })
      );
    }
  };
}

/**
 * Tipo de paquete Android que corresponde al artefacto: un `.apk` se instala
 * como APK y cualquier otro (`.zip`) es un bundle OTA del shell.
 */
export function androidUpdateKindForArtifact(
  artifact: Pick<UpdateArtifact, "name"> | null | undefined
): "bundle" | "apk" {
  const name = artifact && typeof artifact.name === "string" ? artifact.name.toLowerCase() : "";
  return name.endsWith(".apk") ? "apk" : "bundle";
}

export type AppUpdatePhase =
  | "unconfigured"
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "blocked"
  | "unverified"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  result: UpdateCheckResult | null;
  platform: UpdatePlatform;
  artifact: UpdateArtifact | null;
  lastCheckAt: number | null;
  error?: string;
  manual: boolean;
  /** Notas del manifiesto aceptado (solo cuando hay actualización). */
  notes?: string;
}

export interface AppUpdateRuntime {
  readonly client: UpdateClient | null;
  readonly state: AppUpdateState;
  check(force?: boolean): Promise<AppUpdateState>;
  subscribe(listener: (state: AppUpdateState) => void): () => void;
  dismiss(version: string): void;
  isDismissed(version: string): boolean;
  /**
   * Arranca la vigilancia automática (arranque, primer plano y cada
   * `intervalMs`). Idempotente: devuelve la parada de la vigilancia activa.
   */
  startAutoCheck(options?: { intervalMs?: number }): () => void;
  /** Detiene la vigilancia automática si estaba activa. */
  stopAutoCheck(): void;
}

export interface AppUpdateRuntimeDeps {
  /** Cliente ya construido (pruebas/integración). `null` = sin canal. */
  client?: UpdateClient | null;
  now?: () => number;
  /** Sustituto de VITE_UPDATE_MANIFEST_URL; undefined = leer el entorno. */
  manifestUrl?: string | null;
  /** Sustituto de VITE_UPDATE_PUBLIC_JWK; undefined = leer el entorno. */
  publicJwk?: JsonWebKey | null;
  /** Descarga inyectable; por defecto el `fetch` global. */
  fetchImpl?: typeof fetch;
  /**
   * Arrancar la vigilancia al crear el runtime (por defecto sí, cuando existe
   * `document`). Las pruebas en Node pasan `false` o simplemente no definen
   * `document`, así que nunca quedan temporizadores colgando.
   */
  autoSchedule?: boolean;
}

interface CaptureSlot {
  raw: string | null;
  settled: Promise<void>;
}

function createCaptureSlot(): CaptureSlot {
  return { raw: null, settled: Promise.resolve() };
}

/**
 * Copia los bytes que el cliente está a punto de verificar. Se lee un clon de
 * la respuesta (el cuerpo original queda intacto para el cliente) y solo se
 * conserva si respeta el tope del manifiesto.
 */
async function captureManifestText(response: Response, slot: CaptureSlot): Promise<void> {
  try {
    if (!response || typeof response.clone !== "function") return;
    const clone = response.clone();
    let declared = Number.NaN;
    try {
      const header = clone.headers && typeof clone.headers.get === "function"
        ? clone.headers.get("content-length")
        : null;
      declared = header ? Number(header) : Number.NaN;
    } catch {
      declared = Number.NaN;
    }
    if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) return;
    const text = await clone.text();
    if (typeof text === "string" && text.length <= MAX_MANIFEST_BYTES) slot.raw = text;
  } catch {
    // Un clon ilegible solo deja el artefacto sin resolver; la comprobación vale.
  }
}

function createCapturingFetch(base: typeof fetch, slot: CaptureSlot): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await base(input, init);
    slot.raw = null;
    slot.settled = captureManifestText(response, slot);
    return response;
  }) as typeof fetch;
}

function phaseFor(result: UpdateCheckResult | null): AppUpdatePhase | null {
  if (!result) return null;
  switch (result.status) {
    case "available":
      return "available";
    case "up-to-date":
      return "up-to-date";
    case "blocked":
      return "blocked";
    case "unverified":
      return "unverified";
    case "error":
      return "error";
    case "unconfigured":
      return "unconfigured";
    default:
      // "not-due": no hubo comprobación real; se conserva la fase anterior.
      return null;
  }
}

function errorFor(result: UpdateCheckResult | null): string | undefined {
  if (!result) return undefined;
  if (result.status === "error" || result.status === "blocked") {
    const text = typeof result.error === "string" ? result.error.trim() : "";
    return text !== "" ? text : undefined;
  }
  return undefined;
}

/** Artefacto y notas del manifiesto aceptado (mismos bytes que se verificaron). */
function readAcceptedManifest(
  raw: string | null,
  version: string | undefined,
  platform: UpdatePlatform
): { artifact: UpdateArtifact | null; notes?: string } {
  if (!raw || typeof version !== "string" || version === "") {
    return { artifact: null };
  }
  try {
    const manifest = parseUpdateManifest(JSON.parse(raw), { currentVersion: PRODUCT_VERSION });
    if (manifest.version !== version) return { artifact: null };
    const artifact = selectUpdateArtifact(manifest, platform);
    const notes = typeof manifest.notes === "string" && manifest.notes.trim() !== ""
      ? manifest.notes.trim()
      : undefined;
    return notes === undefined ? { artifact } : { artifact, notes };
  } catch {
    return { artifact: null };
  }
}

/**
 * Crea el runtime del renderer. Con `client` inyectado se usa tal cual (la
 * captura de artefactos solo existe en el cliente que construimos aquí).
 * Sin configuración válida el estado es `unconfigured` y no se crea red.
 */
export function createAppUpdateRuntime(deps: AppUpdateRuntimeDeps = {}): AppUpdateRuntime {
  const platform = getUpdatePlatform();
  const now = deps.now ?? (() => Date.now());
  const slot = createCaptureSlot();
  const listeners = new Set<(state: AppUpdateState) => void>();
  const dismissed = new Set<string>();

  const storedDismissed = readStoredKey(defaultStorage(), UPDATE_DISMISSED_STORAGE_KEY);
  if (storedDismissed !== null) dismissed.add(storedDismissed.trim());

  const configured = resolveClient(deps, slot, now);
  const client = configured.client;

  let state: AppUpdateState = {
    phase: client ? "idle" : "unconfigured",
    result: null,
    platform,
    artifact: null,
    lastCheckAt: null,
    manual: false,
    ...(configured.reason ? { error: configured.reason } : {})
  };
  let inFlight: Promise<AppUpdateState> | null = null;
  let stopAuto: (() => void) | null = null;

  function emit(next: AppUpdateState): void {
    state = next;
    listeners.forEach((listener) => {
      try {
        listener(next);
      } catch {
        // Un suscriptor roto no debe tumbar la comprobación.
      }
    });
  }

  function safeNow(): number {
    try {
      const value = now();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  async function run(force: boolean): Promise<AppUpdateState> {
    if (!client) {
      if (state.manual !== force) emit({ ...state, manual: force });
      return state;
    }
    if (inFlight) return inFlight;

    const previous = state;
    emit({ ...previous, phase: "checking", manual: force, error: undefined });
    slot.raw = null;
    slot.settled = Promise.resolve();

    inFlight = (async () => {
      let result: UpdateCheckResult | null = null;
      try {
        result = await client.check({ force });
      } catch (error) {
        result = {
          status: "error",
          code: "unexpected",
          checkedAt: safeNow(),
          error:
            error instanceof Error && error.message.trim() !== ""
              ? error.message
              : "La comprobación de actualización falló por un motivo desconocido."
        };
      }
      try {
        await slot.settled;
      } catch {
        // La captura es opcional: sin ella solo falta el artefacto.
      }

      const nextPhase = phaseFor(result);
      if (nextPhase === null) {
        // "not-due": el cliente respetó la cadencia; nada cambió de verdad.
        emit({ ...previous, manual: force });
        return state;
      }

      const accepted =
        nextPhase === "available"
          ? readAcceptedManifest(slot.raw, result ? result.version : undefined, platform)
          : { artifact: null };
      const checkedAt = result && Number.isFinite(result.checkedAt) && result.checkedAt > 0
        ? result.checkedAt
        : previous.lastCheckAt;
      const error = errorFor(result);
      const next: AppUpdateState = {
        phase: nextPhase,
        result,
        platform,
        artifact: accepted.artifact,
        lastCheckAt: checkedAt,
        manual: force,
        ...(error ? { error } : {}),
        ...(accepted.notes ? { notes: accepted.notes } : {})
      };
      emit(next);
      return next;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  /**
   * Vigilancia automática: una comprobación al arrancar, otra cada vez que la
   * app vuelve a primer plano (visibilitychange, focus, pageshow, online y el
   * aviso `palmyra:native-resume` del shell Android) y una consulta forzada
   * cada `intervalMs` (24 h por defecto). El aviso inmediato de un build nuevo
   * lo da ahora el servidor por Realtime (`system_update_signals`): este reloj
   * es la red de seguridad para equipos que no reciben la señal, así que no
   * necesita sondear seguido. La firma del manifiesto se sigue verificando.
   *
   * Sin `document` (Node, pruebas) no se instala nada: nunca quedan
   * temporizadores colgando.
   */
  function canWatchLifecycle(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof document !== "undefined" &&
      typeof window.setInterval === "function" &&
      typeof window.addEventListener === "function" &&
      typeof document.addEventListener === "function"
    );
  }

  function startAutoCheck(options: { intervalMs?: number } = {}): () => void {
    if (!client || !canWatchLifecycle()) return () => undefined;
    // Idempotente: dos pantallas que montan el hook comparten una sola vigilancia.
    if (stopAuto) return stopAuto;

    const requested = Number(options && options.intervalMs);
    const intervalMs =
      Number.isFinite(requested) && requested > 0
        ? Math.max(60_000, Math.trunc(requested))
        : DEFAULT_UPDATE_INTERVAL_MS;

    // El reloj periódico force la consulta: si el usuario acaba de comprobar
    // al abrir una pantalla, la cadencia normal dejaría el aviso para más tarde.
    const timer = window.setInterval(() => {
      void run(true);
    }, intervalMs);

    const onForeground = () => {
      try {
        if (document.visibilityState !== "visible") return;
      } catch {
        // Sin Page Visibility se comprueba igual: mejor de más que de menos.
      }
      // Respetar la cadencia: un cambio de pestaña no debe multiplicar descargas.
      void run(false);
    };

    window.addEventListener("focus", onForeground);
    window.addEventListener("online", onForeground);
    window.addEventListener("pageshow", onForeground);
    // Evento propio del shell Android (MainActivity.onResume): en WebView el
    // ciclo de actividad no siempre publica visibilitychange.
    window.addEventListener("palmyra:native-resume", onForeground);
    document.addEventListener("visibilitychange", onForeground);

    const stop = () => {
      try {
        window.clearInterval(timer);
      } catch {
        // Nada que limpiar.
      }
      window.removeEventListener("focus", onForeground);
      window.removeEventListener("online", onForeground);
      window.removeEventListener("pageshow", onForeground);
      window.removeEventListener("palmyra:native-resume", onForeground);
      document.removeEventListener("visibilitychange", onForeground);
      if (stopAuto === stop) stopAuto = null;
    };
    stopAuto = stop;

    // Arranque: la primera comprobación (el cliente respeta la marca persistida).
    void run(false);
    return stop;
  }

  function stopAutoCheck(): void {
    if (stopAuto) stopAuto();
  }

  if (deps.autoSchedule !== false && client) {
    startAutoCheck();
  }

  return {
    get client() {
      return client;
    },
    get state() {
      return state;
    },
    check(force = false) {
      return run(force === true);
    },
    startAutoCheck,
    stopAutoCheck,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dismiss(version) {
      const normalized = typeof version === "string" ? version.trim() : "";
      if (normalized === "") return;
      dismissed.add(normalized);
      writeStoredKey(defaultStorage(), UPDATE_DISMISSED_STORAGE_KEY, normalized);
      // Aviso a la UI: el descarte no cambia la fase, pero sí lo visible.
      emit({ ...state });
    },
    isDismissed(version) {
      const normalized = typeof version === "string" ? version.trim() : "";
      return normalized !== "" && dismissed.has(normalized);
    }
  };
}

/**
 * Construye el cliente real o explica por qué no hay canal. Se resuelve la
 * configuración ANTES de tocar red, almacenamiento o reloj.
 */
function resolveClient(
  deps: AppUpdateRuntimeDeps,
  slot: CaptureSlot,
  now: () => number
): { client: UpdateClient | null; reason: string | null } {
  if (deps.client !== undefined) {
    if (deps.client) return { client: deps.client, reason: null };
    return { client: null, reason: UPDATE_UNCONFIGURED_REASON };
  }

  const manifestUrl =
    deps.manifestUrl !== undefined
      ? typeof deps.manifestUrl === "string"
        ? deps.manifestUrl.trim()
        : ""
      : getUpdateManifestUrl();
  if (manifestUrl === "") {
    return { client: null, reason: UPDATE_UNCONFIGURED_REASON };
  }

  const publicJwk = deps.publicJwk !== undefined ? deps.publicJwk : getUpdatePublicJwk();
  if (!publicJwk) {
    return { client: null, reason: UPDATE_UNCONFIGURED_REASON };
  }

  const baseFetch =
    deps.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!baseFetch) {
    return { client: null, reason: UPDATE_UNCONFIGURED_REASON };
  }

  let shellVersion = PRODUCT_VERSION;
  try {
    const native = typeof window !== "undefined" ? getNativeAppInfo() : null;
    const candidate = native && typeof native.shellVersion === "string"
      ? native.shellVersion.trim()
      : "";
    if (candidate !== "") shellVersion = candidate;
  } catch {
    shellVersion = PRODUCT_VERSION;
  }

  const client = createUpdateClient({
    manifestUrl,
    publicJwk,
    currentVersion: PRODUCT_VERSION,
    shellVersion,
    deviceId: getUpdateDeviceId(),
    channel: "stable",
    storage: createRuntimeStorage(),
    fetchImpl: createCapturingFetch(baseFetch, slot),
    now
  });
  return { client, reason: null };
}
