export type NativeAppInfo = {
  platform: string;
  shellVersion: string;
  webVersion: string;
  ota: boolean;
};

export type NativeUpdateRequest = {
  version: string;
  url: string;
  sha256: string;
  bytes: number;
};

export type NativeOtaProgress = {
  phase?: "downloading" | "verifying" | "applying" | "reloading" | string;
  percent?: number;
  receivedBytes?: number;
  totalBytes?: number;
};

export type PalmyraNativeBridge = {
  getInfo(): string;
  confirmBoot(): void;
  startUpdate(version: string, url: string, sha256: string, bytes: number): void;
  /** OTA del APK: el shell verifica firma, versión y SHA-256 antes de instalar. */
  startApkUpdate?(version: string, url: string, sha256: string, bytes: number): void;
  /** Instala un APK elegido con el selector del sistema (USB/SD). */
  importApk?(): void;
  /** Instala un paquete web .zip elegido con el selector del sistema (USB/SD). */
  importBundle?(): void;
  /**
   * Guarda un archivo exportado por la web (Excel/CSV/TXT) en Descargas
   * públicas. Responde un envelope JSON con `ok:false` si falla.
   */
  saveFile?(fileName: string, dataBase64: string, mimeType: string): string | Promise<string>;
  /**
   * Pide los permisos de hardware del APK (Bluetooth y notificaciones). La
   * versión del shell que añade la impresión térmica lo expone; si falta, el
   * helper correspondiente degrada hacia `PALMYRA_PRINTER.requestPermissions()`.
   */
  requestHardwarePermissions?(): string | Promise<string>;
  /**
   * Aviso real en la bandeja de Android. La WebView no tiene API Web de
   * notificaciones (permission siempre "denied"), así que el NotificationManager
   * del shell es el único canal. Responde un envelope JSON con el motivo cuando
   * no puede publicar.
   */
  showNotification?(title: string, body: string, tag: string): string | Promise<string>;
};

/**
 * Cifrado del Keystore de Android (`PALMYRA_KEYSTORE`).
 *
 * Solo cruzan texto Base64: el Keystore nunca devuelve la clave AES, solo el
 * sobre cifrado (`sealSecret`) o el texto descifrado (`openSecret`). Ambas
 * respuestas son un envelope JSON con `ok:false` si algo falla.
 */
export type NativeKeystoreBridge = {
  sealSecret(plainBase64: string): string | Promise<string>;
  openSecret(envelopeBase64: string): string | Promise<string>;
};

/**
 * Respaldo del dispositivo (`PALMYRA_BACKUP`).
 *
 * Escribe el sobre cifrado en Descargas públicas y restaura desde un archivo
 * elegido con el selector del sistema. Todas las respuestas son envelopes JSON
 * (`ok:false` con un código corto si falla) y el archivo importado se lee por
 * trozos con `readPending` para no cruzar decenas de MB en una sola llamada.
 * `openPicker` no devuelve envelope: el resultado llega como evento
 * `palmyra-backup-imported`.
 */
export type AndroidBackupBridge = {
  save(fileName: string, dataBase64: string, sha256Expected: string): string | Promise<string>;
  list(): string | Promise<string>;
  remove(name: string): string | Promise<string>;
  openPicker(): void | Promise<void>;
  pendingInfo(): string | Promise<string>;
  readPending(offset: number, length: number): string | Promise<string>;
  clearPending(): string | Promise<string>;
};

/** Evento que el shell dispara al terminar (o cancelar) el selector nativo. */
export const ANDROID_BACKUP_IMPORTED_EVENT = "palmyra-backup-imported";

/**
 * Impresora térmica del shell Android (`PALMYRA_PRINTER`).
 *
 * La WebView no expone Web Bluetooth ni Web Serial, así que la única vía real
 * de imprimir un ESC/POS desde el APK es este puente: el contenido viaja en
 * Base64 y el shell lo escribe por RFCOMM (SPP) o por USB con `UsbManager`.
 * Todos los métodos devuelven un envelope JSON `{ok:boolean, code?:string}`;
 * nunca lanzan excepciones hacia la web y nunca registran el ticket.
 */
