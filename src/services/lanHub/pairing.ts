/**
 * Emparejamiento de este equipo con el hub LAN del negocio.
 *
 * `POST /lan/v1/pair` es la ÚNICA ruta del protocolo v1 que no va firmada: en
 * ese momento el equipo todavía no tiene token de dispositivo, y la credencial
 * es el código de 8 dígitos de un solo uso. Firmar aquí con cualquier clave
 * inventada daría una falsa sensación de autenticación; el hub no la verifica.
 * En cuanto llega un acuse válido se guarda la sesión (token incluido) y desde
 * ahí todo lo demás (`changes`, `ops`, `events`) sí va firmado con HMAC.
 *
 * El token nunca se registra ni se devuelve a la interfaz: solo la sesión.
 */
import { getPalmyraLocalScope } from "../localScope";
import { getDesktopHubBridge } from "../../lib/desktopRuntime";
import { HUB_ROUTES } from "./protocol";
import { isValidPairingCode, isValidPin, normalizeFingerprint } from "./pairingQr";
import { saveHubSession, clearHubSession, type HubSession } from "./session";

export const HUB_DEVICE_ID_KEY = "palmyra-hub-device-id";
const DEFAULT_TIMEOUT_MS = 12_000;

export type HubPairingErrorCode =
  | "invalid_input"
  | "invalid_code"
  | "unreachable"
  | "company_mismatch"
  | "missing_company"
  | "hub_rejected"
  | "invalid_response";

/** Error de emparejamiento con mensaje listo para mostrar en español. */
export class HubPairingError extends Error {
  readonly code: HubPairingErrorCode;
  readonly status: number;

  constructor(code: HubPairingErrorCode, message: string, status = 0) {
    super(message);
    this.name = "HubPairingError";
    this.code = code;
    this.status = status;
  }
}

