// Re-exported so entitlement checks and navigation share one source.
export { isPermanentPlan } from '../config/saas';

export type PlanFeature =
  | 'pos'
  | 'cash'
  | 'inventory'
  | 'basic_reports'
  | 'cloud_backup'
  | 'transfers'
  | 'purchases'
  | 'inventory_audit'
  | 'advanced_reports'
  | 'custom_roles'
  | 'banking'
  | 'multi_warehouse'
  | 'advanced_analytics'
  | 'customers_suppliers'
  | 'visual_style'
  | 'excel_exports'
  | 'ai_dashboard'
  | 'warranty_returns'
  | 'abc_analysis'
  | 'labels';

const LEVEL: Record<string, number> = {
  free: -1,
  trial: 0,
  starter: 0,
  growth: 1,
  pro: 2,
};

export const PLAN_FEATURES: Record<PlanFeature, string> = {
  pos: 'free',
  cash: 'free',
  inventory: 'free',
  basic_reports: 'free',
  cloud_backup: 'free',
  transfers: 'growth',
  purchases: 'growth',
  inventory_audit: 'growth',
  advanced_reports: 'growth',
  custom_roles: 'starter',
  banking: 'growth',
  multi_warehouse: 'growth',
  advanced_analytics: 'pro',
  customers_suppliers: 'growth',
  visual_style: 'growth',
  excel_exports: 'pro',
  ai_dashboard: 'pro',
  warranty_returns: 'pro',
  abc_analysis: 'pro',
  labels: 'pro',
};

export function getRequiredPlanCode(feature: PlanFeature): string {
  return PLAN_FEATURES[feature];
}

export function canUsePlanFeature(planCode: string | null | undefined, feature: PlanFeature): boolean {
  const current = LEVEL[String(planCode || '').trim().toLowerCase()] ?? -Infinity;
  return current >= (LEVEL[PLAN_FEATURES[feature]] ?? 999);
}

/**
 * Códigos de plan reconocidos por `canUsePlanFeature`. Un valor fuera de esta
 * lista equivale a "sin plan" (-Infinity), nunca a un plan concedido.
 */
const KNOWN_PLAN_CODES = Object.keys(LEVEL);

/**
 * Código de plan normalizado o null cuando el valor no representa un plan real.
 * Evita que una cadena vacía, 'null' o un código desconocido se interprete como
 * un nivel válido al comparar contra las copias locales y el contexto en vivo.
 */
export function normalizePlanCode(value: unknown): string | null {
  const code = String(value ?? '').trim().toLowerCase();
  return KNOWN_PLAN_CODES.includes(code) ? code : null;
}

/**
 * De dónde salió el plan: del contexto en vivo, del snapshot verificado de
 * acceso offline, de la copia de este dispositivo o de ninguna fuente todavía.
 */
export type PlanCodeSource = 'context' | 'cache' | 'device' | 'none';

export type PlanResolution = {
  planCode: string | null;
  source: PlanCodeSource;
};

/** Empresa y usuario a los que pertenece un plan. */
export type PlanScope = {
  userId?: string | null;
  companyId?: string | null;
};

/**
 * Identidad del alcance ('usuario__empresa') o null si falta alguno de los dos.
 * Un plan sin empresa y sin usuario no es verificable: no se guarda ni se lee.
 */
export function planScopeKey(scope: PlanScope | null | undefined): string | null {
  const userId = String(scope?.userId ?? '').trim();
  const companyId = String(scope?.companyId ?? '').trim();
  return userId && companyId ? `${userId}__${companyId}` : null;
}

/**
 * Clave de la copia local del plan. Incluye empresa y usuario, así que cambiar
 * de empresa (o de cuenta) deja de ver la copia anterior en lugar de heredarla.
 */
export function planSnapshotStorageKey(
  prefix: string,
  scope: PlanScope | null | undefined
): string | null {
  const scopeKey = planScopeKey(scope);
  return prefix && scopeKey ? `${prefix}__${scopeKey}` : null;
}

/**
 * Una copia solo vale para el mismo usuario y la misma empresa que la escribió.
 * Se usa con el snapshot verificado de acceso offline, que puede ser de una
 * empresa anterior del mismo usuario.
 */
export function planSnapshotMatchesScope(
  snapshot: PlanScope | null | undefined,
  scope: PlanScope | null | undefined
): boolean {
  const snapshotKey = planScopeKey(snapshot);
  return Boolean(snapshotKey) && snapshotKey === planScopeKey(scope);
}

