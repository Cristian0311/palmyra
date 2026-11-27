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
  warehouse_required: 'El trabajador necesita al menos una sucursal asignada.'
};

const REDEEM_ERRORS: Record<string, string> = {
  invalid_token: 'El enlace no es válido o pertenece a otra empresa.',
  invite_used: 'Este enlace ya se usó. Pide al propietario que genere uno nuevo.',
  invite_expired: 'El enlace caducó. Pide al propietario que genere uno nuevo.',
  device_link_invalid: 'El enlace de acceso no es válido. Pide uno nuevo al propietario.',
  device_link_used: 'Este enlace ya se usó. Pide uno nuevo al propietario.',
  device_link_expired: 'El enlace de acceso caducó. Pide uno nuevo al propietario.',
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
  method_not_allowed: 'Método no permitido.'
};

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
 * Fecha legible de caducidad del enlace recién generado. `null` cuando no
 * caduca, para que la interfaz lo diga con palabras y no con una fecha lejana.
 */
export function describeAccessInviteExpiry(
  days: number | string | null | undefined,
  createdAt: number = Date.now()
): string {
  const expiry = resolveAccessInviteExpiry(days);
  if (expiry.perpetual) return 'Sin caducidad: el enlace no expira';
  const base = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now();
  const date = new Date(base + expiry.days * 86_400_000);
  return `Caduca el ${date.toLocaleDateString('es-CU')}`;
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

async function readRedeemFailure(error: unknown): Promise<{ code: string; message: string }> {
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
      if (REDEEM_ERRORS[code]) return { code, message: REDEEM_ERRORS[code] };
      serverMessage = String(payload?.message || '');
      if (code) return { code, message: serverMessage || 'No se pudo canjear el enlace de acceso.' };
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
