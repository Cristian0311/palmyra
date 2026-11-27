/**
 * Resolución de la clave pública del lease de licencia (ES256 / P-256).
 *
 * Prioridad:
 *   1. `import.meta.env.VITE_LICENSE_PUBLIC_JWK` (compilada en el build).
 *   2. Clave anclada de una sesión anterior (TOFU): permite verificar el lease
 *      guardado sin conexión, que es el caso normal al reabrir la app.
 *   3. `GET /license-public-key.json` servida por el mismo origen.
 *   4. Clave pública embebida en el propio bundle (`lease-public-key.json`).
 *
 * El paso 4 es el que blinda el arranque offline: si el servidor no responde,
 * la ruta 404 o el Service Worker se quedó con una respuesta vieja, el equipo
 * sigue pudiendo evaluar el lease que ya tiene guardado. Es la MISMA clave
 * pública que viaja en `public/license-public-key.json` (prueba de deriva en
 * `tests/unit/license-bundled-key.test.ts`); no añade secretos ni relaja la
 * firma: un lease solo vale si esta clave (o la remota, si difiere) lo verifica.
 *
 * La resolución nunca lanza: devuelve `missing` si no hay clave y `error` si
 * la red falló sin clave previa ni anclada. El runtime traduce esos estados al
 * modo `unmanaged` sin bloquear, tal como hacía antes.
 *
 * Anclar la clave no relaja la firma: el lease se sigue verificando contra una
 * clave EC P-256 conocida; el anclaje solo evita depender de la red al arrancar.
 * `refresh()` fuerza una lectura remota (rotación de clave) sin perder el anclaje.
 *
 * El resultado se cachea por resolver. El runtime crea uno por instancia para
 * que una prueba o una pestaña no contamine a otra; `resolveLicensePublicKey`
 * ofrece un resolver de módulo para usos sueltos.
 */

import bundledLeaseKeyJson from "./lease-public-key.json";

export const LICENSE_PUBLIC_KEY_PATH = "/license-public-key.json";

export type LicensePublicKeyFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

/**
 * `pinned` = clave aceptada en un arranque anterior y guardada en el equipo.
 * Sin ella, un arranque sin red no podría evaluar el lease cacheado.
 * `bundled` = la misma clave pública compilada en el bundle: última reserva,
 * para que un 404 de la ruta, una respuesta vieja del Service Worker o un
 * almacén recién vaciado no dejen de poder evaluar el lease que ya está en disco.
 */
export type LicensePublicKeySource = "env" | "remote" | "pinned" | "bundled";

/** Clave pública ya validada y lista para `importVerifyKey`. */
export interface LicensePublicKey {
  jwk: JsonWebKey;
  keyId: string;
  source: LicensePublicKeySource;
}

export type LicensePublicKeyResult =
  | { status: "found"; key: LicensePublicKey }
  | { status: "missing" }
  | { status: "error" };

export interface LicensePublicKeyResolver {
  /** Clave disponible ya (entorno → anclada → red). */
  resolve(): Promise<LicensePublicKeyResult>;
  /** Fuerza una lectura remota (rotación); conserva el anclaje si falla. */
  refresh(): Promise<LicensePublicKeyResult>;
  reset(): void;
}

export interface LicensePublicKeyResolverOptions {
  fetchImpl?: LicensePublicKeyFetch;
  /**
   * Sustituto de `import.meta.env.VITE_LICENSE_PUBLIC_JWK` para pruebas.
   * `undefined` = leer el entorno; `null` = forzar ausencia.
   */
  envRaw?: string | null;
  /**
   * Clave anclada en un arranque anterior. Sin red, es la única forma de
   * verificar el lease guardado, así que se consulta antes de salir a la red.
   */
  loadPinned?: () => Promise<JsonWebKey | null>;
  /** Guarda la clave aceptada (entorno o remota) para el siguiente arranque. */
  savePinned?: (jwk: JsonWebKey) => Promise<void>;
  /**
   * Clave pública embebida en el build. `undefined` = la compilada en
   * `lease-public-key.json`; `null` = desactivar la reserva (solo pruebas que
   * necesitan simular que el equipo no tiene ninguna clave).
   */
  bundled?: JsonWebKey | null;
}

