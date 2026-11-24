/**
 * Código QR de emparejamiento del hub LAN (módulo puro, sin React).
 *
 * El QR transporta tres datos imprescindibles: la dirección del hub, el código
 * de un solo uso y, si el hub usa TLS, la huella del certificado. Nada de esto
 * es un secreto de sesión: el token de dispositivo solo se entrega al canjear
 * el código, así que puede mostrarse en pantalla y pegarse en otro equipo.
 *
 * Formato: `palmyra://hub?v=1&url=<encodeURIComponent(baseUrl)>&code=12345678`,
 * con `&fp=<64 hex>` y `&company=<id>` opcionales. El decodificador también
 * acepta una URL `http(s)://...` con los mismos parámetros para que el usuario
 * pueda pegar a mano lo que ve en el equipo principal.
 */
import type { DesktopHubStatus } from "../../lib/desktopRuntime";

/** Esquema propio del payload; el host `hub` distingue futuros tipos. */
export const PAIRING_PAYLOAD_SCHEME = "palmyra://hub";
export const PAIRING_PAYLOAD_VERSION = "1";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_PIN_MIN_LENGTH = 4;
export const PAIRING_PIN_MAX_LENGTH = 8;
export const PAIRING_FINGERPRINT_HEX_LENGTH = 64;

const PAYLOAD_PREFIX = /^palmyra:\/\/hub\/?\?/i;
const HTTP_SCHEME = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const KNOWN_PARAMS = new Set(["v", "url", "code", "fp", "company"]);
const COMPANY_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

export type PairingPayloadErrorCode =
  | "invalid_payload"
  | "invalid_url"
  | "invalid_code"
  | "invalid_fingerprint";

/** Error de lectura/escritura del payload con mensaje listo para mostrar. */
export class PairingPayloadError extends Error {
  readonly code: PairingPayloadErrorCode;

  constructor(code: PairingPayloadErrorCode, message: string) {
    super(message);
    this.name = "PairingPayloadError";
    this.code = code;
  }
}

/** Payload decodificado: los opcionales quedan como cadena vacía si faltan. */
export interface PairingPayload {
  baseUrl: string;
  code: string;
  fingerprint: string;
  companyId: string;
}

export interface PairingPayloadInput {
  baseUrl: string;
  code: string;
  fingerprint?: string;
  companyId?: string;
}

/** Resultado de construir el QR desde el estado del hub. */
export interface HubPairingPayload {
  /** Dirección efectiva del hub; vacía cuando el host es wildcard. */
  baseUrl: string;
  /** Payload listo para el QR; vacío si no se puede construir. */
  payload: string;
  code: string;
  fingerprint: string;
  companyId: string;
  /** true si el hub escucha en 0.0.0.0/:: y el usuario debe indicar la IP. */
  requiresHost: boolean;
}

/** Estado del hub con la huella TLS, que puede no estar en el contrato base. */
export type HubStatusLike = Pick<DesktopHubStatus, "host" | "port" | "pairingCode" | "companyId"> & {
  tlsFingerprint?: string;
};

/** Direcciones que no sirven para que otro equipo conecte. */
export function isWildcardHost(host: string): boolean {
  const value = typeof host === "string" ? host.trim().toLowerCase() : "";
  if (!value) return true;
  const bare = value.replace(/^\[/, "").replace(/\]$/, "");
  return (
    bare === "0.0.0.0" ||
    bare === "::" ||
    bare === "::1" ||
    bare === "localhost" ||
    bare === "127.0.0.1"
  );
}

/**
 * Normaliza una huella de certificado: admite mayúsculas y separadores ":".
 * Devuelve 64 hex en minúsculas o "" si no es una huella SHA-256.
 */
export function normalizeFingerprint(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const compact = raw.replace(/[\s:]/g, "").toLowerCase();
  return new RegExp(`^[0-9a-f]{${PAIRING_FINGERPRINT_HEX_LENGTH}}$`).test(compact) ? compact : "";
}

function failInvalidFingerprint(): never {
  throw new PairingPayloadError(
    "invalid_fingerprint",
    "La huella del certificado no es válida: deben ser 64 caracteres hexadecimales."
  );
}

/** Igual que `normalizeFingerprint`, pero lanza si la huella no sirve. */
export function requireFingerprint(raw: unknown): string {
  const normalized = normalizeFingerprint(raw);
  if (!normalized) failInvalidFingerprint();
  return normalized;
}

export function isValidPairingCode(value: unknown): boolean {
  return typeof value === "string" && new RegExp(`^\\d{${PAIRING_CODE_LENGTH}}$`).test(value.trim());
}

