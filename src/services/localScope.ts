const STORAGE_KEY = "palmyra_local_scope_v1";

export interface PalmyraLocalScope {
  userId: string;
  companyId: string;
  /** True only after the user explicitly verified cached credentials offline. */
  offlineSession?: boolean;
}

export function setPalmyraLocalScope(userId: string, companyId: string, offlineSession?: boolean) {
  if (typeof localStorage === "undefined") return;
  if (!userId || !companyId) return;
  const previous = getPalmyraLocalScope();
  const keepOfflineSession = previous?.userId === userId && previous.companyId === companyId && previous.offlineSession === true;
  const value: PalmyraLocalScope = {
    userId,
    companyId,
    offlineSession: offlineSession === undefined ? keepOfflineSession : offlineSession
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function getPalmyraLocalScope(): PalmyraLocalScope | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.userId || !parsed?.companyId) return null;
    return {
      userId: String(parsed.userId),
      companyId: String(parsed.companyId),
      offlineSession: parsed.offlineSession === true
    };
  } catch {
    return null;
  }
}

export function clearPalmyraLocalScope() {
  if (typeof localStorage === "undefined") return;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

export function getPalmyraLocalScopeKey(): string | null {
  const scope = getPalmyraLocalScope();
  if (!scope) return null;
  return scope.userId + "__" + scope.companyId;
}

export function getPalmyraScopedStorageKey(prefix: string): string | null {
  const scopeKey = getPalmyraLocalScopeKey();
  return scopeKey ? prefix + "__" + scopeKey : null;
}