/** EC P-256 con coordenadas presentes. Rechaza claves de otro tipo. */
export function isPublicLeaseJwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object") return false;
  const jwk = value as JsonWebKey;
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    jwk.x.length > 0 &&
    typeof jwk.y === "string" &&
    jwk.y.length > 0
  );
}

/**
 * Copia solo los campos públicos. Si el JSON traía parámetros privados (`d`,
 * `dp`, `dq`, `qi`), se descartan: una clave privada nunca debe acabar en el
 * verificador de firma del cliente.
 */
function sanitizeJwk(jwk: JsonWebKey): JsonWebKey {
  const clean: JsonWebKey = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y
  };
  const kid = (jwk as { kid?: unknown }).kid;
  if (typeof kid === "string" && kid.trim()) {
    (clean as JsonWebKey & { kid?: string }).kid = kid.trim();
  }
  return clean;
}

function readEnvRaw(override?: string | null): string | null {
  if (override === null) return null;
  if (typeof override === "string") return override;
  try {
    const env = (
      import.meta as ImportMeta & {
        env?: { VITE_LICENSE_PUBLIC_JWK?: unknown };
      }
    ).env;
    const raw = env?.VITE_LICENSE_PUBLIC_JWK;
    return typeof raw === "string" && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

function parseEnvKey(raw: string | null): LicensePublicKey | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPublicLeaseJwk(parsed)) return null;
  const kid = (parsed as { kid?: unknown }).kid;
  return {
    jwk: sanitizeJwk(parsed),
    keyId: typeof kid === "string" ? kid : "",
    source: "env"
  };
}

function parseKeyPayload(
  payload: unknown,
  source: "remote" | "bundled"
): LicensePublicKey | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { keyId?: unknown; jwk?: unknown };
  const candidate = isPublicLeaseJwk(record.jwk)
    ? record.jwk
    : isPublicLeaseJwk(payload)
      ? (payload as JsonWebKey)
      : null;
  if (!candidate) return null;
  const keyId =
    typeof record.keyId === "string"
      ? record.keyId
      : typeof (candidate as { kid?: unknown }).kid === "string"
        ? ((candidate as { kid: string }).kid)
        : "";
  return { jwk: sanitizeJwk(candidate), keyId, source };
}

/**
 * Clave pública compilada en la app. Es la misma que sirve el servidor en
 * `/license-public-key.json` (hay una prueba que falla si las dos fichas
 * divergen), así que no introduce ningún secreto ni ninguna confianza nueva.
 */
export const BUNDLED_LEASE_PUBLIC_KEY: LicensePublicKey | null = parseKeyPayload(
  bundledLeaseKeyJson,
  "bundled"
);

/**
 * Resolver con caché propia. Un fallo de red no se cachea: el siguiente
 * refresco vuelve a intentarlo. La clave encontrada se conserva hasta
 * `reset()`, igual que la lógica anterior del runtime.
 */
