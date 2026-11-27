const STORAGE_KEY = "palmyra_local_scope_v1";

/**
 * Aviso de que el alcance local cambió. Lo consumen los servicios que dependen
 * de una empresa activa (p. ej. el runtime de licencia) en lugar de adivinarlo
 * por intervalos: sin este evento, un arranque que monta la interfaz antes de
 * que la empresa quede escrita se queda evaluando para siempre.
 */
export const PALMYRA_LOCAL_SCOPE_EVENT = "palmyra-local-scope-change";

function announceScopeChange(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(PALMYRA_LOCAL_SCOPE_EVENT));
  } catch {
    // Sin eventos el consumidor vuelve a su cadencia normal; nunca rompe el login.
  }
}

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
  announceScopeChange();
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
  announceScopeChange();
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
