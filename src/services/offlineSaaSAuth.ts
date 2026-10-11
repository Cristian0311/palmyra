import type { SaaSContext } from "./saas";
import { cacheSaaSContext, getCachedSaaSContext } from "./offlineAuthContext";
import { setPalmyraLocalScope } from "./localScope";

const PREFIX = "palmyra:offline-saas-credential:v2:";
const PBKDF2_ITERATIONS = 120_000;

type OfflineCredential = {
  userId: string;
  email: string;
  salt: string;
  verifier: string;
  contextVerifier: string;
  version: 2;
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

function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error("Invalid salt.");
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i += 1) result[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}

async function deriveVerifier(
  userId: string,
  email: string,
  secret: string,
  saltHex: string,
  purpose: "credential" | "context"
): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("Este navegador no dispone de criptografía segura para el acceso offline.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const domainSalt = new TextEncoder().encode("PALMYRA:v2:" + purpose + ":" + userId + ":" + normalizeEmail(email));
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: new Uint8Array([...fromHex(saltHex), ...domainSalt]),
    iterations: PBKDF2_ITERATIONS,
    hash: "SHA-256"
  }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableSerialize).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + stableSerialize(record[key])).join(",") + "}";
}

function normalizedArray(values: unknown): string[] {
  return Array.isArray(values) ? values.map(value => String(value)).sort() : [];
}

/**
 * Bind the verifier to the cached company and permission scope. localStorage is
 * user-editable, so a valid password alone must not authorize a modified cached
 * role, company, warehouse allowlist or suspended-account status.
 */
function contextFingerprint(context: SaaSContext): string {
  const user = context.user as unknown as Record<string, unknown>;
  const userSnapshot = {
    ...user,
    permissions: normalizedArray(user.permissions),
    allowedWarehouseIds: normalizedArray(user.allowedWarehouseIds),
    allowedBranches: normalizedArray(user.allowedBranches),
  };
  const snapshot = {
    authUserId: context.authUserId,
    user: userSnapshot,
    companyId: context.companyId,
    company: context.company,
    membershipStatus: context.membershipStatus,
    isOwner: context.isOwner,
    deviceActive: context.deviceActive,
    roleKey: context.roleKey,
    warehouseIds: normalizedArray(context.warehouseIds),
    subscription: context.subscription
  };
  return stableSerialize(snapshot);
}

/** Store a salted password verifier and a verifier for the cached security scope.
 * The raw password is never persisted. */
export async function rememberOfflineSaaSCredential(
  context: SaaSContext,
  password: string
): Promise<void> {
  const userId = String(context?.authUserId || "").trim();
  const email = normalizeEmail(context?.user?.email || "");
  if (!userId || !email || !password) return;

  const salt = bytesToHex(randomSalt());
  // Ensure the snapshot used by the verifier is exactly the one that is cached.
  const normalizedContext = { ...context, user: { ...context.user, email } };
  cacheSaaSContext(normalizedContext);
  const verifier = await deriveVerifier(userId, email, password, salt, "credential");
  const contextVerifier = await deriveVerifier(
    userId,
    email,
    password + "\u0000" + contextFingerprint(normalizedContext),
    salt,
    "context"
  );
  const record: OfflineCredential = {
    userId,
    email,
    salt,
    verifier,
    contextVerifier,
    version: 2,
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
        if (record?.version === 2 && record.userId && normalizeEmail(record.email) === email &&
            record.salt && record.verifier && record.contextVerifier) {
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
      const verifier = await deriveVerifier(candidate.userId, candidate.email, password, candidate.salt, "credential");
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

      const currentContextVerifier = await deriveVerifier(
        candidate.userId,
        candidate.email,
        password + "\u0000" + contextFingerprint(context),
        candidate.salt,
        "context"
      );
      if (currentContextVerifier.length !== candidate.contextVerifier.length) continue;
      let contextMismatch = 0;
      for (let i = 0; i < currentContextVerifier.length; i += 1) {
        contextMismatch |= currentContextVerifier.charCodeAt(i) ^ candidate.contextVerifier.charCodeAt(i);
      }
      if (contextMismatch !== 0) continue;

      // Rehydrate the exact company/user scope before the offline queue starts.
      setPalmyraLocalScope(context.authUserId, context.companyId, true);
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
