import { getSupabase } from "../lib/supabase";
import { loadSaaSContext } from "./saas";

export interface SubscriptionPlan {
  id: string;
  code: string;
  name: string;
  monthly_price: number;
  billing_currency_code: string;
  trial_days: number;
  limits: Record<string, unknown>;
  features: Record<string, unknown>;
  active: boolean;
}

export async function loadSubscriptionOverview() {
  const supabase=getSupabase();
  if(!supabase) throw new Error("Supabase no está configurado.");
  const ctx=await loadSaaSContext(true);
  if(!ctx?.companyId) throw new Error("No hay una empresa activa.");

  const [{data:plans,error:plansError},{data:request,error:requestError},{data:invoices,error:invoiceError}]=await Promise.all([
    supabase.from("plans").select("id,code,name,monthly_price,billing_currency_code,trial_days,limits,features,active").eq("active",true).neq("code","trial").order("monthly_price",{ascending:true}),
    supabase.rpc("get_my_plan_request",{p_company_id:ctx.companyId}),
    ctx.isOwner
      ? supabase.rpc("get_my_billing_invoices",{p_company_id:ctx.companyId})
      : Promise.resolve({data:[],error:null} as any)
  ]);
  if(plansError) throw plansError;
  if(requestError) throw requestError;
  if(invoiceError) throw invoiceError;

  const {data:subscription,error:subscriptionError}=await supabase
    .from("subscriptions")
    .select("id,status,starts_at,trial_ends_at,current_period_start,current_period_end,cancelled_at,plans!inner(id,code,name,monthly_price,billing_currency_code,limits,features)")
    .eq("company_id",ctx.companyId)
    .order("updated_at",{ascending:false})
    .limit(1)
    .maybeSingle();
  if(subscriptionError) throw subscriptionError;

  return {ctx,plans:(plans||[]) as SubscriptionPlan[],request:(request||null),subscription,invoices:(invoices||[]) as any[]};
}

export async function selectSubscriptionPlan(planId:string) {
  const supabase=getSupabase();
  if(!supabase) throw new Error("Supabase no está configurado.");
  const ctx=await loadSaaSContext(true);
  if(!ctx?.companyId) throw new Error("No hay una empresa activa.");
  const {data,error}=await supabase.rpc("select_company_plan",{p_company_id:ctx.companyId,p_plan_id:planId});
  if(error) throw error;
  return data;
}
