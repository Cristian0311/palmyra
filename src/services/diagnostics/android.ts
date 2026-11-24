/**
 * Diagnóstico del APK Android para soporte in situ, sin PC.
 *
 * El informe se arma con el mínimo privilegio posible: nunca cruzan valores de
 * localStorage, tokens, claves, rutas privadas ni contenido de la base. Solo
 * salen estados, versiones, conteos y tamaños. Cada bloque falla contenido y
 * deja una nota, de modo que una tablet a medias sigue produciendo un informe
 * útil en lugar de una pantalla rota.
 */
import {
  getAndroidBackupBridge,
  getNativeAppInfo,
  getNativeKeystoreBridge,
  type NativeAppInfo
} from "../../lib/nativeApp";
import { PRODUCT_VERSION } from "../../lib/productVersion";
import {
  createAndroidSqliteAdapter,
  type AndroidSqliteBridge
} from "../localDb/sqlite/androidAdapter";

/**
 * Misma clave que `ANDROID_BACKUP_STATUS_KEY` de `useAndroidBackup`.
 *
 * Se repite aquí para que este servicio no dependa de React ni del hook de
 * respaldo: el diagnóstico debe poder ejecutarse (y probarse) aislado.
 */
export const ANDROID_BACKUP_STATUS_STORAGE_KEY = "palmyra-android-backup-status";

const MAX_TEXT = 200;
const MAX_NOTES = 12;
/** Mismo techo que usa el puente al devolver detalles de `integrity_check`. */
const MAX_INTEGRITY_DETAIL = 240;

type MaybePromise<T> = T | Promise<T>;

/** Lo mínimo que necesita el diagnóstico de `localStorage` (sin exponer API de escritura). */
export interface DiagnosticsStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

export type AndroidBridgeId =
  | "PALMYRA_DB"
  | "PALMYRA_KEYSTORE"
  | "PALMYRA_BACKUP"
  | "PALMYRA_NATIVE";

export interface AndroidBridgeCheck {
  id: AndroidBridgeId;
  label: string;
  present: boolean;
  /** `true` correcto, `false` fallo comprobado, `null` presente sin verificación profunda. */
  healthy: boolean | null;
  detail: string | null;
}

export interface AndroidDiagnosticsReport {
  generatedAt: string;
  platform: {
    name: string;
    isAndroid: boolean;
  };
  versions: {
    app: string;
    shell: string;
    web: string;
    ota: boolean;
  };
  bridges: AndroidBridgeCheck[];
  database: {
    integrity: "ok" | "failed" | "unavailable";
    integrityDetail: string | null;
    sales: number | null;
    products: number | null;
  };
  storage: {
    estimateSupported: boolean;
    usageBytes: number | null;
    quotaBytes: number | null;
    localStorageKeys: number;
    /** Bytes aproximados (UTF-16); jamás se copian claves ni valores. */
    localStorageBytes: number;
  };
  backup: {
    present: boolean;
    status: "ok" | "error" | "missing" | "corrupt";
    lastBackupAt: string | null;
    fileName: string | null;
    location: string | null;
    error: string | null;
    attemptAt: string | null;
  };
  notes: string[];
}

/**
 * Dependencias inyectables. En producción todas tienen un valor por defecto
 * que lee el runtime real; en pruebas se sustituyen para no tocar puentes.
 */
export interface AndroidDiagnosticsDeps {
  now?: () => Date;
  appVersion?: string;
  getNativeAppInfo?: () => NativeAppInfo | null;
  getKeystoreBridge?: () => unknown | null;
  getBackupBridge?: () => unknown | null;
  getNativeBridge?: () => unknown | null;
  getDbBridge?: () => unknown | null;
  getStorage?: () => DiagnosticsStorage | null;
  estimateStorage?: () => MaybePromise<{ usage?: unknown; quota?: unknown } | null>;
  countRows?: (table: "sales" | "products") => MaybePromise<number | null>;
}

type RuntimeScope = {
  PALMYRA_DB?: unknown;
  PALMYRA_NATIVE?: unknown;
  localStorage?: DiagnosticsStorage;
};

const BRIDGE_LABELS: Record<AndroidBridgeId, string> = {
  PALMYRA_DB: "Base SQLite nativa",
  PALMYRA_KEYSTORE: "Cifrado del dispositivo",
  PALMYRA_BACKUP: "Respaldo en Descargas",
  PALMYRA_NATIVE: "Shell de Android"
};

function browserScope(): RuntimeScope | null {
  if (typeof window !== "undefined") return window as unknown as RuntimeScope;
  if (typeof globalThis !== "undefined") return globalThis as unknown as RuntimeScope;
  return null;
}

function safeNow(source: (() => Date) | undefined): Date {
  try {
    const value = source ? source() : new Date();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
  } catch {
    return new Date();
  }
}

