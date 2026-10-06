import type { SaaSContext } from "./saas";

const PREFIX = "palmyra_offline_auth_context_v1";

function key(userId: string) {
  return PREFIX + "__" + userId;
}

function isValidContext(value: unknown): value is SaaSContext {
  const context = value as SaaSContext | null;
  return Boolean(
    context &&
    typeof context.authUserId === "string" &&
    typeof context.user === "object" &&
    context.user?.id &&
    context.authUserId === context.user.id
  );
}

export function cacheSaaSContext(context: SaaSContext) {
  if (typeof localStorage === "undefined" || !context?.authUserId) return;
  try {
    localStorage.setItem(key(context.authUserId), JSON.stringify({
      ...context,
      cachedAt: new Date().toISOString()
    }));
  } catch {
    // The offline cache is an enhancement; failure must never break login.
  }
}

export function getCachedSaaSContext(userId: string): SaaSContext | null {
  if (typeof localStorage === "undefined" || !userId) return null;
  try {
    const raw = localStorage.getItem(key(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidContext(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearCachedSaaSContext(userId?: string | null) {
  if (typeof localStorage === "undefined") return;
  try {
    if (userId) localStorage.removeItem(key(userId));
    else {
      Object.keys(localStorage)
        .filter((item) => item.startsWith(PREFIX + "__"))
        .forEach((item) => localStorage.removeItem(item));
    }
  } catch {
    // Ignore browser storage cleanup errors.
  }
}
