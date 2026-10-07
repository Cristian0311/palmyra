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
    supabase.rpc("get_pending_plan_requests"),
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
export async function approvePlanRequest(requestId:string){
  const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
  const {data,error}=await supabase.rpc("approve_plan_request",{p_request_id:requestId});
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
