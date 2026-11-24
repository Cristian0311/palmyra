import { getSupabase } from '../lib/supabase';

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
  warehouse_required: 'El trabajador necesita al menos una sucursal activa asignada.'
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
  warehouse_unavailable: 'El trabajador no tiene sucursales activas asignadas.',
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

export function buildDeviceAccessLink(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/device-access?token=${encodeURIComponent(token)}`;
}

/** Esquema propio de la app instalada (PC/APK): palmyra://device-access?token=… */
export function buildDeviceAccessDeepLink(token: string): string {
  return `palmyra://device-access?token=${encodeURIComponent(token)}`;
}

export async function createDeviceAccessInvite(
  employeeId: string,
  expiresInDays = 7
): Promise<{ token: string; link: string }> {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  if (!employeeId) throw new Error('Selecciona un trabajador.');

  // expiresInDays <= 0: enlace sin caducidad (tiempo indefinido).
  const { data, error } = await supabase.rpc('create_device_access_invite', {
    p_employee_id: employeeId,
    p_expires_in_days: expiresInDays
  });
  if (error) throw new Error(mapInviteError(error.message));

  const token = String(data || '');
  if (!token) throw new Error('El servidor no devolvió un token de acceso.');
  return { token, link: buildDeviceAccessLink(token) };
}

async function readRedeemFailure(error: unknown): Promise<{ code: string; message: string }> {
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