export type NativePrinterEnvelope = {
  ok: boolean;
  code?: string;
  deviceName?: string;
  bytes?: number;
  /** "pending": Android aún está mostrando el diálogo de permisos. */
  state?: string;
};

export type PalmyraPrinterBridge = {
  /** Hay adaptador Bluetooth y/o dispositivos USB de impresión presentes. */
  available(): string | Promise<string>;
  /** Pide los permisos de hardware (Bluetooth/USB) del lado de Android. */
  requestPermissions(): string | Promise<string>;
  /** Estado actual de los permisos del sistema (no pide nada al usuario). */
  permissionStatus?(): string | Promise<string>;
  /** Dispositivos visibles/candidatos para imprimir (nombre + dirección). */
  listDevices(): string | Promise<string>;
  printRawBase64(payloadBase64: string, deviceAddress: string): string | Promise<string>;
  close(): string | Promise<string>;
};

/** Nombre exacto del objeto que inyecta `MainActivity` en la WebView. */
export const PRINTER_BRIDGE_GLOBAL_KEY = "PALMYRA_PRINTER";
/** Techo del payload ESC/POS que cruza el puente (un ticket ronda 2-8 KB). */
export const NATIVE_PRINT_MAX_BASE64_CHARS = 2 * 1024 * 1024;

export type AndroidBackupImportedDetail = {
  ok: boolean;
  name?: string;
  error?: string;
};

declare global {
  interface Window {
    PALMYRA_NATIVE?: PalmyraNativeBridge;
    PALMYRA_KEYSTORE?: NativeKeystoreBridge;
    PALMYRA_BACKUP?: AndroidBackupBridge;
    PALMYRA_PRINTER?: PalmyraPrinterBridge;
    __palmyraOtaProgress?: (detail: NativeOtaProgress) => void;
    __palmyraOtaInstalled?: (version?: string) => void;
    __palmyraOtaError?: (message?: string) => void;
  }
}

let cachedInfo: NativeAppInfo | null | undefined;

export function getNativeAppInfo(): NativeAppInfo | null {
  if (cachedInfo !== undefined) return cachedInfo;
  const bridge = typeof window !== "undefined" ? window.PALMYRA_NATIVE : undefined;
  if (!bridge) {
    cachedInfo = null;
    return cachedInfo;
  }
  try {
    const parsed = JSON.parse(bridge.getInfo()) as Partial<NativeAppInfo>;
    cachedInfo = {
      platform: String(parsed.platform || "android"),
      shellVersion: String(parsed.shellVersion || ""),
      webVersion: String(parsed.webVersion || ""),
      ota: parsed.ota === true,
    };
  } catch {
    cachedInfo = null;
  }
  return cachedInfo;
}

/**
 * Conecta los callbacks nativos con eventos de la web. Se instala antes de
 * renderizar para que ninguna actualización pierda progreso o errores.
 */
export function installNativeUpdateHooks(): void {
  if (!getNativeAppInfo()) return;
  const size = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  window.__palmyraOtaProgress = (detail) => {
    // El progreso nativo siempre debe llevar bytes para mostrar MB reales.
    const payload: NativeOtaProgress = {
      phase: detail?.phase,
      percent: size(detail?.percent),
      receivedBytes: size(detail?.receivedBytes),
      totalBytes: size(detail?.totalBytes),
    };
    window.dispatchEvent(new CustomEvent<NativeOtaProgress>("palmyra:ota-progress", { detail: payload }));
  };
  window.__palmyraOtaInstalled = (version) => {
    window.dispatchEvent(new CustomEvent("palmyra:ota-installed", { detail: { version } }));
  };
  window.__palmyraOtaError = (message) => {
    window.dispatchEvent(new CustomEvent("palmyra:ota-error", { detail: { message } }));
  };
}

/** La app quedó operativa: el shell puede dar por buena esta versión. */
export function confirmNativeBoot(): void {
  try {
    if (getNativeAppInfo()) window.PALMYRA_NATIVE?.confirmBoot();
  } catch {
    // El puente es opcional; en navegador/PWA no existe.
  }
}