export function createLicensePublicKeyResolver(
  options: LicensePublicKeyResolverOptions = {}
): LicensePublicKeyResolver {
  const fetchImpl: LicensePublicKeyFetch =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  let cached: LicensePublicKey | null = null;
  let inFlight: Promise<LicensePublicKeyResult> | null = null;

  function reset(): void {
    cached = null;
    inFlight = null;
  }

  /** Ancla la clave aceptada; nunca lanza (el arranque no depende del disco). */
  async function persistPinned(jwk: JsonWebKey): Promise<void> {
    if (!options.savePinned) return;
    try {
      await options.savePinned(jwk);
    } catch {
      // Sin persistencia la app sigue verificando mientras haya red.
    }
  }

  function keyIdOf(jwk: JsonWebKey): string {
    const kid = (jwk as { kid?: unknown }).kid;
    return typeof kid === "string" ? kid : "";
  }

  /** Clave de un arranque anterior; se valida la forma antes de confiar en ella. */
  async function readPinned(): Promise<LicensePublicKey | null> {
    if (!options.loadPinned) return null;
    try {
      const jwk = await options.loadPinned();
      if (!isPublicLeaseJwk(jwk)) return null;
      return { jwk: sanitizeJwk(jwk), keyId: keyIdOf(jwk), source: "pinned" };
    } catch {
      return null;
    }
  }

  /** Lectura remota del mismo origen. Un fallo no cachea nada. */
  async function fetchRemote(): Promise<LicensePublicKeyResult> {
    let response: Response;
    try {
      response = await fetchImpl(LICENSE_PUBLIC_KEY_PATH, {
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
    } catch {
      // Sin red y sin anclaje: se informa el fallo, no se bloquea.
      return { status: "error" };
    }

    if (!response.ok) return { status: "missing" };

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { status: "missing" };
    }

    const key = parseKeyPayload(payload, "remote");
    if (!key) return { status: "missing" };
    return { status: "found", key };
  }

  function bundledKey(): LicensePublicKey | null {
    if (options.bundled === null) return null;
    if (options.bundled !== undefined) return parseKeyPayload(options.bundled, "bundled");
    return BUNDLED_LEASE_PUBLIC_KEY;
  }

  async function resolveOnce(): Promise<LicensePublicKeyResult> {
    // 1. Clave compilada en el build: manda sobre la red y sobre el anclaje.
    const fromEnv = parseEnvKey(readEnvRaw(options.envRaw));
    if (fromEnv) {
      cached = fromEnv;
      void persistPinned(fromEnv.jwk);
      return { status: "found", key: fromEnv };
    }

    // 2. Clave anclada: evalúa el lease guardado sin tocar la red (offline-first).
    const pinned = await readPinned();
    if (pinned) {
      cached = pinned;
      return { status: "found", key: pinned };
    }

    // 3. Clave pública servida por el mismo origen.
    const remote = await fetchRemote();
    if (remote.status === "found") {
      cached = remote.key;
      void persistPinned(remote.key.jwk);
      return remote;
    }

    // 4. Clave embebida en el bundle: un 404, una respuesta vieja del Service
    //    Worker o un almacén vacío no pueden hacer que el equipo «olvide» una
    //    licencia verificada. No se ancla: cuando el servidor responde, su
    //    clave vuelve a mandar y la rotación sigue funcionando.
    const bundled = bundledKey();
    if (bundled) return { status: "found", key: bundled };

    return remote;
  }

  /**
   * Relee la clave remota saltándose caché y anclaje. Si falla, la clave
   * anclada sigue en uso: una rotación del servidor nunca rompe la app offline.
   */
  async function refresh(): Promise<LicensePublicKeyResult> {
    const remote = await fetchRemote();
    if (remote.status === "found") {
      cached = remote.key;
      void persistPinned(remote.key.jwk);
    }
    return remote;
  }

  async function resolve(): Promise<LicensePublicKeyResult> {
    if (cached) return { status: "found", key: cached };
    if (inFlight) return inFlight;
    inFlight = resolveOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return { resolve, refresh, reset };
}

let moduleResolver: LicensePublicKeyResolver | null = null;

/**
 * Resolver de conveniencia con caché de módulo. Acepta un `fetchImpl` para
 * usos aislados (devuelve un resolver efímero, sin compartir caché).
 */
export function resolveLicensePublicKey(options: {
  fetchImpl?: LicensePublicKeyFetch;
  forceRefresh?: boolean;
} = {}): Promise<LicensePublicKeyResult> {
  if (options.fetchImpl) {
    return createLicensePublicKeyResolver({ fetchImpl: options.fetchImpl }).resolve();
  }
  if (!moduleResolver) moduleResolver = createLicensePublicKeyResolver();
  if (options.forceRefresh) moduleResolver.reset();
  return moduleResolver.resolve();
}

/** Limpia la caché del resolver de módulo (pruebas o recarga de clave). */
export function resetLicensePublicKeyCache(): void {
  moduleResolver?.reset();
  moduleResolver = null;
}
