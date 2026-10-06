export type PlanFeature =
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
  trial: 0,
  starter: 0,
  growth: 1,
  pro: 2,
};

export const PLAN_FEATURES: Record<PlanFeature, string> = {
  transfers: 'growth',
  purchases: 'growth',
  inventory_audit: 'growth',
  advanced_reports: 'growth',
  custom_roles: 'growth',
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
  const current = LEVEL[String(planCode || '').toLowerCase()] ?? -1;
  return current >= (LEVEL[PLAN_FEATURES[feature]] ?? 999);
}

export function getPlanDisplayName(code: string | null | undefined): string {
  const names: Record<string,string> = { trial: 'Prueba PALMYRA', starter: 'Oasis', growth: 'Caravana', pro: 'Ciudadela' };
  return names[String(code || '').toLowerCase()] || 'tu plan actual';
}
