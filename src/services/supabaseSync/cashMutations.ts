import { getSupabase } from '../../lib/supabase';
import { enqueueOfflineItem } from '../offlineQueue';
import type { OfflineActionType } from '../offlineQueue';
import { getActiveTenant, getEmployeeForIdentity } from '../tenant';
import type { CashRegisterSession } from '../../types';

async function onlineClient() {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase no está configurado.');
  if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('offline');
  return supabase;
}

const queue = async (type: OfflineActionType, data: unknown, id: string) => {
  await enqueueOfflineItem(type, data, id);
};

async function ensureCashRegister(supabase: any, companyId: string, warehouseId: string) {
  // cash_registers is protected by RLS. Provisioning/retrieval is performed
  // through a SECURITY DEFINER RPC so POS workers and admins do not depend on
  // direct table INSERT/SELECT permissions during offline replay.
  const { data, error } = await supabase.rpc('ensure_cash_register_secure', {
    p_company_id: companyId,
    p_warehouse_id: warehouseId,
  });
  if (error) throw error;
  if (!data) throw new Error('No se pudo obtener la caja del almacén.');
  return String(data);
}

export async function pushCashSessionToSupabase(session: CashRegisterSession): Promise<boolean> {
  try {
    const supabase = await onlineClient();
    const { companyId, authUserId } = await getActiveTenant();

    const [cashRegisterId, employeeRes, companyRes] = await Promise.all([
      ensureCashRegister(supabase, companyId, session.branchId),
      getEmployeeForIdentity(session.userId),
      supabase
        .from('companies')
        .select('default_currency_code')
        .eq('id', companyId)
        .single(),
    ]);

    if (companyRes.error) throw companyRes.error;

    const defaultCurrency = companyRes.data?.default_currency_code || 'CUP';
    const expected = Number.isFinite(Number(session.expectedBalance))
      ? Number(session.expectedBalance)
      : null;

    const physicalCashBase = (session.closingBalances || [])
      .filter((payment: any) => payment?.method === 'cash')
      .reduce(
        (sum: number, payment: any) =>
          sum + (Number(payment?.amount) || 0) * (Number(payment?.exchangeRate) || 1),
        0
      );

    const metadata = {
      closingBalances: session.closingBalances || [],
      expectedBalance: expected,
      isForcedClose: Boolean(session.isForcedClose),
      forcedCloseReason: session.forcedCloseReason || null,
      discrepancyNote: session.discrepancyNote || null,
      hasDiscrepancy: Boolean(session.hasDiscrepancy),
      discrepancyDetails: session.discrepancyDetails || [],
      discrepancyDeductionApplied: Number(session.discrepancyDeductionApplied) || 0,
      deductedFromSalary: Boolean(session.deductedFromSalary),
      aiDiagnostic: session.aiDiagnostic || null,
      matchingProductsAnalysis: session.matchingProductsAnalysis || [],
      auditStatus: session.auditStatus || 'pending_review',
      auditNotes: session.auditNotes || '',
      workerName: session.workerName || null,
      workingEmployeeIds: session.workingEmployeeIds || [],
    };

    const payload = {
      id: session.id,
      company_id: companyId,
      cash_register_id: cashRegisterId,
      employee_id: employeeRes?.id || null,
      opened_by: authUserId,
      closed_by: session.status !== 'open' ? authUserId : null,
      status: session.status,
      opened_at: session.openedAt,
      closed_at: session.closedAt || null,
      opening_amount: Number(session.openingAmount ?? session.openingBalance) || 0,
      expected_cash: expected,
      physical_cash: session.status === 'open' ? null : physicalCashBase,
      difference: expected === null ? 0 : physicalCashBase - expected,
      turn_number: Number(session.turnNumber) || null,
      metadata,
    };

    const { data: existing, error: lookupError } = await supabase
      .from('cash_sessions')
      .select('id')
      .eq('id', session.id)
      .eq('company_id', companyId)
      .maybeSingle();

    if (lookupError) throw lookupError;

    const result = existing?.id
      ? await supabase
          .from('cash_sessions')
          .update(payload)
          .eq('id', session.id)
          .eq('company_id', companyId)
      : await supabase.from('cash_sessions').insert(payload);

    if (result.error) throw result.error;

    await supabase
      .from('cash_movements')
      .delete()
      .eq('cash_session_id', session.id)
      .eq('company_id', companyId);

    if (session.movements?.length) {
      const rows = session.movements.map((movement: any) => ({
        id: movement.id,
        company_id: companyId,
        cash_session_id: session.id,
        movement_type: (() => {
          const raw = String(movement.type || '').toLowerCase();
          const aliases: Record<string, string> = {
            expense: 'cash_out',
            withdrawal: 'cash_out',
            ingreso: 'cash_in',
            income: 'cash_in',
            deposit: 'cash_in',
            entrada: 'cash_in',
            salida: 'cash_out',
            adjustment: 'closing_adjustment',
          };
          return aliases[raw] || (['sale', 'refund', 'cash_in', 'cash_out', 'opening', 'closing_adjustment'].includes(raw)
            ? raw
            : 'cash_out');
        })(),
        amount: Number(movement.amount) || 0,
        currency_code: movement.currencyCode || defaultCurrency,
        reference_id: null,
        note: movement.description || '',
        created_by: authUserId,
      }));

      const { error: movementError } = await supabase
        .from('cash_movements')
        .insert(rows);

      if (movementError) throw movementError;
    }

    return true;
  } catch (error) {
    await queue('cash_session', session, session.id);
    return false;
  }
}
