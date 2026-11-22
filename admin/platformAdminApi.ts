import { getAdminSupabase } from "./supabase";

export type PlatformCompany = {
  id: string;
  name: string;
  slug?: string | null;
  account_status?: string | null;
  active?: boolean | null;
  products?: number | null;
  employees?: number | null;
  warehouses?: number | null;
  created_at?: string | null;
  plan_code?: string | null;
  plan_name?: string | null;
  plan_status?: string | null;
  period_end?: string | null;
};

export type PlanRequest = {
  id: string;
  status?: string | null;
  company_id?: string | null;
  company_name?: string | null;
  company_status?: string | null;
  plan_code?: string | null;
  plan_name?: string | null;
  monthly_price?: number | null;
  billing_months?: number | null;
  quoted_amount?: number | null;
  quoted_currency?: string | null;
  payment_method?: string | null;
  payment_provider?: string | null;
  payer_abroad?: boolean | null;
  terms_version?: number | null;
  requested_at?: string | null;
  approved_at?: string | null;
  note?: string | null;
  contact_phone?: string | null;
  owner_email?: string | null;
};

export type PlatformOverview = {
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
};

export type PlatformSnapshot = {
  companies: PlatformCompany[];
  requests: PlanRequest[];
  overview: PlatformOverview;
};

export type PlatformPayment = {
  id: string;
  company_id: string;
  company_name: string;
  amount: number;
  currency: string;
  status: string;
  payment_method?: string | null;
  payment_provider?: string | null;
  reference?: string | null;
  manual_reference?: string | null;
  paid_at?: string | null;
  created_at: string;
  plan_code?: string | null;
};

export type PlatformPlan = {
  id: string;
  code: string;
  name: string;
  monthly_price: number;
  currency?: string | null;
  limits: Record<string, unknown>;
  features: Record<string, unknown>;
  active: boolean;
};

