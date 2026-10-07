const STORAGE_PREFIX = 'palmyra:offline-pos-credential:v1:';

function key(companyId: string, userId: string): string {
  return STORAGE_PREFIX + encodeURIComponent(companyId) + ':' + encodeURIComponent(userId);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function digest(value: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Este navegador no dispone de criptografía segura para validar el acceso offline.');
  }
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(hash));
}

export async function rememberOfflinePosCredential(
  companyId: string,
  userId: string,
  password: string
): Promise<void> {
  const cleanCompanyId = String(companyId || '').trim();
  const cleanUserId = String(userId || '').trim();
  const cleanPassword = String(password || '');
  if (!cleanCompanyId || !cleanUserId || !cleanPassword) return;

  const salt = crypto.randomUUID();
  const verifier = await digest(cleanUserId + ':' + salt + ':' + cleanPassword);
  localStorage.setItem(key(cleanCompanyId, cleanUserId), JSON.stringify({ salt, verifier }));
}

export async function verifyOfflinePosCredential(
  companyId: string,
  userId: string,
  password: string
): Promise<boolean> {
  const cleanCompanyId = String(companyId || '').trim();
  const cleanUserId = String(userId || '').trim();
  const cleanPassword = String(password || '');
  if (!cleanCompanyId || !cleanUserId || !cleanPassword) return false;

  try {
    const raw = localStorage.getItem(key(cleanCompanyId, cleanUserId));
    if (!raw) return false;
    const stored = JSON.parse(raw);
    if (!stored?.salt || !stored?.verifier) return false;
    const verifier = await digest(cleanUserId + ':' + stored.salt + ':' + cleanPassword);
    return verifier === stored.verifier;
  } catch {
    return false;
  }
}

export function forgetOfflinePosCredential(companyId: string, userId: string): void {
  try { localStorage.removeItem(key(String(companyId || ''), String(userId || ''))); } catch {}
}


const OFFLINE_RESUME_GRANT_PREFIX = 'palmyra:offline-pos-resume-grant:v1:';

function resumeGrantKey(companyId: string, userId: string, sessionId: string): string {
  return OFFLINE_RESUME_GRANT_PREFIX +
    encodeURIComponent(String(companyId || '').trim()) + ':' +
    encodeURIComponent(String(userId || '').trim()) + ':' +
    encodeURIComponent(String(sessionId || '').trim());
}

/**
 * Marca localmente que una cuenta ya autorizada vio/recibió un turno abierto
 * mientras tenía conexión. No guarda contraseñas ni secretos: solo permite
 * reanudar ese turno concreto en el mismo dispositivo hasta que expire el
 * permiso local.
 */
export function rememberOfflinePosResumeGrant(
  companyId: string,
  userId: string,
  sessionId: string,
  ttlMs = 7 * 24 * 60 * 60 * 1000
): void {
  const cleanCompanyId = String(companyId || '').trim();
  const cleanUserId = String(userId || '').trim();
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanCompanyId || !cleanUserId || !cleanSessionId) return;
  try {
    localStorage.setItem(
      resumeGrantKey(cleanCompanyId, cleanUserId, cleanSessionId),
      JSON.stringify({ createdAt: Date.now(), expiresAt: Date.now() + Math.max(1, ttlMs) })
    );
  } catch {}
}

export function verifyOfflinePosResumeGrant(
  companyId: string,
  userId: string,
  sessionId: string
): boolean {
  const cleanCompanyId = String(companyId || '').trim();
  const cleanUserId = String(userId || '').trim();
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanCompanyId || !cleanUserId || !cleanSessionId) return false;
  try {
    const raw = localStorage.getItem(resumeGrantKey(cleanCompanyId, cleanUserId, cleanSessionId));
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!Number.isFinite(Number(parsed?.expiresAt)) || Number(parsed.expiresAt) <= Date.now()) {
      localStorage.removeItem(resumeGrantKey(cleanCompanyId, cleanUserId, cleanSessionId));
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function forgetOfflinePosResumeGrant(
  companyId: string,
  userId: string,
  sessionId: string
): void {
  try {
    localStorage.removeItem(resumeGrantKey(String(companyId || ''), String(userId || ''), String(sessionId || '')));
  } catch {}
}
