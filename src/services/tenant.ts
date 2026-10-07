import { getSupabase } from '../lib/supabase';
import { getCachedSaaSContext } from './offlineAuthContext';
import { getPalmyraLocalScope } from './localScope';

export interface ActiveTenant {
  companyId: string;
  authUserId: string;
  defaultCurrencyCode: string;
}

let cached: ActiveTenant | null = null;

export function clearActiveTenant() {
  cached = null;
}

export async function getActiveTenant(forceRefresh = false): Promise<ActiveTenant> {
  if (cached && !forceRefresh) return cached;

  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');

  let authUserId: string | null = null;
  let offlineContext: ReturnType<typeof getCachedSaaSContext> = null;
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (!authError && authData.user) authUserId = authData.user.id;
  } catch {}

  if (!authUserId && typeof navigator !== 'undefined' && !navigator.onLine) {
    // Offline: usar exclusivamente la empresa/usuario que figura como alcance
    // activo. Nunca elegir "la caché más reciente" entre varias empresas.
    try {
      const scope = getPalmyraLocalScope();
      if (scope?.userId) offlineContext = getCachedSaaSContext(scope.userId);
    } catch {}
    if (!offlineContext || !offlineContext.companyId || !offlineContext.authUserId) {
      throw new Error('No existe una sesión local válida para trabajar sin conexión.');
    }
    cached = {
      companyId: offlineContext.companyId,
      authUserId: offlineContext.authUserId,
      defaultCurrencyCode: offlineContext.company?.default_currency_code || 'USD'
    };
    return cached;
  }

  if (!authUserId) throw new Error('Debes iniciar sesión para acceder a la empresa.');

  const authDataUserId = authUserId;

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('active_company_id')
    .eq('id', authDataUserId)
    .maybeSingle();
  if (profileError) throw profileError;

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
    if (membershipError) throw membershipError;
    companyId = membership?.company_id || null;
  }

  if (!companyId) throw new Error('Tu cuenta todavía no tiene una empresa configurada.');

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('id,default_currency_code')
    .eq('id', companyId)
    .maybeSingle();
  if (companyError) throw companyError;
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
