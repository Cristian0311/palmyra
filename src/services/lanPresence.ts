import { getSupabase } from '../lib/supabase';
import { fetchWithRetry } from '../lib/http';
import { canUseLanPresence, lanHubUrl } from './lanHost';

const DEVICE_ID_KEY = 'palmyra:device-id';
const DEVICE_NAME_KEY = 'palmyra:device-name';

export type LanDeviceKind = 'desktop' | 'mobile' | 'tablet' | 'browser';

export type LanDevice = {
  id: string;
  name: string;
  ip: string;
  kind: LanDeviceKind;
  lastSeen: string;
  firstSeen: string;
  online: boolean;
  warehouseName?: string | null;
  platform?: string | null;
  model?: string | null;
  nameSource?: 'auto' | 'manual';
};

export type LanStatus = {
  enabled: boolean;
  desired: boolean;
  desktop: boolean;
  host: string;
  port: number;
  addresses: string[];
  url: string | null;
  requiresRestart: boolean;
};

export type LanSnapshot = { devices: LanDevice[]; status: LanStatus; serverNow: string };

export function getDeviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_ID_KEY);
    if (saved) return saved;
    const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return `temp-${Math.random()}`;
  }
}

export function detectDeviceKind(): LanDeviceKind {
  if (typeof navigator === 'undefined') return 'desktop';
  if (/Electron\//i.test(navigator.userAgent)) return 'desktop';
  const mobile = /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
  if (mobile) return 'mobile';
  if (/iPad|Tablet/i.test(navigator.userAgent)) return 'tablet';
  return 'browser';
}

function devicePlatform(): string {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  if (/Windows Phone/i.test(ua)) return 'Windows Phone';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return '';
}

/** Modelo real del equipo cuando el navegador lo expone (Android suele incluirlo en el UA). */
function deviceModel(): string {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  const android = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build[/:][^);]*)?[;)]/i);
  const model = android?.[1]?.replace(/\s*(Build|wv).*$/i, '').trim();
  if (model && !/^(K|Android|Linux|Mobile|Tablet)/i.test(model)) return model;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  return '';
}

/** Descripción corta y legible: "SM-A536B" (móvil Android), "iPhone", "PC Windows". */
export function describeThisDevice(): string {
  const model = deviceModel();
  const platform = devicePlatform();
  if (model) return model;
  if (platform) return `PC ${platform}`;
  return detectDeviceKind() === 'desktop' ? 'PC' : 'Equipo';
}

export function defaultDeviceName(): string {
  const described = describeThisDevice();
  if (described === 'Equipo' || described === 'PC') {
    const label = detectDeviceKind() === 'tablet' ? 'Tablet' : detectDeviceKind() === 'mobile' ? 'Móvil' : 'Caja';
    return `${label} ${getDeviceId().replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase()}`;
  }
  return described;
}

export function getDeviceName(): string {
  try {
    const saved = localStorage.getItem(DEVICE_NAME_KEY);
    if (saved && saved.trim()) return saved.trim();
  } catch { /* sin almacenamiento */ }
  return defaultDeviceName();
}

export function setDeviceName(name: string): void {
  try { localStorage.setItem(DEVICE_NAME_KEY, name.trim()); } catch { /* sin almacenamiento */ }
}

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = (await getSupabase()?.auth.getSession()) || { data: { session: null } };
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function lanEndpoint(path: string): string {
  const hub = lanHubUrl();
  return hub ? `${hub}${path}` : path;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!canUseLanPresence()) {
    throw new Error('La red local no está disponible en este equipo.');
  }
  // Los endpoints LAN son idempotentes (heartbeat/rename/delete), así que un
  // reintento es seguro si el equipo servidor está ocupado o despertando.
  const response = await fetchWithRetry(lanEndpoint(path), {
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers || {}) },
    cache: 'no-store'
  }, { timeoutMs: 6_000, retries: 1 });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `No se pudo completar la operación en la red local (${response.status}).`);
  }
  return body as T;
}

export async function sendLanPresence(warehouseName?: string | null): Promise<void> {
  if (!canUseLanPresence()) return;
  await api('/api/lan/presence', {
    method: 'POST',
    body: JSON.stringify({
      id: getDeviceId(),
      name: getDeviceName(),
      kind: detectDeviceKind(),
      platform: devicePlatform(),
      model: deviceModel(),
      warehouseName: warehouseName || null
    })
  });
}

export async function fetchLanSnapshot(): Promise<LanSnapshot> {
  return api<LanSnapshot>('/api/lan/devices', { headers: await authHeaders() });
}

export async function renameLanDevice(id: string, name: string): Promise<LanSnapshot> {
  return api<LanSnapshot>(`/api/lan/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
    headers: await authHeaders()
  });
}

export async function forgetLanDevice(id: string): Promise<LanSnapshot> {
  return api<LanSnapshot>(`/api/lan/devices/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders()
  });
}

export async function updateLanAccess(enabled: boolean): Promise<LanStatus> {
  const result = await api<{ status: LanStatus }>('/api/lan/settings', {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
    headers: await authHeaders()
  });
  return result.status;
}
