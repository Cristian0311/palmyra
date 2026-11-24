/**
 * Handler del protocolo v1 del hub LAN.
 *
 * Recibe peticiones ya parseadas y responde sin conocer el transporte HTTP.
 * El hub es el único escritor del almacén local de la empresa: los clientes
 * emparejados solo proponen operaciones firmadas que se aplican de forma
 * idempotente por `actionId`.
 */
import {
  LocalDbError,
  assertLocalRow,
  type ChangeRecord,
  type LocalDbDriver,
  type LocalRow,
  type LocalTable
} from "../localDb/contract";
import { LOCAL_DB_TABLE_NAMES } from "../localDb/schema";
import {
  HUB_AUTH_HEADERS,
  createDeviceToken,
  createPairingCode,
  createReplayGuard,
  hashDeviceToken,
  verifyHubRequest,
  type HubReplayGuard
} from "./auth";
import { hashPin, isValidPin, verifyPin } from "./devicePin";
import {
  HUB_DEFAULT_PAGE_LIMIT,
  HUB_LOGIN_ERRORS,
  HUB_LOGIN_MAX_FAILURES,
  HUB_LOGIN_WINDOW_MS,
  HUB_MAX_BODY_BYTES,
  HUB_MAX_PAGE_LIMIT,
  HUB_PAIR_DEVICE_MAX_FAILURES,
  HUB_PAIR_DEVICE_WINDOW_MS,
  HUB_PAIR_ERRORS,
  HUB_PAIR_MAX_FAILURES,
  HUB_PAIRING_TTL_MS,
  HUB_PROTOCOL_VERSION,
  HUB_ROUTES,
  errorResponse,
  jsonResponse,
  type HubDeviceInfo,
  type HubDevicesResponse,
  type HubLoginResponse,
  type HubOpResult,
  type HubRateQuote,
  type HubRatesResponse,
  type HubRequest,
  type HubResponse,
  type HubRevokeResponse
} from "./protocol";
import { isValidationFailure, validateOperation } from "./validation";

export interface HubHandlerOptions {
  driver: LocalDbDriver;
  hubId: string;
  companyId: string;
  /** Milisegundos; se inyecta en pruebas. */
  now?: () => number;
  /** Generador del código de emparejamiento; por defecto 8 dígitos aleatorios. */
  pairingCode?: () => string;
  /**
   * Proveedor de cotizaciones para `GET /lan/v1/rates`. Si falta o falla, el
   * hub responde 503 `rates_unavailable`; nunca inventa tasas.
   */
  rates?: () => Promise<HubRateQuote[]>;
  /**
   * Frenos del login por PIN. Defaults: 5 fallos por equipo dentro de una
   * ventana de 10 minutos. Se inyectan en pruebas para no esperar de verdad.
   */
  pinRateLimit?: { maxFailures?: number; windowMs?: number };
}

export interface HubPairingSession {
  code: string;
  expiresAt: string;
}

export interface HubHandler {
  (req: HubRequest): Promise<HubResponse>;
  /** Genera un código nuevo (10 min) y lo deja vigente. */
  createPairingSession(): HubPairingSession;
  currentPairingSession(): HubPairingSession | null;
}

/** Tablas internas del hub: un cliente nunca las escribe ni las lee en claro. */
const INTERNAL_TABLES = new Set<LocalTable>(["hub_devices", "hub_receipts"]);
const MAX_DEVICE_ID_LENGTH = 200;
const MAX_ACTION_ID_LENGTH = 200;
/**
 * Tope de contadores de emparejamiento en memoria. Un cliente puede inventar
 * cabeceras nuevas en cada intento, así que el mapa nunca crece sin límite:
 * al llenarse se descarta el contador más antiguo.
 */
const MAX_TRACKED_PAIRING_DEVICES = 512;
/** Mismo tope para los contadores de PIN: claves inventadas no crecen sin fin. */
const MAX_TRACKED_LOGIN_DEVICES = 512;
/** Direcciones desde las que se aceptan las rutas administrativas del hub. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

interface ActiveSession {
  code: string;
  expiresAtMs: number;
  /** Fallos acumulados contra este código; al llegar al tope la sesión muere. */
  failures: number;
}

/** Estado del contador de fallos de un equipo dentro de su ventana. */
interface DeviceAttemptState {
  failures: number;
  /** Fin de la ventana: a partir de aquí el contador vuelve a cero. */
  resetAtMs: number;
}

/**
 * Compara el código sin cortar en el primer dígito distinto: así el tiempo de
 * respuesta no delata cuántos dígitos acertó el que prueba ni si el código
 * existía. La longitud la fija el código vigente (8 dígitos).
 */
