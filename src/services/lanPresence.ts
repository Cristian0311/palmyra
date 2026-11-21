import { getSupabase } from '../lib/supabase';

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

export function defaultDeviceName(): string {
  const kind = detectDeviceKind();
  const label = kind === 'desktop' ? 'Caja' : kind === 'mobile' ? 'Móvil' : kind === 'tablet' ? 'Tablet' : 'Equipo';
  return `${label} ${getDeviceId().replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase()}`;
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

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers || {}) },
    cache: 'no-store',
    signal: AbortSignal.timeout(6000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `La solicitud LAN falló (${response.status}).`);
  }
  return body as T;
}

export async function sendLanPresence(warehouseName?: string | null): Promise<void> {
  await api('/api/lan/presence', {
    method: 'POST',
    body: JSON.stringify({
      id: getDeviceId(),
      name: getDeviceName(),
      kind: detectDeviceKind(),
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
