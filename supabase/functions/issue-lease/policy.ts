/**
 * Política de emisión de leases de PALMYRA.
 *
 * Módulo puro: sin APIs de Deno, sin red y sin imports fuera de esta carpeta,
 * para poder probarlo con tsx/node:test. Los códigos de plan, límites y feature
 * keys replican lo que ya publica la tabla public.plans (ver migraciones
 * 20261118130000_cuba_free_plans_manual_renewals.sql y
 * 20261120120000_free_plan_cloud_backup.sql) y src/config/saas.ts.
 */

/** Códigos reales del producto. "Mensual" y "6 meses" son periodos de facturación. */
export const PLAN_CODES = ["free", "starter", "growth", "pro"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/** Periodos que acepta public.plan_requests.billing_months (1,3,6,12). */
export const BILLING_MONTHS = [1, 3, 6, 12] as const;

export interface PlanLimits {
  warehouses: number;
  employees: number;
  products: number;
  reports: string;
  support: string;
}

export const PLAN_LIMITS: Record<PlanCode, PlanLimits> = {
  free: { warehouses: 1, employees: 1, products: 25, reports: "basic", support: "self_service" },
  starter: { warehouses: 1, employees: 2, products: 50, reports: "basic", support: "standard" },
  growth: { warehouses: 3, employees: 4, products: 150, reports: "advanced", support: "standard" },
  pro: { warehouses: 7, employees: 10, products: 300, reports: "advanced_plus", support: "priority" }
};

/** Feature keys vigentes de public.plans.features->'feature_keys'. */
export const PLAN_FEATURES: Record<PlanCode, readonly string[]> = {
  free: ["pos", "cash", "inventory", "offline", "basic_reports", "cloud_backup"],
  starter: ["pos", "cash", "inventory", "offline", "basic_reports", "custom_roles", "cloud_backup"],
  growth: [
    "pos",
    "cash",
    "inventory",
    "offline",
    "basic_reports",
    "customers_suppliers",
    "purchases",
    "transfers",
    "advanced_reports",
    "custom_roles",
    "banking",
    "multi_warehouse",
    "visual_style",
    "cloud_backup"
  ],
  pro: [
    "pos",
    "cash",
    "inventory",
    "offline",
    "basic_reports",
    "customers_suppliers",
    "purchases",
    "transfers",
    "advanced_reports",
    "custom_roles",
    "banking",
    "multi_warehouse",
    "visual_style",
    "cloud_backup",
    "excel_exports",
    "ai_dashboard",
    "warranty_returns",
    "abc_analysis",
    "labels",
    "advanced_analytics"
  ]
};

/** Los cuatro planes sincronizan con la nube; Gratis conserva respaldo comercial. */
export const PLAN_STORAGE_MODE: Record<PlanCode, "cloud" | "local" | "hybrid"> = {
  free: "cloud",
  starter: "cloud",
  growth: "cloud",
  pro: "cloud"
};

/**
 * Ventana offline por periodo pagado.
 * - 1 mes: +5 días desde paidThrough, tope 35 días desde issuedAt, gracia 5.
 * - 3/6/12 meses: +7 días, tope 200 días, gracia 7. Se renueva al contactar.
 */
export interface OfflinePolicy {
  offlineGapDays: number;
  offlineCapDays: number;
  graceDays: number;
  maxOfflineDays: number;
}

export const OFFLINE_POLICIES = {
  monthly: { offlineGapDays: 5, offlineCapDays: 35, graceDays: 5, maxOfflineDays: 35 },
  extended: { offlineGapDays: 7, offlineCapDays: 200, graceDays: 7, maxOfflineDays: 200 }
} as const satisfies Record<string, OfflinePolicy>;

/** Tope absoluto del lease después de la ventana offline. */
export const EXPIRES_AFTER_OFFLINE_DAYS = 30;

/** Horizonte de Gratis: no vence y no depende de internet. */
export const FREE_HORIZON_ISO = "9999-12-31T23:59:59.000Z";

const DAY_MS = 24 * 60 * 60 * 1000;

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && (PLAN_CODES as readonly string[]).includes(value);
}

export function assertPlanCode(value: unknown): PlanCode {
  if (!isPlanCode(value)) {
    throw new TypeError(
      `Plan no válido: "${String(value)}". Planes admitidos: ${PLAN_CODES.join(", ")}.`
    );
  }
  return value;
}

function toMs(value: string | number | Date, label: string): number {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`${label} inválida.`);
  return ms;
}

export function addDays(fromMs: number, days: number): number {
  return fromMs + days * DAY_MS;
}

