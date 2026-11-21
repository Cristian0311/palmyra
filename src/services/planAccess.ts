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
