import { parseUpdateManifest, updateManifestErrorCode } from "./manifest";
import type { UpdateChannel, UpdateManifestV1 } from "./manifest";
import { evaluateUpdate, verifyUpdateManifest } from "./verify";

/**
 * Cliente del manifiesto de actualizaciones.
 *
 * Consulta el manifiesto firmado (ver ./manifest.ts y ./verify.ts) como mucho
 * una vez cada 24 h, tolera que la red, el proxy o la CDN fallen y decide si
 * hay actualización aplicable al equipo. Nunca lanza por datos del servidor:
 * toda respuesta se devuelve como UpdateCheckResult con `status` y un `code`
 * estable; `error` solo añade el texto accionable en español.
 *
 * Sin `publicJwk` nunca se declara `available`: la firma no se comprobó, así
 * que la versión se informa como `unverified` para que la UI pida confirmación
 * explícita (o se niegue a instalar) en lugar de confiar en un JSON anónimo.
 *
 * La descarga del artefacto (`downloadArtifact`) queda fuera de este módulo.
 */

/** Cadencia por defecto entre comprobaciones automáticas: 24 h. */
export const DEFAULT_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Tiempo máximo de una comprobación (incluye la lectura del cuerpo). */
export const DEFAULT_UPDATE_TIMEOUT_MS = 10_000;

/** Tope del manifiesto en caracteres; un JSON firmado legítimo es diminuto. */
export const MAX_MANIFEST_BYTES = 512 * 1024;

export interface UpdateCheckSnapshot {
  lastCheckAt: number;
  lastStatus: string;
}

/** Persistencia mínima de la última comprobación (IndexedDB, archivo, etc.). */
export interface UpdateCheckStorage {
  load(): Promise<UpdateCheckSnapshot | null>;
  save(value: UpdateCheckSnapshot): Promise<void>;
}

/** Almacén volátil para pruebas y como último recurso en memoria. */
export function createMemoryUpdateStorage(
  initial: UpdateCheckSnapshot | null = null
): UpdateCheckStorage {
  let current: UpdateCheckSnapshot | null = initial ? { ...initial } : null;
  return {
    async load(): Promise<UpdateCheckSnapshot | null> {
      return current ? { ...current } : null;
    },
    async save(value: UpdateCheckSnapshot): Promise<void> {
      current = { lastCheckAt: value.lastCheckAt, lastStatus: value.lastStatus };
    }
  };
}

export type UpdateCheckStatus =
  | "not-due"
  | "up-to-date"
  | "available"
  | "blocked"
  | "unverified"
  | "error"
  | "unconfigured";

/**
 * Códigos estables del resultado: la UI puede ramificar por `code` sin mirar
 * el texto. Los de verificación coinciden con UpdateVerificationFailure y los
 * de evaluación con UpdateEvaluationReason.
 */
export type UpdateCheckCode =
  | "unconfigured"
  | "not-due"
  | "insecure-url"
  | "network"
  | "timeout"
  | "http-status"
  | "not-json"
  | "empty-body"
  | "too-large"
  | "json-invalid"
  | "invalid-manifest"
  | "missing-signature"
  | "invalid-signature"
  | "invalid-key"
  | "unsupported-algorithm"
  | "up-to-date"
  | "available"
  | "unverified"
  | "downgrade"
  | "channel"
  | "rollout"
  | "shell-too-old"
  | "not-before"
  | "unexpected";

export type UpdateCheckResult = {
  status: UpdateCheckStatus;
  /** Motivo estable y tipado (nunca texto libre). */
  code: UpdateCheckCode;
  version?: string;
  /** Detalle de máquina adicional (p. ej. el código del manifiesto). */
  detail?: string;
  reason?: string;
  checkedAt: number;
  error?: string;
};

export interface UpdateClientOptions {
  /** URL del manifiesto JSON. Sin ella el cliente está desconfigurado. */
  manifestUrl?: string;
  /** Clave pública ES256 (JWK EC P-256) con la que se verifica la firma. */
  publicJwk?: JsonWebKey;
  /** Versión instalada del producto (x.y.z o x.y.z-beta.N). */
  currentVersion: string;
  /** Versión del shell nativo; si falta se asume `currentVersion`. */
  shellVersion?: string;
  /** Identificador estable del equipo, usado por el rollout. */
  deviceId: string;
  channel?: UpdateChannel;
  storage: UpdateCheckStorage;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Cadencia entre comprobaciones automáticas; por defecto 24 h. */
  intervalMs?: number;
  /** Tiempo máximo por comprobación; por defecto 10 s. */
  timeoutMs?: number;
}

export interface UpdateClient {
  check(options?: { force?: boolean }): Promise<UpdateCheckResult>;
}

/** Estados que se guardan: la comprobación llegó a buen término. */
const PERSISTED_STATUSES: ReadonlySet<UpdateCheckStatus> = new Set<UpdateCheckStatus>([
  "available",
  "up-to-date",
  "blocked",
  "unverified"
]);

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "string" && error.trim() !== "") return error;
  return "La comprobación de actualización falló por un motivo desconocido.";
}