function pairingCodesMatch(expected: string, provided: string): boolean {
  const length = expected.length;
  let diff = provided.length === length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    const probed = index < provided.length ? provided.charCodeAt(index) : 0;
    diff |= expected.charCodeAt(index) ^ probed;
  }
  return diff === 0;
}

interface AuthResult {
  deviceId: string;
  /** Respuesta de error ya lista; null cuando la firma es válida. */
  rejection: HubResponse | null;
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === target && typeof value === "string") return value;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function queryInt(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function bodyBytes(text: string): number {
  // La longitud en unidades UTF-16 nunca supera la longitud en bytes UTF-8, así
  // que se puede descartar un cuerpo gigante sin codificarlo.
  if (text.length > HUB_MAX_BODY_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

function isKnownTable(name: string): name is LocalTable {
  return (LOCAL_DB_TABLE_NAMES as string[]).includes(name);
}

/**
 * Rutas administrativas (listar y revocar equipos): solo el propio hub. Si el
 * transporte no informa la dirección (pruebas, llamadas internas) se asume
 * loopback, porque en ese caso no hay red de por medio.
 */
function isLoopbackRequest(remoteAddr: string | undefined): boolean {
  if (remoteAddr === undefined || remoteAddr === null) return true;
  const normalized = remoteAddr.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (!normalized) return true;
  return LOOPBACK_ADDRESSES.has(normalized);
}

/** Entero positivo de configuración; si no sirve, se usa el default del hub. */
function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Campo de la fila como texto ISO, o null si no lo es. */
function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * PIN opcional del cuerpo de emparejamiento: ausente o vacío significa "sin
 * PIN"; presente pero mal formado invalida la petición. Nunca se registra.
 */
function optionalPin(raw: unknown): { valid: boolean; pin: string | null } {
  if (raw === undefined || raw === null) return { valid: true, pin: null };
  if (typeof raw === "string" && raw.trim() === "") return { valid: true, pin: null };
  if (isValidPin(raw)) return { valid: true, pin: raw };
  return { valid: false, pin: null };
}

/**
 * Clave del contador por dispositivo: la cabecera `x-palmyra-device` manda; si
 * el cliente no la envía se usa el `deviceId` del cuerpo para no dejar el
 * contador sin sujeto. El valor nunca se registra, solo se usa como clave.
 */
function pairingDeviceKey(req: HubRequest, bodyDeviceId: string): string | null {
  const raw = nonEmptyString(headerValue(req.headers, HUB_AUTH_HEADERS.device)) ?? bodyDeviceId;
  return raw ? raw.slice(0, MAX_DEVICE_ID_LENGTH) : null;
}

/** 429 del emparejamiento: solo dice cuánto esperar, nunca si el código existía. */
function tooManyAttemptsResponse(retryAfterMs: number): HubResponse {
  return jsonResponse(429, { error: HUB_PAIR_ERRORS.tooManyAttempts, retryAfterMs });
}

/**
 * Normaliza una cotización del proveedor. Devuelve `null` si no cumple el
 * contrato: el hub prefiere 503 antes que publicar una tasa inventada.
 */
function sanitizeRateQuote(value: unknown): HubRateQuote | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const code = nonEmptyString(record.code);
  const rate = record.rate;
  const capturedAt = nonEmptyString(record.capturedAt);
  const source = nonEmptyString(record.source);
  if (!code || typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  if (!capturedAt || !source) return null;
  return {
    code,
    rate,
    capturedAt,
    source,
    stale: record.stale === true
  };
}

export function createHubHandler(options: HubHandlerOptions): HubHandler {
  const { driver, hubId, companyId } = options;
  const clock = options.now ?? (() => Date.now());
  const codeFactory = options.pairingCode ?? createPairingCode;
  const ratesProvider = options.rates;
  const replay: HubReplayGuard = createReplayGuard({ now: clock });
  const pairingTtlMs = HUB_PAIRING_TTL_MS;
  let session: ActiveSession | null = null;
  /** Fallos de emparejamiento por dispositivo; se limpia al emparejar con éxito. */
  const pairingAttempts = new Map<string, DeviceAttemptState>();
  /** Fallos de PIN por equipo; ventana propia y configurable para pruebas. */
  const loginAttempts = new Map<string, DeviceAttemptState>();
  const loginMaxFailures = positiveIntOr(options.pinRateLimit?.maxFailures, HUB_LOGIN_MAX_FAILURES);
  const loginWindowMs = positiveIntOr(options.pinRateLimit?.windowMs, HUB_LOGIN_WINDOW_MS);

  function serverTime(): string {
    return new Date(clock()).toISOString();
  }

  function publicSession(active: ActiveSession): HubPairingSession {
    return { code: active.code, expiresAt: new Date(active.expiresAtMs).toISOString() };
  }

  function createPairingSession(): HubPairingSession {
    // Un código nuevo abre ventana: los contadores que ya vencieron se sueltan.
    const at = clock();
    prunePairingAttempts(at);
    session = { code: codeFactory(), expiresAtMs: at + pairingTtlMs, failures: 0 };
    return publicSession(session);
  }

  function currentPairingSession(): HubPairingSession | null {
    const at = clock();
    // Limpieza perezosa: sin intentos no se acumula nada, y lo vencido se va.
    prunePairingAttempts(at);
    if (!session) return null;
    if (session.expiresAtMs <= at) {
      session = null;
      return null;
    }
    return publicSession(session);
  }

  /** Descarta contadores de ventanas ya vencidas antes de leer o escribir. */
  function prunePairingAttempts(at: number): void {
    for (const [key, state] of pairingAttempts) {
      if (state.resetAtMs <= at) pairingAttempts.delete(key);
    }
  }

  /** Milisegundos que faltan para que el equipo pueda reintentar; 0 si no está bloqueado. */
  function deviceRetryAfterMs(key: string, at: number): number {
    const state = pairingAttempts.get(key);
    if (!state) return 0;
    if (state.resetAtMs <= at) {
      pairingAttempts.delete(key);
      return 0;
    }
    if (state.failures < HUB_PAIR_DEVICE_MAX_FAILURES) return 0;
    return Math.max(1, state.resetAtMs - at);
  }

  /**
   * Anota un fallo del equipo. La ventana empieza con el primer fallo y no se
   * desliza: o se empareja bien (y se borra) o se espera a que venza. El mapa
   * está acotado y se purga por tiempo, de modo que generar muchos códigos no
   * deja contadores huérfanos.
   */
  function registerDeviceFailure(key: string, at: number): DeviceAttemptState {
    prunePairingAttempts(at);
    let state = pairingAttempts.get(key);
    if (!state) {
      if (pairingAttempts.size >= MAX_TRACKED_PAIRING_DEVICES) {
        const oldest = pairingAttempts.keys().next();
        if (!oldest.done) pairingAttempts.delete(oldest.value);
      }
      state = { failures: 0, resetAtMs: at + HUB_PAIR_DEVICE_WINDOW_MS };
      pairingAttempts.set(key, state);
    }
    state.failures += 1;
    return state;
  }

  /**
   * Anota un intento fallido contra la sesión vigente: suma el fallo del equipo
   * y el del código. Al tocar cualquiera de los dos topes la sesión se invalida
   * (el código deja de servir y hay que generar uno nuevo) y el intento se
   * responde con 429. Devuelve los milisegundos de espera, o 0 si solo es un
   * fallo normal.
   */
  function registerFailedAttempt(deviceKey: string | null, at: number): number {
    let deviceWait = 0;
    if (deviceKey) {
      const state = registerDeviceFailure(deviceKey, at);
      if (state.failures >= HUB_PAIR_DEVICE_MAX_FAILURES) {
        deviceWait = Math.max(1, state.resetAtMs - at);
      }
    }

    let sessionWait = 0;
    if (session) {
      session.failures += 1;
      if (session.failures >= HUB_PAIR_MAX_FAILURES) {
        sessionWait = Math.max(1, session.expiresAtMs - at);
      }
    }

    if (deviceWait === 0 && sessionWait === 0) return 0;
    // Tope alcanzado: el código se quema aunque el intento fuera el acertado.
    session = null;
    return Math.max(deviceWait, sessionWait, 1);
  }

  /** Descarta contadores de PIN de ventanas vencidas antes de leer o escribir. */
  function pruneLoginAttempts(at: number): void {
    for (const [key, state] of loginAttempts) {
      if (state.resetAtMs <= at) loginAttempts.delete(key);
    }
  }

  /** Milisegundos de espera del equipo en el login; 0 si aún puede probar. */
  function loginRetryAfterMs(key: string, at: number): number {
    const state = loginAttempts.get(key);
    if (!state) return 0;
    if (state.resetAtMs <= at) {
      loginAttempts.delete(key);
      return 0;
    }
    if (state.failures < loginMaxFailures) return 0;
    return Math.max(1, state.resetAtMs - at);
  }

  /**
   * Anota un fallo de PIN. Devuelve la espera (ms) cuando el intento toca el
   * tope, o 0 si todavía es un fallo normal. La ventana no se desliza: se
   * perdona al acertar o al vencer, y el mapa está acotado y purgado por tiempo.
   */
  function registerLoginFailure(key: string, at: number): number {
    pruneLoginAttempts(at);
    let state = loginAttempts.get(key);
    if (!state) {
      if (loginAttempts.size >= MAX_TRACKED_LOGIN_DEVICES) {
        const oldest = loginAttempts.keys().next();
        if (!oldest.done) loginAttempts.delete(oldest.value);
      }
      state = { failures: 0, resetAtMs: at + loginWindowMs };
      loginAttempts.set(key, state);
    }
    state.failures += 1;
    return state.failures >= loginMaxFailures ? Math.max(1, state.resetAtMs - at) : 0;
  }

  function parseBody(text: string): Record<string, unknown> | null {
    if (!text.trim()) return null;
    try {
      return asRecord(JSON.parse(text));
    } catch {
      return null;
    }
  }

  async function handlePair(req: HubRequest): Promise<HubResponse> {
    const body = parseBody(req.bodyText);
    if (!body) return errorResponse(400, "invalid_body");

    const code = nonEmptyString(body.pairingCode);
    const deviceId = nonEmptyString(body.deviceId);
    const requestCompany = nonEmptyString(body.companyId);
    if (!code || !deviceId || !requestCompany) return errorResponse(400, "invalid_body");
    if (deviceId.length > MAX_DEVICE_ID_LENGTH) return errorResponse(400, "invalid_device");
    if (requestCompany !== companyId) return errorResponse(403, "company_mismatch");
    // PIN opcional: si viene, o es válido o el pareo se rechaza antes de contar
    // un intento. Vacío/ausente significa que el equipo quedará sin PIN.
    const pinField = optionalPin(body.pin);
    if (!pinField.valid) return errorResponse(400, HUB_LOGIN_ERRORS.invalidPin);

    const at = clock();
    const deviceKey = pairingDeviceKey(req, deviceId);
    if (deviceKey) {
      const retryAfterMs = deviceRetryAfterMs(deviceKey, at);
      // Un equipo bloqueado no prueba códigos ni aunque acierte: el 429 no dice
      // nada del código y la espera se cuenta desde su primer fallo.
      if (retryAfterMs > 0) return tooManyAttemptsResponse(retryAfterMs);
    }

    // Sesión vencida: se descarta en cuanto se detecta para no arrastrarla.
    const active = session && session.expiresAtMs > at ? session : null;
    if (!active) session = null;

    if (!active) {
      // Sin código vigente no hay nada que comparar ni que proteger: mismo 401
      // que un código erróneo, para que el cliente no distinga los dos casos.
      return errorResponse(401, HUB_PAIR_ERRORS.invalidCode);
    }

    if (!pairingCodesMatch(active.code, code)) {
      const retryAfterMs = registerFailedAttempt(deviceKey, at);
      // Tope por código o por equipo: la sesión queda invalidada y solo se
      // comunica la espera, nunca si el código probado existía.
      if (retryAfterMs > 0) return tooManyAttemptsResponse(retryAfterMs);
      return errorResponse(401, HUB_PAIR_ERRORS.invalidCode);
    }

    // El token se entrega una sola vez; a partir de aquí solo existe su hash.
    const token = createDeviceToken();
    const atIso = new Date(at).toISOString();
    const pinHash = pinField.pin ? await hashPin(pinField.pin) : null;
    const existing = await driver.get<LocalRow>("hub_devices", deviceId);
    const row: LocalRow = {
      id: deviceId,
      company_id: companyId,
      version: existing && Number.isFinite(existing.version) ? Number(existing.version) + 1 : 1,
      updated_at: atIso,
      origin_device: deviceId,
      deleted_at: null,
      device_id: deviceId,
      device_name: nonEmptyString(body.deviceName) ?? "",
      platform: nonEmptyString(body.platform) ?? "",
      token_hash: hashDeviceToken(token),
      /** PBKDF2 del PIN de equipo; null si el equipo se emparejó sin PIN. */
      pin_hash: pinHash,
      paired_at: atIso,
      revoked_at: null
    };
    await driver.put("hub_devices", [row]);
    // Un código empareja un solo equipo; repetir exige generar otro.
    session = null;
    // Emparejar bien perdona los fallos previos de este equipo.
    if (deviceKey) pairingAttempts.delete(deviceKey);

    return jsonResponse(200, {
      deviceToken: token,
      deviceId,
      hubId,
      serverTime: atIso,
      companyId
    });
  }

  /**
   * Login local por PIN. No lleva HMAC: es el paso previo a tener sesión y debe
   * funcionar con el hub aislado de internet, porque todo ocurre en la LAN.
   *
   * Hacia afuera, equipo desconocido, de otra empresa o sin PIN responden lo
   * mismo que un PIN erróneo (`invalid_pin`); un equipo revocado sí se nombra
   * como tal (403 `device_revoked`), igual que ya hace la firma HMAC.
   */
  async function handleLogin(req: HubRequest): Promise<HubResponse> {
    const body = parseBody(req.bodyText);
    if (!body) return errorResponse(400, "invalid_body");
    const deviceId = nonEmptyString(body.deviceId);
    const pin = typeof body.pin === "string" ? body.pin : "";
    if (!deviceId || !pin) return errorResponse(400, "invalid_body");
    if (deviceId.length > MAX_DEVICE_ID_LENGTH) return errorResponse(400, "invalid_device");

    const at = clock();
    // Un equipo bloqueado no llega ni a leer su fila: el 429 no dice nada.
    const retryAfterMs = loginRetryAfterMs(deviceId, at);
    if (retryAfterMs > 0) return tooManyAttemptsResponse(retryAfterMs);

    const device = await driver.get<LocalRow>("hub_devices", deviceId);
    if (!device || device.company_id !== companyId) {
      return loginFailure(deviceId, at);
    }
    if (device.revoked_at || device.deleted_at) {
      return errorResponse(403, "device_revoked");
    }
    const stored = typeof device.pin_hash === "string" ? device.pin_hash : "";
    if (!stored) return loginFailure(deviceId, at);

    if (!(await verifyPin(pin, stored))) return loginFailure(deviceId, at);

    // Acierto: el equipo recupera sus intentos.
    loginAttempts.delete(deviceId);
    const payload: HubLoginResponse = {
      ok: true,
      deviceId,
      companyId,
      serverTime: new Date(at).toISOString()
    };
    return jsonResponse(200, payload);
  }

  /** Cuenta el fallo y devuelve 429 si toca el tope; si no, 401 sin pistas. */
  function loginFailure(deviceId: string, at: number): HubResponse {
    const retryAfterMs = registerLoginFailure(deviceId, at);
    if (retryAfterMs > 0) return tooManyAttemptsResponse(retryAfterMs);
    return errorResponse(401, HUB_LOGIN_ERRORS.invalidPin);
  }

  /**
   * Inventario de equipos de la empresa para el panel local. Solo loopback:
   * fuera del propio hub nadie enumera equipos. Nunca expone `token_hash` ni
   * el PIN; solo si lo tiene.
   */
  async function handleDevices(req: HubRequest): Promise<HubResponse> {
    if (!isLoopbackRequest(req.remoteAddr)) return errorResponse(403, "forbidden");
    const rows = await driver.query<LocalRow>({
      table: "hub_devices",
      where: [{ field: "company_id", op: "eq", value: companyId }],
      orderBy: { field: "paired_at", direction: "asc" }
    });
    const devices: HubDeviceInfo[] = rows.map((row) => ({
      deviceId: String(row.device_id ?? row.id),
      deviceName: typeof row.device_name === "string" ? row.device_name : "",
      platform: typeof row.platform === "string" ? row.platform : "",
      pairedAt: isoOrNull(row.paired_at),
      revokedAt: isoOrNull(row.revoked_at),
      hasPin: typeof row.pin_hash === "string" && row.pin_hash.length > 0
    }));
    const payload: HubDevicesResponse = { devices };
    return jsonResponse(200, payload);
  }

  /**
   * Revocación de un equipo desde el propio hub. Idempotente: revocar dos veces
   * devuelve la fecha original. La fila se versiona para que el cambio viaje en
   * el journal; la firma HMAC de ese equipo deja de valer en el acto.
   */
  async function handleRevoke(req: HubRequest): Promise<HubResponse> {
    if (!isLoopbackRequest(req.remoteAddr)) return errorResponse(403, "forbidden");
    const body = parseBody(req.bodyText);
    if (!body) return errorResponse(400, "invalid_body");
    const deviceId = nonEmptyString(body.deviceId);
    if (!deviceId) return errorResponse(400, "invalid_body");
    if (deviceId.length > MAX_DEVICE_ID_LENGTH) return errorResponse(400, "invalid_device");

    const row = await driver.get<LocalRow>("hub_devices", deviceId);
    if (!row || row.company_id !== companyId) return errorResponse(404, "unknown_device");

    const already = isoOrNull(row.revoked_at);
    if (already) {
      const payload: HubRevokeResponse = { ok: true, deviceId, revokedAt: already };
      return jsonResponse(200, payload);
    }

    const atIso = serverTime();
    await driver.put<LocalRow>("hub_devices", [
      {
        ...row,
        version: Number.isFinite(row.version) ? Number(row.version) + 1 : 1,
        updated_at: atIso,
        revoked_at: atIso
      }
    ]);
    // Un equipo revocado no conserva intentos de PIN pendientes.
    loginAttempts.delete(deviceId);
    const payload: HubRevokeResponse = { ok: true, deviceId, revokedAt: atIso };
    return jsonResponse(200, payload);
  }

  async function authenticate(req: HubRequest): Promise<AuthResult> {
    const deviceId = headerValue(req.headers, HUB_AUTH_HEADERS.device);
    const timestamp = headerValue(req.headers, HUB_AUTH_HEADERS.timestamp);
    const nonce = headerValue(req.headers, HUB_AUTH_HEADERS.nonce);
    const signature = headerValue(req.headers, HUB_AUTH_HEADERS.signature);
    if (!deviceId || !timestamp || !nonce || !signature) {
      return { deviceId: deviceId ?? "", rejection: errorResponse(401, "unauthorized") };
    }

    const device = await driver.get<LocalRow>("hub_devices", deviceId);
    if (!device || device.company_id !== companyId) {
      return { deviceId, rejection: errorResponse(403, "unknown_device") };
    }
    if (device.revoked_at || device.deleted_at) {
      return { deviceId, rejection: errorResponse(403, "device_revoked") };
    }
    const tokenHash = typeof device.token_hash === "string" ? device.token_hash : "";
    if (!tokenHash) return { deviceId, rejection: errorResponse(403, "device_revoked") };

    const verdict = verifyHubRequest({
      tokenHash,
      signature,
      deviceId,
      method: req.method,
      path: req.path,
      timestamp,
      nonce,
      body: req.bodyText,
      now: clock(),
      replay
    });
    if (!verdict.ok) {
      return { deviceId, rejection: errorResponse(401, verdict.reason ?? "invalid_signature") };
    }
    return { deviceId, rejection: null };
  }

  function rejected(actionId: string, error: string): HubOpResult {
    return { actionId, status: "rejected", error };
  }

  function receiptRow(
    id: string,
    actionId: string,
    table: LocalTable,
    deviceId: string,
    rowCount: number,
    deleteCount: number
  ): LocalRow {
    const at = serverTime();
    return {
      id,
      company_id: companyId,
      version: 1,
      updated_at: at,
      origin_device: deviceId,
      deleted_at: null,
      action_id: actionId,
      device_id: deviceId,
      table,
      row_count: rowCount,
      delete_count: deleteCount,
      status: "applied",
      applied_at: at
    };
  }

  async function applyOperation(raw: unknown, deviceId: string): Promise<HubOpResult> {
    const op = asRecord(raw);
    const actionId = op ? nonEmptyString(op.actionId) : null;
    if (!op || !actionId) return rejected(actionId ?? "", "invalid_action");
    if (actionId.length > MAX_ACTION_ID_LENGTH) return rejected(actionId, "invalid_action");

    const tableName = nonEmptyString(op.table);
    if (!tableName || !isKnownTable(tableName)) return rejected(actionId, "unknown_table");
    const table = tableName;
    if (INTERNAL_TABLES.has(table)) return rejected(actionId, "forbidden_table");

    const rowsRaw = op.rows === undefined ? [] : op.rows;
    const deletesRaw = op.deletes === undefined ? [] : op.deletes;
    if (!Array.isArray(rowsRaw) || !Array.isArray(deletesRaw)) {
      return rejected(actionId, "invalid_rows");
    }

    const rows: LocalRow[] = [];
    for (const candidate of rowsRaw) {
      try {
        assertLocalRow(table, candidate);
      } catch {
        return rejected(actionId, "invalid_row");
      }
      const row = candidate as LocalRow;
      if (row.company_id !== companyId) return rejected(actionId, "company_mismatch");
      rows.push(row);
    }

    const deletes: string[] = [];
    for (const candidate of deletesRaw) {
      const id = nonEmptyString(candidate);
      if (!id) return rejected(actionId, "invalid_deletes");
      deletes.push(id);
    }
    if (rows.length === 0 && deletes.length === 0) {
      return rejected(actionId, "empty_operation");
    }

    // El recibo se escribe en la misma transacción que los datos: o quedan
    // ambos, o no queda nada, y un reintento posteriores siempre ve el recibo.
    // La validación de negocio lee el estado dentro de la transacción, de modo
    // que dos lotes concurrentes no pueden saltarse las comprobaciones.
    const receiptId = `${deviceId}:${actionId}`;
    type ApplyOutcome =
      | { status: "applied" | "duplicate" }
      | { status: "rejected"; error: string };
    try {
      const outcome = await driver.transaction<ApplyOutcome>(async (tx) => {
        const previous = await tx.get<LocalRow>("hub_receipts", receiptId);
        if (previous) return { status: "duplicate" as const };

        const verdict = await validateOperation({
          table,
          rows,
          deletes,
          driver: tx,
          companyId
        });
        if (isValidationFailure(verdict)) {
          // Un lote idéntico ya aplicado se acusa como duplicado; el resto de
          // códigos viaja en `error` y no tumba las demás operaciones.
          if (verdict.code === "duplicate") return { status: "duplicate" as const };
          return { status: "rejected" as const, error: verdict.code };
        }

        if (rows.length > 0) await tx.put(table, rows);
        if (deletes.length > 0) {
          await tx.remove(table, deletes, {
            company_id: companyId,
            origin_device: deviceId,
            at: serverTime()
          });
        }
        await tx.put("hub_receipts", [
          receiptRow(receiptId, actionId, table, deviceId, rows.length, deletes.length)
        ]);
        return { status: "applied" as const };
      });
      if (outcome.status === "rejected") return rejected(actionId, outcome.error);
      return { actionId, status: outcome.status };
    } catch (error) {
      const code = error instanceof LocalDbError ? error.code : "apply_failed";
      return rejected(actionId, code === "invalid_row" ? "invalid_row" : "apply_failed");
    }
  }

  async function handleOps(req: HubRequest, auth: { deviceId: string }): Promise<HubResponse> {
    const body = parseBody(req.bodyText);
    if (!body) return errorResponse(400, "invalid_body");
    if (body.deviceId !== auth.deviceId) return errorResponse(403, "device_mismatch");
    if (!Array.isArray(body.ops)) return errorResponse(400, "invalid_body");

    const results: HubOpResult[] = [];
    // Cada operación es independiente: una inválida no tumba a las demás.
    for (const raw of body.ops) {
      results.push(await applyOperation(raw, auth.deviceId));
    }
    return jsonResponse(200, {
      results,
      latestSeq: await driver.latestSeq(),
      serverTime: serverTime()
    });
  }

  async function handleChanges(url: URL): Promise<HubResponse> {
    const since = queryInt(url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = queryInt(url, "limit", HUB_DEFAULT_PAGE_LIMIT, 1, HUB_MAX_PAGE_LIMIT);
    const changes = await driver.changes(since, limit);
    const latestSeq = await driver.latestSeq();
    const last = changes[changes.length - 1];
    const hasMore = changes.length === limit && Boolean(last) && last.seq < latestSeq;
    // El journal no guarda la fila: se adjunta la vigente para que un equipo que
    // se incorpora tarde pueda aplicar el upsert sin consultar fila por fila.
    // Si la fila ya no existe (o quedó en lápida), el cambio se sirve como
    // borrado para que la réplica no resucite datos.
    const enriched: Array<ChangeRecord & { row?: LocalRow }> = [];
    for (const change of changes) {
      if (change.op === "delete") {
        enriched.push(change);
        continue;
      }
      let row: LocalRow | null = null;
      try {
        row = await driver.get<LocalRow>(change.table, change.row_id);
      } catch {
        row = null;
      }
      if (!row || row.deleted_at || row.company_id !== change.company_id) {
        enriched.push({ ...change, op: "delete" });
      } else {
        enriched.push({ ...change, row });
      }
    }
    return jsonResponse(200, { changes: enriched, latestSeq, serverTime: serverTime(), hasMore });
  }

  async function handleSnapshot(url: URL): Promise<HubResponse> {
    const tableName = nonEmptyString(url.searchParams.get("table"));
    if (!tableName || !isKnownTable(tableName)) return errorResponse(404, "unknown_table");
    if (INTERNAL_TABLES.has(tableName)) return errorResponse(403, "forbidden_table");

    const requestedCompany = nonEmptyString(url.searchParams.get("companyId"));
    if (requestedCompany && requestedCompany !== companyId) {
      return errorResponse(403, "company_mismatch");
    }
    const limit = queryInt(url, "limit", HUB_MAX_PAGE_LIMIT, 1, HUB_MAX_PAGE_LIMIT);
    const rows = await driver.query<LocalRow>({
      table: tableName,
      where: [{ field: "company_id", op: "eq", value: companyId }],
      orderBy: { field: "id", direction: "asc" },
      limit,
      // Se incluyen las lápidas para que un cliente pueda reconciliar borrados.
      includeDeleted: true
    });
    return jsonResponse(200, { rows, latestSeq: await driver.latestSeq() });
  }

  async function handleHealth(): Promise<HubResponse> {
    const devices = await driver.query<LocalRow>({
      table: "hub_devices",
      where: [{ field: "company_id", op: "eq", value: companyId }]
    });
    const active = devices.filter((row) => !row.revoked_at && !row.deleted_at).length;
    return jsonResponse(200, {
      ok: true,
      protocol: HUB_PROTOCOL_VERSION,
      hubId,
      serverTime: serverTime(),
      devices: active
    });
  }

  /**
   * Cotizaciones para los equipos de la LAN. Sin proveedor (o si falla) el hub
   * no inventa tasas: responde 503 para que el cliente use su último respaldo.
   * La respuesta no incluye nada del dispositivo ni de la empresa.
   */
  async function handleRates(): Promise<HubResponse> {
    if (typeof ratesProvider !== "function") {
      return errorResponse(503, "rates_unavailable");
    }
    let quotes: unknown;
    try {
      quotes = await ratesProvider();
    } catch {
      return errorResponse(503, "rates_unavailable");
    }
    if (!Array.isArray(quotes)) return errorResponse(503, "rates_unavailable");
    const rates: HubRateQuote[] = [];
    for (const raw of quotes) {
      const quote = sanitizeRateQuote(raw);
      if (!quote) return errorResponse(503, "rates_unavailable");
      rates.push(quote);
    }
    const body: HubRatesResponse = { rates, serverTime: serverTime() };
    return jsonResponse(200, body);
  }

  async function dispatch(req: HubRequest): Promise<HubResponse> {
    try {
      const declaredLength = headerValue(req.headers, "content-length");
      if (declaredLength && Number(declaredLength) > HUB_MAX_BODY_BYTES) {
        return errorResponse(413, "body_too_large");
      }
      if (bodyBytes(req.bodyText ?? "") > HUB_MAX_BODY_BYTES) {
        return errorResponse(413, "body_too_large");
      }

      const url = new URL(req.path, "http://hub.local");
      const route = url.pathname.replace(/\/+$/, "") || "/";

      if (route === HUB_ROUTES.pair) {
        return req.method === "POST" ? await handlePair(req) : errorResponse(405, "method_not_allowed");
      }
      if (route === HUB_ROUTES.health) {
        return req.method === "GET" ? await handleHealth() : errorResponse(405, "method_not_allowed");
      }
      // Rutas locales del hub: login por PIN (sin token todavía) y administración
      // de equipos (solo loopback). Ninguna pasa por `authenticate`.
      if (route === HUB_ROUTES.login) {
        return req.method === "POST" ? await handleLogin(req) : errorResponse(405, "method_not_allowed");
      }
      if (route === HUB_ROUTES.devices) {
        return req.method === "GET" ? await handleDevices(req) : errorResponse(405, "method_not_allowed");
      }
      if (route === HUB_ROUTES.revoke) {
        return req.method === "POST" ? await handleRevoke(req) : errorResponse(405, "method_not_allowed");
      }

      const guarded =
        route === HUB_ROUTES.ops ||
        route === HUB_ROUTES.changes ||
        route === HUB_ROUTES.snapshot ||
        route === HUB_ROUTES.rates;
      if (!guarded) return errorResponse(404, "not_found");

      const auth = await authenticate(req);
      if (auth.rejection) return auth.rejection;

      if (route === HUB_ROUTES.ops) {
        return req.method === "POST"
          ? await handleOps(req, auth)
          : errorResponse(405, "method_not_allowed");
      }
      if (route === HUB_ROUTES.rates) {
        return req.method === "GET"
          ? await handleRates()
          : errorResponse(405, "method_not_allowed");
      }
      if (route === HUB_ROUTES.changes) {
        return req.method === "GET" ? await handleChanges(url) : errorResponse(405, "method_not_allowed");
      }
      return req.method === "GET" ? await handleSnapshot(url) : errorResponse(405, "method_not_allowed");
    } catch {
      // Nunca se filtra el error interno: códigos y nada más.
      return errorResponse(500, "internal_error");
    }
  }

  const handler = dispatch as HubHandler;
  handler.createPairingSession = createPairingSession;
  handler.currentPairingSession = currentPairingSession;
  return handler;
}