export function isValidPin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const pin = value.trim();
  return new RegExp(`^\\d{${PAIRING_PIN_MIN_LENGTH},${PAIRING_PIN_MAX_LENGTH}}$`).test(pin);
}

function normalizeCompanyId(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (!COMPANY_PATTERN.test(value)) {
    throw new PairingPayloadError("invalid_payload", "El identificador de empresa del QR no es válido.");
  }
  return value;
}

/**
 * Valida y normaliza la dirección del hub. Acepta `192.168.1.10`,
 * `192.168.1.10:48900`, `http://host:puerto` y `https://host/`, y devuelve
 * siempre `esquema://host[:puerto][/ruta]` sin barra final.
 */
export function normalizeHubBaseUrl(raw: unknown): string {
  const original = typeof raw === "string" ? raw.trim() : "";
  if (!original) {
    throw new PairingPayloadError("invalid_url", "Escribe la dirección del hub (por ejemplo 192.168.1.10:48900).");
  }
  if (ANY_SCHEME.test(original) && !HTTP_SCHEME.test(original)) {
    throw new PairingPayloadError("invalid_url", "La dirección del hub debe usar http o https.");
  }
  const candidate = HTTP_SCHEME.test(original) ? original : `http://${original}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new PairingPayloadError("invalid_url", "La dirección del hub no es válida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PairingPayloadError("invalid_url", "La dirección del hub debe usar http o https.");
  }
  if (url.username || url.password) {
    throw new PairingPayloadError("invalid_url", "La dirección del hub no debe incluir credenciales.");
  }
  if (url.search || url.hash) {
    throw new PairingPayloadError("invalid_url", "La dirección del hub no debe incluir query ni fragmento.");
  }
  if (!url.hostname) {
    throw new PairingPayloadError("invalid_url", "La dirección del hub no incluye un equipo.");
  }
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new PairingPayloadError("invalid_url", "El puerto del hub debe estar entre 1 y 65535.");
    }
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** Construye el texto que va dentro del QR. */
export function encodePairingPayload(input: PairingPayloadInput): string {
  if (!input || typeof input !== "object") {
    throw new PairingPayloadError("invalid_payload", "Faltan los datos del emparejamiento.");
  }
  const baseUrl = normalizeHubBaseUrl(input.baseUrl);
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (!isValidPairingCode(code)) {
    throw new PairingPayloadError(
      "invalid_code",
      `El código de emparejamiento debe tener ${PAIRING_CODE_LENGTH} dígitos.`
    );
  }
  const fingerprint = normalizeFingerprint(input.fingerprint);
  if (input.fingerprint !== undefined && input.fingerprint !== "" && !fingerprint) failInvalidFingerprint();
  const companyId = normalizeCompanyId(input.companyId);

  const params = [
    `v=${PAIRING_PAYLOAD_VERSION}`,
    `url=${encodeURIComponent(baseUrl)}`,
    `code=${code}`
  ];
  if (fingerprint) params.push(`fp=${fingerprint}`);
  if (companyId) params.push(`company=${encodeURIComponent(companyId)}`);
  return `${PAIRING_PAYLOAD_SCHEME}?${params.join("&")}`;
}

function readParams(params: URLSearchParams): PairingPayload {
  for (const key of params.keys()) {
    if (!KNOWN_PARAMS.has(key)) {
      throw new PairingPayloadError("invalid_payload", "El QR contiene datos que PALMYRA no reconoce.");
    }
  }
  const version = params.get("v");
  if (version !== null && version !== PAIRING_PAYLOAD_VERSION) {
    throw new PairingPayloadError(
      "invalid_payload",
      "El QR pertenece a otra versión de PALMYRA. Actualiza la aplicación en ambos equipos."
    );
  }
  const code = (params.get("code") || "").trim();
  if (!isValidPairingCode(code)) {
    throw new PairingPayloadError(
      "invalid_code",
      `El código de emparejamiento del QR debe tener ${PAIRING_CODE_LENGTH} dígitos.`
    );
  }
  const rawFingerprint = params.get("fp");
  let fingerprint = "";
  if (rawFingerprint !== null && rawFingerprint !== "") {
    fingerprint = normalizeFingerprint(rawFingerprint);
    if (!fingerprint) failInvalidFingerprint();
  }
  const companyId = normalizeCompanyId(params.get("company") || "");
  return { baseUrl: "", code, fingerprint, companyId };
}

/**
 * Lee el contenido del QR o una URL `http(s)://` equivalente.
 * Lanza `PairingPayloadError` con un código estable para la interfaz.
 */
export function decodePairingPayload(text: unknown): PairingPayload {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) throw new PairingPayloadError("invalid_payload", "El contenido del QR está vacío.");
  if (raw.length > 2048) {
    throw new PairingPayloadError("invalid_payload", "El contenido pegado es demasiado largo para un QR de emparejamiento.");
  }

  if (ANY_SCHEME.test(raw) && !PAYLOAD_PREFIX.test(raw) && !HTTP_SCHEME.test(raw)) {
    throw new PairingPayloadError("invalid_payload", "El texto no es un QR de emparejamiento de PALMYRA.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PairingPayloadError("invalid_payload", "El texto no es un QR de emparejamiento de PALMYRA.");
  }

  const isHubPayload = url.protocol === "palmyra:" && url.host.toLowerCase() === "hub";
  if (!isHubPayload && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PairingPayloadError("invalid_payload", "El texto no es un QR de emparejamiento de PALMYRA.");
  }
  if (url.username || url.password || url.hash) {
    throw new PairingPayloadError("invalid_url", "La dirección del hub no debe incluir credenciales ni fragmento.");
  }

  const parsed = readParams(url.searchParams);
  const urlParam = (url.searchParams.get("url") || "").trim();
  // En la forma corta `http://host?code=...` la propia URL es la dirección.
  const baseUrl = normalizeHubBaseUrl(urlParam || (isHubPayload ? "" : `${url.origin}${url.pathname}`));
  return { ...parsed, baseUrl };
}

/**
 * Dirección escrita a mano en el equipo secundario. Rechaza credenciales,
 * query, fragmento, esquemas ajenos y puertos fuera de rango.
 */
export function parseManualHubAddress(raw: unknown): string {
  return normalizeHubBaseUrl(raw);
}

/**
 * Campo único que admite dirección y código ("192.168.1.10:48900 48219307").
 * El código es opcional; si no aparece devuelve "".
 */
export function parseManualPairingInput(raw: unknown): { baseUrl: string; code: string } {
  const original = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!original) {
    throw new PairingPayloadError("invalid_url", "Escribe la dirección del hub (por ejemplo 192.168.1.10:48900).");
  }
  let code = "";
  let rest = original;
  // Etiquetas explícitas: "codigo=48219307", "código: 48219307".
  const labeled = /(?:\b(?:codigo|código|code)\b\s*[:=]?\s*)(\d{8})(?![0-9])/i.exec(rest);
  if (labeled) {
    code = labeled[1];
    rest = rest.replace(labeled[0], " ");
  }
  if (!code) {
    const loose = /(?:^|\s)(\d{8})(?=\s|$)/.exec(rest);
    if (loose) {
      code = loose[1];
      rest = rest.slice(0, loose.index) + " " + rest.slice(loose.index + loose[0].length);
    }
  }
  const address = rest.replace(/\s+/g, " ").trim();
  if (!address) return { baseUrl: "", code };
  return { baseUrl: parseManualHubAddress(address), code };
}