/** True solo si ya pasó la cadencia. Un reloj retrocedido vuelve a comprobar. */
function isDue(lastCheckAt: number, current: number, intervalMs: number): boolean {
  if (!Number.isFinite(lastCheckAt)) return true;
  const elapsed = current - lastCheckAt;
  if (elapsed < 0) return true;
  return elapsed >= Math.max(0, intervalMs);
}

/**
 * Solo HTTPS. Se tolera http:// en loopback para desarrollo local, nunca para
 * un manifiesto de producción.
 */
export function isSecureManifestUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]"
  );
}

async function loadSnapshot(storage: UpdateCheckStorage): Promise<UpdateCheckSnapshot | null> {
  try {
    return await storage.load();
  } catch {
    // Un almacén roto no debe impedir comprobar; se trata como "nunca revisado".
    return null;
  }
}

/**
 * Resultado interno de la descarga. Se modela como objeto plano (en lugar de
 * unión discriminada por `ok`) porque el proyecto compila sin strictNullChecks
 * y los literales booleanos no estrechan la unión.
 */
interface FetchOutcome {
  ok: boolean;
  raw: string;
  code: UpdateCheckCode;
  error: string;
}

/** Fallo de descarga con su código estable y mensaje accionable. */
function fetchFailure(code: UpdateCheckCode, error: string): FetchOutcome {
  return { ok: false, raw: "", code, error };
}

function timeoutMessage(timeoutMs: number): string {
  return `La comprobación de actualización tardó más de ${Math.max(
    1,
    Math.round(timeoutMs / 1000)
  )} s y se canceló. Reintenta cuando la conexión mejore.`;
}

/**
 * Descarga el manifiesto con AbortController y un límite de tiempo real: la
 * carrera contra el temporizador garantiza que la promesa termina aunque el
 * `fetch` ignore la señal de cancelación. Devuelve un resultado tipado en
 * lugar de lanzar por datos del servidor.
 */
