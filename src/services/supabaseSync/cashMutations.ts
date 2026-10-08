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

    // Los movimientos de caja se escriben por una RPC idempotente independiente.
    // No borramos/reinsertamos toda la sesión: hacerlo provocaba carreras entre
    // ingresos/egresos y turnos offline consecutivos.

    return true;
  } catch (error:any) {
    // Offline replay needs the real database error. Converting it to false
    // here made cash-close failures appear as "[object Object]" and blocked
    // every dependent salary settlement without an actionable cause.
    await queue('cash_session', session, session.id);
    if (error instanceof Error) throw error;
    const raw = error?.message || error?.details || error?.hint || error;
    const normalized = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const wrapped:any = new Error(normalized || 'No se pudo sincronizar el turno de caja.');
    wrapped.code = error?.code;
    wrapped.details = error?.details;
    wrapped.hint = error?.hint;
    throw wrapped;
  }
}

export async function pushCashMovementToSupabase(params:{
  id:string; sessionId:string; type:'income'|'expense'; amount:number;
  currencyCode:string; description?:string; throwOnError?: boolean;
}):Promise<boolean>{
  try{
    const supabase=await onlineClient();
    const {companyId}=await getActiveTenant();
    const {data,error}=await supabase.rpc('palmyra_record_cash_movement',{
      p_movement_id:params.id,
      p_company_id:companyId,
      p_cash_session_id:params.sessionId,
      p_movement_type:params.type,
      p_amount:Number(params.amount)||0,
      p_currency_code:params.currencyCode,
      p_note:params.description||''
    });
    if(error) throw error;
    if(data?.success===false) throw new Error(data?.message||'No se pudo registrar el movimiento de caja.');
    return true;
  }catch(error){
    // The normal UI keeps the boolean contract, but offline replay can request
    // the original database error so the queue records the real cause.
    if (params.throwOnError) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    return false;
  }
}

export async function deleteCashMovementFromSupabase(params:{id:string;sessionId:string}):Promise<boolean>{
  try{
    const supabase=await onlineClient();
    const {companyId}=await getActiveTenant();
    const {data,error}=await supabase.rpc('palmyra_delete_cash_movement',{
      p_movement_id:params.id,
      p_company_id:companyId,
      p_cash_session_id:params.sessionId
    });
    if(error) throw error;
    return data?.success!==false;
  }catch(error){
    return false;
  }
}

export async function pushCashSessionMetadataToSupabase(session:CashRegisterSession):Promise<boolean>{
  try{
    const supabase=await onlineClient();
    const {companyId}=await getActiveTenant();
    const metadata={
      closingBalances:session.closingBalances||[],
      expectedBalance:Number.isFinite(Number(session.expectedBalance))?Number(session.expectedBalance):null,
      isForcedClose:Boolean(session.isForcedClose),
      forcedCloseReason:session.forcedCloseReason||null,
      discrepancyNote:session.discrepancyNote||null,
      hasDiscrepancy:Boolean(session.hasDiscrepancy),
      discrepancyDetails:session.discrepancyDetails||[],
      discrepancyDeductionApplied:Number(session.discrepancyDeductionApplied)||0,
      deductedFromSalary:Boolean(session.deductedFromSalary),
      aiDiagnostic:session.aiDiagnostic||null,
      matchingProductsAnalysis:session.matchingProductsAnalysis||[],
      auditStatus:session.auditStatus||'pending_review',
      auditNotes:session.auditNotes||'',
      workerName:session.workerName||null,
      workingEmployeeIds:session.workingEmployeeIds||[],
    };
    const {data,error}=await supabase.rpc('palmyra_update_cash_session_metadata',{
      p_session_id:session.id,p_company_id:companyId,p_metadata:metadata
    });
    if(error) throw error;
    return data?.success!==false;
  }catch(error){
    return false;
  }
}
