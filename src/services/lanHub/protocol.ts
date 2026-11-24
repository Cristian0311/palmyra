/**
 * Protocolo v1 del hub LAN.
 *
 * Este módulo solo describe el cable: el handler recibe peticiones ya parseadas
 * (método, ruta, cabeceras y cuerpo de texto) y devuelve una respuesta con el
 * cuerpo JSON serializado. La conexión HTTP real se cablea fuera, de modo que
 * el mismo contrato sirve para el servidor Node del hub y para las pruebas.
 */
import type { ChangeRecord, LocalRow } from "../localDb/contract";

export const HUB_PROTOCOL_VERSION = 1;
/**
 * Interruptor del hub LAN. El producto se opera por Wi-Fi/nube: mientras esté
 * en `false` ninguna superficie intenta emparejarse ni consultar
 * `/lan/v1/rates`, y las tasas se resuelven siempre contra `/api/exchange-rates`
 * del propio servidor. Los módulos del hub se conservan para uso futuro.
 */
export const LAN_HUB_ENABLED = false;
/** Límite del cuerpo completo de una petición (5 MiB). */
export const HUB_MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Tolerancia de reloj entre hub y cliente. */
export const HUB_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Un nonce se recuerda diez minutos: dentro de la ventana de reloj no se repite. */
export const HUB_NONCE_TTL_MS = 10 * 60 * 1000;
/** El código de emparejamiento caduca a los diez minutos y se consume al usarse. */
export const HUB_PAIRING_TTL_MS = 10 * 60 * 1000;
/**
 * Fallos de código tolerados en una misma sesión de emparejamiento. Al llegar
 * al límite la sesión se invalida (el código deja de servir) y hay que generar
 * uno nuevo: un código de 8 dígitos no se puede adivinar a base de reintentos.
 */
export const HUB_PAIR_MAX_FAILURES = 10;
/** Fallos tolerados por dispositivo dentro de la ventana antes de responder 429. */
export const HUB_PAIR_DEVICE_MAX_FAILURES = 5;
/** Ventana del contador por dispositivo (10 min, igual que el TTL del código). */
export const HUB_PAIR_DEVICE_WINDOW_MS = 10 * 60 * 1000;
/**
 * Errores del emparejamiento. `invalidCode` cubre código erróneo y vencido por
 * igual (no se distingue el motivo); `tooManyAttempts` solo indica espera.
 */
export const HUB_PAIR_ERRORS = {
  invalidCode: "invalid_pairing_code",
  tooManyAttempts: "too_many_attempts"
} as const;
/** Tope de filas por página en changes y snapshot. */
export const HUB_MAX_PAGE_LIMIT = 1000;
export const HUB_DEFAULT_PAGE_LIMIT = 500;

export const HUB_ROUTES = {
  pair: "/lan/v1/pair",
  ops: "/lan/v1/ops",
  changes: "/lan/v1/changes",
  snapshot: "/lan/v1/snapshot",
  health: "/lan/v1/health",
  rates: "/lan/v1/rates",
  /** Login local por PIN; no lleva HMAC porque aún no hay token que firmar. */
  login: "/lan/v1/login",
  /** Revocación de un equipo; solo se acepta desde loopback. */
  revoke: "/lan/v1/revoke",
  /** Inventario de equipos de la empresa; solo se acepta desde loopback. */
  devices: "/lan/v1/devices"
} as const;

/** Fallos de PIN tolerados por equipo antes de responder 429. */
export const HUB_LOGIN_MAX_FAILURES = 5;
/** Ventana del contador de PIN (10 min), igual que la del emparejamiento. */
export const HUB_LOGIN_WINDOW_MS = 10 * 60 * 1000;
/**
 * Errores del login por PIN. `invalidPin` cubre equipo desconocido, de otra
 * empresa o sin PIN: hacia afuera los tres casos son indistinguibles.
 */
export const HUB_LOGIN_ERRORS = {
  invalidPin: "invalid_pin",
  tooManyAttempts: "too_many_attempts"
} as const;

export type HubMethod = "GET" | "POST";

export interface HubRequest {
  method: HubMethod;
  path: string;
  headers: Record<string, string>;
  bodyText: string;
  remoteAddr?: string;
}

export interface HubResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON serializado. */
  body: string;
}

export interface HubPairRequest {
  pairingCode: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  companyId: string;
  /** PIN de 4 a 8 dígitos para el login offline; opcional. */
  pin?: string;
}

export interface HubPairResponse {
  deviceToken: string;
  deviceId: string;
  hubId: string;
  serverTime: string;
  companyId: string;
}

/**
 * Login local por PIN de un equipo ya emparejado. El PIN viaja en claro solo
 * aqui, dentro de la LAN; el hub lo compara contra el PBKDF2 guardado.
 */
export interface HubLoginRequest {
  deviceId: string;
  pin: string;
}

export interface HubLoginResponse {
  ok: true;
  deviceId: string;
  companyId: string;
  serverTime: string;
}

/** Ficha pública de un equipo: nunca incluye `token_hash` ni el PIN. */
export interface HubDeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
  pairedAt: string | null;
  revokedAt: string | null;
  hasPin: boolean;
}

export interface HubDevicesResponse {
  devices: HubDeviceInfo[];
}

export interface HubRevokeRequest {
  deviceId: string;
}

export interface HubRevokeResponse {
  ok: true;
  deviceId: string;
  revokedAt: string;
}

export interface HubOpInput {
  actionId: string;
  table: string;
  rows: LocalRow[];
  deletes?: string[];
}

export interface HubOpsRequest {
  deviceId: string;
  ops: HubOpInput[];
}

export type HubOpStatus = "applied" | "duplicate" | "rejected";

export interface HubOpResult {
  actionId: string;
  status: HubOpStatus;
  error?: string;
}

export interface HubOpsResponse {
  results: HubOpResult[];
  latestSeq: number;
  serverTime: string;
}

export interface HubChangesResponse {
  changes: ChangeRecord[];
  latestSeq: number;
  serverTime: string;
  hasMore: boolean;
}

export interface HubSnapshotResponse {
  rows: LocalRow[];
  latestSeq: number;
}

export interface HubHealthResponse {
  ok: boolean;
  protocol: number;
  hubId: string;
  serverTime: string;
  /** Equipos emparejados y no revocados. */
  devices: number;
}

/**
 * Cotización de una divisa publicada por el hub para sus equipos.
 * `code` es el código ISO de la moneda y `stale` indica que el valor es la
 * última copia conocida, no una lectura fresca del proveedor.
 */
export interface HubRateQuote {
  code: string;
  rate: number;
  capturedAt: string;
  source: string;
  stale: boolean;
}

export interface HubRatesResponse {
  rates: HubRateQuote[];
  serverTime: string;
}

/** Todo error del protocolo es un JSON `{error: "code"}` sin detalles internos. */
export interface HubErrorResponse {
  error: string;
}

export function jsonResponse(status: number, body: unknown): HubResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

export function errorResponse(status: number, error: string): HubResponse {
  return jsonResponse(status, { error } satisfies HubErrorResponse);
}
