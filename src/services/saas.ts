import type { User } from '../types';
import { getSupabase } from '../lib/supabase';
import { slugifyCompany, type PlanCode } from '../config/saas';
import { setPalmyraLocalScope, clearPalmyraLocalScope } from './localScope';

export interface SaaSContext {
  authUserId: string;
  user: User;
  companyId: string | null;
  company: { id: string; name: string; slug: string; account_status: string; default_currency_code: string } | null;
  membershipStatus: string | null;
  isOwner: boolean;
  deviceActive: boolean;
  roleKey: string;
  warehouseIds: string[];
  subscription: {
    id: string;
    status: string;
    planCode: string;
    planName: string;
    limits: { warehouses?: number; employees?: number; products?: number; reports?: string; support?: string };
    currentPeriodEnd?: string | null;
    trialEndsAt?: string | null;
  } | null;
}

const mapRole = (key: string): 'admin' | 'employee' => key === 'admin' ? 'admin' : 'employee';

export async function signUpSaaSAccount(fullName: string, email: string, password: string, redirectPath = "/auth") {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  const origin = window.location.origin;
  return supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      data: { full_name: fullName.trim(), product: 'PALMYRA POS' },
      emailRedirectTo: `${origin}${redirectPath.startsWith("/") ? redirectPath : `/${redirectPath}`}`
    }
  });
}

export async function signInSaaSAccount(email: string, password: string) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  return supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password
  });
}

export async function signOutSaaSAccount() {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function getAuthenticatedUser() {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user || null;
}

export async function loadSaaSContext(forceRefresh = false): Promise<SaaSContext | null> {
  void forceRefresh;
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data: authData } = await supabase.auth.getUser();
  const authUser = authData.user;
  if (!authUser) return null;

  const [{ data: profile, error: profileError }, { data: memberships, error: membershipError }] = await Promise.all([
    supabase.from('profiles').select('full_name,phone,active_company_id').eq('id', authUser.id).maybeSingle(),
    supabase.from('company_memberships').select('company_id,is_owner,status,companies!inner(id,name,slug,account_status,default_currency_code)').eq('user_id', authUser.id).limit(1)
  ]);
  if (profileError || membershipError) throw profileError || membershipError;

  const membershipRows: any[] = memberships || [];
  const activeMembership = membershipRows.find(row => row.status === 'active') || null;
  const fallbackMembership = membershipRows[0] || null;
  const companyId = activeMembership?.company_id || null;
  const membershipStatus = activeMembership?.status || fallbackMembership?.status || null;
  if (!companyId) {
    clearPalmyraLocalScope();
    return {
      authUserId: authUser.id,
      user: {
        id: authUser.id,
        name: profile?.full_name || authUser.user_metadata?.full_name || authUser.email || 'Administrador',
        email: authUser.email || '',
        role: 'admin',
        baseSalary: 0,
        permissions: [],
        isActive: true
      },
      companyId: null,
      company: null,
      membershipStatus,
      isOwner: Boolean(fallbackMembership?.is_owner),
      deviceActive: true,
      roleKey: 'admin',
      warehouseIds: [],
      subscription: null
    };
  }

  const [{ data: company }, { data: userRole }, { data: locations }, { data: employee }, { data: subscription }, { data: permissionRows }] = await Promise.all([
    supabase.from('companies').select('id,name,slug,account_status,default_currency_code').eq('id',companyId).maybeSingle(),
    supabase.from('user_roles').select('role_id,roles!inner(key,name)').eq('user_id',authUser.id).eq('company_id',companyId).maybeSingle(),
    supabase.from('user_locations').select('warehouse_id,is_default').eq('user_id',authUser.id).eq('company_id',companyId).order('is_default',{ascending:false}),
    supabase.from('employees').select('id,full_name,base_salary,active').eq('user_id',authUser.id).eq('company_id',companyId).maybeSingle(),
    supabase.from('subscriptions').select('id,status,plan_id,current_period_end,trial_ends_at,plans!inner(code,name,limits,features)').eq('company_id',companyId).order('updated_at',{ascending:false}).maybeSingle(),
    supabase.from('role_permissions').select('permissions!inner(key)').eq('role_id', (userRole as any)?.role_id || '00000000-0000-0000-0000-000000000000')
  ]);

  const isOwner = activeMembership?.is_owner === true;
  const roleKey = (userRole as any)?.roles?.key || (isOwner ? 'admin' : 'employee');
  const warehouseIds = (locations || []).map((row:any) => row.warehouse_id).filter(Boolean);
  const granularPermissions = (permissionRows || []).map((row:any) => (row as any)?.permissions?.key).filter(Boolean);
  const permissions = granularPermissions.length > 0 ? granularPermissions : (roleKey === 'admin'
    ? ['pos.access','reports.view','inventory.manage','products.manage','customers.manage','employees.manage','suppliers.manage','settings.manage','roles.manage','cash.open']
    : ['pos.access']);

  const { data: deviceActiveData, error: deviceActiveError } = await supabase.rpc('is_current_device_active', { p_company_id: companyId });
  if (deviceActiveError) throw deviceActiveError;
  const deviceActive = deviceActiveData !== false;

  const user: User = {
    id: authUser.id,
    name: employee?.full_name || profile?.full_name || authUser.user_metadata?.full_name || authUser.email || 'Usuario',
    email: authUser.email || '',
    role: mapRole(roleKey),
    baseSalary: Number(employee?.base_salary) || 0,
    permissions,
    isActive: employee?.active !== false,
    branchId: warehouseIds[0],
    allowedBranches: warehouseIds
  };

  const plan = (subscription as any)?.plans;
  const trialEndsAt = subscription?.trial_ends_at || null;
  const currentPeriodEnd = subscription?.current_period_end || null;
  const nowMs = Date.now();
  const trialExpired = subscription?.status === 'trialing' && !!trialEndsAt && new Date(trialEndsAt).getTime() <= nowMs;
  const paidPeriodExpired = subscription?.status === 'active' && !!currentPeriodEnd && new Date(currentPeriodEnd).getTime() <= nowMs;
  const effectiveCompany = company
    ? { ...company, account_status: (company.account_status === 'active' && (trialExpired || paidPeriodExpired)) ? 'pending_payment' : company.account_status }
    : null;

  return {
    authUserId: authUser.id,
    user,
    companyId,
    company: effectiveCompany,
    membershipStatus,
    isOwner,
    deviceActive,
    roleKey,
    warehouseIds,
    subscription: subscription && plan ? {
      id: subscription.id,
      status: subscription.status,
      planCode: plan.code,
      planName: plan.name,
      limits: plan.limits || {},
      currentPeriodEnd,
      trialEndsAt
    } : null
  };
}

