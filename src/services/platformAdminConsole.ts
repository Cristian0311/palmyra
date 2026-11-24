import { getSupabase } from "../lib/supabase";
import { platformAdminError } from "./platformAdmin";
import { recordRequest } from "./requestBudget";

export interface PlatformOverview {
  companies_total: number;
  companies_active: number;
  companies_suspended: number;
  companies_setup: number;
  companies_pending_payment: number;
  companies_new_30d: number;
  pending_plan_requests: number;
  mrr_usd: number;
  expiring_7d: number;
  open_invoices: number;
  open_invoice_amount: number;
  payments_30d_amount: number;
  payments_30d_count: number;
  support_open: number;
  support_in_progress: number;
  users_total: number;
}

export interface PlatformPlan {
  id: string;
  code: string;
  name: string;
  monthly_price: number;
  currency?: string | null;
  limits: Record<string, unknown>;
  features: Record<string, unknown>;
  active: boolean;
}

export interface PlatformPayment {
  id: string;
  company_id: string;
  company_name: string;
  amount: number;
  currency: string;
  status: string;
  payment_method?: string | null;
  reference?: string | null;
  manual_reference?: string | null;
  paid_at?: string | null;
  created_at: string;
  plan_code?: string | null;
}

export interface PlatformAuditEntry {
  id: string;
  actor_id?: string | null;
  actor_email?: string | null;
  action: string;
  target_company_id?: string | null;
  company_name?: string | null;
  target_request_id?: string | null;
  detail?: Record<string, unknown>;
  created_at: string;
}

export interface PlatformCompanyDetail {
  company: {
    id: string;
    name: string;
    slug?: string | null;
    account_status?: string | null;
    active?: boolean | null;
    created_at?: string | null;
    currency?: string | null;
  };
  subscription: {
    plan_code?: string | null;
    plan_name?: string | null;
    monthly_price?: number | null;
    status?: string | null;
    starts_at?: string | null;
    current_period_start?: string | null;
    current_period_end?: string | null;
    trial_ends_at?: string | null;
    grace_ends_at?: string | null;
    cancelled_at?: string | null;
  } | null;
  counts: { products: number; employees: number; warehouses: number };
  requests: Array<{
    id: string;
    status: string;
    plan_code?: string | null;
    plan_name?: string | null;
    billing_months?: number | null;
    quoted_amount?: number | null;
    quoted_currency?: string | null;
    payment_method?: string | null;
    requested_at: string;
    approved_at?: string | null;
    note?: string | null;
  }>;
  invoices: Array<{
    invoice_number: string;
    amount: number;
    currency: string;
    status: string;
    period_start?: string | null;
    period_end?: string | null;
    paid_at?: string | null;
    created_at: string;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    payment_method?: string | null;
    reference?: string | null;
    paid_at?: string | null;
    created_at: string;
  }>;
}

export interface PlatformUser {
  user_id: string;
  email: string | null;
  full_name?: string | null;
  phone?: string | null;
  locale?: string | null;
  created_at: string;
  last_sign_in_at?: string | null;
  email_confirmed: boolean;
  is_platform_admin: boolean;
  company_id?: string | null;
  company_name?: string | null;
  membership_status?: string | null;
  is_owner?: boolean;
  active_company_id?: string | null;
}

export interface PlatformUserDetail {
  user: PlatformUser;
  memberships: Array<{
    company_id: string;
    company_name?: string | null;
    account_status?: string | null;
    is_owner: boolean;
    status: string;
    joined_at?: string | null;
  }>;
  employees: Array<{
    id: string;
    company_name?: string | null;
    employee_code?: string | null;
    full_name?: string | null;
    active: boolean;
    created_at?: string | null;
  }>;
}

/**
 * Toda RPC de la consola se mide (F6): ruta, latencia y error en el registro
 * local, para que el panel de presupuesto muestre el costo real de la consola.
 */
async function callRpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  const startedAt = Date.now();
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.rpc(name, args);
  } catch (networkError) {
    // Fallo de transporte: se mide una sola vez y se propaga.
    recordRequest(`admin/${name}`, { ms: Date.now() - startedAt, ok: false });
    throw networkError;
  }
  recordRequest(`admin/${name}`, { ms: Date.now() - startedAt, ok: !result.error });
  if (result.error) throw new Error(platformAdminError(result.error));
  return result.data as T;
}

async function rpcList<T>(name: string, args: Record<string, unknown> = {}): Promise<T[]> {
  const data = await callRpc<unknown>(name, args);
  return Array.isArray(data) ? (data as T[]) : [];
}

export async function loadPlatformOverview(): Promise<PlatformOverview> {
  return (await callRpc<PlatformOverview>("get_platform_overview")) || ({} as PlatformOverview);
}

export function loadPlanRequests(
  status: "pending" | "approved" | "rejected" | "cancelled" | "all" = "pending",
  limit = 300,
) {
  return rpcList<any>("get_pending_plan_requests", { p_status: status, p_limit: limit });
}

export function loadPlatformPayments(limit = 40) {
  return rpcList<PlatformPayment>("get_platform_billing_payments", { p_limit: limit });
}

export function loadPlatformAudit(limit = 150, companyId?: string) {
  return rpcList<PlatformAuditEntry>("get_platform_admin_audit", {
    p_limit: limit,
    p_company_id: companyId || null,
  });
}

export function loadPlatformPlans() {
  return rpcList<PlatformPlan>("get_platform_plans");
}

export async function loadPlatformCompanyDetail(companyId: string): Promise<PlatformCompanyDetail> {
  return callRpc<PlatformCompanyDetail>("get_platform_company_detail", { p_company_id: companyId });
}

export async function assignPlatformCompanyPlan(companyId: string, planCode: string, months = 1, note?: string) {
  return callRpc<{ ok: boolean; plan_name: string; months: number; current_period_end?: string | null }>(
    "set_platform_company_plan_v2",
    {
      p_company_id: companyId,
      p_plan_code: planCode,
      p_months: planCode === "free" ? 0 : months,
      p_note: note?.trim() || null,
    }
  );
}

export function loadPlatformUsers(search?: string, limit = 300) {
  return rpcList<PlatformUser>("get_platform_users", { p_search: search?.trim() || null, p_limit: limit });
}

export async function loadPlatformUserDetail(userId: string): Promise<PlatformUserDetail> {
  return callRpc<PlatformUserDetail>("get_platform_user_detail", { p_user_id: userId });
}

export function loadPlatformSupportRequests(status = "all", limit = 200) {
  return rpcList<any>("get_platform_support_requests", { p_status: status, p_limit: limit });
}
