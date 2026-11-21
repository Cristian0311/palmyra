import { getSupabase } from '../lib/supabase';
import { loadSaaSContext } from './saas';
import { isAcquisitionPaymentMethod, isBillingMonths, slugifyCompany, type AcquisitionPaymentMethod, type BillingMonths, type PlanCode } from '../config/saas';

export interface SubscriptionPlan {
  id: string;
  code: string;
  name: string;
  monthly_price: number;
  billing_currency_code?: string | null;
  trial_days: number;
  limits: Record<string, unknown>;
  features: Record<string, unknown>;
  active: boolean;
}

export async function loadSubscriptionOverview() {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  const ctx = await loadSaaSContext(true);
  if (!ctx?.companyId) throw new Error('No hay una empresa activa.');
  const [plans, request, invoices, subscription] = await Promise.all([
    supabase.from('plans').select('id,code,name,monthly_price,billing_currency_code,trial_days,limits,features,active').eq('active', true).in('code', ['free', 'starter', 'growth', 'pro']).order('monthly_price', { ascending: true }),
    ctx.isOwner ? supabase.rpc('get_my_plan_request', { p_company_id: ctx.companyId }) : Promise.resolve({ data: null, error: null }),
    ctx.isOwner ? supabase.rpc('get_my_billing_invoices', { p_company_id: ctx.companyId }) : Promise.resolve({ data: [], error: null }),
    supabase.from('subscriptions').select('id,status,starts_at,trial_ends_at,current_period_start,current_period_end,grace_ends_at,cancelled_at,plans!inner(id,code,name,monthly_price,billing_currency_code,limits,features)').eq('company_id', ctx.companyId).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const result of [plans, request, invoices, subscription]) if (result.error) throw result.error;
  return { ctx, plans: (plans.data || []) as SubscriptionPlan[], request: request.data, subscription: subscription.data, invoices: (invoices.data || []) as any[] };
}

export async function selectSubscriptionPlan(planId: string, paymentMethod: AcquisitionPaymentMethod = 'cup_cash', months: BillingMonths = 1) {
  if (!isAcquisitionPaymentMethod(paymentMethod)) throw new Error('Método de pago no válido.');
  if (!isBillingMonths(months)) throw new Error('Selecciona 1, 3, 6 o 12 meses.');
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  const ctx = await loadSaaSContext(true);
  if (!ctx?.companyId || !ctx.isOwner) throw new Error('Solo el propietario puede solicitar o renovar el plan.');
  // No fallback to the legacy RPC: an undeployed backend must not silently start a trial.
  const { data, error } = await supabase.rpc('request_company_plan_v3', {
    p_company_id: ctx.companyId, p_plan_id: planId, p_payment_method: paymentMethod,
    p_months: months,
  });
  if (error) throw error;
  return data;
}

export async function createCompanyAcquisition(input: {
  name: string; warehouseName: string; planCode: PlanCode;
  paymentMethod: AcquisitionPaymentMethod; months: BillingMonths;
}) {
  if (!isAcquisitionPaymentMethod(input.paymentMethod) || !isBillingMonths(input.months)) throw new Error('Solicitud de plan no válida.');
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  const { data, error } = await supabase.rpc('palmyra_onboard_company_v3', {
    p_name: input.name.trim(), p_slug: slugifyCompany(input.name), p_warehouse_name: input.warehouseName.trim(),
    p_plan_code: input.planCode, p_payment_method: input.paymentMethod,
    p_months: input.months,
  });
  if (error) {
    const code = String((error as any).code || '');
    const message = String(error.message || '');
    if (code === 'PGRST202' || /palmyra_onboard_company_v3/i.test(message)) {
      throw new Error('La base de datos todavía no tiene habilitado el alta del plan Gratis. Un administrador debe aplicar la migración de planes antes de crear empresas.');
    }
    if (message.includes('free_plan_not_deployed')) {
      throw new Error('El plan Gratis aún no está publicado en el catálogo. Contacta al administrador de la plataforma.');
    }
    throw error;
  }
  return data as { company_id: string; warehouse_id: string; request_id?: string; account_status: string };
}
