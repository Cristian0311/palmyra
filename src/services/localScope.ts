const STORAGE_KEY = "palmyra_local_scope_v1";

export interface PalmyraLocalScope {
  userId: string;
  companyId: string;
}

export function setPalmyraLocalScope(userId: string, companyId: string) {
  if (typeof localStorage === "undefined") return;
  if (!userId || !companyId) return;
  const value: PalmyraLocalScope = { userId, companyId };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function getPalmyraLocalScope(): PalmyraLocalScope | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.userId || !parsed?.companyId) return null;
    return { userId: String(parsed.userId), companyId: String(parsed.companyId) };
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