export type PlatformCompanyDetail = {  company: {
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
};

export type PlatformCompanyConsole = {
  company: {
    id: string;
    name: string;
    slug?: string | null;
    account_status?: string | null;
    active?: boolean | null;
    created_at?: string | null;
    updated_at?: string | null;
    currency?: string | null;
  };
  subscription: PlatformCompanyDetail["subscription"];
  plan: {
    code: string;
    name: string;
    limits: Record<string, unknown>;
    features: Record<string, unknown>;
  } | null;
  counts: { products: number; employees: number; warehouses: number; devices: number };
  owner: { user_id: string; full_name?: string | null; email?: string | null; phone?: string | null } | null;
  members: Array<{
    user_id: string;
    full_name?: string | null;
    email?: string | null;
    phone?: string | null;
    is_owner?: boolean | null;
    status?: string | null;
    roles?: string | null;
  }>;
  note: { text: string; updated_at?: string | null; updated_by?: string | null } | null;
};

export type PlatformAuditEntry = {
  id: string;
  actor_id?: string | null;
  actor_email?: string | null;
  action: string;
  target_company_id?: string | null;
  company_name?: string | null;
  target_request_id?: string | null;
  detail?: Record<string, unknown>;
  created_at: string;
};

export type PlatformSupportSettings = {
  whatsapp_number: string | null;
  support_email: string | null;
  privacy_url: string | null;
  facebook_url: string | null;
  whatsapp_channel_url: string | null;
};

export type PlatformUser = {
  user_id: string;
  email?: string | null;
  full_name?: string | null;
  phone?: string | null;
  locale?: string | null;
  created_at?: string | null;
  last_sign_in_at?: string | null;
  email_confirmed?: boolean | null;
  is_platform_admin?: boolean | null;
  company_id?: string | null;
  company_name?: string | null;
  membership_status?: string | null;
  is_owner?: boolean | null;
  active_company_id?: string | null;
};

export type PlatformUserMembership = {
  company_id: string;
  company_name?: string | null;
  account_status?: string | null;
  is_owner?: boolean | null;
  status?: string | null;
  joined_at?: string | null;
};

export type PlatformUserEmployee = {
  id: string;
  company_name?: string | null;
  employee_code?: string | null;
  full_name?: string | null;
  active?: boolean | null;
  created_at?: string | null;
};

export type PlatformUserDetail = {
  user: PlatformUser;
  memberships: PlatformUserMembership[];
  employees: PlatformUserEmployee[];
};

export type PlatformSupportRequest = {
  id: string;
  company_id: string;
  company_name: string;
  request_type: string;
  subject: string;
  message: string;
  contact_phone?: string | null;
  owner_email?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

const ADMIN_ERRORS: Record<string, string> = {
  permission_denied: "Tu cuenta no tiene permisos de administración.",
  company_not_found: "La empresa ya no existe.",
  plan_request_not_found: "La solicitud ya no existe.",
  plan_request_not_pending: "La solicitud ya fue atendida.",
  plan_not_available: "El plan elegido no está disponible.",
  invalid_plan: "El plan elegido no es válido.",
  invalid_billing_months: "La duración debe ser 1, 3, 6 o 12 meses.",
  invalid_company_status: "El estado de empresa no es válido.",
  invalid_support_status: "El estado de soporte no es válido.",
  support_request_not_found: "La solicitud de soporte ya no existe.",
  received_amount_required: "Indica el importe que realmente recibiste.",
  manual_confirmation_reference_required: "La referencia del pago es obligatoria.",
  payment_amount_below_quote: "El importe recibido en USD es menor que la cotización de la solicitud.",
  payment_currency_mismatch: "La moneda no coincide con el método de pago elegido por la empresa.",
  legacy_payment_method_requires_review: "Es una solicitud antigua con método de pago no reconocido. Recházala y pide una nueva.",
  request_owner_no_longer_active: "El propietario de la empresa ya no está activo.",
  company_access_denied: "La empresa está suspendida: reactívala antes de aprobar un plan.",
  plan_warehouse_limit: "La empresa supera el límite de almacenes de ese plan.",
  plan_product_limit: "La empresa supera el límite de productos de ese plan.",
  plan_employee_limit: "La empresa supera el límite de empleados de ese plan.",
  invalid_company_name: "El nombre debe tener entre 2 y 120 caracteres.",
  invalid_company_slug: "El identificador solo admite minúsculas, números y guiones (2–61 caracteres).",
  company_slug_taken: "Ese identificador ya lo usa otra empresa.",
  invalid_currency: "La moneda debe ser CUP, USD, MLC o EUR.",
  subscription_not_found: "La empresa no tiene suscripción configurada.",
  invalid_subscription_status: "El estado de suscripción no es válido.",
  trial_end_required: "Una suscripción en prueba necesita fecha de fin de prueba.",
  period_end_required: "Una suscripción activa de pago necesita fecha de fin de período.",
  invalid_subscription_dates: "El fin de prueba no puede ser posterior al fin del período.",
  invalid_grace_date: "La gracia no puede terminar antes del fin del período.",
  user_not_found: "El usuario ya no existe.",
};

export function adminErrorMessage(error: unknown, fallback = "No se pudo completar la operación.") {
  const message = String((error as any)?.message ?? error ?? "");
  const code = String((error as any)?.code ?? "");
  if (ADMIN_ERRORS[message]) return ADMIN_ERRORS[message];
  if (code === "PGRST202" || /could not find the function|schema cache/i.test(message)) {
    return "Falta aplicar la actualización de la base de datos para esta función administrativa.";
  }
  if (/failed to fetch|network|load failed|timeout/i.test(message)) {
    return "No se pudo conectar con Supabase. Revisa tu conexión.";
  }
  return message || fallback;
}

async function assertPlatformAdmin() {
  const supabase = getAdminSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) throw new Error("Necesitas iniciar sesión.");
  // La autorización real vive en la base de datos/RPC.
  // El frontend nunca decide quién es Super Admin por metadata local.
  return supabase;
}

async function rpcArray<T>(name: string, args: Record<string, unknown> = {}): Promise<T[]> {
  const supabase = await assertPlatformAdmin();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(adminErrorMessage(error));
  return Array.isArray(data) ? (data as T[]) : [];
}

export async function loadPlatformSnapshot(): Promise<PlatformSnapshot> {
  const supabase = await assertPlatformAdmin();
  const [companies, requests, overview] = await Promise.all([
    supabase.rpc("get_platform_companies"),
    supabase.rpc("get_pending_plan_requests", { p_status: "pending", p_limit: 200 }),
    supabase.rpc("get_platform_overview"),
  ]);
  if (companies.error) throw new Error(adminErrorMessage(companies.error));
  if (requests.error) throw new Error(adminErrorMessage(requests.error));
  if (overview.error) throw new Error(adminErrorMessage(overview.error));
  return {
    companies: (companies.data || []) as PlatformCompany[],
    requests: (requests.data || []) as PlanRequest[],
    overview: (overview.data || {}) as PlatformOverview,
  };
}

export function loadPlanRequests(status: "pending" | "approved" | "rejected" | "cancelled" | "all" = "pending") {
  return rpcArray<PlanRequest>("get_pending_plan_requests", { p_status: status, p_limit: 200 });
}

export function loadBillingPayments(limit = 100) {
  return rpcArray<PlatformPayment>("get_platform_billing_payments", { p_limit: limit });
}

export function loadAdminAudit(limit = 150, companyId?: string) {
  return rpcArray<PlatformAuditEntry>("get_platform_admin_audit", { p_limit: limit, p_company_id: companyId || null });
}

export function loadPlatformPlans() {
  return rpcArray<PlatformPlan>("get_platform_plans");
}

export function loadPlatformUsers(search?: string, limit = 200) {
  return rpcArray<PlatformUser>("get_platform_users", {
    p_search: search?.trim() || null,
    p_limit: limit,
  });
}

export async function loadPlatformUserDetail(userId: string): Promise<PlatformUserDetail> {
  const supabase = await assertPlatformAdmin();
  const { data, error } = await supabase.rpc("get_platform_user_detail", { p_user_id: userId });
  if (error) throw new Error(adminErrorMessage(error));
  const value = (data || {}) as Partial<PlatformUserDetail>;
  if (!value.user) throw new Error("No se encontró ese usuario.");
  return {
    user: value.user,
    memberships: Array.isArray(value.memberships) ? value.memberships : [],
    employees: Array.isArray(value.employees) ? value.employees : [],
  };
}

export async function loadCompanyDetail(companyId: string): Promise<PlatformCompanyDetail> {
  const supabase = await assertPlatformAdmin();
  const { data, error } = await supabase.rpc("get_platform_company_detail", { p_company_id: companyId });
  if (error) throw new Error(adminErrorMessage(error));
  return data as PlatformCompanyDetail;
}

export async function loadCompanyConsole(companyId: string): Promise<PlatformCompanyConsole> {
  const supabase = await assertPlatformAdmin();
  const { data, error } = await supabase.rpc("get_platform_company_console", { p_company_id: companyId });
  if (error) throw new Error(adminErrorMessage(error));
  return data as PlatformCompanyConsole;
}

export async function updateCompanyProfile(
  companyId: string,
  profile: { name: string; slug: string; currency: string },
) {
  const { data, error } = await getAdminSupabase().rpc("update_platform_company_profile", {
    p_company_id: companyId,
    p_name: profile.name.trim(),
    p_slug: profile.slug.trim().toLowerCase(),
    p_currency: profile.currency,
  });
  if (error) throw new Error(adminErrorMessage(error));
  return data;
}

export async function saveCompanyNote(companyId: string, note: string) {
  const { data, error } = await getAdminSupabase().rpc("set_platform_company_note", {
    p_company_id: companyId,
    p_note: note,
  });
  if (error) throw new Error(adminErrorMessage(error));
  return data;
}

export async function updateCompanySubscriptionDates(
  companyId: string,
  input: {
    status: string;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    graceEndsAt: string | null;
    note?: string;
  },
) {
  const { data, error } = await getAdminSupabase().rpc("set_platform_company_subscription_dates", {
    p_company_id: companyId,
    p_status: input.status,
    p_trial_ends_at: input.trialEndsAt,
    p_current_period_end: input.currentPeriodEnd,
    p_grace_ends_at: input.graceEndsAt,
    p_note: input.note?.trim() || null,
  });
  if (error) throw new Error(adminErrorMessage(error));
  return data as {
    ok: boolean;
    status: string;
    trial_ends_at?: string | null;
    current_period_end?: string | null;
    grace_ends_at?: string | null;
  };
}

export async function approveRequest(
  id: string,
  payment: { amount: number; currency: "CUP" | "USD"; reference: string },
) {
  const reference = payment.reference.trim();
  if (!Number.isFinite(payment.amount) || payment.amount <= 0) {
    throw new Error("Indica el importe realmente recibido.");
  }
  if (!reference) throw new Error("La referencia del pago es obligatoria.");
  const { data, error } = await getAdminSupabase().rpc("approve_plan_request_v3", {
    p_request_id: id,
    p_received_amount: payment.amount,
    p_received_currency: payment.currency,
    p_reference: reference,
  });
  if (error) throw new Error(adminErrorMessage(error));
  return data as { ok?: boolean; company_id: string; plan_name?: string; current_period_end?: string };
}

export async function rejectRequest(id: string, note: string) {
  const { data, error } = await getAdminSupabase().rpc("reject_plan_request", {
    p_request_id: id,
    p_note: note.trim() || null,
  });
  if (error) throw new Error(adminErrorMessage(error));
  return data;
}

export async function changeCompanyStatus(
  companyId: string,
  status: "active" | "suspended" | "setup" | "pending_payment",
) {
  const { data, error } = await getAdminSupabase().rpc("set_platform_company_status", {
    p_company_id: companyId,
    p_status: status,
  });
  if (error) throw new Error(adminErrorMessage(error));
  return data;
}

export async function setCompanyPlan(
  companyId: string,
  planCode: string,
  months = 1,
  note?: string,
) {
  const { data, error } = await getAdminSupabase().rpc("set_platform_company_plan_v2", {
    p_company_id: companyId,
    p_plan_code: planCode,
    p_months: planCode === "free" ? 0 : months,
    p_note: note?.trim() || null,
  });
  if (error) throw new Error(adminErrorMessage(error));
  return data as { ok: boolean; plan_name: string; months: number; current_period_end?: string | null };
}

export async function loadSupportSettings(): Promise<PlatformSupportSettings> {
  const supabase = await assertPlatformAdmin();
  const { data, error } = await supabase.rpc("get_platform_support_settings");
  if (error) throw new Error(adminErrorMessage(error));
  const value = (data || {}) as Record<string, unknown>;
  return {
    whatsapp_number: value.whatsapp_number ? String(value.whatsapp_number) : null,
    support_email: value.support_email ? String(value.support_email) : null,
    privacy_url: value.privacy_url ? String(value.privacy_url) : null,
    facebook_url: value.facebook_url ? String(value.facebook_url) : null,
    whatsapp_channel_url: value.whatsapp_channel_url ? String(value.whatsapp_channel_url) : null,
  };
}

export async function saveSupportSettings(settings: PlatformSupportSettings): Promise<PlatformSupportSettings> {
  const supabase = await assertPlatformAdmin();
  const { data, error } = await supabase.rpc("set_platform_support_settings", {
    p_whatsapp_number: settings.whatsapp_number || null,
    p_support_email: settings.support_email || null,
    p_privacy_url: settings.privacy_url || null,
    p_facebook_url: settings.facebook_url || null,
    p_whatsapp_channel_url: settings.whatsapp_channel_url || null,
  });
  if (error) throw new Error(adminErrorMessage(error));
  const value = (data || {}) as Record<string, unknown>;
  return {
    whatsapp_number: value.whatsapp_number ? String(value.whatsapp_number) : null,
    support_email: value.support_email ? String(value.support_email) : null,
    privacy_url: value.privacy_url ? String(value.privacy_url) : null,
    facebook_url: value.facebook_url ? String(value.facebook_url) : null,
    whatsapp_channel_url: value.whatsapp_channel_url ? String(value.whatsapp_channel_url) : null,
  };
}

export async function loadSupportRequests(status?: string): Promise<PlatformSupportRequest[]> {
  return rpcArray<PlatformSupportRequest>("get_platform_support_requests", {
    p_status: status || "all",
    p_limit: 200,
  });
}

export async function setSupportRequestStatus(
  requestId: string,
  status: "open" | "in_progress" | "resolved" | "closed",
) {
  const { data, error } = await getAdminSupabase().rpc("set_platform_support_request_status", {
    p_request_id: requestId,
    p_status: status,
  });
  if (error) throw new Error(adminErrorMessage(error));
  return data;
}
