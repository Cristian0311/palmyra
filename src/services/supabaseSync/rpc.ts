import { getSupabase } from '../../lib/supabase';
import { getActiveTenant, getEmployeeForIdentity } from '../tenant';
import type { CashRegisterSession, Transaction, SalarySettlement, InventoryTransfer } from '../../types';

export type RpcFailure = { success: false; error: string; errorCode?: string; data?: any; conflict?: boolean };
export type RpcSuccess<T = any> = { success: true; data: T; error?: string; errorCode?: string };
export type RpcResult<T = any> = RpcSuccess<T> | RpcFailure;

function errorResult(e:any): RpcFailure { return { success:false, error:e?.message || String(e), errorCode:e?.code || e?.status || undefined, data:undefined }; }
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function logAuditEvent(entry:{userId?:string;action:string;entityType:string;entityId?:string;oldData?:any;newData?:any;meta?:any}){
  try { const supabase=getSupabase(); if(!supabase)return; const {companyId,authUserId}=await getActiveTenant(); await supabase.from('audit_logs').insert({id:crypto.randomUUID(),company_id:companyId,user_id:entry.userId||authUserId,action:entry.action,entity_type:entry.entityType,entity_id:entry.entityId||null,before_data:entry.oldData||null,after_data:entry.newData||null,metadata:entry.meta||null}); } catch(e){ console.warn('[PALMYRA] audit log failed',e); }
}

async function rpc(name:string,args:any){
  const supabase=getSupabase(); if(!supabase)throw new Error('Supabase no configurado');
  const {data,error}=await supabase.rpc(name,args); if(error)throw error; if(data&&data.success===false) { const e:any=new Error(data.message||data.error||'Operación rechazada'); e.code=data.code||data.error_code; throw e; } return data;
}

export async function callAdjustInventoryRPC(params:{
  operationId:string;
  companyId?:string;
  warehouseId:string;
  productId:string;
  variantId?:string|null;
  delta:number;
  expectedQuantity?:number|null;
  minQuantity?:number;
  notes?:string;
}):Promise<RpcResult<{quantity:number;already_applied?:boolean;conflict?:boolean}>>{
  try{
    const {companyId}=await getActiveTenant();
    const data=await rpc('palmyra_adjust_inventory',{
      p_operation_id:params.operationId,
      p_company_id:companyId,
      p_warehouse_id:params.warehouseId,
      p_product_id:params.productId,
      p_variant_id:params.variantId||null,
      p_delta:Number(params.delta)||0,
      p_expected_quantity:params.expectedQuantity ?? null,
      p_min_quantity:Number(params.minQuantity)||0,
      p_notes:params.notes||null
    });
    if(data?.success===false){
      return {
        success:false,
        conflict:Boolean(data.conflict),
        error:String(data.error||data.message||'El ajuste de inventario fue rechazado.')
      };
    }
    return {success:true,data:data};
  }catch(e:any){return errorResult(e);}
}

export async function callOpenSessionRPC(session:CashRegisterSession){ return callOpenSessionRPCWithId(session); }

export async function callOpenSessionRPCWithId(session:CashRegisterSession){
  try { const {companyId}=await getActiveTenant(); const data=await rpc('palmyra_open_cash_session',{p_session_id:session.id,p_company_id:companyId,p_warehouse_id:session.branchId,p_user_id:session.userId,p_opening_amount:Number(session.openingAmount??session.openingBalance)||0,p_opened_at:session.openedAt}); return {success:true as const,error:undefined,errorCode:undefined,data}; } catch(e:any){ return errorResult(e); }
}

