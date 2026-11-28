import { getSupabase } from '../lib/supabase';
import { PALMYRA_REMOTE_ORIGIN } from '../lib/install';

export interface DeviceAccessCredentials {
  email: string;
  password: string;
}

/** Error de canje con el código de negocio que devolvió la edge function. */
export class DeviceAccessError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DeviceAccessError';
    this.code = code;
  }
}

const INVITE_ERRORS: Record<string, string> = {
  authentication_required: 'Debes iniciar sesión como propietario para generar el enlace.',
  permission_denied: 'No tienes permiso para generar enlaces de acceso de trabajadores.',
  employee_not_found: 'El trabajador no existe en tu empresa.',
  employee_inactive: 'El trabajador está inactivo. Actívalo antes de generar el enlace.',
  employee_role_required: 'Asigna un rol al trabajador antes de generar el enlace.',
  warehouse_required: 'El trabajador necesita al menos una sucursal asignada.',
  device_link_exists: 'Este trabajador ya tiene un enlace de acceso activo. Revoquelo para eliminarlo y genera entonces uno nuevo.'
};

const REDEEM_ERRORS: Record<string, string> = {
  invalid_token: 'El enlace no es válido o pertenece a otra empresa.',
  invite_used: 'Este enlace ya se usó. Pide al propietario que genere uno nuevo.',
  invite_expired: 'El enlace caducó. Pide al propietario que genere uno nuevo.',
  device_link_invalid: 'El enlace de acceso caducó o el propietario lo eliminó. Pide uno nuevo.',
  device_link_used: 'Este enlace ya se usó. Pide uno nuevo al propietario.',
  device_link_expired: 'Tu enlace de acceso caducó. Pide uno nuevo al propietario.',
  pos_password_required: 'Escribe la contraseña POS configurada por el administrador.',
  pos_password_invalid: 'La contraseña POS no es correcta. Vuelve a intentarlo.',
  employee_not_found: 'El trabajador ya no está activo en la empresa.',
  employee_inactive: 'El trabajador ya no está activo en la empresa.',
  company_inactive: 'La cuenta de la empresa no está activa.',
  warehouse_unavailable: 'El trabajador no tiene sucursales asignadas.',
  role_unavailable: 'El rol del trabajador ya no está disponible.',
  server_not_configured: 'El servicio de acceso no está configurado en el servidor.',
  identity_provision_failed: 'No se pudo preparar la identidad del trabajador. Intenta con un enlace nuevo.',
  profile_write_failed: 'No se pudo guardar el perfil del trabajador.',
  membership_write_failed: 'No se pudo vincular al trabajador con la empresa.',
  role_write_failed: 'No se pudo asignar el rol del trabajador.',
  location_write_failed: 'No se pudieron asignar las sucursales del trabajador.',
  employee_write_failed: 'No se pudo vincular el empleado con este dispositivo.',
  claim_failed: 'No se pudo cerrar el enlace. Intenta de nuevo.',
  too_many_attempts: 'Demasiados intentos. Espera un minuto y vuelve a intentarlo.',
  invalid_request: 'El enlace no contiene los datos necesarios.',
  unsupported_action: 'Solicitud de acceso no soportada.',
  method_not_allowed: 'Método no permitido.',
  lookup_failed: 'El servidor no pudo leer los datos del trabajador. Genera un enlace nuevo.',
  internal_error: 'No se pudo completar la activación. Inténtalo de nuevo en unos segundos.'
};

/**
 * Causa concreta que la edge function publica en `detail`. Son códigos de negocio
 * de los triggers de la base (lista blanca en el servidor, nunca SQL ni datos de
 * otras empresas). Sin ellos el activador decía solo «No se pudo guardar el perfil
 * del trabajador» y no se distinguía un límite de plan de una regla rota.
 */
