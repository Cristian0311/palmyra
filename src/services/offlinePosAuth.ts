import { getSupabase } from "../lib/supabase";

const STORAGE_PREFIX = "palmyra:offline-pos-credential:v2:";
const LEGACY_STORAGE_PREFIX = "palmyra:offline-pos-credential:v1:";
const PBKDF2_ITERATIONS = 310_000;
// Offline PIN verifiers are durable device credentials. App updates and routine
// server snapshots must never expire/delete them; only an explicit password
// overwrite or an authorized account revocation flow may replace/remove one.
const SYNC_RETRY_WINDOW_MS = 30_000;
const lastSyncAttempt = new Map<string, number>();

type OfflinePosCredential = {
  version: 2;
  salt: string;
  verifier: string;
  iterations: number;
  savedAt: number;
};

type RemoteOfflinePosVerifier = {
  subject_id?: string;
  salt?: string;
  verifier?: string;
  iterations?: number;
  updated_at?: string;
};

function key(companyId: string, userId: string): string {
  return STORAGE_PREFIX + encodeURIComponent(companyId) + ":" + encodeURIComponent(userId);
}

function legacyKey(companyId: string, userId: string): string {
  return LEGACY_STORAGE_PREFIX + encodeURIComponent(companyId) + ":" + encodeURIComponent(userId);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error("Verificador offline inválido.");
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i += 1) result[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}

function makeSalt(): string {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return bytesToHex(salt);
}

async function deriveVerifier(companyId: string, userId: string, password: string, saltHex: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("Este navegador no dispone de criptografía segura para validar el POS offline.");
  }
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const domain = new TextEncoder().encode("PALMYRA:offline-pos:v2:" + companyId + ":" + userId);
  const salt = new Uint8Array([...fromHex(saltHex), ...domain]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2", salt, iterations, hash: "SHA-256"
  }, material, 256);
  return bytesToHex(new Uint8Array(bits));
}

async function legacyDigest(value: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) throw new Error("Criptografía no disponible.");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(hash));
}

function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function isFresh(savedAt: number): boolean {
  // Do not expire valid offline credentials based on age.
  return Number.isFinite(savedAt) && savedAt > 0;
}

async function createCredential(companyId: string, userId: string, password: string, savedAt = Date.now()): Promise<OfflinePosCredential> {
  const salt = makeSalt();
  const verifier = await deriveVerifier(companyId, userId, password, salt);
  return { version: 2, salt, verifier, iterations: PBKDF2_ITERATIONS, savedAt };
}

async function pushVerifierToServer(companyId: string, userId: string, password: string, credential: OfflinePosCredential): Promise<void> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.rpc("palmyra_store_offline_pos_verifier", {
      p_company_id: companyId,
      p_subject_id: userId,
      p_password: password,
      p_salt: credential.salt,
      p_verifier: credential.verifier,
      p_iterations: credential.iterations
    });
    if (error) {
      // Non-manager employees cannot publish a verifier for the whole team. A
      // successful local verifier still permits this device to work offline.
      console.info("[PALMYRA] El verificador POS quedó solo en este dispositivo.", error.message);
    }
  } catch (error) {
    console.info("[PALMYRA] No se pudo sincronizar el verificador POS; se conserva localmente.", error);
  }
}

/**
 * Stores only a PBKDF2 verifier, never the employee's password. When the server
 * confirms a credential online, its verifier can be synchronized to the
 * company's authorized offline cache so other authorized company devices can
 * prepare for offline work.
 */
export async function rememberOfflinePosCredential(companyId: string, userId: string, password: string): Promise<void> {
  const cleanCompanyId = String(companyId || "").trim();
  const cleanUserId = String(userId || "").trim();
  const cleanPassword = String(password || "");
  if (!cleanCompanyId || !cleanUserId || !cleanPassword || typeof localStorage === "undefined") return;

  const credential = await createCredential(cleanCompanyId, cleanUserId, cleanPassword);
  localStorage.setItem(key(cleanCompanyId, cleanUserId), JSON.stringify(credential));
  try { localStorage.removeItem(legacyKey(cleanCompanyId, cleanUserId)); } catch {}
  await pushVerifierToServer(cleanCompanyId, cleanUserId, cleanPassword, credential);
}

