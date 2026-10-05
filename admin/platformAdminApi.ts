import { getAdminSupabase } from "./supabase";

export type PlatformCompany = {
  id: string;
  name: string;
  slug?: string | null;
  account_status?: string | null;
  products?: number | null;
  employees?: number | null;
  warehouses?: number | null;
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

  const [{ data: companies, error: companiesError }, { data: requests, error: requestsError }] =
    await Promise.all([
      supabase.rpc("get_platform_companies"),
      supabase.rpc("get_pending_plan_requests"),
    ]);

  if (companiesError) throw new Error(companiesError.message);
  if (requestsError) throw new Error(requestsError.message);

  return {
    companies: (companies || []) as PlatformCompany[],
    requests: (requests || []) as PlanRequest[],
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
