import type { SaaSContext } from "./saas";
import { getCachedSaaSContext } from "./offlineAuthContext";
import { setPalmyraLocalScope } from "./localScope";

const PREFIX = "palmyra:offline-saas-credential:v1:";
const PBKDF2_ITERATIONS = 120_000;

type OfflineCredential = {
  userId: string;
  email: string;
  salt: string;
  verifier: string;
  version: 1;
  savedAt: string;
};

function normalizeEmail(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function credentialKey(userId: string): string {
  return PREFIX + encodeURIComponent(userId);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

function toHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error("Invalid salt.");
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i += 1) result[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}

async function deriveVerifier(userId: string, email: string, password: string, saltHex: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("Este navegador no dispone de criptografía segura para el acceso offline.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: new Uint8Array([
      ...fromHex(saltHex),
      ...new TextEncoder().encode("PALMYRA:" + userId + ":" + normalizeEmail(email))
    ]),
    iterations: PBKDF2_ITERATIONS,
    hash: "SHA-256"
  }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

/** Store only a salted password verifier. The password itself is never persisted. */
export async function rememberOfflineSaaSCredential(
  context: Pick<SaaSContext, "authUserId" | "user">,
  password: string
): Promise<void> {
  const userId = String(context?.authUserId || "").trim();
  const email = normalizeEmail(context?.user?.email || "");
  if (!userId || !email || !password) return;

  const salt = toHex(randomSalt());
  const verifier = await deriveVerifier(userId, email, password, salt);
  const record: OfflineCredential = {
    userId,
    email,
    salt,
    verifier,
    version: 1,
    savedAt: new Date().toISOString()
  };
  localStorage.setItem(credentialKey(userId), JSON.stringify(record));
}

/**
 * Authenticate against a credential previously verified by Supabase on this
 * device. It only opens a cached, active company context; it cannot create a
 * new account, change a password, or grant permissions not already cached.
 */
export async function verifyOfflineSaaSCredential(
  emailInput: string,
  password: string
): Promise<SaaSContext | null> {
  const email = normalizeEmail(emailInput);
  if (!email || !password || typeof localStorage === "undefined") return null;
  if (typeof crypto === "undefined" || !crypto.subtle) return null;

  const candidates: OfflineCredential[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const record = JSON.parse(localStorage.getItem(key) || "null") as OfflineCredential | null;
        if (record?.version === 1 && record.userId && normalizeEmail(record.email) === email && record.salt && record.verifier) {
          candidates.push(record);
        }
      } catch {
        // Ignore malformed local entries and keep checking other stored accounts.
      }
    }
  } catch {
    return null;
  }

  for (const candidate of candidates) {
    try {
      const verifier = await deriveVerifier(candidate.userId, candidate.email, password, candidate.salt);
      if (verifier.length !== candidate.verifier.length) continue;
      let mismatch = 0;
      for (let i = 0; i < verifier.length; i += 1) mismatch |= verifier.charCodeAt(i) ^ candidate.verifier.charCodeAt(i);
      if (mismatch !== 0) continue;

      const context = getCachedSaaSContext(candidate.userId);
      if (!context || context.authUserId !== candidate.userId || context.user.id !== candidate.userId) continue;
      if (!context.companyId || !context.company || !context.warehouseIds?.length) continue;
      if (context.membershipStatus && context.membershipStatus !== "active") continue;
      if (context.company.account_status === "suspended" || context.company.account_status === "pending_payment") continue;
      if (context.deviceActive === false) continue;

      // Rehydrate the exact company/user scope before the offline queue starts.
      setPalmyraLocalScope(context.authUserId, context.companyId);
      return context;
    } catch {
      // A credential or browser crypto error must not be treated as a successful login.
    }
  }
  return null;
}

export function forgetOfflineSaaSCredential(userId: string): void {
  try { localStorage.removeItem(credentialKey(String(userId || ""))); } catch {}
}