/** Pull the safe, client-verifiable employee POS records provisioned for a company. */
async function syncOfflinePosCredentialsOnce(companyId: string): Promise<{ synced: number; skipped: number }> {
  const cleanCompanyId = String(companyId || "").trim();
  if (!cleanCompanyId || typeof localStorage === "undefined" ||
      (typeof navigator !== "undefined" && !navigator.onLine)) return { synced: 0, skipped: 0 };
  const lastAttempt = lastSyncAttempt.get(cleanCompanyId) || 0;
  if (Date.now() - lastAttempt < SYNC_RETRY_WINDOW_MS) return { synced: 0, skipped: 0 };
  const syncStartedAt = Date.now();
  lastSyncAttempt.set(cleanCompanyId, syncStartedAt);
  const supabase = getSupabase();
  if (!supabase) { lastSyncAttempt.delete(cleanCompanyId); return { synced: 0, skipped: 0 }; }

  const { data, error } = await supabase.rpc("palmyra_get_offline_pos_verifiers", {
    p_company_id: cleanCompanyId
  });
  if (error) {
    lastSyncAttempt.delete(cleanCompanyId);
    console.info("[PALMYRA] No fue posible descargar los verificadores POS para trabajo offline.", error.message);
    return { synced: 0, skipped: 0 };
  }

  let synced = 0;
  let skipped = 0;
  const allowedSubjects = new Set<string>();
  const records = Array.isArray(data) ? data as RemoteOfflinePosVerifier[] : [];
  for (const row of records) {
    const subjectId = String(row?.subject_id || "").trim();
    const salt = String(row?.salt || "");
    const verifier = String(row?.verifier || "");
    const iterations = Number(row?.iterations) || PBKDF2_ITERATIONS;
    const timestamp = row?.updated_at ? new Date(row.updated_at).getTime() : 0;
    if (!subjectId || !/^(?:[0-9a-f]{2}){16}$/i.test(salt) ||
        !/^(?:[0-9a-f]{2}){32}$/i.test(verifier) ||
        iterations < 100_000 || iterations > 1_000_000 || !isFresh(timestamp)) {
      skipped += 1;
      continue;
    }
    const record: OfflinePosCredential = {
      version: 2, salt, verifier, iterations, savedAt: timestamp
    };
    allowedSubjects.add(subjectId);
    try {
      localStorage.setItem(key(cleanCompanyId, subjectId), JSON.stringify(record));
      try { localStorage.removeItem(legacyKey(cleanCompanyId, subjectId)); } catch {}
      synced += 1;
    } catch {
      skipped += 1;
    }
  }
  // Never delete device-local verifiers just because a server snapshot omitted
  // them. Older deployments, role/permission changes, transient RPC results or
  // legacy employee IDs can produce incomplete snapshots; deleting here made
  // offline POS access disappear after a refresh/update. Existing credentials
  // are overwritten only when the server explicitly returns a valid newer row.
  return { synced, skipped };
}

const activeSyncs = new Map<string, Promise<{ synced: number; skipped: number }>>();

/**
 * Coalesce concurrent auth/bootstrap prefetches. A second caller waits for the
 * active pull instead of being told "0 synced" by the retry throttle while the
 * first pull is still running.
 */
export function syncOfflinePosCredentials(companyId: string): Promise<{ synced: number; skipped: number }> {
  const cleanCompanyId = String(companyId || "").trim();
  if (!cleanCompanyId || typeof localStorage === "undefined" ||
      (typeof navigator !== "undefined" && !navigator.onLine)) {
    return Promise.resolve({ synced: 0, skipped: 0 });
  }
  const active = activeSyncs.get(cleanCompanyId);
  if (active) return active;

  const task = syncOfflinePosCredentialsOnce(cleanCompanyId);
  activeSyncs.set(cleanCompanyId, task);
  return task.finally(() => {
    if (activeSyncs.get(cleanCompanyId) === task) activeSyncs.delete(cleanCompanyId);
  });
}