export async function callProcessTransactionRPC(tx:Transaction){
  try { const {companyId,authUserId,defaultCurrencyCode}=await getActiveTenant(); const supabase=getSupabase()!; const items=(tx.items||[]).map(item=>{const prod=typeof item.product==='string'?null:item.product;return {id:item.id,product_id:typeof item.product==='string'?item.product:prod?.id,product_name:prod?.name||null,quantity:Number(item.quantity)||0,price:Number(item.price??prod?.price)||0,total:Number(item.total)||((Number(item.price??prod?.price)||0)*(Number(item.quantity)||0)),variant_label:item.variantLabel||null,variant_id:null,serial_number:item.serialNumber||null,discount:0,tax:0};});
    const payments=(tx.payments||[]).map((p:any)=>({method:p.method==='transfer'?'bank_transfer':p.method||'cash',currency_code:p.currencyCode||null,amount:Number(p.amount)||0,exchange_rate:Number(p.exchangeRate)||1,reference:p.reference||null}));
    // Older queued tickets used PALMYRA-TK... as their local id. Supabase
    // sales.id is UUID, so generate a new remote UUID for those legacy items.
    // The readable ticket number remains in metadata/UI.
    const remoteSaleId = isUuid(tx.remoteId) ? tx.remoteId : (isUuid(tx.id) ? tx.id : crypto.randomUUID());
    const data=await rpc('palmyra_record_sale',{p_sale_id:remoteSaleId,p_company_id:companyId,p_warehouse_id:tx.branchId,p_cash_session_id:tx.sessionId||null,p_user_id:tx.userId||authUserId,p_total:Number(tx.total)||0,p_currency_code:defaultCurrencyCode || 'CUP',p_notes:tx.notes||'',p_customer_id:tx.customerId||null,p_items:items,p_payments:payments});
    const metadataPayload = {
      ticket_id: tx.id,
      ticket_number: tx.ticketNumber || tx.id,
      ncf: tx.ncf || null,
      ncfType: tx.ncfType || null,
      subtotal: Number(tx.subtotal) || 0,
      changeGiven: Number(tx.changeGiven) || 0,
      sellerEmployeeIds: tx.sellerEmployeeIds || []
    };
    const { error: metadataError } = await supabase
      .from('sales')
      .update({ metadata: metadataPayload })
      .eq('id', remoteSaleId)
      .eq('company_id', companyId);
    if (metadataError) throw metadataError;
    return {success:true as const,error:undefined,errorCode:undefined,data:{...data,remote_id:remoteSaleId}};
  } catch(e:any){ return errorResult(e); }
}