async function fetchManifestText(
  url: string,
  timeoutMs: number,
  doFetch: typeof fetch
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const limit = Math.max(1, timeoutMs);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(timeoutMessage(limit)));
    }, limit);
  });

  try {
    let response: Response;
    try {
      response = await Promise.race([
        doFetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
          cache: "no-store"
        }),
        timeout
      ]);
    } catch (error) {
      if (timedOut) return fetchFailure("timeout", timeoutMessage(limit));
      return fetchFailure("network", messageOf(error));
    }

    if (!response || typeof response !== "object") {
      return fetchFailure("network", "La respuesta del servidor llegó vacía o mal formada.");
    }

    const status = typeof response.status === "number" ? response.status : 0;
    if (!response.ok) {
      return fetchFailure(
        "http-status",
        `El servidor respondió HTTP ${status} al pedir el manifiesto. Comprueba que manifestUrl apunte a un release publicado.`
      );
    }

    // Una redirección de HTTPS a HTTP degradaría el canal: se rechaza.
    const finalUrl = typeof response.url === "string" ? response.url : "";
    if (finalUrl !== "" && !isSecureManifestUrl(finalUrl)) {
      return fetchFailure(
        "insecure-url",
        "El manifiesto se sirvió desde una URL no segura tras una redirección; se rechaza la descarga."
      );
    }

    let contentType = "";
    try {
      contentType = (response.headers && response.headers.get("content-type")) || "";
    } catch {
      contentType = "";
    }
    contentType = contentType.toLowerCase();
    const looksJsonType = /json/.test(contentType);
    const maybeOctetStream = contentType === "" || contentType.includes("octet-stream");
    if (!looksJsonType && !maybeOctetStream) {
      return fetchFailure(
        "not-json",
        `La respuesta del manifiesto no es JSON (HTTP ${status}, content-type: ${contentType}). Revisa que manifestUrl apunte al archivo JSON del release y no a una página web.`
      );
    }

    let raw: string;
    try {
      raw = await Promise.race([response.text(), timeout]);
    } catch (error) {
      if (timedOut) return fetchFailure("timeout", timeoutMessage(limit));
      return fetchFailure("network", messageOf(error));
    }
    if (typeof raw !== "string") {
      return fetchFailure("not-json", "El manifiesto llegó con un cuerpo ilegible.");
    }
    if (!looksJsonType && !/^\s*[{[]/.test(raw)) {
      // GitHub puede servir el asset como octet-stream: solo se acepta si el
      // cuerpo es realmente JSON y nunca si llegó una página HTML.
      return fetchFailure(
        "not-json",
        `La respuesta del manifiesto no es JSON (HTTP ${status}, content-type: ${contentType || "desconocido"}). Revisa que manifestUrl apunte al archivo JSON del release.`
      );
    }
    if (raw.trim() === "") {
      return fetchFailure(
        "empty-body",
        `El manifiesto llegó vacío (HTTP ${status}). Reintenta en unos minutos.`
      );
    }
    if (raw.length > MAX_MANIFEST_BYTES) {
      return fetchFailure(
        "too-large",
        `El manifiesto supera el tamaño máximo permitido (${MAX_MANIFEST_BYTES} caracteres).`
      );
    }
    return { ok: true, raw, code: "unexpected", error: "" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function persistResult(
  storage: UpdateCheckStorage,
  result: UpdateCheckResult
): Promise<UpdateCheckResult> {
  if (PERSISTED_STATUSES.has(result.status)) {
    try {
      await storage.save({ lastCheckAt: result.checkedAt, lastStatus: result.status });
    } catch {
      // Guardar la marca es best-effort: el resultado del chequeo ya es válido.
    }
  }
  return result;
}

export function createUpdateClient(options: UpdateClientOptions): UpdateClient {
  const intervalMs = options.intervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
  const channel: UpdateChannel = options.channel ?? "stable";
  const shellVersion = options.shellVersion ?? options.currentVersion;
  const now = options.now ?? (() => Date.now());
  const doFetch = options.fetchImpl ?? fetch;
  const publicJwk = options.publicJwk;

  async function runCheck(force: boolean): Promise<UpdateCheckResult> {
    const checkedAt = now();

    const rawUrl = options.manifestUrl;
    const manifestUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (manifestUrl === "") {
      return { status: "unconfigured", code: "unconfigured", checkedAt };
    }
    if (!isSecureManifestUrl(manifestUrl)) {
      // Nunca se descarga un manifiesto por HTTP abierto ni con esquema raro.
      return {
        status: "error",
        code: "insecure-url",
        checkedAt,
        error:
          "manifestUrl debe usar https:// (solo http:// en localhost para desarrollo). Corrige la URL del manifiesto."
      };
    }

    if (!force) {
      const previous = await loadSnapshot(options.storage);
      if (previous && !isDue(previous.lastCheckAt, checkedAt, intervalMs)) {
        return { status: "not-due", code: "not-due", checkedAt };
      }
    }

    const outcome = await fetchManifestText(manifestUrl, timeoutMs, doFetch);
    if (outcome.ok !== true || typeof outcome.raw !== "string") {
      return { status: "error", code: outcome.code, checkedAt, error: outcome.error };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(outcome.raw);
    } catch {
      return {
        status: "error",
        code: "json-invalid",
        checkedAt,
        error:
          "El manifiesto llegó con JSON mal formado y no se pudo leer. Vuelve a intentarlo en unos minutos."
      };
    }

    let manifest: UpdateManifestV1;
    try {
      manifest = parseUpdateManifest(payload);
    } catch (error) {
      // JSON válido pero fuera del contrato v1: se bloquea y no se instala nada.
      return persistResult(options.storage, {
        status: "blocked",
        code: "invalid-manifest",
        detail: updateManifestErrorCode(error) ?? undefined,
        reason: "invalid-manifest",
        checkedAt,
        error: messageOf(error)
      });
    }

    if (publicJwk) {
      const verification = await verifyUpdateManifest(manifest, {
        publicJwk,
        requireSignature: true
      });
      if (!verification.ok) {
        // `in` en lugar de estrechar por `ok`: con strictNullChecks apagado los
        // literales true/false se ensanchan y la unión no se discrimina.
        const reason = "reason" in verification ? verification.reason : "invalid-signature";
        return persistResult(options.storage, {
          status: "blocked",
          code: reason,
          reason,
          checkedAt
        });
      }
    }

    const evaluation = evaluateUpdate({
      manifest,
      currentVersion: options.currentVersion,
      shellVersion,
      deviceId: options.deviceId,
      channel,
      now: checkedAt
    });

    if (evaluation.allowed) {
      return persistResult(options.storage, {
        status: publicJwk ? "available" : "unverified",
        code: publicJwk ? "available" : "unverified",
        version: manifest.version,
        reason: publicJwk ? evaluation.reason : "signature-not-checked",
        checkedAt
      });
    }

    if (evaluation.reason === "up-to-date") {
      return persistResult(options.storage, {
        status: "up-to-date",
        code: "up-to-date",
        version: manifest.version,
        checkedAt
      });
    }

    const blockedCode: UpdateCheckCode =
      evaluation.reason === "invalid" ? "invalid-manifest" : (evaluation.reason as UpdateCheckCode);
    return persistResult(options.storage, {
      status: "blocked",
      code: blockedCode,
      version: manifest.version,
      reason: evaluation.reason,
      checkedAt
    });
  }

  return {
    async check({ force = false }: { force?: boolean } = {}): Promise<UpdateCheckResult> {
      try {
        return await runCheck(force);
      } catch (error) {
        let checkedAt = 0;
        try {
          checkedAt = now();
        } catch {
          checkedAt = 0;
        }
        return {
          status: "error",
          code: "unexpected",
          checkedAt,
          error: messageOf(error)
        };
      }
    }
  };
}