export function startNativeUpdate(update: NativeUpdateRequest): boolean {
  const bridge = typeof window !== "undefined" ? window.PALMYRA_NATIVE : undefined;
  if (!bridge) return false;
  try {
    const version = String(update.version || "").trim();
    const url = String(update.url || "").trim();
    const sha256 = String(update.sha256 || "").trim();
    const parsedBytes = Number(update.bytes);
    // El shell exige versión, HTTPS y SHA-256: se valida aquí para no dejar la
    // UI en "Descargando" cuando el puente rechazaría la petición.
    if (!version || !/^https:\/\//i.test(url) || !/^[a-f0-9]{64}$/i.test(sha256)) return false;
    bridge.startUpdate(version, url, sha256, Number.isFinite(parsedBytes) && parsedBytes > 0 ? Math.floor(parsedBytes) : 0);
    return true;
  } catch {
    return false;
  }
}

/** True solo si el shell expone la OTA del APK (versión con instalador). */
export function hasAndroidOtaBridge(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.PALMYRA_NATIVE;
  return Boolean(bridge && typeof bridge.startApkUpdate === "function");
}

/* ------------------------------------------------------------------ */
/* Keystore de Android (secretos del dispositivo)                      */
/* ------------------------------------------------------------------ */

/** Techo de texto que cruza el puente; el Keystore aplica el mismo límite. */
export const NATIVE_SECRET_MAX_BYTES = 32 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Puente del Keystore del APK; null en escritorio, navegador y PWA. */
export function getNativeKeystoreBridge(): NativeKeystoreBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = window.PALMYRA_KEYSTORE;
  if (
    candidate &&
    typeof candidate.sealSecret === "function" &&
    typeof candidate.openSecret === "function"
  ) {
    return candidate;
  }
  return null;
}

/**
 * Puente de respaldo del APK; null en escritorio, navegador y PWA. Se exige la
 * superficie completa: un puente a medias dejaría el panel roto a mitad de un
 * respaldo.
 */
export function getAndroidBackupBridge(): AndroidBackupBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = window.PALMYRA_BACKUP;
  if (
    candidate &&
    typeof candidate.save === "function" &&
    typeof candidate.list === "function" &&
    typeof candidate.remove === "function" &&
    typeof candidate.openPicker === "function" &&
    typeof candidate.pendingInfo === "function" &&
    typeof candidate.readPending === "function" &&
    typeof candidate.clearPending === "function"
  ) {
    return candidate;
  }
  return null;
}

function parseEnvelope(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > NATIVE_SECRET_MAX_BYTES * 2) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Cifra un texto con la clave AES del Android Keystore y devuelve el sobre en
 * Base64. Nunca lanza: un Keystore roto devuelve null y el llamador degrada.
 */
export async function sealNativeSecret(text: string): Promise<string | null> {
  const bridge = getNativeKeystoreBridge();
  if (!bridge || typeof text !== "string") return null;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0 || bytes.length > NATIVE_SECRET_MAX_BYTES) return null;
  try {
    const envelope = parseEnvelope(await bridge.sealSecret(bytesToBase64(bytes)));
    if (!envelope || envelope.ok !== true) return null;
    const sealed = envelope.envelope;
    if (typeof sealed !== "string" || sealed.length === 0 || sealed.length > NATIVE_SECRET_MAX_BYTES * 2) {
      return null;
    }
    return sealed;
  } catch {
    return null;
  }
}

