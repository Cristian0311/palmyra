/**
 * Resolución de la clave pública del lease de licencia (ES256 / P-256).
 *
 * Prioridad:
 *   1. `import.meta.env.VITE_LICENSE_PUBLIC_JWK` (compilada en el build).
 *   2. `GET /license-public-key.json` servida por el mismo origen.
 *
 * La resolución nunca lanza: devuelve `missing` si no hay clave y `error` si
 * la red falló sin clave previa. El runtime traduce esos estados al modo
 * `unmanaged` sin bloquear, tal como hacía antes.
 *
 * El resultado se cachea por resolver. El runtime crea uno por instancia para
 * que una prueba o una pestaña no contamine a otra; `resolveLicensePublicKey`
 * ofrece un resolver de módulo para usos sueltos.
 */

export const LICENSE_PUBLIC_KEY_PATH = "/license-public-key.json";

export type LicensePublicKeyFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export type LicensePublicKeySource = "env" | "remote";

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
  resolve(): Promise<LicensePublicKeyResult>;
  reset(): void;
}

export interface LicensePublicKeyResolverOptions {
  fetchImpl?: LicensePublicKeyFetch;
  /**
   * Sustituto de `import.meta.env.VITE_LICENSE_PUBLIC_JWK` para pruebas.
   * `undefined` = leer el entorno; `null` = forzar ausencia.
   */
  envRaw?: string | null;
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

function parseRemotePayload(payload: unknown): LicensePublicKey | null {
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
  return { jwk: sanitizeJwk(candidate), keyId, source: "remote" };
}

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

  async function resolveOnce(): Promise<LicensePublicKeyResult> {
    // 1. Clave compilada en el build: manda sobre la red.
    const fromEnv = parseEnvKey(readEnvRaw(options.envRaw));
    if (fromEnv) {
      cached = fromEnv;
      return { status: "found", key: fromEnv };
    }

    // 2. Clave pública servida por el mismo origen.
    let response: Response;
    try {
      response = await fetchImpl(LICENSE_PUBLIC_KEY_PATH, {
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
    } catch {
      // Sin red y sin clave previa: se informa el fallo, no se bloquea.
      return { status: "error" };
    }

    if (!response.ok) return { status: "missing" };

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { status: "missing" };
    }

    const key = parseRemotePayload(payload);
    if (!key) return { status: "missing" };
    cached = key;
    return { status: "found", key };
  }

  async function resolve(): Promise<LicensePublicKeyResult> {
    if (cached) return { status: "found", key: cached };
    if (inFlight) return inFlight;
    inFlight = resolveOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return { resolve, reset };
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
