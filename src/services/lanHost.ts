export const LAN_HUB_URL_KEY = "palmyra:lan-hub-url";

function normalizeHubUrl(value: string | null | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function readLanHubUrl(): string {
  try {
    return normalizeHubUrl(localStorage.getItem(LAN_HUB_URL_KEY));
  } catch {
    return "";
  }
}

export function isPrivateLanHost(hostname: string): boolean {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export type LanPresenceContext = {
  hostname?: string;
  native?: boolean;
  hubUrl?: string | null;
};

/**
 * La presencia LAN solo tiene sentido en el servidor local del negocio o con
 * un hub configurado. El host de Render y el Android autónomo (que sirve su
 * propia app desde NanoHTTPD) no deben enviar latidos a `/api/lan/*`.
 */
export function canUseLanPresence(context: LanPresenceContext = {}): boolean {
  const hubUrl = context.hubUrl !== undefined ? normalizeHubUrl(context.hubUrl) : readLanHubUrl();
  if (hubUrl) return true;
  const hostname = context.hostname ?? (typeof window !== "undefined" ? window.location.hostname : "");
  const native = context.native ?? (typeof window !== "undefined" && Boolean(
    (window as Window & { PALMYRA_NATIVE?: unknown }).PALMYRA_NATIVE
  ));
  if (native) return false;
  return isPrivateLanHost(hostname);
}

export function lanHubUrl(): string {
  return readLanHubUrl();
}