/** Descifra un sobre del Keystore. Devuelve null si no es descifrable. */
export async function openNativeSecret(envelope: string): Promise<string | null> {
  const bridge = getNativeKeystoreBridge();
  if (!bridge || typeof envelope !== "string" || envelope.length === 0) return null;
  if (envelope.length > NATIVE_SECRET_MAX_BYTES * 2) return null;
  try {
    const result = parseEnvelope(await bridge.openSecret(envelope));
    if (!result || result.ok !== true || typeof result.value !== "string") return null;
    const bytes = base64ToBytes(result.value);
    if (!bytes || bytes.length === 0 || bytes.length > NATIVE_SECRET_MAX_BYTES) return null;
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Impresora térmica del APK (PALMYRA_PRINTER)                          */
/* ------------------------------------------------------------------ */

/**
 * Puente de impresión del APK; null en escritorio, navegador y PWA. Se exige la
 * superficie mínima (`available` + `printRawBase64` + `close`): un puente a
 * medias dejaría el POS sin vía de impresión a mitad de un ticket.
 */
export function getNativePrinterBridge(): PalmyraPrinterBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = window[PRINTER_BRIDGE_GLOBAL_KEY as keyof Window] as
    | PalmyraPrinterBridge
    | undefined;
  if (
    candidate &&
    typeof candidate.available === "function" &&
    typeof candidate.printRawBase64 === "function" &&
    typeof candidate.close === "function"
  ) {
    return candidate;
  }
  return null;
}

/** True solo si el shell expone el puente de impresión (APK con este shell). */
export function hasNativePrinterBridge(): boolean {
  return getNativePrinterBridge() !== null;
}

/**
 * Lee un envelope del puente de impresión. Nunca lanza: un puente roto o una
 * respuesta inesperada devuelven `{ok:false, code}` para que la UI pueda
 * explicar el motivo sin romper la venta.
 */
export function parsePrinterEnvelope(raw: unknown): NativePrinterEnvelope {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64 * 1024) {
    return { ok: false, code: "bad_response" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "bad_response" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, code: "bad_response" };
  const record = parsed as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : undefined;
  const state = typeof record.state === "string" ? record.state : undefined;
  if (record.ok === true) {
    return {
      ok: true,
      code,
      state,
      deviceName: typeof record.deviceName === "string" ? record.deviceName : undefined,
      bytes: Number.isFinite(Number(record.bytes)) ? Number(record.bytes) : undefined,
    };
  }
  return { ok: false, code: code || "print_failed", state };
}

/**
 * Imprime bytes ESC/POS por el puente nativo. Devuelve el envelope ya saneado;
 * `unavailable` significa que no hay puente (el llamador degrada a Web
 * Bluetooth/Serial o a la guía de la superficie correspondiente).
 */
export async function printViaNativePrinter(
  bytes: Uint8Array,
  deviceAddress?: string
): Promise<NativePrinterEnvelope> {
  const bridge = getNativePrinterBridge();
  if (!bridge) return { ok: false, code: "unavailable" };
  if (!bytes || bytes.length === 0) return { ok: false, code: "empty_data" };
  try {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    const payload = btoa(binary);
    if (payload.length > NATIVE_PRINT_MAX_BASE64_CHARS) return { ok: false, code: "too_large" };
    return parsePrinterEnvelope(await bridge.printRawBase64(payload, String(deviceAddress || "")));
  } catch {
    return { ok: false, code: "bridge_error" };
  }
}

/** Estado del hardware de impresión del dispositivo (Bluetooth/USB presentes). */
export async function queryNativePrinterAvailability(): Promise<NativePrinterEnvelope> {
  const bridge = getNativePrinterBridge();
  if (!bridge) return { ok: false, code: "unavailable" };
  try {
    return parsePrinterEnvelope(await bridge.available());
  } catch {
    return { ok: false, code: "bridge_error" };
  }
}

/**
 * Nombre del callback que `MainActivity` invoca tras cerrar el diálogo de
 * permisos del sistema.
 */
export const HARDWARE_PERMISSIONS_PUSH_KEY = "__palmyraHardwarePermissions";

/**
 * Pide los permisos de hardware del APK (Bluetooth/USB/notificaciones).
 *
 * Android muestra el diálogo en el hilo de la interfaz, así que el puente
 * responde enseguida con `{ok:true, state:"pending"}` y el resultado real llega
 * después, empujado desde `MainActivity` a `window.__palmyraHardwarePermissions`.
 * Aquí se espera ese empuje: sin esta espera la UI creería que el permiso quedó
 * concedido en el instante en que apareció el diálogo.
 */
export async function requestNativeHardwarePermissions(): Promise<NativePrinterEnvelope> {
  const first = await requestNativeHardwarePermissionsOnce();
  if (!(first.ok && first.state === "pending")) return first;
  const settled = await waitForHardwarePermissionsPush();
  return settled ?? first;
}

async function requestNativeHardwarePermissionsOnce(): Promise<NativePrinterEnvelope> {
  const native = typeof window !== "undefined" ? window.PALMYRA_NATIVE : undefined;
  if (native && typeof native.requestHardwarePermissions === "function") {
    try {
      return parsePrinterEnvelope(await native.requestHardwarePermissions());
    } catch {
      return { ok: false, code: "bridge_error" };
    }
  }
  const bridge = getNativePrinterBridge();
  if (bridge && typeof bridge.requestPermissions === "function") {
    try {
      return parsePrinterEnvelope(await bridge.requestPermissions());
    } catch {
      return { ok: false, code: "bridge_error" };
    }
  }
  return { ok: false, code: "unavailable" };
}

/**
 * Promise que resuelve el empuje de Android. Devuelve null si el shell nunca
 * avisa (el usuario deja el diálogo abierto): el llamador conserva el "pending"
 * y puede volver a preguntar más tarde.
 */
function waitForHardwarePermissionsPush(timeoutMs = 90000): Promise<NativePrinterEnvelope | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const host = window as unknown as Record<string, unknown>;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: NativePrinterEnvelope | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete host[HARDWARE_PERMISSIONS_PUSH_KEY];
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    host[HARDWARE_PERMISSIONS_PUSH_KEY] = (raw: unknown) => {
      finish(typeof raw === "string" ? parsePrinterEnvelope(raw) : parsePrinterEnvelope(JSON.stringify(raw ?? {})));
    };
  });
}