const REDEEM_DETAILS: Record<string, string> = {
  invalid_active_company: 'La cuenta aún no quedó vinculada a la empresa.',
  membership_not_active: 'El vínculo del trabajador con la empresa no está activo.',
  role_not_found: 'El rol asignado al trabajador ya no existe. Asigna otro rol y genera un enlace nuevo.',
  role_company_mismatch: 'El rol del enlace pertenece a otra empresa.',
  warehouse_company_mismatch: 'Alguna sucursal del enlace no pertenece a esta empresa.',
  cross_company_reference: 'Los datos del trabajador cruzan dos empresas. Genera un enlace nuevo.',
  plan_employees_limit: 'La empresa llegó al límite de trabajadores de su plan: sube de plan para activar este equipo.',
  plan_warehouses_limit: 'La empresa llegó al límite de sucursales de su plan.',
  company_id_immutable: 'La empresa de esta cuenta no se puede cambiar.',
  company_required: 'La cuenta no tiene una empresa asignada.',
  company_not_found: 'La empresa del enlace ya no existe.'
};

/** `detail` -> frase en español. Un valor fuera de la lista blanca se ignora. */
function describeDetail(value: unknown): string {
  return REDEEM_DETAILS[String(value || '')] || '';
}

function mapInviteError(message: string): string {
  const code = String(message || '').trim();
  return INVITE_ERRORS[code] || `No se pudo generar el enlace de acceso (${code || 'error_desconocido'}).`;
}

/**
 * Origen que puede abrir OTRO equipo. En PC/APK la interfaz se sirve desde
 * 127.0.0.1:<puerto> (o desde una IP de LAN con el hub), así que `window.location.origin`
 * solo es válido dentro de esta máquina: quien reciba el enlace vería
 * «127.0.0.1 rechazó la conexión». Se usa el origen público de PALMYRA y solo se
 * conserva el origen actual cuando es un host público real.
 */
