import { getAdminSupabase } from "./supabase";

export type PlatformCompany = {
  id: string;
  name: string;
  slug?: string | null;
  account_status?: string | null;
  products?: number | null;
  employees?: number | null;
  warehouses?: number | null;
  sales?: number | null;
  stock_movements?: number | null;
  cash_sessions?: number | null;
  data_records?: number | null;
  last_sale_at?: string | null;
  plan_code?: string | null;
  plan_name?: string | null;
  plan_limits?: { products?: number; employees?: number; warehouses?: number } | null;
  created_at?: string | null;
};

export type PlanRequest = {
  id: string;
  company_name?: string | null;
  plan_name?: string | null;
  monthly_price?: number | null;
  requested_at?: string | null;
  payment_method?: string | null;
  status?: string | null;
};

export type PlatformSnapshot = {
  companies: PlatformCompany[];
  requests: PlanRequest[];
  supportRequests: PlatformSupportRequest[];
};

async function assertPlatformAdmin() {
  const supabase = getAdminSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) throw new Error("Necesitas iniciar sesión.");

  // La autorización real vive en la base de datos/RPC.
  // El frontend nunca decide quién es Super Admin por metadata local.
  return supabase;
}

export async function loadPlatformSnapshot(): Promise<PlatformSnapshot> {
  const supabase = await assertPlatformAdmin();

  const [{ data: companies, error: companiesError }, { data: requests, error: requestsError }, { data: supportRequests, error: supportError }] =
    await Promise.all([
      supabase.rpc("get_platform_companies"),
      supabase.rpc("get_pending_plan_requests"),
      supabase.rpc("get_platform_support_requests", { p_status: null, p_limit: 100 }),
    ]);

  if (companiesError) throw new Error(companiesError.message);
  if (requestsError) throw new Error(requestsError.message);
  if (supportError) throw new Error(supportError.message);

  return {
    companies: (companies || []) as PlatformCompany[],
    requests: (requests || []) as PlanRequest[],
    supportRequests: (supportRequests || []) as PlatformSupportRequest[],
  };
}

export async function approveRequest(id: string) {
  const { data, error } = await getAdminSupabase().rpc("approve_plan_request", { p_request_id: id });
  if (error) throw error;
  return data;
}

export async function rejectRequest(id: string, note: string) {
  const { data, error } = await getAdminSupabase().rpc("reject_plan_request", {
    p_request_id: id,
    p_note: note.trim() || null,
  });
  if (error) throw error;
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
  if (error) throw error;
  return data;
}


export type PlatformSupportSettings = {
  whatsapp_number: string | null;
  support_email: string | null;
  privacy_url: string | null;
};

export type PlatformSupportRequest = {
  id: string;
  company_id: string;
  company_name: string;
  request_type: string;
  subject: string;
  message: string;
  contact_phone?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export async function loadSupportSettings(): Promise<PlatformSupportSettings> {
  const supabase = await assertPlatformAdmin();
  const { data, error } = await supabase.rpc("get_platform_support_settings");
  if (error) throw error;
  const value = (data || {}) as Record<string, unknown>;
  return {
    whatsapp_number: value.whatsapp_number ? String(value.whatsapp_number) : null,
    support_email: value.support_email ? String(value.support_email) : null,
    privacy_url: value.privacy_url ? String(value.privacy_url) : null,
  };
}

export async function saveSupportSettings(settings: PlatformSupportSettings): Promise<PlatformSupportSettings> {
  const supabase = await assertPlatformAdmin();
  const { data, error } = await supabase.rpc("set_platform_support_settings", {
    p_whatsapp_number: settings.whatsapp_number || null,
    p_support_email: settings.support_email || null,
    p_privacy_url: settings.privacy_url || null,
  });
  if (error) throw error;
  const value = (data || {}) as Record<string, unknown>;
  return {
    whatsapp_number: value.whatsapp_number ? String(value.whatsapp_number) : null,
    support_email: value.support_email ? String(value.support_email) : null,
    privacy_url: value.privacy_url ? String(value.privacy_url) : null,
  };
}

export type InfrastructureUsage = {
  capturedAt: string;
  monthStart: string;
  providerSources: { render: string; supabase: string; supabaseManagement: string };
  render: {
    configured: boolean;
    workspaceId: string;
    bandwidthGb: number | null;
    bandwidthLimitGb: number | null;
    bandwidthAvailableGb: number | null;
    bandwidthPercent: number | null;
    services: Array<{
      id:string; name:string; type:string; repo:string|null; branch:string|null; region:string|null;
      plan:string|null; url:string|null; suspended:string|null; autoDeploy:string|null;
      bandwidthGb:number|null; cpuCurrent:number|null; cpuLimit:number|null; cpuPercent:number|null;
      memoryCurrentMb:number|null; memoryLimitMb:number|null; memoryPercent:number|null;
      requestCount6h:number|null;
      metricsAvailable:{bandwidth:boolean;cpu:boolean;memory:boolean;requests:boolean};
      error:string|null;
    }>;
    error:string|null;
  };
  supabase: {
    configured:boolean; plan:string;
    databaseMb:number|null; databaseLimitMb:number|null; databaseAvailableMb:number|null; databasePercent:number|null;
    activeConnections:number; storageBytes:number; storageObjects:number;
    tables:Array<{schema:string;table:string;bytes:number;rows:number}>;
    syncQueue:{pending:number;failed:number;conflicts:number;applied_operations:number};
    companyMetrics:Array<{id:string;name:string;products:number;sales:number;employees:number;warehouses:number;stock_movements:number;data_records:number}>;
    apiRequests:number|null; apiRequestsLimit:number|null; apiRequestsSource:string; error:string|null;
  };
  limits:{renderMonthlyBandwidthGb:number|null;supabaseFreeDatabaseMb:number};
};

export async function loadInfrastructureUsage(): Promise<InfrastructureUsage> {
  const supabase = await assertPlatformAdmin();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("La sesión administrativa no está disponible.");

  const response = await fetch("https://palmyracrm.onrender.com/api/platform-usage", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || "No se pudo consultar el consumo de infraestructura.");
  return payload as InfrastructureUsage;
}

export async function loadSupportRequests(status?: string): Promise<PlatformSupportRequest[]> {
  const supabase = await assertPlatformAdmin();
  const { data, error } = await supabase.rpc("get_platform_support_requests", {
    p_status: status || null,
    p_limit: 100,
  });
  if (error) throw error;
  return Array.isArray(data) ? data as PlatformSupportRequest[] : [];
}
