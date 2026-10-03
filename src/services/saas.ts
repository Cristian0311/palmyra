import type { User } from '../types';
import { getSupabase } from '../lib/supabase';
import { slugifyCompany, type PlanCode } from '../config/saas';
import { setPalmyraLocalScope, clearPalmyraLocalScope } from './localScope';

export interface SaaSContext {
  authUserId: string;
  user: User;
  companyId: string | null;
  company: { id: string; name: string; slug: string; account_status: string; default_currency_code: string } | null;
  availableCompanies: Array<{ id: string; name: string; slug: string; account_status: string; isOwner: boolean }>;
  membershipStatus: string | null;
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
    supabase.from('company_memberships').select('company_id,is_owner,status,companies!inner(id,name,slug,account_status,default_currency_code)').eq('user_id', authUser.id).order('joined_at',{ascending:true})
  ]);
  if (profileError || membershipError) throw profileError || membershipError;

  const membershipRows: any[] = memberships || [];
  const activeMembership = membershipRows.find(row => row.status === 'active' && row.company_id === profile?.active_company_id)
    || membershipRows.find(row => row.status === 'active')
    || null;
  const fallbackMembership = membershipRows.find(row => row.company_id === profile?.active_company_id) || membershipRows[0] || null;
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
      availableCompanies: [],
      membershipStatus: null,
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

  const roleKey = (userRole as any)?.roles?.key || (membership?.is_owner ? 'admin' : 'employee');
  const warehouseIds = (locations || []).map((row:any) => row.warehouse_id).filter(Boolean);
  const granularPermissions = (permissionRows || []).map((row:any) => (row as any)?.permissions?.key).filter(Boolean);
  const permissions = granularPermissions.length > 0 ? granularPermissions : (roleKey === 'admin'
    ? ['pos.access','reports.view','inventory.manage','products.manage','customers.manage','employees.manage','suppliers.manage','settings.manage','roles.manage','cash.open']
    : ['pos.access']);

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
    availableCompanies: membershipRows.filter(row => row.status === 'active').map(row => ({
      id: row.company_id,
      name: row.companies?.name || 'Empresa',
      slug: row.companies?.slug || '',
      account_status: row.companies?.account_status || 'setup',
      isOwner: row.is_owner === true
    })),
    membershipStatus,
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
}) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');

  const payload = {
    p_name: input.name.trim(),
    p_slug: slugifyCompany(input.name),
    p_country_code: 'PR',
    p_default_currency_code: 'USD',
    p_timezone: 'America/Puerto_Rico',
    p_warehouse_name: input.warehouseName.trim(),
    p_plan_code: input.planCode,
    p_employee_name: input.employeeName?.trim() || null,
    p_employee_code: input.employeeCode?.trim() || null
  };

  const { data, error } = await supabase.rpc('palmyra_onboard_company', payload);
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


export async function switchActiveCompany(companyId: string) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  const { data, error } = await supabase.rpc('set_active_company', { p_company_id: companyId });
  if (error) throw error;
  const ctx = await loadSaaSContext(true);
  if (ctx?.companyId) setPalmyraLocalScope(ctx.authUserId, ctx.companyId);
  return ctx || data;
}