/** Texto corto y plano: sin saltos de línea ni controles que ensucien el JSON. */
function safeText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function safeNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function safeIsoDate(value: unknown): string | null {
  const text = safeText(value, 60);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Una ruta absoluta del sistema no aporta nada al diagnóstico y puede revelar
 * la estructura del dispositivo: en ese caso solo se conserva el archivo.
 */
function safeLocation(value: unknown): string | null {
  const text = safeText(value);
  if (!text) return null;
  const absolute = /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith("/") || /^(file|content):/i.test(text);
  if (!absolute) return text;
  const parts = text.split(/[\\/]/).filter(Boolean);
  return safeText(parts[parts.length - 1] ?? null);
}

function pushNote(notes: string[], note: string): void {
  if (notes.length >= MAX_NOTES) return;
  if (!notes.includes(note)) notes.push(note);
}

/** Puente presente/ausente sin verificación profunda (solo SQLite la tiene). */
function bridgeCheck(id: AndroidBridgeId, bridge: unknown): AndroidBridgeCheck {
  return {
    id,
    label: BRIDGE_LABELS[id],
    present: Boolean(bridge),
    healthy: Boolean(bridge),
    detail: bridge ? "Presente." : "No disponible."
  };
}

/** `true` cuando el objeto expone `integrity()`, la comprobación nueva del puente. */
function hasIntegrity(bridge: unknown): bridge is { integrity(): unknown } {
  return (
    Boolean(bridge) &&
    typeof bridge === "object" &&
    typeof (bridge as { integrity?: unknown }).integrity === "function"
  );
}

async function readIntegrity(bridge: unknown): Promise<{
  integrity: AndroidDiagnosticsReport["database"]["integrity"];
  detail: string | null;
}> {
  if (!bridge) return { integrity: "unavailable", detail: null };
  if (!hasIntegrity(bridge)) {
    return { integrity: "unavailable", detail: "El puente no expone integrity()." };
  }
  try {
    const raw = await Promise.resolve(bridge.integrity());
    if (typeof raw !== "string" || raw.length === 0) {
      return { integrity: "failed", detail: "El puente devolvió una respuesta vacía." };
    }
    const parsed = JSON.parse(raw) as { ok?: unknown; result?: unknown } | null;
    if (!parsed || typeof parsed !== "object") {
      return { integrity: "failed", detail: "El puente devolvió una respuesta inválida." };
    }
    const detail = safeText(parsed.result, MAX_INTEGRITY_DETAIL);
    if (parsed.ok === true && (detail ?? "").toLowerCase() === "ok") {
      return { integrity: "ok", detail: "ok" };
    }
    return { integrity: "failed", detail: detail || "integrity_check no devolvió «ok»." };
  } catch {
    return { integrity: "failed", detail: "No se pudo ejecutar integrity_check." };
  }
}

/**
 * Conteos por el puente SQLite nativo.
 *
 * `COUNT(*)` evita cargar 50.000 ventas solo para contarlas. Sin el puente no
 * se abre otro motor (IndexedDB/memoria) desde el diagnóstico: hacerlo tendría
 * efectos secundarios y el informe saldría con datos de un almacén distinto.
 */
function defaultCountRows(bridge: unknown): (table: "sales" | "products") => Promise<number | null> {
  return async (table) => {
    if (!bridge) return null;
    try {
      const adapter = createAndroidSqliteAdapter(bridge as AndroidSqliteBridge);
      const rows = await Promise.resolve(
        adapter.all<{ total?: unknown }>(
          `SELECT COUNT(*) AS total FROM ${table} WHERE deleted_at IS NULL`,
          []
        )
      );
      return safeNumber(rows[0]?.total);
    } catch {
      return null;
    }
  };
}

function defaultStorage(): DiagnosticsStorage | null {
  const scope = browserScope();
  if (!scope) return null;
  try {
    return scope.localStorage ?? null;
  } catch {
    return null;
  }
}

async function defaultEstimate(): Promise<{ usage?: unknown; quota?: unknown } | null> {
  try {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    if (!nav?.storage?.estimate) return null;
    return (await nav.storage.estimate()) ?? null;
  } catch {
    return null;
  }
}

function measureLocalStorage(storage: DiagnosticsStorage | null): {
  keys: number;
  bytes: number;
} {
  if (!storage) return { keys: 0, bytes: 0 };
  let keys = 0;
  let chars = 0;
  let length = 0;
  try {
    length = Number(storage.length);
  } catch {
    return { keys: 0, bytes: 0 };
  }
  if (!Number.isFinite(length) || length <= 0) return { keys: 0, bytes: 0 };
  for (let index = 0; index < length; index += 1) {
    try {
      const key = storage.key(index);
      if (!key) continue;
      keys += 1;
      chars += key.length;
      // El valor solo se mide; jamás se copia al informe.
      const value = storage.getItem(key);
      if (typeof value === "string") chars += value.length;
    } catch {
      // Una entrada ilegible no invalida el resto de la medición.
    }
  }
  // Aproximación UTF-16: cada unidad de código ocupa 2 bytes en el WebView.
  return { keys, bytes: chars * 2 };
}

function emptyBackup(): AndroidDiagnosticsReport["backup"] {
  return {
    present: false,
    status: "missing",
    lastBackupAt: null,
    fileName: null,
    location: null,
    error: null,
    attemptAt: null
  };
}

const CORRUPT_BACKUP_NOTE =
  "El estado del respaldo está corrupto; el respaldo automático lo reescribirá en el próximo intento.";

/** Estado ilegible: se conserva el hecho de que existe y se avisa en las notas. */
function corruptBackup(notes: string[]): AndroidDiagnosticsReport["backup"] {
  pushNote(notes, CORRUPT_BACKUP_NOTE);
  return { ...emptyBackup(), present: true, status: "corrupt" };
}

function readBackupStatus(
  storage: DiagnosticsStorage | null,
  notes: string[]
): AndroidDiagnosticsReport["backup"] {
  if (!storage) {
    pushNote(notes, "No hay almacenamiento local para leer el estado del respaldo.");
    return emptyBackup();
  }

  let raw: string | null = null;
  try {
    raw = storage.getItem(ANDROID_BACKUP_STATUS_STORAGE_KEY);
  } catch {
    pushNote(notes, "No se pudo leer el estado del respaldo automático.");
    return emptyBackup();
  }
  if (!raw) return emptyBackup();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corruptBackup(notes);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return corruptBackup(notes);
  }

  const record = parsed as Record<string, unknown>;
  // Lista blanca de campos: cualquier otra clave del JSON no cruza al informe.
  const lastBackupAt = safeIsoDate(record.lastBackupAt);
  const attemptAt = safeIsoDate(record.attemptAt);
  const fileName = safeText(record.fileName);
  const location = safeLocation(record.location);
  const error = safeText(record.error);

  if (record.lastBackupAt && !lastBackupAt) {
    pushNote(notes, "La fecha del último respaldo no es válida.");
  }

  const status: AndroidDiagnosticsReport["backup"]["status"] = error
    ? "error"
    : lastBackupAt
      ? "ok"
      : "missing";

  return {
    present: true,
    status,
    lastBackupAt,
    fileName,
    location,
    error,
    attemptAt
  };
}