/** Suma meses de calendario UTC con ajuste de fin de mes (31 ene + 1 mes = 28/29 feb). */
export function addMonths(fromMs: number, months: number): number {
  const start = new Date(fromMs);
  const end = new Date(start.getTime());
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return end.getTime();
}

function assertBillingMonths(planCode: PlanCode, billingMonths: number): void {
  if (!Number.isInteger(billingMonths) || billingMonths < 0) {
    throw new TypeError(`Meses de facturación inválidos: ${String(billingMonths)}.`);
  }
  if (planCode === "free") {
    if (billingMonths !== 0) {
      throw new TypeError("El plan Gratis no admite meses de facturación; use 0.");
    }
    return;
  }
  if (!(BILLING_MONTHS as readonly number[]).includes(billingMonths)) {
    throw new TypeError(
      `Un plan de pago solo admite ${BILLING_MONTHS.join(", ")} meses de facturación (recibido: ${billingMonths}).`
    );
  }
}

export function offlinePolicyFor(billingMonths: number): OfflinePolicy {
  return billingMonths <= 1 ? OFFLINE_POLICIES.monthly : OFFLINE_POLICIES.extended;
}

export interface LeaseDates {
  paidThrough: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  offlineUntil: string;
  graceDays: number;
  maxOfflineDays: number;
}

export interface BuildLeaseDatesInput {
  planCode: PlanCode | string;
  billingMonths: number;
  issuedAt: string | number | Date;
  /** Fin del periodo pagado (subscriptions.current_period_end). */
  paidThrough?: string | number | Date | null;
}

/**
 * Calcula las fechas del lease:
 * - Gratis: horizonte lejano en todas las ventanas (evaluate lo trata como "free").
 * - Pago: paidThrough = fin del periodo pagado; offlineUntil = min(paidThrough +
 *   gracia offline, issuedAt + tope); expiresAt = offlineUntil + 30 días.
 */
export function buildLeaseDates(input: BuildLeaseDatesInput): LeaseDates {
  const planCode = assertPlanCode(input.planCode);
  assertBillingMonths(planCode, input.billingMonths);

  const issuedMs = toMs(input.issuedAt, "Fecha de emisión");
  const issuedAt = new Date(issuedMs).toISOString();

  if (planCode === "free") {
    return {
      paidThrough: FREE_HORIZON_ISO,
      issuedAt,
      notBefore: issuedAt,
      expiresAt: FREE_HORIZON_ISO,
      offlineUntil: FREE_HORIZON_ISO,
      graceDays: 0,
      maxOfflineDays: 0
    };
  }

  const paidMs =
    input.paidThrough === undefined || input.paidThrough === null
      ? addMonths(issuedMs, input.billingMonths)
      : toMs(input.paidThrough, "Fecha pagada");
  if (paidMs <= issuedMs) {
    throw new TypeError("La fecha pagada debe ser posterior a la fecha de emisión.");
  }

  const policy = offlinePolicyFor(input.billingMonths);
  const offlineMs = Math.min(addDays(paidMs, policy.offlineGapDays), addDays(issuedMs, policy.offlineCapDays));

  return {
    paidThrough: new Date(paidMs).toISOString(),
    issuedAt,
    notBefore: issuedAt,
    expiresAt: new Date(addDays(offlineMs, EXPIRES_AFTER_OFFLINE_DAYS)).toISOString(),
    offlineUntil: new Date(offlineMs).toISOString(),
    graceDays: policy.graceDays,
    maxOfflineDays: policy.maxOfflineDays
  };
}

/** Límites firmados del plan; se devuelve una copia para no mutar la constante. */
export function buildLeaseLimits(planCode: PlanCode | string): PlanLimits {
  const code = assertPlanCode(planCode);
  return { ...PLAN_LIMITS[code] };
}

/** Copia de las feature keys del plan. */
export function buildLeaseFeatureKeys(planCode: PlanCode | string): string[] {
  const code = assertPlanCode(planCode);
  return [...PLAN_FEATURES[code]];
}

/**
 * Deduce el periodo facturado a partir del fin de periodo real. Evita confiar
 * en el cliente y encaja en los periodos admitidos (1, 3, 6, 12).
 */
export function inferBillingMonths(
  issuedAt: string | number | Date,
  paidThrough: string | number | Date
): number {
  const issuedMs = toMs(issuedAt, "Fecha de emisión");
  const paidMs = toMs(paidThrough, "Fecha pagada");
  for (const months of BILLING_MONTHS) {
    if (addMonths(issuedMs, months) >= paidMs) return months;
  }
  return BILLING_MONTHS[BILLING_MONTHS.length - 1];
}