export async function verifyOfflinePosCredential(companyId: string, userId: string, password: string): Promise<boolean> {
  const cleanCompanyId = String(companyId || "").trim();
  const cleanUserId = String(userId || "").trim();
  const cleanPassword = String(password || "");
  if (!cleanCompanyId || !cleanUserId || !cleanPassword || typeof localStorage === "undefined") return false;

  try {
    const raw = localStorage.getItem(key(cleanCompanyId, cleanUserId));
    if (raw) {
      const stored = JSON.parse(raw) as Partial<OfflinePosCredential>;
      if (stored.version === 2 && stored.salt && stored.verifier &&
          Number(stored.iterations) >= 100_000 && Number(stored.iterations) <= 1_000_000 &&
          isFresh(Number(stored.savedAt))) {
        const verifier = await deriveVerifier(
          cleanCompanyId, cleanUserId, cleanPassword, stored.salt, Number(stored.iterations)
        );
        return equalHex(verifier, stored.verifier);
      }
      // Expired or malformed records must not authorize a POS session.
      localStorage.removeItem(key(cleanCompanyId, cleanUserId));
    }

    // One-time backwards compatibility for older v1 device-local SHA-256 caches.
    // A successful match upgrades the record to PBKDF2 and attempts to sync it.
    const oldRaw = localStorage.getItem(legacyKey(cleanCompanyId, cleanUserId));
    if (!oldRaw) return false;
    const legacy = JSON.parse(oldRaw);
    if (!legacy?.salt || !legacy?.verifier) return false;
    const legacyVerifier = await legacyDigest(cleanUserId + ":" + legacy.salt + ":" + cleanPassword);
    if (!equalHex(legacyVerifier, String(legacy.verifier))) return false;
    await rememberOfflinePosCredential(cleanCompanyId, cleanUserId, cleanPassword);
    return true;
  } catch {
    return false;
  }
}

export function forgetOfflinePosCredential(companyId: string, userId: string): void {
  try {
    localStorage.removeItem(key(String(companyId || ""), String(userId || "")));
    localStorage.removeItem(legacyKey(String(companyId || ""), String(userId || "")));
  } catch {}
}

const OFFLINE_RESUME_GRANT_PREFIX = "palmyra:offline-pos-resume-grant:v1:";

function resumeGrantKey(companyId: string, userId: string, sessionId: string): string {
  return OFFLINE_RESUME_GRANT_PREFIX +
    encodeURIComponent(String(companyId || "").trim()) + ":" +
    encodeURIComponent(String(userId || "").trim()) + ":" +
    encodeURIComponent(String(sessionId || "").trim());
}

/** Only resumes a specific cash session that this account saw while online. */
export function rememberOfflinePosResumeGrant(
  companyId: string,
  userId: string,
  sessionId: string,
  ttlMs = 7 * 24 * 60 * 60 * 1000
): void {
  const cleanCompanyId = String(companyId || "").trim();
  const cleanUserId = String(userId || "").trim();
  const cleanSessionId = String(sessionId || "").trim();
  if (!cleanCompanyId || !cleanUserId || !cleanSessionId || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      resumeGrantKey(cleanCompanyId, cleanUserId, cleanSessionId),
      JSON.stringify({ createdAt: Date.now(), expiresAt: Date.now() + Math.max(1, ttlMs) })
    );
  } catch {}
}

export function verifyOfflinePosResumeGrant(companyId: string, userId: string, sessionId: string): boolean {
  const cleanCompanyId = String(companyId || "").trim();
  const cleanUserId = String(userId || "").trim();
  const cleanSessionId = String(sessionId || "").trim();
  if (!cleanCompanyId || !cleanUserId || !cleanSessionId || typeof localStorage === "undefined") return false;
  try {
    const k = resumeGrantKey(cleanCompanyId, cleanUserId, cleanSessionId);
    const raw = localStorage.getItem(k);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!Number.isFinite(Number(parsed?.expiresAt)) || Number(parsed.expiresAt) <= Date.now()) {
      localStorage.removeItem(k);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function forgetOfflinePosResumeGrant(companyId: string, userId: string, sessionId: string): void {
  try {
    localStorage.removeItem(resumeGrantKey(String(companyId || ""), String(userId || ""), String(sessionId || "")));
  } catch {}
}
