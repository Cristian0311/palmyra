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

const PRODUCTION_APP_URL = 'https://palmyracrm.onrender.com';

function getPalmyraAuthUrl(path: string) {
  const pathname = path.startsWith('/') ? path : `/${path}`;
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  return `${isLocal && typeof window !== 'undefined' ? window.location.origin : PRODUCTION_APP_URL}${pathname}`;
}

export async function signUpSaaSAccount(fullName: string, email: string, password: string, redirectPath = "/auth") {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  return supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: {
      data: { full_name: fullName.trim(), product: 'PALMYRA POS' },
      emailRedirectTo: getPalmyraAuthUrl(redirectPath)
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
  const supabase = getSupabase();
  if (!supabase) return null;

  if (forceRefresh) {
    const { error: refreshError } = await supabase.auth.getSession();
    if (refreshError) throw refreshError;
  }

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const authUser = authData.user;
  if (!authUser) return null;

  // Evitamos relaciones embebidas de PostgREST durante el arranque.
  // Primero resolvemos membresía y luego empresa, rol y plan por separado.
  const [{ data: profile, error: profileError }, { data: memberships, error: membershipError }] = await Promise.all([
    supabase.from('profiles').select('full_name,phone,active_company_id').eq('id', authUser.id).maybeSingle(),
    supabase.from('company_memberships').select('company_id,is_owner,status,joined_at').eq('user_id', authUser.id).eq('status','active').order('joined_at',{ascending:true}).limit(10)
  ]);
  if (profileError) throw new Error(`No se pudo cargar el perfil de la cuenta: ${profileError.message}`);
  if (membershipError) throw new Error(`No se pudo verificar la membresía de la empresa: ${membershipError.message}`);

  const membershipRows: any[] = memberships || [];
  const profileCompanyId = profile?.active_company_id || null;
  const activeMembership = (profileCompanyId
    ? membershipRows.find(row => row.company_id === profileCompanyId) || membershipRows[0]
    : membershipRows[0]) || null;
  const fallbackMembership = activeMembership || membershipRows[0] || null;
  const companyId = activeMembership?.company_id || null;
  const membershipStatus = activeMembership?.status || fallbackMembership?.status || null;

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

  const [
    { data: company, error: companyError },
    { data: userRoleRow, error: userRoleError },
    { data: locations, error: locationsError },
    { data: employee, error: employeeError },
    { data: subscription, error: subscriptionError }
  ] = await Promise.all([
    supabase.from('companies').select('id,name,slug,account_status,default_currency_code').eq('id',companyId).maybeSingle(),
    supabase.from('user_roles').select('role_id').eq('user_id',authUser.id).eq('company_id',companyId).maybeSingle(),
    supabase.from('user_locations').select('warehouse_id,is_default').eq('user_id',authUser.id).eq('company_id',companyId).order('is_default',{ascending:false}),
    supabase.from('employees').select('id,full_name,base_salary,active').eq('user_id',authUser.id).eq('company_id',companyId).maybeSingle(),
    supabase.from('subscriptions').select('id,status,plan_id,current_period_end,trial_ends_at').eq('company_id',companyId).order('updated_at',{ascending:false}).maybeSingle()
  ]);

  if (companyError) throw new Error(`No se pudo cargar la empresa: ${companyError.message}`);
  if (!company) throw new Error('La empresa de la cuenta no existe en PALMYRA.');
  if (userRoleError) throw new Error(`No se pudo cargar el rol de acceso: ${userRoleError.message}`);
  if (locationsError) throw new Error(`No se pudieron cargar los almacenes autorizados: ${locationsError.message}`);
  if (employeeError) throw new Error(`No se pudo comprobar el usuario operativo: ${employeeError.message}`);
  if (subscriptionError) throw new Error(`No se pudo comprobar la suscripción: ${subscriptionError.message}`);
  if (!subscription) throw new Error('La empresa existe, pero todavía no tiene una suscripción configurada.');

  const roleId = userRoleRow?.role_id || null;
  let roleKey = '';
  if (roleId) {
    const { data: roleRow, error: roleError } = await supabase.from('roles').select('key,name').eq('id',roleId).maybeSingle();
    if (roleError) throw new Error(`No se pudo cargar el rol: ${roleError.message}`);
    roleKey = roleRow?.key || '';
  }

  const isOwner = activeMembership?.is_owner === true;
  if (!roleKey) roleKey = isOwner ? 'admin' : 'employee';

  let warehouseIds = (locations || []).map((row:any) => row.warehouse_id).filter(Boolean);
  if (warehouseIds.length === 0 && isOwner) {
    const { data: fallbackWarehouses, error: fallbackWarehouseError } = await supabase
      .from('warehouses').select('id').eq('company_id',companyId).eq('active',true).order('created_at',{ascending:true}).limit(1);
    if (fallbackWarehouseError) throw new Error(`No se pudieron localizar los almacenes de la empresa: ${fallbackWarehouseError.message}`);
    warehouseIds = (fallbackWarehouses || []).map((row:any)=>row.id).filter(Boolean);
  }
  if (warehouseIds.length === 0) throw new Error('La cuenta no tiene un almacén autorizado para trabajar.');

  const permissionIds: string[] = [];
  if (roleId) {
    const { data: rolePermissionRows, error: rolePermissionError } = await supabase.from('role_permissions').select('permission_id').eq('role_id',roleId);
    if (rolePermissionError) throw new Error(`No se pudieron cargar los permisos del rol: ${rolePermissionError.message}`);
    permissionIds.push(...(rolePermissionRows || []).map((row:any)=>row.permission_id).filter(Boolean));
  }
  const permissionKeys: string[] = [];
  if (permissionIds.length) {
    const { data: permissionRows, error: permissionsError } = await supabase.from('permissions').select('id,key').in('id',permissionIds);
    if (permissionsError) throw new Error(`No se pudieron cargar los permisos: ${permissionsError.message}`);
    permissionKeys.push(...(permissionRows || []).map((row:any)=>row.key).filter(Boolean));
  }

  const granularPermissions = [...new Set(permissionKeys)];
  const permissions = granularPermissions.length > 0 ? granularPermissions : (roleKey === 'admin'
    ? ['pos.access','reports.view','inventory.manage','products.manage','customers.manage','employees.manage','suppliers.manage','settings.manage','roles.manage']
    : ['pos.access']);
  if (roleKey === 'admin') {
    if (!permissions.includes('cash.open')) permissions.push('cash.open');
    if (!permissions.includes('cash.close')) permissions.push('cash.close');
  }

  // El estado del dispositivo no debe impedir que el propietario entre al CRM.
  // El registro/activación se reintenta después desde App.tsx.
  const { data: deviceActiveData, error: deviceActiveError } = await supabase.rpc('is_current_device_active', { p_company_id: companyId });
  if (deviceActiveError) {
    console.warn('[PALMYRA] No se pudo comprobar el dispositivo durante el arranque; continuamos y lo reintentamos en segundo plano.', deviceActiveError);
  }
  const deviceActive = deviceActiveError ? true : deviceActiveData !== false;

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

  const { data: plan, error: planError } = await supabase
    .from('plans')
    .select('code,name,limits,features')
    .eq('id', subscription.plan_id)
    .maybeSingle();
  if (planError) throw new Error(`No se pudo cargar el plan de la empresa: ${planError.message}`);
  if (!plan) throw new Error('La suscripción existe, pero su plan no está disponible.');

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
    account_status: string;
    trial_ends_at?: string | null;
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
    redirectTo: getPalmyraAuthUrl("/auth?recovery=1")
  });
}

export async function updateSaaSPassword(password: string) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  return supabase.auth.updateUser({ password });
}