export async function createCompanyOnboarding(input: {
  name: string;
  warehouseName: string;
  employeeName?: string;
  employeeCode?: string;
  planCode: PlanCode;
  paymentMethod?: 'manual_cash' | 'manual_bank_transfer';
}) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');

  const payload = {
    p_name: input.name.trim(),
    p_slug: slugifyCompany(input.name),
    p_country_code: 'CU',
    p_default_currency_code: 'CUP',
    p_timezone: 'America/Havana',
    p_warehouse_name: input.warehouseName.trim(),
    p_plan_code: input.planCode,
    p_employee_name: input.employeeName?.trim() || null,
    p_employee_code: input.employeeCode?.trim() || null
  };

  const { data, error } = await supabase.rpc('palmyra_onboard_company_with_payment', { ...payload, p_payment_method: input.paymentMethod || 'manual_cash' });
  if (error) throw error;
  return data as {
    company_id: string;
    warehouse_id: string;
    employee_id?: string | null;
    subscription_id: string;
    plan_code: string;
    current_period_end: string;
  };
}

export async function selectCompanyPlan(companyId: string, planCode: PlanCode) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  const { data: plan, error: planError } = await supabase.from('plans').select('id,code').eq('code',planCode).maybeSingle();
  if (planError || !plan) throw planError || new Error('Plan no encontrado.');
  const { data, error } = await supabase.rpc('select_company_plan', { p_company_id: companyId, p_plan_id: plan.id });
  if (error) throw error;
  return data;
}



export async function requestSaaSPasswordReset(email: string) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  return supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo: window.location.origin + "/auth?recovery=1"
  });
}

export async function updateSaaSPassword(password: string) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  return supabase.auth.updateUser({ password });
}