export async function callStartInventoryAuditRPC(auditId:string,branchId:string,userId:string,mode:'physical'|'cycle_count',blindCount:boolean,notes?:string){
  try{const {companyId}=await getActiveTenant(); const data=await rpc('palmyra_start_audit',{p_audit_id:auditId,p_company_id:companyId,p_warehouse_id:branchId,p_notes:notes||'',p_blind:blindCount}); return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}
}
export async function callSaveInventoryAuditCountRPC(auditId:string,userId:string,items:any[],notes?:string){
  try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_save_audit_count',{p_audit_id:auditId,p_company_id:companyId,p_items:items,p_notes:notes||''});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}
}
export async function callRequestInventoryAuditRecountRPC(auditId:string,userId:string,notes?:string){
  try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_request_audit_recount',{p_audit_id:auditId,p_company_id:companyId,p_notes:notes||''});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}
}
export async function callApproveInventoryAuditRPC(auditId:string,userId:string,notes?:string){
  try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_approve_audit',{p_audit_id:auditId,p_company_id:companyId,p_notes:notes||''});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}
}
export async function callCompleteInventoryAuditRPC(auditId:string,branchId:string,userId:string,items:any[],notes?:string){
  try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_complete_audit',{p_audit_id:auditId,p_company_id:companyId,p_warehouse_id:branchId,p_items:items,p_notes:notes||''});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}
}
export async function callReceiveSupplierOrderRPC(orderId:string,userId:string){
  try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_receive_purchase',{p_order_id:orderId,p_company_id:companyId});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}
}
export async function callReserveNCFRangeRPC(params:{fiscalType:string;deviceId:string;blockSize?:number;userId:string}){
  try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_reserve_ncf_range',{p_company_id:companyId,p_fiscal_type:params.fiscalType,p_device_id:params.deviceId,p_block_size:params.blockSize||100});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}
}
export async function callTransferInventoryRPC(params:{operationId:string;batchId?:string;productId:string;fromBranchId:string;toBranchId:string;variants:{variantLabel:string;quantity:number}[];userId:string}){
  try{const {companyId}=await getActiveTenant();
    if(params.variants?.length){ for(const v of params.variants){const vid=await resolveVariantId(params.productId,v.variantLabel);await rpc('palmyra_transfer_inventory',{p_operation_id:params.operationId,p_company_id:companyId,p_from_warehouse_id:params.fromBranchId,p_to_warehouse_id:params.toBranchId,p_product_id:params.productId,p_variant_id:vid,p_quantity:Number(v.quantity)||0,p_notes:''});} }
    return {success:true as const,error:undefined,errorCode:undefined,data:{success:true}};
  }catch(e:any){return errorResult(e);}
}
async function resolveVariantId(productId:string,label?:string){const supabase=getSupabase()!;const {companyId}=await getActiveTenant();if(!label?.trim())return null;const {data,error}=await supabase.from('product_variants').select('id').eq('company_id',companyId).eq('product_id',productId).eq('name',label.trim()).eq('active',true).maybeSingle();if(error)throw error;return data?.id||null;}
export async function callTransferInventoryBulkRPC(params:{batchId:string;fromBranchId:string;toBranchId:string;items:{operationId:string;productId:string;variants:{variantLabel:string;quantity:number}[]}[];userId:string}){
  try{for(const item of params.items){await callTransferInventoryRPC({operationId:item.operationId,batchId:params.batchId,productId:item.productId,fromBranchId:params.fromBranchId,toBranchId:params.toBranchId,variants:item.variants||[],userId:params.userId});}return {success:true as const,error:undefined,errorCode:undefined,data:{success:true}};}catch(e:any){return errorResult(e);}
}
export async function callDeleteBankInternalTransferRPC(operationId:string){ try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_delete_bank_internal_transfer',{p_operation_id:operationId,p_company_id:companyId});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);} }
export async function callDeleteBankTransactionRPC(transactionId:string){ try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_delete_bank_transaction',{p_transaction_id:transactionId,p_company_id:companyId});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);} }
export async function callDeleteBankCardRPC(cardId:string){ try{const supabase=getSupabase()!;const {companyId}=await getActiveTenant();const {error}=await supabase.from('bank_accounts').update({active:false}).eq('id',cardId).eq('company_id',companyId);if(error)throw error;return {success:true as const,error:undefined,errorCode:undefined,data:{id:cardId}};}catch(e:any){return errorResult(e);} }
export async function callCompleteReturnRPC(returnId:string,userId:string){try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_complete_return',{p_return_id:returnId,p_company_id:companyId});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}}
export async function callVoidTransactionRPC(id:string,userId:string,reason:string){try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_void_sale',{p_sale_id:id,p_company_id:companyId,p_reason:reason||'Anulación de venta'});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}}
export async function callCancelSessionRPC(sessionId:string,userId:string,reason:string){try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_cancel_cash_session',{p_session_id:sessionId,p_company_id:companyId,p_reason:reason||'Cancelación de turno'});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}}
export async function callCloseSessionRPC(sessionId:string,closingBalances:any[],closedAt:string,notes:string,settlement:SalarySettlement,expectedCash?:number){
  try{
    const {companyId}=await getActiveTenant();
    const physicalCashBase=(closingBalances||[])
      .filter((p:any)=>p?.method==='cash')
      .reduce((sum:number,p:any)=>sum+(Number(p?.amount)||0)*(Number(p?.exchangeRate)||1),0);
    const expected=Number.isFinite(Number(expectedCash)) ? Number(expectedCash) : null;
    const data=await rpc('palmyra_close_cash_session',{
      p_session_id:sessionId,
      p_company_id:companyId,
      p_closed_at:closedAt,
      p_physical_cash:physicalCashBase,
      p_expected_cash:expected,
      p_difference:expected===null?0:physicalCashBase-expected,
      p_notes:notes||''
    });
    return {success:true as const,error:undefined,errorCode:undefined,data};
  }catch(e:any){return errorResult(e);}
}
export async function callProcessBankTransactionRPC(params:{id:string;cardId:string;type:string;amount:number;date?:string;reference?:string;description?:string;transactionId?:string}){try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_process_bank_transaction',{p_id:params.id,p_company_id:companyId,p_bank_account_id:params.cardId,p_type:params.type,p_amount:Number(params.amount)||0,p_date:params.date||new Date().toISOString(),p_reference:params.reference||null,p_description:params.description||'',p_transaction_id:params.transactionId||null});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}}
export async function callBankInternalTransferRPC(params:{operationId:string;fromCardId:string;toCardId:string;amount:number;targetAmount:number;date:string;reason?:string}){try{const {companyId}=await getActiveTenant();const data=await rpc('palmyra_bank_internal_transfer',{p_operation_id:params.operationId,p_company_id:companyId,p_from_bank_account_id:params.fromCardId,p_to_bank_account_id:params.toCardId,p_amount:Number(params.amount)||0,p_target_amount:Number(params.targetAmount)||0,p_date:params.date,p_reason:params.reason||''});return {success:true as const,error:undefined,errorCode:undefined,data};}catch(e:any){return errorResult(e);}}