export interface JoinHubInput {
  /** Dirección del hub; admite `192.168.1.10:48900` sin esquema. */
  baseUrl: string;
  /** Código de 8 dígitos generado en el equipo principal. */
  code: string;
  deviceName: string;
  /** Solo para pruebas o para forzar una empresa concreta. */
  companyId?: string;
  platform?: string;
  /**
   * PIN opcional del equipo principal (4-8 dígitos). Solo se envía si es
   * válido: un PIN mal escrito no debe bloquear el emparejamiento normal.
   */
  pin?: string;
  /** Huella SHA-256 del certificado TLS del hub, si viene del QR. */
  tlsFingerprint?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function normalizeBaseUrl(raw: string): string {
  let value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new HubPairingError("invalid_input", "Escribe la dirección del hub (por ejemplo 192.168.1.10:48900).");
  }
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HubPairingError("invalid_input", "La dirección del hub no es válida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HubPairingError("invalid_input", "La dirección del hub debe usar http o https.");
  }
  if (url.username || url.password) {
    throw new HubPairingError("invalid_input", "La dirección del hub no debe incluir credenciales.");
  }
  if (url.search || url.hash) {
    throw new HubPairingError("invalid_input", "La dirección del hub no debe incluir query ni fragmento.");
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Pinta la huella del certificado en el puente de escritorio para que el hub
 * https se acepte solo con ese certificado. Es best-effort: en navegador/PWA
 * el puente no existe y el método puede faltar; no se falla por ello.
 */
async function pinHubCertificate(baseUrl: string, fingerprint: string): Promise<void> {
  if (!/^https:\/\//i.test(baseUrl)) return;
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized) return;
  try {
    const bridge = getDesktopHubBridge() as
      | (NonNullable<ReturnType<typeof getDesktopHubBridge>> & {
          pinCertificate?: (url: string, fp: string) => unknown;
        })
      | null;
    const pin = bridge?.pinCertificate;
    if (typeof pin !== "function") return;
    await pin.call(bridge, baseUrl, normalized);
  } catch {
    // Sin pinning previo la conexión sigue su curso normal.
  }
}

function randomId(): string {
  const api = (globalThis as { crypto?: Crypto }).crypto;
  if (api && typeof api.randomUUID === "function") return api.randomUUID();
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Identificador estable de este equipo para el hub. Vive en localStorage para
 * sobrevivir recargas; en un entorno sin almacenamiento se genera uno por
 * ejecución (el hub lo vuelve a registrar en cada emparejamiento).
 */
export function getOrCreateHubDeviceId(): string {
  try {
    if (typeof localStorage === "undefined") return randomId();
    const existing = localStorage.getItem(HUB_DEVICE_ID_KEY);
    if (existing && existing.trim()) return existing.trim();
    const created = randomId();
    localStorage.setItem(HUB_DEVICE_ID_KEY, created);
    return created;
  } catch {
    return randomId();
  }
}

function detectedPlatform(input: string | undefined): string {
  const explicit = typeof input === "string" ? input.trim() : "";
  if (explicit) return explicit.slice(0, 40);
  try {
    if (typeof navigator !== "undefined") {
      const ua = navigator.userAgent;
      if (/Android/i.test(ua)) return "android";
      if (/Windows/i.test(ua)) return "windows";
      if (/Mac/i.test(ua)) return "macos";
      if (/Linux/i.test(ua)) return "linux";
    }
  } catch {
    // Sin navigator: se usa el valor genérico.
  }
  return "web";
}

function errorCodeOf(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const code = (payload as { error?: unknown }).error;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return "";
}

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function messageForStatus(status: number, code: string): HubPairingError {
  if (status === 401 || code === "invalid_pairing_code") {
    return new HubPairingError(
      "invalid_code",
      "No se pudo vincular: código inválido o vencido. Genera uno nuevo en el equipo principal.",
      status
    );
  }
  if (status === 403 || code === "company_mismatch") {
    return new HubPairingError(
      "company_mismatch",
      "El hub pertenece a otra empresa; no puede vincular este equipo.",
      status
    );
  }
  if (status === 404) {
    return new HubPairingError(
      "hub_rejected",
      "El hub no expone el emparejamiento. Actualiza PALMYRA en el equipo principal.",
      status
    );
  }
  return new HubPairingError(
    "hub_rejected",
    `El hub rechazó el emparejamiento${code ? ` (${code})` : ""}. Inténtalo de nuevo.`,
    status
  );
}

/**
 * Pide un token al hub y guarda la sesión solo si el acuse es válido.
 * Devuelve la sesión ya persistida (sin exponer el token a la UI).
 */
export async function joinHub(input: JoinHubInput): Promise<{ session: HubSession }> {
  if (!input || typeof input !== "object") {
    throw new HubPairingError("invalid_input", "Faltan los datos para vincular este equipo.");
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const code = nonEmpty(input.code);
  if (!isValidPairingCode(code)) {
    throw new HubPairingError(
      "invalid_code",
      "No se pudo vincular: código inválido o vencido. El código tiene 8 dígitos."
    );
  }

  const companyId = nonEmpty(input.companyId) || nonEmpty(getPalmyraLocalScope()?.companyId);
  if (!companyId) {
    throw new HubPairingError(
      "missing_company",
      "Inicia sesión en tu empresa antes de vincular este equipo al hub."
    );
  }

  const deviceId = getOrCreateHubDeviceId();
  const deviceName = nonEmpty(input.deviceName) || "Equipo PALMYRA";
  const platform = detectedPlatform(input.platform);
  const pin = nonEmpty(input.pin);
  const body: Record<string, string> = {
    pairingCode: code,
    deviceId,
    deviceName,
    platform,
    companyId
  };
  // El PIN del equipo es opcional: solo viaja si tiene forma válida.
  if (isValidPin(pin)) body.pin = pin;
  const bodyText = JSON.stringify(body);

  // Con TLS y huella en el QR se fija el certificado antes del POST; si el
  // puente no expone el método, el emparejamiento continúa igual.
  if (typeof input.tlsFingerprint === "string" && input.tlsFingerprint.trim()) {
    await pinHubCertificate(baseUrl, input.tlsFingerprint);
  }

  const doFetch =
    input.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          // El fetch ya terminó; el aborto sobra.
        }
        reject(new HubPairingError("unreachable", "No se pudo contactar con el hub: hub inalcanzable."));
      }, timeoutMs);
    });
    response = await Promise.race([
      doFetch(`${baseUrl}${HUB_ROUTES.pair}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: bodyText,
        signal: controller?.signal,
        cache: "no-store"
      }),
      timeout
    ]);
  } catch (error) {
    if (error instanceof HubPairingError) throw error;
    throw new HubPairingError(
      "unreachable",
      "No se pudo contactar con el hub: hub inalcanzable. Revisa que ambos equipos estén en la misma red Wi-Fi."
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const text = await response.text().catch(() => "");
  let payload: unknown = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw messageForStatus(response.status, errorCodeOf(payload));
  }

  const ack = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
  const token = ack ? nonEmpty(ack.deviceToken) : "";
  const hubId = ack ? nonEmpty(ack.hubId) : "";
  const ackDeviceId = ack ? nonEmpty(ack.deviceId) : "";
  const ackCompany = ack ? nonEmpty(ack.companyId) : "";
  if (!token || !hubId || !ackDeviceId) {
    throw new HubPairingError(
      "invalid_response",
      "El hub respondió sin un acuse válido; este equipo no quedó vinculado.",
      response.status
    );
  }
  if (ackCompany && ackCompany !== companyId) {
    throw new HubPairingError(
      "company_mismatch",
      "El hub pertenece a otra empresa; no puede vincular este equipo.",
      response.status
    );
  }

  const clock = input.now ?? (() => Date.now());
  let joinedAt: string;
  try {
    joinedAt = new Date(clock()).toISOString();
  } catch {
    joinedAt = new Date().toISOString();
  }

  const saved = await saveHubSession({
    hubId,
    deviceId: ackDeviceId,
    token,
    baseUrl,
    joinedAt,
    cursor: 0
  });
  if (!saved) {
    throw new HubPairingError(
      "invalid_response",
      "No se pudo guardar la sesión del hub en este equipo."
    );
  }
  return { session: saved };
}

/** Desvincula este equipo: olvida token y cursor. */
export async function leaveHub(): Promise<void> {
  await clearHubSession();
}
