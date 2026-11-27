import { useEffect, useState } from 'react';
import { loadSaaSContext } from '../services/saas';
import { getCachedSaaSContext } from '../services/offlineAuthContext';
import { getPalmyraLocalScope, PALMYRA_LOCAL_SCOPE_EVENT } from '../services/localScope';
import {
  normalizePlanCode,
  planScopeKey,
  planSnapshotMatchesScope,
  planSnapshotStorageKey,
  resolvePlanCode,
  type PlanResolution,
  type PlanScope,
} from '../services/planAccess';
import { useStore } from '../store/useStore';

/**
 * Plan de la empresa para las puertas de funciones (Excel en Inventario y
 * Reportes, etiquetas, análisis ABC).
 *
 * El reporte del dueño era «el botón aparece desactivado». La causa no estaba
 * en la descarga: las páginas pedían el plan con UNA sola llamada a
 * `loadSaaSContext()` y, si esa llamada lanzaba o respondía sin suscripción,
 * lo fijaban a `null` para siempre. Con `planCode = null` la puerta se pintaba
 * cerrada —«Excel · Ciudadela»— aunque la empresa tuviera Ciudadela pagado, y
 * sin forma de reintentar en esa sesión.
 *
 * Fuentes, en orden de autoridad:
 * 1. `loadSaaSContext()` (Supabase en vivo).
 * 2. El snapshot verificado de acceso offline (`cacheSaaSContext`), siempre que
 *    pertenezca a la empresa y usuario activos.
 * 3. La copia que este dispositivo guardó al autenticar, ligada a la misma
 *    empresa y usuario (`storePlanCode`).
 *
 * Se reintenta solo mientras ninguna fuente aporte información. Ninguna copia
 * local se usa para autorizar operaciones de servidor: es solo presentación.
 */
const RETRY_DELAYS_MS = [800, 2500, 7000, 15000];
/** Una llamada colgada no puede dejar la puerta en «no sé» para siempre. */
const CONTEXT_TIMEOUT_MS = 8000;
const PLAN_SNAPSHOT_PREFIX = 'palmyra-plan-code-v1';

const UNKNOWN: PlanResolution = { planCode: null, source: 'none' };

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Alcance activo (empresa + usuario) tal como lo escribió el arranque. */
export function readPlanScope(): PlanScope | null {
  const scope = getPalmyraLocalScope();
  return scope ? { userId: scope.userId, companyId: scope.companyId } : null;
}

/** Copia guardada por este dispositivo, solo si es del alcance indicado. */
export function readStoredPlanCode(scope: PlanScope | null = readPlanScope()): string | null {
  const store = storage();
  const key = planSnapshotStorageKey(PLAN_SNAPSHOT_PREFIX, scope);
  if (!key || !store) return null;
  try {
    return normalizePlanCode(store.getItem(key));
  } catch {
    // Almacenamiento ilegible o bloqueado: simplemente no aporta plan.
    return null;
  }
}

/**
 * Guarda el plan que acaba de entregar la fuente autorizada (arranque o
 * contexto en vivo). Un valor desconocido NO borra la copia buena: `null`
 * significa «no lo sé» (suscripción ilegible, sesión caducada), no «no tiene
 * plan». Cambiar de empresa cambia la clave, así que nunca se hereda.
 */
export function storePlanCode(planCode: string | null | undefined): void {
  const store = storage();
  const key = planSnapshotStorageKey(PLAN_SNAPSHOT_PREFIX, readPlanScope());
  if (!key || !store) return;
  try {
    const normalized = normalizePlanCode(planCode);
    if (normalized) store.setItem(key, normalized);
  } catch {
    // Sin almacenamiento disponible no hay copia local; la nube sigue mandando.
  }
}

/**
 * Plan del snapshot verificado de acceso offline. Debe ser del mismo usuario y
 * la misma empresa: `getCachedSaaSContext` se indexa por usuario y ese usuario
 * pudo tener otra empresa la última vez que estuvo en línea.
 */
export function readCachedPlanCode(scope: PlanScope | null): string | null {
  const userId = String(scope?.userId ?? '').trim();
  if (!userId) return null;
  try {
    const cached = getCachedSaaSContext(userId);
    if (!cached) return null;
    const cachedScope = { userId: cached.authUserId, companyId: cached.companyId };
    if (!planSnapshotMatchesScope(cachedScope, scope)) return null;
    return cached.subscription?.planCode ?? null;
  } catch {
    return null;
  }
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    task.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); }
    );
  });
}

async function resolveFromSources(scope: PlanScope | null): Promise<PlanResolution> {
  let contextPlanCode: unknown = null;
  try {
    const context = await withTimeout(loadSaaSContext(), CONTEXT_TIMEOUT_MS);
    const contextCompanyId = context?.companyId ?? null;
    const activeCompanyId = scope?.companyId ?? null;
    // Un contexto de OTRA empresa (caché que sobrevivió a un cambio de empresa)
    // no decide esta puerta ni alimenta la copia local de esta empresa.
    const sameCompany = !contextCompanyId || !activeCompanyId || contextCompanyId === activeCompanyId;
    contextPlanCode = sameCompany ? context?.subscription?.planCode ?? null : null;
  } catch {
    // Sesión caducada, backend sin suscripción o red caída: se usan las copias.
    contextPlanCode = null;
  }
  const resolution = resolvePlanCode({
    context: contextPlanCode,
    cached: readCachedPlanCode(scope),
    device: readStoredPlanCode(scope),
  });
  // Solo se guarda lo que vino del contexto en vivo, nunca lo leído de una copia.
  if (resolution.source === 'context' && resolution.planCode) storePlanCode(resolution.planCode);
  return resolution;
}

export function usePlanCode(): PlanResolution & { planResolved: boolean } {
  const currentUserId = useStore(state => state.currentUser?.id ?? null);
  const [scope, setScope] = useState<PlanScope | null>(() => readPlanScope());
  const [state, setState] = useState<PlanResolution>(UNKNOWN);

  const scopeKey = planScopeKey(scope);

  // El alcance cambia al entrar, al cambiar de empresa y al cerrar sesión.
  useEffect(() => {
    const sync = () => {
      const next = readPlanScope();
      setScope(previous => (planScopeKey(previous) === planScopeKey(next) ? previous : next));
    };
    sync();
    if (typeof window === 'undefined') return;
    window.addEventListener(PALMYRA_LOCAL_SCOPE_EVENT, sync);
    return () => window.removeEventListener(PALMYRA_LOCAL_SCOPE_EVENT, sync);
  }, [currentUserId]);

  useEffect(() => {
    let active = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Plan de otra empresa o de otra cuenta no puede decidir esta puerta.
    setState(UNKNOWN);

    const run = async () => {
      const resolved = await resolveFromSources(scope);
      if (!active) return;
      setState(resolved);
      if (resolved.source !== 'none' || attempt >= RETRY_DELAYS_MS.length) return;
      timer = setTimeout(() => { void run(); }, RETRY_DELAYS_MS[attempt]);
      attempt += 1;
    };

    void run();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [scopeKey]);

  return { ...state, planResolved: state.source !== 'none' };
}