/**
 * Estado de los permisos del sistema en el APK, sin abrir ningún diálogo.
 * Devuelve null cuando el shell no lo reporta (APK antiguo o no-Android).
 */
export async function queryNativePermissionStatus(): Promise<
  { notifications: boolean; bluetooth: boolean } | null
> {
  const bridge = getNativePrinterBridge();
  if (!bridge || typeof bridge.permissionStatus !== "function") return null;
  try {
    const raw = await bridge.permissionStatus();
    if (typeof raw !== "string" || raw.length > 8192) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed?.ok !== true) return null;
    return {
      notifications: parsed.notifications === true,
      bluetooth: parsed.bluetooth === true
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Aviso del sistema en el APK (NotificationManager del shell)          */
/* ------------------------------------------------------------------ */

export type NativeAlertOutcome = "sent" | "denied" | "unsupported" | "failed";

/** El shell exporta el canal de avisos (APK con PalmyraNotifications). */
export function hasNativeAlertBridge(): boolean {
  const bridge = typeof window !== "undefined" ? window.PALMYRA_NATIVE : undefined;
  return typeof bridge?.showNotification === "function";
}

/**
 * Publica el aviso en la bandeja de Android. El envelope distingue los casos:
 * `denied` es que falta POST_NOTIFICATIONS (se pide al entrar), no que el sistema
 * no pueda mostrar nada. Cualquier otro fallo degrada sin interrumpir el aviso
 * dentro de PALMYRA.
 */
export async function showNativeNotification(
  title: string,
  body: string,
  tag: string
): Promise<NativeAlertOutcome> {
  const bridge = typeof window !== "undefined" ? window.PALMYRA_NATIVE : undefined;
  if (!bridge || typeof bridge.showNotification !== "function") return "unsupported";
  try {
    const parsed = parseEnvelope(await bridge.showNotification(title, body, tag));
    if (!parsed) return "failed";
    if (parsed.ok === true) return "sent";
    return parsed.code === "permission_denied" ? "denied" : "failed";
  } catch {
    return "failed";
  }
}

/* ------------------------------------------------------------------ */
/* Causa real de un fallo de push (mensajes accionables)                */
/* ------------------------------------------------------------------ */

export type PushFailureCause =
  | "no_service_worker"
  | "no_push_api"
  | "missing_vapid_key"
  | "permission_denied"
  | "permission_dismissed"
  | "insecure_context"
  | "iframe_context"
  | "subscription_expired"
  | "invalid_subscription"
  | "network"
  | "server_unreachable"
  | "unknown";

export type PushFailureInfo = {
  cause: PushFailureCause;
  /** Primer renglón: español claro, sin tecnicismos crudos. */
  headline: string;
  /** Cuerpo del aviso: detalle técnico y siguiente paso concreto. */
  detail: string;
};

const PUSH_FAILURE_TEXT: Record<PushFailureCause, { headline: string; detail: string }> = {
  no_service_worker: {
    headline: "PALMYRA no terminó de instalarse en este navegador",
    detail:
      "Falta el servicio de avisos del dispositivo. Abre PALMYRA una vez con Chrome, deja que cargue completa y vuelve a activar el push."
  },
  no_push_api: {
    headline: "Este navegador no admite notificaciones push",
    detail:
      "La app de escritorio y la pestaña web no reciben push. Usa Chrome en Android o instala PALMYRA como aplicación y actívalo allí."
  },
  missing_vapid_key: {
    headline: "El servidor todavía no puede enviar avisos",
    detail:
      "Esta instalación no tiene clave pública VAPID configurada (VITE_VAPID_PUBLIC_KEY). Los avisos siguen visibles dentro de PALMYRA hasta corregirlo."
  },
  permission_denied: {
    headline: "El navegador bloqueó los avisos de PALMYRA",
    detail:
      "En Ajustes › Aplicaciones › PALMYRA › Permisos (Android) o en el candado de la barra de direcciones (escritorio), permite las notificaciones y vuelve a pulsar «Activar push»."
  },
  permission_dismissed: {
    headline: "Cerraste la ventana del permiso sin responder",
    detail:
      "El navegador solo muestra esa ventana una vez por sesión. Vuelve a pulsar «Activar push» y elige «Permitir»."
  },
  insecure_context: {
    headline: "PALMYRA está abierto en una dirección no segura",
    detail:
      "Los avisos exigen HTTPS. Abre https://palmyracrm.onrender.com en lugar de una IP o un enlace http:."
  },
  iframe_context: {
    headline: "PALMYRA está dentro de otra página",
    detail: "Abre PALMYRA en su propia pestaña: en vista embebida el navegador no concede permisos de avisos."
  },
  subscription_expired: {
    headline: "El registro anterior de este móvil caducó",
    detail:
      "El proveedor de avisos retiró la suscripción. Pulsa «Activar push» de nuevo: PALMYRA crea un registro fresco."
  },
  invalid_subscription: {
    headline: "El navegador devolvió un registro incompleto",
    detail:
      "Faltan datos del sobre de avisos. Borra el sitio en los permisos del navegador, recarga PALMYRA y vuelve a activar el push."
  },
  network: {
    headline: "Sin conexión con el servicio de avisos",
    detail:
      "Revisa la red (en Cuba una VPN o un portal cautivo interrumpe el push) y vuelve a intentarlo. Tus avisos quedan guardados dentro de PALMYRA."
  },
  server_unreachable: {
    headline: "No se pudo hablar con el servicio de PALMYRA",
    detail: "El registro del dispositivo no llegó al servidor. Revisa la conexión y pulsa «Activar push» otra vez."
  },
  unknown: {
    headline: "No se pudo activar el push",
    detail:
      "PALMYRA no pudo identificar el motivo exacto. Desactiva el modo de ahorro de datos del navegador y vuelve a intentarlo."
  }
};

/**
 * Causas cuya redacción original manda al usuario a «Ajustes del navegador».
 * En el APK y en el programa de PC no hay ese navegador, así que ese paso sería
 * falso: se sustituye por el texto propio de cada superficie.
 */
const BROWSER_STEP_CAUSES = new Set<PushFailureCause>([
  "no_push_api",
  "no_service_worker",
  "permission_denied",
  "permission_dismissed",
  "unknown"
]);

// Ninguna de las dos superficies puede suscribirse al push de la nube, pero desde
// 1.3.19 sí publican avisos del sistema mientras están abiertas (shell de Android y
// AppUserModelID en Electron). El texto tiene que decir las dos cosas: lo que falta
// es el servicio, no el permiso, y la campana del sistema sí funciona aquí.
const APK_PUSH_TEXT = {
  headline: "En la app de Android los avisos los manda PALMYRA, no Google",
  detail:
    "El APK no incluye el servicio de avisos de Google, así que no puede suscribirse al push: no es un permiso que falte. Con el permiso de notificaciones concedido, cada aviso sale en la bandeja de Android mientras la app está abierta y queda además en la campana y el punto rojo de Notificaciones. Para recibirlos con la app cerrada, abre https://palmyracrm.onrender.com en Chrome y actívalo allí."
};

const DESKTOP_PUSH_TEXT = {
  headline: "El programa de PALMYRA para PC avisa sin servicio de push",
  detail:
    "El programa no trae el servicio de push de los navegadores, así que ese botón no puede registrarse aquí: no es un permiso que falte. Acepta el aviso de permisos que PALMYRA muestra al entrar —o actívalo en Configuración de Windows › Sistema › Notificaciones › PALMYRA— y verás los avisos en la bandeja de Windows mientras el programa está abierto; también quedan en la campana. Para avisos con el programa cerrado, activa el push en Chrome o Edge con https://palmyracrm.onrender.com."
};

/** Clasifica el error del flujo de push según su forma y su texto técnico. */
function classifyPushErrorText(message: string): PushFailureCause | null {
  const text = String(message || "");
  if (/Failed to fetch|NetworkError|ERR_INTERNET|timed? ?out|ECONN|fetch failed/i.test(text)) return "network";
  // Electron no registra PushService: el fallo dice "not available"/"push service",
  // y en esa superficie no hay navegador que ajustar (ver DESKTOP_PUSH_TEXT).
  if (/push service|NotSupportedError|is not available/i.test(text)) return "no_push_api";
  if (/serviceWorker/i.test(text) && /not|undefined|no hay/i.test(text)) return "no_service_worker";
  if (/registration.*ready|servicio de avisos/i.test(text)) return "no_service_worker";
  if (/NotAllowedError|permission(?:s)? denied|permiso denegado/i.test(text)) return "permission_denied";
  if (/applicationServerKey|VAPID|invalid key|InvalidStateError.*key/i.test(text)) return "missing_vapid_key";
  if (/InvalidStateError|already subscribed|subscription/i.test(text)) return "subscription_expired";
  if (/DOMException/i.test(text)) return "unknown";
  return null;
}

/**
 * Traduce cualquier excepción del flujo de push a un aviso con causa real.
 * Puro: recibe los hechos del entorno (flags y mensaje) y devuelve textos.
 */
export function describePushFailure(input: {
  message?: string;
  hasServiceWorker?: boolean;
  hasPushManager?: boolean;
  hasNotificationApi?: boolean;
  secureContext?: boolean;
  insideIframe?: boolean;
  vapidKey?: string;
  permission?: NotificationPermission | "unsupported";
  online?: boolean;
  /** Superficie: el APK y el programa de PC no tienen navegador que configurar. */
  androidApp?: boolean;
  desktopApp?: boolean;
}): PushFailureInfo {
  let cause: PushFailureCause | null = null;

  if (input.hasNotificationApi === false || input.hasPushManager === false) cause = "no_push_api";
  else if (input.hasServiceWorker === false) cause = "no_service_worker";
  else if (input.insideIframe === true) cause = "iframe_context";
  else if (input.secureContext === false) cause = "insecure_context";
  else if (!String(input.vapidKey || "").trim()) cause = "missing_vapid_key";
  else if (input.permission === "denied") cause = "permission_denied";
  else if (input.online === false) cause = "network";
  else if (input.permission === "default") cause = "permission_dismissed";

  if (!cause) cause = classifyPushErrorText(input.message || "");
  if (!cause && input.message) cause = "server_unreachable";
  const resolved: PushFailureCause = cause || "unknown";
  const surfaceText = BROWSER_STEP_CAUSES.has(resolved)
    ? (input.androidApp === true ? APK_PUSH_TEXT : input.desktopApp === true ? DESKTOP_PUSH_TEXT : null)
    : null;
  const text = surfaceText ?? PUSH_FAILURE_TEXT[resolved];
  return { cause: resolved, headline: text.headline, detail: text.detail };
}

/** Texto listo para el aviso de la pantalla de Notificaciones. */
export function pushFailureMessage(info: PushFailureInfo): string {
  return `${info.headline} ${info.detail}`.trim();
}
