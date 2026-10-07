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