/**
 * Construye el payload desde el estado del hub. Con host wildcard (0.0.0.0,
 * ::, localhost) devuelve `baseUrl` y `payload` vacíos y `requiresHost: true`:
 * la IP real la elige el usuario en la interfaz, nunca se inventa aquí.
 * Con huella TLS se asume `https://`; sin ella, `http://`.
 */
export function hubStatusToPairingPayload(status: HubStatusLike | null | undefined): HubPairingPayload {
  const code = typeof status?.pairingCode === "string" ? status.pairingCode.trim() : "";
  const fingerprint = normalizeFingerprint(status?.tlsFingerprint);
  const companyId = typeof status?.companyId === "string" ? status.companyId.trim() : "";
  const empty: HubPairingPayload = {
    baseUrl: "",
    payload: "",
    code,
    fingerprint,
    companyId,
    requiresHost: true
  };
  if (!isValidPairingCode(code)) return empty;
  const host = typeof status?.host === "string" ? status.host.trim() : "";
  if (isWildcardHost(host)) return empty;
  const port = typeof status?.port === "number" && Number.isInteger(status.port) && status.port > 0 && status.port <= 65535
    ? status.port
    : 0;
  if (!port) return empty;

  try {
    const baseUrl = normalizeHubBaseUrl(`${fingerprint ? "https" : "http"}://${host}:${port}`);
    return {
      baseUrl,
      payload: encodePairingPayload({ baseUrl, code, fingerprint, companyId }),
      code,
      fingerprint,
      companyId,
      requiresHost: false
    };
  } catch {
    // Un host con formato raro no debe romper el panel: se pide a mano.
    return empty;
  }
}
