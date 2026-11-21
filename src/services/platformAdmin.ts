import {getSupabase} from "../lib/supabase";

export interface PlatformSupportSettings {
  whatsapp_number: string | null;
  support_email: string | null;
  privacy_url: string | null;
  facebook_url: string | null;
  whatsapp_channel_url: string | null;
}

export interface PlatformSupportRequest {
  id: string;
  company_id: string;
  company_name: string;
  request_type: string;
  subject: string;
  message: string;
  contact_phone: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export async function loadPlatformAdminSnapshot(){
  const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
  const [
    {data:companies,error:companiesError},
    {data:requests,error:requestsError},
    {data:supportSettings,error:supportSettingsError},
    {data:supportRequests,error:supportRequestsError}
  ]=await Promise.all([
    supabase.rpc("get_platform_companies"),
    supabase.rpc("get_pending_plan_requests",{p_status:"pending",p_limit:300}),
    supabase.rpc("get_platform_support_settings"),
    supabase.rpc("get_platform_support_requests",{p_status:null,p_limit:50})
  ]);
  if(companiesError||requestsError||supportSettingsError||supportRequestsError) {
    throw companiesError||requestsError||supportSettingsError||supportRequestsError;
  }
  return {
    companies:(companies||[]) as any[],
    requests:(requests||[]) as any[],
    supportSettings:(supportSettings||{}) as PlatformSupportSettings,
    supportRequests:(supportRequests||[]) as PlatformSupportRequest[]
  };
}

export async function setPlatformSupportSettings(settings: PlatformSupportSettings){
  const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
  const {data,error}=await supabase.rpc("set_platform_support_settings",{
    p_whatsapp_number:settings.whatsapp_number?.trim()||null,
    p_support_email:settings.support_email?.trim()||null,
    p_privacy_url:settings.privacy_url?.trim()||null,
    p_facebook_url:settings.facebook_url?.trim()||null,
    p_whatsapp_channel_url:settings.whatsapp_channel_url?.trim()||null
  });
  if(error) throw error;
  return (data||{}) as PlatformSupportSettings;
}
export async function approvePlanRequest(input:{
  requestId:string;receivedAmount:number;receivedCurrency:'CUP'|'USD';reference:string;
}){
  const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
  const reference=String(input.reference||'').trim();
  if(!Number.isFinite(input.receivedAmount)||input.receivedAmount<=0) throw new Error("Indica el importe realmente recibido.");
  if(!reference) throw new Error("La referencia del pago es obligatoria.");
  const {data,error}=await supabase.rpc("approve_plan_request_v3",{
    p_request_id:input.requestId,
    p_received_amount:input.receivedAmount,
    p_received_currency:input.receivedCurrency,
    p_reference:reference
  });
  if(error) throw error; return data;
}
export async function rejectPlanRequest(requestId:string,note=""){
  const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
  const {data,error}=await supabase.rpc("reject_plan_request",{p_request_id:requestId,p_note:note||null});
  if(error) throw error; return data;
}
export async function setPlatformCompanyStatus(companyId:string,status:"active"|"suspended"|"setup"|"pending_payment"){
  const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
  const {data,error}=await supabase.rpc("set_platform_company_status",{p_company_id:companyId,p_status:status});
  if(error) throw error; return data;
}
export async function setSupportRequestStatus(requestId:string,status:"open"|"in_progress"|"resolved"|"closed"){
  const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
  const {data,error}=await supabase.rpc("set_platform_support_request_status",{p_request_id:requestId,p_status:status});
  if(error) throw error; return data;
}


const PLATFORM_ERRORS: Record<string, string> = {
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
  payment_amount_below_quote: "El importe recibido en USD es menor que la cotización.",
  payment_currency_mismatch: "La moneda no coincide con el método de pago elegido.",
  legacy_payment_method_requires_review: "Solicitud antigua con método no reconocido. Recházala y pide una nueva.",
  request_owner_no_longer_active: "El propietario de la empresa ya no está activo.",
  company_access_denied: "La empresa está suspendida: reactívala antes de aprobar un plan.",
  plan_warehouse_limit: "La empresa supera el límite de almacenes de ese plan.",
  plan_product_limit: "La empresa supera el límite de productos de ese plan.",
  plan_employee_limit: "La empresa supera el límite de empleados de ese plan.",
  user_not_found: "El usuario ya no existe.",
};

export function platformAdminError(error: unknown) {
  const message = String((error as any)?.message ?? error ?? "");
  if (PLATFORM_ERRORS[message]) return PLATFORM_ERRORS[message];
  if (/could not find the function|schema cache/i.test(message) || (error as any)?.code === "PGRST202") {
    return "Falta aplicar la actualización de la base de datos para esta función administrativa.";
  }
  if (/permission denied|not authorized|JWT/i.test(message)) return PLATFORM_ERRORS.permission_denied;
  if (/failed to fetch|network|load failed|timeout/i.test(message)) return "No se pudo conectar con Supabase. Revisa tu conexión.";
  return message || "No se pudo completar la operación.";
}

export async function loadPlatformUsage() {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("La sesión administrativa no está disponible.");
  const response = await fetch("/api/platform-usage", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || "No se pudo consultar el consumo de infraestructura.");
  return payload;
}
