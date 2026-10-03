import {getSupabase} from "../lib/supabase";

export async function loadPlatformAdminSnapshot(){
  const supabase=getSupabase(); if(!supabase) throw new Error("Supabase no está configurado.");
  const [{data:companies,error:companiesError},{data:requests,error:requestsError}]=await Promise.all([
    supabase.rpc("get_platform_companies"),
    supabase.rpc("get_pending_plan_requests")
  ]);
  if(companiesError||requestsError) throw companiesError||requestsError;
  return {companies:(companies||[]) as any[],requests:(requests||[]) as any[]};
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
