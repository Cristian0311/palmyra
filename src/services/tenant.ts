import { getSupabase } from '../lib/supabase';
import { getCachedSaaSContext } from './offlineAuthContext';
import { getPalmyraLocalScope } from './localScope';
import { isBrowserOffline, isTransientNetworkError } from './offlineNetwork';

export interface ActiveTenant {
  companyId: string;
  authUserId: string;
  defaultCurrencyCode: string;
}

let cached: ActiveTenant | null = null;

function readCachedTenant(expectedUserId?: string | null): ActiveTenant | null {
  const scope = getPalmyraLocalScope();
  if (!scope?.userId || !scope.companyId) return null;
  if (expectedUserId && scope.userId !== expectedUserId) return null;
  const context = getCachedSaaSContext(scope.userId);
  if (!context || context.authUserId !== scope.userId || context.companyId !== scope.companyId) return null;
  if (!context.companyId) return null;
  return {
    companyId: context.companyId,
    authUserId: context.authUserId,
    defaultCurrencyCode: context.company?.default_currency_code || 'USD'
  };
}

export function clearActiveTenant() {
  cached = null;
}

export async function getActiveTenant(forceRefresh = false): Promise<ActiveTenant> {
  const supabase = getSupabase();
  if (!supabase) {
    const localTenant = readCachedTenant();
    if (isBrowserOffline() && localTenant) return (cached = localTenant);
    throw new Error('Supabase no está configurado.');
  }

  let authUserId: string | null = null;
  let authRequestError: unknown = null;
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (!authError && authData.user) authUserId = authData.user.id;
    else authRequestError = authError;
  } catch (error) {
    authRequestError = error;
  }

  if (!authUserId && (isBrowserOffline() || getPalmyraLocalScope()?.offlineSession === true || isTransientNetworkError(authRequestError))) {
    // Offline: usar exclusivamente la empresa/usuario que figura como alcance
    // activo. Nunca elegir "la caché más reciente" entre varias empresas.
    const localTenant = readCachedTenant();
    if (localTenant) return (cached = localTenant);
  }

  if (!authUserId) throw new Error('Debes iniciar sesión para acceder a la empresa.');

  // El tenant cacheado es global al módulo. Nunca reutilizarlo si la sesión de
  // Supabase cambió (por ejemplo, al entrar con una cuenta de empleado).
  if (cached && !forceRefresh && cached.authUserId === authUserId) return cached;

  const authDataUserId = authUserId;

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('active_company_id')
    .eq('id', authDataUserId)
    .maybeSingle();
  if (profileError) {
    if (isBrowserOffline() || getPalmyraLocalScope()?.offlineSession === true || isTransientNetworkError(profileError)) {
      const localTenant = readCachedTenant(authDataUserId);
      if (localTenant) return (cached = localTenant);
    }
    throw profileError;
  }

  let companyId = profile?.active_company_id || null;
  if (!companyId) {
    const { data: membership, error: membershipError } = await supabase
      .from('company_memberships')
      .select('company_id')
      .eq('user_id', authDataUserId)
      .eq('status', 'active')
      .order('joined_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (membershipError) {
      if (isBrowserOffline() || getPalmyraLocalScope()?.offlineSession === true || isTransientNetworkError(membershipError)) {
        const localTenant = readCachedTenant(authDataUserId);
        if (localTenant) return (cached = localTenant);
      }
      throw membershipError;
    }
    companyId = membership?.company_id || null;
  }

  if (!companyId) throw new Error('Tu cuenta todavía no tiene una empresa configurada.');

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('id,default_currency_code')
    .eq('id', companyId)
    .maybeSingle();
  if (companyError) {
    if (isBrowserOffline() || getPalmyraLocalScope()?.offlineSession === true || isTransientNetworkError(companyError)) {
      const localTenant = readCachedTenant(authDataUserId);
      if (localTenant) return (cached = localTenant);
    }
    throw companyError;
  }
  if (!company) throw new Error('La empresa activa no existe.');

  cached = {
    companyId: company.id,
    authUserId: authDataUserId,
    defaultCurrencyCode: company.default_currency_code || 'USD'
  };
  return cached;
}

export async function getEmployeeForIdentity(identityId?: string | null) {
  const tenant = await getActiveTenant();
  const supabase = getSupabase()!;
  const id = identityId || tenant.authUserId;

  const { data } = await supabase
    .from('employees')
    .select('id,full_name,base_salary,active,user_id,employee_code,role_id')
    .eq('company_id', tenant.companyId)
    .eq('active', true)
    .or(`id.eq.${id},user_id.eq.${id}`)
    .limit(1)
    .maybeSingle();

  return data || null;
}