function shareableOrigin(): string {
  if (typeof window === 'undefined') return PALMYRA_REMOTE_ORIGIN;
  const raw = window.location.origin || '';
  if (!raw || raw === 'null') return PALMYRA_REMOTE_ORIGIN;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return PALMYRA_REMOTE_ORIGIN;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return PALMYRA_REMOTE_ORIGIN;
    if (host === 'localhost' || host.endsWith('.localhost')) return PALMYRA_REMOTE_ORIGIN;
    if (host === '0.0.0.0' || host === '::' || /^127\./.test(host)) return PALMYRA_REMOTE_ORIGIN;
    // Direcciones privadas (10/8, 172.16/12, 192.168/16) y nombres sin dominio.
    if (/^(10\.|192\.168\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return PALMYRA_REMOTE_ORIGIN;
    if (!host.includes('.')) return PALMYRA_REMOTE_ORIGIN;
    return raw.replace(/\/+$/, '');
  } catch {
    return PALMYRA_REMOTE_ORIGIN;
  }
}

export function buildDeviceAccessLink(token: string): string {
  return `${shareableOrigin()}/device-access?token=${encodeURIComponent(token)}`;
}

/** Esquema propio de la app instalada (PC/APK): palmyra://device-access?token=… */
export function buildDeviceAccessDeepLink(token: string): string {
  return `palmyra://device-access?token=${encodeURIComponent(token)}`;
}

/** Caducidad por defecto del enlace de acceso (la que asume la RPC). */
export const ACCESS_INVITE_DEFAULT_DAYS = 7;
/** Tope que aplica `create_device_access_invite` en el servidor. */
export const ACCESS_INVITE_MAX_DAYS = 90;
/** Opciones del selector, en el mismo orden que el modal de Equipo. */
export const ACCESS_INVITE_DAY_OPTIONS = [1, 7, 30, 90, 0] as const;

export interface AccessInviteExpiry {
  /** Días que se envían a la RPC. 0 = sin caducidad (expires_at = infinity). */
  days: number;
  /** true cuando el enlace no caduca nunca. */
  perpetual: boolean;
  /** «Sin caducidad» · «Válido 1 día» · «Válido 7 días». */
  label: string;
  /** Leyenda de la nota del modal, con el aviso de un solo uso. */
  note: string;
}

/**
 * Normaliza la caducidad elegida y produce la etiqueta que usan TODOS los
 * caminos del enlace de acceso (selector del editor, nota y diálogo del menú de
 * la fila). Sin este punto único el menú de la fila generaba siempre 7 días y
 * el diálogo rotulaba «Válido 7 días» aunque la invitación fuera indefinida.
 */
export function resolveAccessInviteExpiry(value: number | string | null | undefined): AccessInviteExpiry {
  const raw = typeof value === 'string' ? value.trim() : value;
  // Un valor ausente o vacío no es «sin caducidad»: cae al valor por defecto.
  const parsed = raw === '' || raw === null || raw === undefined ? Number.NaN : Number(raw);
  const finite = Number.isFinite(parsed) ? parsed : ACCESS_INVITE_DEFAULT_DAYS;
  const days = finite <= 0 ? 0 : Math.min(ACCESS_INVITE_MAX_DAYS, Math.max(1, Math.round(finite)));
  const perpetual = days === 0;
  const label = perpetual ? 'Sin caducidad' : `Válido ${days} ${days === 1 ? 'día' : 'días'}`;
  return {
    days,
    perpetual,
    label,
    note: `${label} · un solo uso · personal e intransferible`
  };
}

/**
 * Fecha legible de caducidad del enlace recién generado. **Estimación local**:
 * suma `createdAt + days` sin preguntar al servidor, así que solo se usa cuando
 * no hay red. Con conexión la etiqueta sale de `describeAccessLink`, que lee el
 * `expires_at` real de la fila.
 */
export function describeAccessInviteExpiry(
  days: number | string | null | undefined,
  createdAt: number = Date.now()
): string {
  const expiry = resolveAccessInviteExpiry(days);
  if (expiry.perpetual) return 'Sin caducidad: el enlace no expira';
  const base = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now();
  const date = new Date(base + expiry.days * 86_400_000);
  return `Caduca el ${date.toLocaleDateString('es-CU')} (estimado, sin conectar)`;
}

/** Enlaces vivos por trabajador que admite el servidor: uno solo. */
export const ACCESS_INVITE_MAX_PENDING_LINKS = 1;

/**
 * Enlace de acceso como lo devuelve `list_device_access_links`. Nunca incluye el
 * token ni su hash: el secreto solo se muestra una vez, en el momento de crearlo.
 */
export interface DeviceAccessLink {
  id: string;
  createdAt: number;
  /** `null` = sin caducidad (la fila tiene `expires_at = infinity`). */
  expiresAt: number | null;
  usedAt: number | null;
  usedByDevice: string;
}

export type AccessLinkStatus = 'used' | 'expired' | 'active';

function toTimestamp(value: unknown): number | null {
  // PostgREST serializa `infinity` como la cadena 'infinity': `new Date()` de eso
  // sale Invalid Date, y tratarlo como fecha produciría el año 292278994.
  if (typeof value === 'string' && /^[-+]?infinity$/i.test(value.trim())) return null;
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeLinkRow(row: any): DeviceAccessLink | null {
  const id = String(row?.id || '');
  if (!id) return null;
  return {
    id,
    createdAt: toTimestamp(row?.created_at) ?? Date.now(),
    expiresAt: toTimestamp(row?.expires_at),
    usedAt: toTimestamp(row?.used_at),
    usedByDevice: String(row?.used_by_device || '')
  };
}

/** Estado real del enlace: usado primero, luego caducado, luego vivo. */
export function accessLinkStatus(link: DeviceAccessLink, now: number = Date.now()): AccessLinkStatus {
  if (link.usedAt) return 'used';
  if (link.expiresAt !== null && link.expiresAt <= now) return 'expired';
  return 'active';
}

function formatMoment(value: number): string {
  return new Date(value).toLocaleString('es-CU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

/** Chip del enlace: «Sin caducidad» · «Caduca 05 dic 2026 16:48» · «Usado …». */
export function describeAccessLink(link: DeviceAccessLink, now: number = Date.now()): string {
  const status = accessLinkStatus(link, now);
  if (status === 'used') return `Usado el ${formatMoment(link.usedAt as number)}`;
  if (link.expiresAt === null) return 'Sin caducidad';
  return status === 'expired'
    ? `Expirado el ${formatMoment(link.expiresAt)}`
    : `Caduca ${formatMoment(link.expiresAt)}`;
}

/**
 * Enlaces vivos de un trabajador, leídos del servidor. La tabla está cerrada por
 * RLS, así que el único camino es la RPC `SECURITY DEFINER`; devuelve `[]` cuando
 * el trabajador aún no tiene enlaces.
 */
export async function listDeviceAccessLinks(employeeId: string): Promise<DeviceAccessLink[]> {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  if (!employeeId) throw new Error('Selecciona un trabajador.');
  const { data, error } = await supabase.rpc('list_device_access_links', {
    p_employee_id: employeeId
  });
  if (error) throw new Error(mapInviteError(error.message));
  const rows = Array.isArray(data) ? data : Array.isArray((data as { links?: unknown[] } | null)?.links)
    ? (data as { links: unknown[] }).links
    : [];
  return rows.map(normalizeLinkRow).filter((link): link is DeviceAccessLink => Boolean(link));
}

/**
 * Elimina enlaces pendientes de un trabajador (revocar = eliminar). La RPC también
 * purga los caducados nunca usados, así que tras esta llamada la lista queda limpia.
 */
export async function revokeDeviceAccessLinks(employeeId: string, ids: string[]): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  if (!employeeId) throw new Error('Selecciona un trabajador.');
  const linkIds = ids.map(id => String(id || '').trim()).filter(Boolean);
  if (!linkIds.length) return true;
  const { data, error } = await supabase.rpc('revoke_device_access_links', {
    p_employee_id: employeeId,
    p_ids: linkIds
  });
  if (error) throw new Error(mapInviteError(error.message));
  return data !== null && data !== undefined;
}

export async function createDeviceAccessInvite(
  employeeId: string,
  expiresInDays: number = ACCESS_INVITE_DEFAULT_DAYS
): Promise<{ token: string; link: string; days: number }> {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  if (!employeeId) throw new Error('Selecciona un trabajador.');

  // expiresInDays <= 0: enlace sin caducidad (tiempo indefinido).
  const expiry = resolveAccessInviteExpiry(expiresInDays);
  const { data, error } = await supabase.rpc('create_device_access_invite', {
    p_employee_id: employeeId,
    p_expires_in_days: expiry.days
  });
  if (error) throw new Error(mapInviteError(error.message));

  const token = String(data || '');
  if (!token) throw new Error('El servidor no devolvió un token de acceso.');
  return { token, link: buildDeviceAccessLink(token), days: expiry.days };
}

/** Traduce la respuesta non-2xx de la edge function a código de negocio + causa. */
export async function readRedeemFailure(error: unknown): Promise<{ code: string; message: string }> {
  // supabase-js solo lanza FunctionsFetchError cuando la petición no llegó al
  // servidor (red caída o preflight CORS rechazado): no es un fallo del enlace
  // y el intento no se gastó. Se nombra como causa de red, no como error raro.
  if ((error as { name?: string } | null)?.name === "FunctionsFetchError") {
    return {
      code: "network_error",
      message: "No se pudo contactar con el servicio de acceso. Revisa la conexión e inténtalo de nuevo."
    };
  }
  const response = (error as { context?: Response } | null)?.context;
  let serverMessage = '';
  if (response && typeof response.json === 'function') {
    try {
      const payload = await response.json();
      const code = String(payload?.error || '');
      const detail = describeDetail(payload?.detail);
      if (REDEEM_ERRORS[code]) return { code, message: `${REDEEM_ERRORS[code]} ${detail}`.trim() };
      serverMessage = String(payload?.message || '');
      if (code) return { code, message: serverMessage || detail || 'No se pudo canjear el enlace de acceso.' };
    } catch {
      // Cuerpo no JSON: caemos al mensaje genérico.
    }
  }
  if (serverMessage) return { code: '', message: serverMessage };
  const raw = String((error as { message?: string } | null)?.message || '');
  return { code: '', message: raw || 'No se pudo canjear el enlace de acceso.' };
}

export async function redeemDeviceAccessInvite(
  token: string,
  password: string,
  deviceName: string
): Promise<DeviceAccessCredentials> {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  if (!token.trim()) throw new Error('El enlace no contiene un token válido.');
  if (!password.trim()) throw new Error('Escribe la contraseña POS configurada por el administrador.');

  const { data, error } = await supabase.functions.invoke('device-access', {
    body: {
      action: 'redeem',
      token: token.trim(),
      password: password.trim(),
      deviceName: deviceName.trim().slice(0, 120)
    }
  });
  if (error) {
    const failure = await readRedeemFailure(error);
    throw new DeviceAccessError(failure.code, failure.message);
  }

  const email = String((data as { email?: string } | null)?.email || '');
  const generatedPassword = String((data as { password?: string } | null)?.password || '');
  if (!email || !generatedPassword) throw new Error('El servicio no devolvió credenciales para este dispositivo.');
  return { email, password: generatedPassword };
}