function emptyReport(generatedAt: string): AndroidDiagnosticsReport {
  return {
    generatedAt,
    platform: { name: "desconocida", isAndroid: false },
    versions: { app: PRODUCT_VERSION, shell: "", web: "", ota: false },
    bridges: [],
    database: {
      integrity: "unavailable",
      integrityDetail: null,
      sales: null,
      products: null
    },
    storage: {
      estimateSupported: false,
      usageBytes: null,
      quotaBytes: null,
      localStorageKeys: 0,
      localStorageBytes: 0
    },
    backup: emptyBackup(),
    notes: []
  };
}

/** Nombre del archivo de exportación: mismo patrón que pide soporte. */
export function androidDiagnosticsFileName(generatedAt: string): string {
  const date = new Date(generatedAt);
  const iso = Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(0, 10)
    : date.toISOString().slice(0, 10);
  return `palmyra-diagnostico-android-${iso}.json`;
}

/** JSON legible del informe. Nunca contiene secretos por construcción. */
export function androidDiagnosticsJson(report: AndroidDiagnosticsReport): string {
  return JSON.stringify(report, null, 2);
}

/** Recolecta el diagnóstico completo. Nunca lanza: cada fallo queda en `notes`. */
export async function collectAndroidDiagnostics(
  deps: AndroidDiagnosticsDeps = {}
): Promise<AndroidDiagnosticsReport> {
  const generatedAt = safeNow(deps.now).toISOString();
  const report = emptyReport(generatedAt);
  const notes = report.notes;

  try {
    /* ── Shell y versiones ─────────────────────────────────────────── */
    let info: NativeAppInfo | null = null;
    try {
      info = (deps.getNativeAppInfo ?? getNativeAppInfo)() ?? null;
    } catch {
      info = null;
    }
    if (!info) {
      pushNote(notes, "No se pudo leer la información del shell nativo (PALMYRA_NATIVE).");
    }

    const scope = browserScope();
    // Cada puente se lee aislado: un getter roto no debe tumbar el resto.
    const readBridge = (
      source: (() => unknown | null) | undefined,
      fallback: () => unknown | null
    ): unknown | null => {
      try {
        return (source ?? fallback)();
      } catch {
        return null;
      }
    };
    const dbBridge = readBridge(deps.getDbBridge, () => scope?.PALMYRA_DB ?? null);
    const keystoreBridge = readBridge(deps.getKeystoreBridge, getNativeKeystoreBridge);
    const backupBridge = readBridge(deps.getBackupBridge, getAndroidBackupBridge);
    const nativeBridge = readBridge(deps.getNativeBridge, () => scope?.PALMYRA_NATIVE ?? null);

    let androidByUserAgent = false;
    try {
      androidByUserAgent =
        typeof navigator !== "undefined" && /android/i.test(String(navigator.userAgent ?? ""));
    } catch {
      androidByUserAgent = false;
    }

    const isAndroid = Boolean(info) || Boolean(dbBridge) || androidByUserAgent;
    report.platform = {
      name: safeText(info?.platform, 40) ?? (isAndroid ? "android" : "web"),
      isAndroid
    };
    report.versions = {
      app: safeText(deps.appVersion ?? PRODUCT_VERSION, 40) ?? PRODUCT_VERSION,
      shell: safeText(info?.shellVersion, 40) ?? "",
      web: safeText(info?.webVersion, 40) ?? "",
      ota: info?.ota === true
    };

    /* ── Integridad de la base ─────────────────────────────────────── */
    const integrity = await readIntegrity(dbBridge);
    if (integrity.integrity === "failed") {
      pushNote(notes, "La comprobación de integridad de SQLite no devolvió «ok».");
    } else if (integrity.integrity === "unavailable" && dbBridge) {
      pushNote(notes, "El puente SQLite no permite comprobar la integridad de la base.");
    }
    report.database.integrity = integrity.integrity;
    report.database.integrityDetail = integrity.detail;

    /* ── Conteos ───────────────────────────────────────────────────── */
    if (dbBridge) {
      const countRows = deps.countRows ?? defaultCountRows(dbBridge);
      const [sales, products] = await Promise.all([
        Promise.resolve()
          .then(() => countRows("sales"))
          .catch(() => null),
        Promise.resolve()
          .then(() => countRows("products"))
          .catch(() => null)
      ]);
      report.database.sales = safeNumber(sales);
      report.database.products = safeNumber(products);
      if (report.database.sales === null || report.database.products === null) {
        pushNote(notes, "No se pudieron contar las ventas o los productos del almacén local.");
      }
    } else {
      pushNote(
        notes,
        "Sin el puente SQLite (PALMYRA_DB) no hay un accessor de conteos sin abrir otro motor; se omiten ventas y productos."
      );
    }

    /* ── Puentes ───────────────────────────────────────────────────── */
    report.bridges = [
      {
        id: "PALMYRA_DB",
        label: BRIDGE_LABELS.PALMYRA_DB,
        present: Boolean(dbBridge),
        healthy:
          integrity.integrity === "ok"
            ? true
            : integrity.integrity === "failed"
              ? false
              : null,
        detail:
          integrity.integrity === "ok"
            ? "integrity_check: ok"
            : integrity.detail ??
              (dbBridge ? "Sin comprobación de integridad." : "No disponible.")
      },
      bridgeCheck("PALMYRA_KEYSTORE", keystoreBridge),
      bridgeCheck("PALMYRA_BACKUP", backupBridge),
      bridgeCheck("PALMYRA_NATIVE", nativeBridge)
    ];

    /* ── Almacenamiento ────────────────────────────────────────────── */
    let storage: DiagnosticsStorage | null = null;
    try {
      storage = (deps.getStorage ?? defaultStorage)();
    } catch {
      storage = null;
      pushNote(notes, "No se pudo acceder al almacenamiento del navegador.");
    }
    const localSizes = measureLocalStorage(storage);
    report.storage.localStorageKeys = localSizes.keys;
    report.storage.localStorageBytes = localSizes.bytes;

    let estimate: { usage?: unknown; quota?: unknown } | null = null;
    try {
      estimate = await (deps.estimateStorage ?? defaultEstimate)();
    } catch {
      estimate = null;
    }
    if (estimate) {
      report.storage.estimateSupported = true;
      report.storage.usageBytes = safeNumber(estimate.usage);
      report.storage.quotaBytes = safeNumber(estimate.quota);
    } else {
      pushNote(notes, "El sistema no informa el espacio usado del dispositivo (storage.estimate).");
    }

    /* ── Respaldo ──────────────────────────────────────────────────── */
    report.backup = readBackupStatus(storage, notes);
    if (report.backup.status === "error") {
      pushNote(notes, "El último respaldo automático terminó con error.");
    }
  } catch {
    pushNote(notes, "El diagnóstico se interrumpió; se muestran solo los datos ya recogidos.");
  }

  return report;
}