/**
 * Plan efectivo de la empresa. El contexto en vivo manda siempre que trae un
 * plan conocido; si no, se acepta el snapshot verificado de acceso offline y,
 * por último, la copia que este dispositivo guardó al autenticar.
 *
 * Un contexto con un plan conocido pero inferior NO cae al respaldo: un
 * downgrade real nunca queda enmascarado por una copia antigua. Cuando ninguna
 * fuente aporta un plan el resultado es `source: 'none'` ("todavía no se sabe"),
 * que no es lo mismo que "su plan no incluye la función".
 */
export function resolvePlanCode(
  sources: { context?: unknown; cached?: unknown; device?: unknown } = {}
): PlanResolution {
  const fromContext = normalizePlanCode(sources.context);
  if (fromContext) return { planCode: fromContext, source: 'context' };
  const fromCache = normalizePlanCode(sources.cached);
  if (fromCache) return { planCode: fromCache, source: 'cache' };
  const fromDevice = normalizePlanCode(sources.device);
  if (fromDevice) return { planCode: fromDevice, source: 'device' };
  return { planCode: null, source: 'none' };
}

export type PlanFeatureDecision = {
  /** El plan todavía no se pudo determinar: no hay base para bloquear nada. */
  pending: boolean;
  /** Plan conocido que no incluye la función: corresponde la puerta de pago. */
  locked: boolean;
  /** La función está incluida según un plan conocido. */
  granted: boolean;
};

/**
 * Decisión de una puerta de función a partir del plan resuelto.
 *
 * `pending` y `locked` son excluyentes: mientras el plan no se conoce no se
 * puede afirmar que la empresa no lo paga, así que la puerta de pago no aplica
 * (las secciones que contienen estas funciones ya están protegidas). Es solo
 * presentación: nunca autoriza operaciones de servidor ni sustituye a RLS.
 */
export function decidePlanFeature(
  resolution: PlanResolution | null | undefined,
  feature: PlanFeature
): PlanFeatureDecision {
  const planCode = normalizePlanCode(resolution?.planCode);
  if (!planCode) return { pending: true, locked: false, granted: false };
  const granted = canUsePlanFeature(planCode, feature);
  return { pending: false, locked: !granted, granted };
}

export type PlanVisual = {
  badge: string;
  soft: string;
  border: string;
  text: string;
  accent: string;
};

export function getPlanVisual(code: string | null | undefined): PlanVisual {
  const key = String(code || '').toLowerCase();
  const visuals: Record<string, PlanVisual> = {
    free: {
      badge: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700',
      soft: 'bg-slate-50 dark:bg-slate-800/60', border: 'border-slate-200 dark:border-slate-700', text: 'text-slate-700 dark:text-slate-200', accent: 'bg-slate-700',
    },
    trial: {
      badge: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700',
      soft: 'bg-slate-50 dark:bg-slate-800/60',
      border: 'border-slate-200 dark:border-slate-700',
      text: 'text-slate-700 dark:text-slate-200',
      accent: 'bg-slate-700',
    },
    starter: {
      badge: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-900',
      soft: 'bg-sky-50/70 dark:bg-sky-950/40',
      border: 'border-sky-200 dark:border-sky-900',
      text: 'text-sky-700 dark:text-sky-300',
      accent: 'bg-sky-600',
    },
    growth: {
      badge: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-900',
      soft: 'bg-violet-50/70 dark:bg-violet-950/40',
      border: 'border-violet-200 dark:border-violet-900',
      text: 'text-violet-700 dark:text-violet-300',
      accent: 'bg-violet-600',
    },
    pro: {
      badge: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-900',
      soft: 'bg-emerald-50/70 dark:bg-emerald-950/40',
      border: 'border-emerald-200 dark:border-emerald-900',
      text: 'text-emerald-700 dark:text-emerald-300',
      accent: 'bg-emerald-600',
    },
  };
  return visuals[key] || visuals.trial;
}

export function getPlanDisplayName(code: string | null | undefined): string {
  const names: Record<string,string> = { free: 'Gratis', trial: 'Prueba PALMYRA', starter: 'Oasis', growth: 'Caravana', pro: 'Ciudadela' };
  return names[String(code || '').toLowerCase()] || 'tu plan actual';
}
