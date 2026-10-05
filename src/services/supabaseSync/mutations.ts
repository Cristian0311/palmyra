import { getSupabase } from '../../lib/supabase';
import { enqueueOfflineItem } from '../offlineQueue';
import { getActiveTenant, getEmployeeForIdentity } from '../tenant';
import { callAdjustInventoryRPC } from './rpc';
export type ResetSection =
  | 'inventory' | 'reports' | 'catalog' | 'customers' | 'suppliers'
  | 'purchases' | 'cash' | 'bank' | 'users' | 'branches' | 'quotes' | 'settings';

import type {
  Product, Category, Branch, InventoryLevel, User, BankCard, Customer, Transaction, CashRegisterSession,
  Warranty, ReturnItem, InventoryTransfer, TimeShift, Quote, BankTransaction, SupplierOrder, Supplier,
  InventoryAudit, SalarySettlement, Currency, ReceiptConfig, StoreConfig
} from '../../types';

async function onlineClient() {
  const supabase=getSupabase();
  if(!supabase)throw new Error('Supabase no está configurado.');
  if(typeof navigator!=='undefined'&&!navigator.onLine)throw new Error('offline');
  return supabase;
}
const queue=async(type:any,data:any,id:string)=>{await enqueueOfflineItem(type,data,id);};

export async function pushProductToSupabase(product:Product){
  try{
    const supabase=await onlineClient();const {companyId}=await getActiveTenant();
    const row={id:product.id,company_id:companyId,category_id:product.categoryId||null,brand_id:null,sku:product.sku||product.id.slice(0,12),name:product.name,description:null,status:product.status||'active',track_stock:true,base_unit:product.unit||'unidad',cost:Number(product.costPrice)||0,commission_fixed:product.commissionType==='fixed'?Number(product.commissionValue)||0:0,commission_percent:product.commissionType==='percentage'?Number(product.commissionValue)||0:0,image_path:product.image||null,minimum_stock:Number(product.minStockAlert)||0,is_kit:Boolean(product.isKit),track_serial:Boolean(product.hasSerial)};
    const {error}=await supabase.from('products').upsert(row,{onConflict:'id'});if(error)throw error;
    if(product.barcode){
      await supabase.from('product_barcodes').update({active:false}).eq('company_id',companyId).eq('product_id',product.id).eq('active',true);
      const {error:be}=await supabase.from('product_barcodes').insert({id:crypto.randomUUID(),company_id:companyId,product_id:product.id,barcode:product.barcode,active:true});if(be)throw be;
    }
    await supabase.from('product_kit_components').delete().eq('company_id',companyId).eq('kit_product_id',product.id);
    if(product.isKit&&Array.isArray(product.kitComponents)&&product.kitComponents.length){
      const rows=product.kitComponents.map(c=>({id:crypto.randomUUID(),company_id:companyId,kit_product_id:product.id,component_product_id:c.productId,quantity:Number(c.quantity)||0}));
      const {error:ke}=await supabase.from('product_kit_components').insert(rows);if(ke)throw ke;
    }
    return true;
  }catch(e:any){await queue('product',product,product.id);console.warn('[PALMYRA] product sync failed',e);return false;}
}

async function resolveVariantId(supabase:any,companyId:string,productId:string,variantLabel?:string){
  if(!variantLabel?.trim())return null;
  const {data,error}=await supabase.from('product_variants').select('id').eq('company_id',companyId).eq('product_id',productId).eq('name',variantLabel.trim()).eq('active',true).maybeSingle();
  if(error)throw error;return data?.id||null;
}

export async function applyInventoryAdjustmentToSupabase(params:{operationId:string;productId:string;branchId:string;variantLabel?:string;delta:number;minQuantity?:number;userId?:string;movementType?:string}): Promise<{success:true;conflict:false;data:{quantity:number};error?:string}|{success:false;conflict?:boolean;error:string;data?:never}>{
  try{
    const supabase=await onlineClient();
    const {companyId}=await getActiveTenant();
    const vid=await resolveVariantId(supabase,companyId,params.productId,params.variantLabel);
    const result=await callAdjustInventoryRPC({
      operationId:params.operationId,
      warehouseId:params.branchId,
      productId:params.productId,
      variantId:vid,
      delta:Number(params.delta)||0,
      minQuantity:params.minQuantity,
      notes:params.movementType || 'Ajuste de inventario'
    });
    if(result.success === false){
      if(result.conflict) return {success:false,conflict:true,error:result.error};
      throw new Error(result.error);
    }
    return {success:true,conflict:false,data:{quantity:Number(result.data?.quantity)||0}};
  }catch(e:any){
    await queue('inventory_adjustment',params,params.operationId);
    return {success:false,error:e?.message||'Error de inventario'};
  }
}

export async function reconcileInventoryToSupabase(params:{operationId:string;productId:string;branchId:string;variantLabel?:string;expectedQuantity:number;newQuantity:number;minQuantity?:number;userId?:string}): Promise<{success:true;conflict:false;data:{quantity:number};error?:string}|{success:false;conflict?:boolean;error:string;data?:never}>{
  try{
    const supabase=await onlineClient();
    const {companyId}=await getActiveTenant();
    const vid=await resolveVariantId(supabase,companyId,params.productId,params.variantLabel);
    const delta=Number(params.newQuantity)-Number(params.expectedQuantity);
    const result=await callAdjustInventoryRPC({
      operationId:params.operationId,
      warehouseId:params.branchId,
      productId:params.productId,
      variantId:vid,
      delta,
      expectedQuantity:Number(params.expectedQuantity),
      minQuantity:params.minQuantity,
      notes:'Reconciliación de inventario'
    });
    if(result.success === false){
      if(result.conflict) return {success:false,conflict:true,error:result.error};
      throw new Error(result.error);
    }
    return {success:true,conflict:false,data:{quantity:Number(result.data?.quantity)||0}};
  }catch(e:any){
    await queue('inventory_reconcile',params,params.operationId);
    return {success:false,error:e?.message||'Error de reconciliación'};
  }
}

export async function pushInventoryToSupabase(level:InventoryLevel){
  try{
    const supabase=await onlineClient();const {companyId}=await getActiveTenant();const vid=await resolveVariantId(supabase,companyId,level.productId,level.variantLabel);const table=vid?'variant_stock_balances':'stock_balances';const conflictTarget=vid?'company_id,warehouse_id,product_id,variant_id':'warehouse_id,product_id';
    const {error}=await supabase.from(table).upsert({company_id:companyId,warehouse_id:level.branchId,product_id:level.productId,variant_id:vid,quantity:Math.max(0,Number(level.quantity)||0),updated_at:new Date().toISOString()},{onConflict:conflictTarget});if(error)throw error;return true;
  }catch(e:any){await queue('inventory',level,level.productId+'_'+level.branchId+'_'+(level.variantLabel||''));return false;}
}

function salePayload(tx:Transaction,companyId:string,authUserId:string){
  return {
    p_sale_id:tx.id,p_company_id:companyId,p_warehouse_id:tx.branchId,p_cash_session_id:tx.sessionId||null,p_user_id:tx.userId||authUserId,
    p_total:Number(tx.total)||0,p_currency_code:null,p_notes:tx.notes||'',p_customer_id:tx.customerId||null,
    p_items:(tx.items||[]).map(item=>({id:item.id,product_id:typeof item.product==='string'?item.product:item.product?.id,quantity:Number(item.quantity)||0,price:Number(item.price)||0,total:Number(item.total)||((Number(item.price)||0)*(Number(item.quantity)||0)),variant_label:item.variantLabel||null,variant_id:null,serial_number:item.serialNumber||null,discount:0,tax:0})),
    p_payments:(tx.payments||[]).map((p:any)=>({id:crypto.randomUUID(),method:p.method||'cash',currency_code:p.currencyCode||null,amount:Number(p.amount)||0,exchange_rate:Number(p.exchangeRate)||1}))
  };
}

export async function pushTransactionToSupabase(tx:Transaction):Promise<boolean>{
  try{const supabase=await onlineClient();const {companyId,authUserId}=await getActiveTenant();const {data,error}=await supabase.rpc('palmyra_record_sale',salePayload(tx,companyId,authUserId));if(error)throw error;if(data?.success===false)throw new Error(data?.message||'La venta fue rechazada.');return true;}
  catch(e:any){await queue('transaction',tx,tx.id);return false;}
}

async function ensureCashRegister(supabase:any,companyId:string,warehouseId:string){
  const {data:existing,error}=await supabase.from('cash_registers').select('id').eq('company_id',companyId).eq('warehouse_id',warehouseId).eq('active',true).order('id').limit(1).maybeSingle();
  if(error)throw error;if(existing?.id)return existing.id;
  const code='CAJA-'+warehouseId.slice(0,6).toUpperCase();
  const {data,error:ie}=await supabase.from('cash_registers').insert({id:crypto.randomUUID(),company_id:companyId,warehouse_id:warehouseId,code,name:'Caja principal',active:true}).select('id').single();if(ie)throw ie;return data.id;
}
export async function pushCashSessionToSupabase(session:CashRegisterSession):Promise<boolean>{
  try{
    const supabase=await onlineClient();
    const {companyId,authUserId}=await getActiveTenant();
    const [cashRegisterId,employeeRes,companyRes]=await Promise.all([
      ensureCashRegister(supabase,companyId,session.branchId),
      getEmployeeForIdentity(session.userId),
      supabase.from('companies').select('default_currency_code').eq('id',companyId).single()
    ]);
    if(companyRes.error)throw companyRes.error;
    const defaultCurrency=companyRes.data?.default_currency_code||'CUP';
    const expected=Number.isFinite(Number(session.expectedBalance))?Number(session.expectedBalance):null;
    const physicalCashBase=(session.closingBalances||[])
      .filter((p:any)=>p?.method==='cash')
      .reduce((sum:number,p:any)=>sum+(Number(p?.amount)||0)*(Number(p?.exchangeRate)||1),0);
    const metadata={
      closingBalances:session.closingBalances||[],
      expectedBalance:expected,
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
      workingEmployeeIds:session.workingEmployeeIds||[]
    };
    const payload={
      id:session.id,company_id:companyId,cash_register_id:cashRegisterId,
      employee_id:employeeRes?.id||null,opened_by:authUserId,
      closed_by:session.status!=='open'?authUserId:null,status:session.status,
      opened_at:session.openedAt,closed_at:session.closedAt||null,
      opening_amount:Number(session.openingAmount??session.openingBalance)||0,
      expected_cash:expected,physical_cash:session.status==='open'?null:physicalCashBase,
      difference:expected===null?0:physicalCashBase-expected,
      turn_number:Number(session.turnNumber)||null,metadata
    };
    const {data:existing,error:re}=await supabase.from('cash_sessions').select('id').eq('id',session.id).eq('company_id',companyId).maybeSingle();if(re)throw re;
    const result=existing?.id?await supabase.from('cash_sessions').update(payload).eq('id',session.id).eq('company_id',companyId):await supabase.from('cash_sessions').insert(payload);
    if(result.error)throw result.error;
    await supabase.from('cash_movements').delete().eq('cash_session_id',session.id).eq('company_id',companyId);
    if(session.movements?.length){
      const rows=session.movements.map((m:any)=>({
        id:m.id,company_id:companyId,cash_session_id:session.id,movement_type:m.type||'expense',
        amount:Number(m.amount)||0,currency_code:m.currencyCode||defaultCurrency,reference_id:null,note:m.description||'',
        created_by:authUserId
      }));
      const {error:movementError}=await supabase.from('cash_movements').insert(rows);if(movementError)throw movementError;
    }
    return true;
  }catch(e:any){await queue('cash_session',session,session.id);return false;}
}

export async function pushBranchToSupabase(branch:Branch){
  try{
    const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {data:existing,error:ee}=await supabase.from('warehouses').select('code').eq('company_id',companyId).eq('id',branch.id).maybeSingle();if(ee)throw ee;
    let code=existing?.code;
    if(!code){const {count,error:ce}=await supabase.from('warehouses').select('id',{count:'exact',head:true}).eq('company_id',companyId);if(ce)throw ce;code='ALM-'+String((count||0)+1).padStart(2,'0');}
    const {error}=await supabase.from('warehouses').upsert({id:branch.id,company_id:companyId,code,name:branch.name,active:branch.isActive!==false},{onConflict:'id'});if(error)throw error;return true;
  }catch(e:any){await queue('branch',branch,branch.id);return false;}
}
export async function deleteBranchFromSupabase(id:string):Promise<boolean>{try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {error}=await supabase.from('warehouses').update({active:false}).eq('id',id).eq('company_id',companyId);if(error)throw error;return true;}catch{return false;}}

export async function pushCategoryToSupabase(category:Category){
  try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {error}=await supabase.from('categories').upsert({id:category.id,company_id:companyId,name:category.name,parent_id:null,active:true},{onConflict:'id'});if(error)throw error;return true;}catch(e:any){await queue('category',category,category.id);return false;}
}
export async function deleteCategoryFromSupabase(id:string):Promise<boolean>{try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {error}=await supabase.from('categories').update({active:false}).eq('id',id).eq('company_id',companyId);if(error)throw error;return true;}catch{return false;}}

export async function deleteProductFromSupabase(id:string):Promise<boolean>{
  try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {data,error}=await supabase.from('products').update({status:'archived'}).eq('id',id).eq('company_id',companyId).select('id');if(error)throw error;return Boolean(data?.length);}
  catch{return false;}
}

export async function pushUserToSupabase(user:User){
  try{
    const supabase=await onlineClient();const {companyId}=await getActiveTenant();if(user.role==='admin')return true;
    const warehouses=(user.allowedBranches||[user.branchId]).filter(Boolean) as string[];
    const {data:role,error:roleErr}=await supabase.from('roles').select('id').eq('key','employee').is('company_id',null).maybeSingle();if(roleErr)throw roleErr;if(!role?.id)throw new Error('Rol empleado no disponible');
    let targetWarehouses=warehouses;
    if(!targetWarehouses.length){const {data:w}=await supabase.from('warehouses').select('id').eq('company_id',companyId).eq('active',true).order('created_at').limit(1).maybeSingle();if(w?.id)targetWarehouses=[w.id];}
    if(!targetWarehouses.length)throw new Error('La empresa no tiene almacenes activos.');
    const {error}=await supabase.rpc('create_employee_secure',{p_company_id:companyId,p_employee_id:user.id,p_employee_code:(user as any).employeeCode||('EMP-'+user.id.slice(0,6).toUpperCase()),p_full_name:user.name,p_base_salary:Number(user.baseSalary)||0,p_role_id:role.id,p_warehouse_ids:targetWarehouses});if(error)throw error;return true;
  }catch(e:any){await queue('user',user,user.id);return false;}
}
export async function deleteUserFromSupabase(id:string){try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {error}=await supabase.from('employees').update({active:false}).eq('id',id).eq('company_id',companyId);if(error)throw error;}catch{}}

export async function pushCustomerToSupabase(customer:Customer):Promise<{success:boolean;pending:boolean;error?:string}>{
  try{
    const supabase=await onlineClient();
    const {companyId}=await getActiveTenant();
    const {error}=await supabase.from('customers').upsert({
      id:customer.id,company_id:companyId,name:customer.name,
      phone:customer.phone||null,email:customer.email||null,
      tax_id:customer.taxId||null,active:true
    },{onConflict:'id'});
    if(error) throw error;
    return {success:true,pending:false};
  }catch(e:any){
    const message=String(e?.message||e||'No se pudo guardar el cliente.');
    const offline=typeof navigator!=='undefined' && !navigator.onLine;
    const transportError=offline || /failed to fetch|network|timeout|fetch error|load failed/i.test(message);
    if(transportError){
      await queue('customer',{...customer},customer.id);
      return {success:false,pending:true,error:message};
    }
    return {success:false,pending:false,error:message};
  }
}
export async function deleteCustomerFromSupabase(id:string):Promise<boolean>{try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {error}=await supabase.from('customers').update({active:false}).eq('id',id).eq('company_id',companyId);if(error)throw error;return true;}catch{return false;}}

export async function pushInventoryTransferToSupabase(transfer:InventoryTransfer){
  try{
    const supabase=await onlineClient();const {companyId}=await getActiveTenant();
    if(Array.isArray(transfer.variants)&&transfer.variants.length){for(const v of transfer.variants){const opId=crypto.randomUUID();const vid=await resolveVariantId(supabase,companyId,transfer.productId,v.variantLabel);const {error}=await supabase.rpc('palmyra_transfer_inventory',{p_operation_id:opId,p_company_id:companyId,p_from_warehouse_id:transfer.fromBranchId,p_to_warehouse_id:transfer.toBranchId,p_product_id:transfer.productId,p_variant_id:vid,p_quantity:Number(v.quantity)||0,p_notes:transfer.productName||''});if(error)throw error;}return true;}
    const vid=await resolveVariantId(supabase,companyId,transfer.productId,transfer.variantLabel);const {error}=await supabase.rpc('palmyra_transfer_inventory',{p_operation_id:transfer.operationId||transfer.id,p_company_id:companyId,p_from_warehouse_id:transfer.fromBranchId,p_to_warehouse_id:transfer.toBranchId,p_product_id:transfer.productId,p_variant_id:vid,p_quantity:Number(transfer.quantity)||0,p_notes:transfer.productName||''});if(error)throw error;return true;
  }catch(e:any){await queue('transfer',transfer,transfer.id);return false;}
}

export async function pushWarrantyToSupabase(warranty:Warranty){
  try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {data:saleItems,error:se}=await supabase.from('sale_items').select('id').eq('sale_id',warranty.transactionId).eq('product_id',warranty.productId).limit(1);if(se)throw se;const {error}=await supabase.from('warranties').upsert({id:warranty.id,company_id:companyId,sale_item_id:saleItems?.[0]?.id||null,code:warranty.id,starts_at:warranty.purchaseDate,expires_at:warranty.expiryDate,status:warranty.status,notes:warranty.productName},{onConflict:'id'});if(error)throw error;return true;}catch(e:any){await queue('warranty',warranty,warranty.id);return false;}
}
export async function pushCurrencyToSupabase(_currency:Currency){return true;}

export async function pushReturnToSupabase(item:ReturnItem):Promise<boolean>{
  try{
    const supabase=await onlineClient();const {companyId}=await getActiveTenant();
    if(item.status==='pending' || item.status==='approved'){
      const {data,error}=await supabase.rpc('palmyra_create_return',{p_return_id:item.id,p_company_id:companyId,p_sale_id:item.transactionId,p_product_id:item.productId,p_quantity:Number(item.quantity)||0,p_reason:item.reason||'',p_amount:Number(item.refundAmount)||0,p_type:item.type||'refund'});
      if(error)throw error;
      return Boolean(data?.success);
    }
    return true;
  }catch(e:any){await queue('return',item,item.id);return false;}
}

export async function pushTimeShiftToSupabase(shift:TimeShift){
  try{const supabase=await onlineClient();const {companyId,authUserId}=await getActiveTenant();const employee=await getEmployeeForIdentity(shift.userId);if(!employee)throw new Error('Empleado no encontrado');const {data:loc}=await supabase.from('employee_warehouse_access').select('warehouse_id').eq('employee_id',employee.id).eq('company_id',companyId).eq('is_default',true).maybeSingle();const {error}=await supabase.from('employee_time_shifts').upsert({id:shift.id,company_id:companyId,employee_id:employee.id,warehouse_id:loc?.warehouse_id||null,clock_in:shift.clockIn,clock_out:shift.clockOut||null,notes:shift.notes||null,created_by:authUserId,updated_at:new Date().toISOString()},{onConflict:'id'});if(error)throw error;return true;}catch(e:any){await queue('time_shift',shift,shift.id);return false;}
}

export async function pushQuoteToSupabase(quote:Quote){
  try{const supabase=await onlineClient();const {companyId,authUserId}=await getActiveTenant();const {error}=await supabase.from('quotes').upsert({id:quote.id,company_id:companyId,quote_number:quote.id,customer_id:quote.customerId||null,warehouse_id:quote.branchId,currency_code:'USD',status:quote.status,total:Number(quote.total)||0,valid_until:null,notes:quote.notes||null,created_by:authUserId},{onConflict:'id'});if(error)throw error;await supabase.from('quote_items').delete().eq('quote_id',quote.id);if(quote.items?.length){const {error:ie}=await supabase.from('quote_items').insert(quote.items.map(i=>({id:crypto.randomUUID(),quote_id:quote.id,product_id:typeof i.product==='string'?i.product:i.product.id,quantity:Number(i.quantity)||0,unit_price:Number(i.price)||0,discount:0,tax:0,line_total:Number(i.total)||0})));if(ie)throw ie;}return true;}catch(e:any){await queue('quote',quote,quote.id);return false;}
}

export async function pushBankTransactionToSupabase(tx:BankTransaction){
  try{
    const { callProcessBankTransactionRPC } = await import('./rpc');
    const res=await callProcessBankTransactionRPC({
      id:tx.id,cardId:tx.cardId,type:tx.type,amount:Number(tx.amount)||0,date:tx.date,
      reference:tx.reference,description:tx.description,transactionId:tx.transactionId
    });
    if(!res.success)throw new Error(res.error||'No se pudo registrar el movimiento bancario.');
    return true;
  }catch(e:any){await queue('bank_transaction',tx,tx.id);return false;}
}
export async function deleteBankTransactionFromSupabase(id:string){try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {error}=await supabase.from('bank_transactions').delete().eq('id',id).eq('company_id',companyId);if(error)throw error;}catch{}}

export async function pushBankCardToSupabase(card:BankCard){
  try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {error}=await supabase.from('bank_accounts').upsert({id:card.id,company_id:companyId,name:card.name||card.bankName||'Cuenta bancaria',bank_name:card.bankName||card.bank||'Banco',last_four:(card.lastFour||card.lastFourDigits||'').slice(-4),currency_code:card.currency||'USD',balance:Number(card.balance)||0,active:card.isActive!==false,updated_at:new Date().toISOString()},{onConflict:'id'});if(error)throw error;return true;}catch(e:any){await queue('bank_card',card,card.id);return false;}
}
export async function setBankCardBalanceToSupabase(cardId:string,expectedBalance:number,newBalance:number):Promise<boolean>{try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {data,error}=await supabase.from('bank_accounts').update({balance:Number(newBalance)||0,updated_at:new Date().toISOString()}).eq('id',cardId).eq('company_id',companyId).eq('balance',Number(expectedBalance)||0).select('id');if(error)throw error;return Boolean(data?.length);}catch{return false;}}
export async function updateBankCardMetadataToSupabase(card:BankCard):Promise<boolean>{return pushBankCardToSupabase(card);}
export async function deleteBankCardFromSupabase(id:string){try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {error}=await supabase.from('bank_accounts').update({active:false}).eq('id',id).eq('company_id',companyId);if(error)throw error;}catch{}}

export async function pushSupplierToSupabase(supplier:Supplier){
  try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {error}=await supabase.from('suppliers').upsert({id:supplier.id,company_id:companyId,name:supplier.name,phone:supplier.phone||null,address:supplier.address||null,email:supplier.email||null,rating:Number(supplier.rating)||0,merchandise_type:supplier.typeOfMerchandise||null,active:true},{onConflict:'id'});if(error)throw error;return true;}catch(e:any){await queue('supplier',supplier,supplier.id);return false;}
}
export async function deleteSupplierFromSupabase(id:string):Promise<boolean>{try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {error}=await supabase.from('suppliers').update({active:false}).eq('id',id).eq('company_id',companyId);if(error)throw error;return true;}catch{return false;}}

export async function pushSupplierOrderToSupabase(order:SupplierOrder){
  try{const supabase=await onlineClient();const {companyId,authUserId}=await getActiveTenant();const {error}=await supabase.from('purchase_orders').upsert({id:order.id,company_id:companyId,supplier_id:order.supplierId,warehouse_id:order.branchId,status:order.status,order_number:order.id,currency_code:'USD',subtotal:Number(order.total)||0,total:Number(order.total)||0,created_by:authUserId,expected_delivery_date:order.expectedDeliveryDate||null,transport_cost:Number(order.transportCost)||0,transport_details:order.transportDetails||null},{onConflict:'id'});if(error)throw error;await supabase.from('purchase_items').delete().eq('purchase_order_id',order.id);if(order.items?.length){const {error:ie}=await supabase.from('purchase_items').insert(order.items.map(i=>({id:crypto.randomUUID(),purchase_order_id:order.id,product_id:i.productId,quantity:Number(i.quantity)||0,unit_cost:Number(i.cost)||0,line_total:(Number(i.quantity)||0)*(Number(i.cost)||0)})));if(ie)throw ie;}return true;}catch(e:any){await queue('supplier_order',order,order.id);return false;}
}

export async function pushInventoryAuditToSupabase(audit:InventoryAudit){
  try{const supabase=await onlineClient();const {companyId,authUserId}=await getActiveTenant();const {error}=await supabase.from('inventory_audits').upsert({id:audit.id,company_id:companyId,warehouse_id:audit.branchId,status:audit.status==='completed'?'approved':'counting',blind_count:Boolean(audit.blindCount),notes:audit.notes||null,created_by:authUserId,submitted_at:audit.submittedAt||null,reviewed_by:audit.reviewedBy||null,reviewed_at:audit.reviewedAt||null},{onConflict:'id'});if(error)throw error;await supabase.from('inventory_audit_items').delete().eq('audit_id',audit.id);if(audit.items?.length){const {error:ie}=await supabase.from('inventory_audit_items').insert(audit.items.map(i=>({id:crypto.randomUUID(),audit_id:audit.id,product_id:i.productId,expected_quantity:Number(i.expected)||0,counted_quantity:i.counted==null?null:Number(i.counted),difference:Number(i.difference)||0,notes:null})));if(ie)throw ie;}return true;}catch(e:any){await queue('inventory_audit',audit,audit.id);return false;}
}

export async function pushSalarySettlementToSupabase(settlement:SalarySettlement){
  try{const supabase=await onlineClient();const {companyId,authUserId}=await getActiveTenant();const employee=await getEmployeeForIdentity(settlement.userId);if(!employee)throw new Error('Empleado no encontrado');const runId=crypto.randomUUID();const day=settlement.date.slice(0,10);const {error:re}=await supabase.from('payroll_runs').insert({id:runId,company_id:companyId,period_start:day,period_end:day,status:settlement.status==='paid'?'paid':'draft',created_by:authUserId});if(re)throw re;const {error:ie}=await supabase.from('payroll_items').insert({id:settlement.id,company_id:companyId,payroll_run_id:runId,employee_id:employee.id,currency_code:'USD',base_salary:Number(settlement.baseSalary)||0,commission_amount:Number(settlement.commissions)||0,adjustments:0,total_amount:Number(settlement.total)||0,details:{session_id:settlement.sessionId||null}});if(ie)throw ie;return true;}catch(e:any){await queue('salary_settlement',settlement,settlement.id);return false;}
}

async function updateCompanySettings(patch:Record<string,any>){
  const supabase=await onlineClient();
  const {companyId}=await getActiveTenant();
  const {data:existing,error:readError}=await supabase.from('company_settings').select('settings').eq('company_id',companyId).maybeSingle();
  if(readError)throw readError;
  const current=existing?.settings && typeof existing.settings==='object' ? existing.settings : {};
  const {error}=await supabase.from('company_settings').upsert({
    company_id:companyId,
    settings:{...current,...patch},
    updated_at:new Date().toISOString()
  },{onConflict:'company_id'});
  if(error)throw error;
}
export async function pushReceiptConfigToSupabase(config:ReceiptConfig){try{await updateCompanySettings({receiptConfig:config});return true;}catch(e:any){await queue('receipt_config',config,'global');return false;}}
export async function pushStoreConfigToSupabase(config:StoreConfig&Record<string,any>){try{await updateCompanySettings({storeConfig:config});return true;}catch(e:any){await queue('store_config',config,'global');return false;}}

export async function deleteTransactionFromSupabase(id:string){
  try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();const {error}=await supabase.rpc('palmyra_void_sale',{p_sale_id:id,p_company_id:companyId,p_reason:'Anulación desde PALMYRA'});if(error)throw error;return true;}catch{return false;}
}

export async function clearSupabaseData(confirmToken?:string):Promise<{success:boolean;failed:string[]}>{
  if(confirmToken!=='ELIMINAR')return {success:false,failed:['Confirma con ELIMINAR.']};
  const failed:string[]=[];try{const supabase=await onlineClient();const {companyId}=await getActiveTenant();
    const sales=(await supabase.from('sales').select('id').eq('company_id',companyId)).data||[];const saleIds=sales.map((x:any)=>x.id);
    const returns=(await supabase.from('sales_returns').select('id').eq('company_id',companyId)).data||[];const returnIds=returns.map((x:any)=>x.id);
    if(returnIds.length)await supabase.from('sales_return_items').delete().in('return_id',returnIds);
    if(saleIds.length){await supabase.from('sale_items').delete().in('sale_id',saleIds);await supabase.from('payments').delete().eq('company_id',companyId);await supabase.from('sales').delete().eq('company_id',companyId);}
    await supabase.from('sales_returns').delete().eq('company_id',companyId);
    for(const table of ['cash_movements','cash_sessions','stock_movements','stock_balances','variant_stock_balances','transfers','inventory_audits','quotes','purchase_orders','bank_transactions','bank_accounts','customers','suppliers','employee_time_shifts'])try{const {error}=await supabase.from(table).delete().eq('company_id',companyId);if(error)failed.push(table+': '+error.message);}catch(e:any){failed.push(table+': '+String(e));}
    await supabase.from('employees').update({active:false}).eq('company_id',companyId);
    await supabase.from('warehouses').update({active:false}).eq('company_id',companyId);
    await supabase.from('products').update({status:'archived'}).eq('company_id',companyId);
    return {success:failed.length===0,failed};
  }catch(e:any){return {success:false,failed:[e?.message||String(e)]};}
}

export async function clearSelectedDataFromSupabase(sections:ResetSection[]):Promise<{success:boolean;failed:string[]}>{
  const failed:string[]=[];try{
    const supabase=await onlineClient();const {companyId}=await getActiveTenant();const has=(s:string)=>sections.includes(s as any);
    if(has('inventory')){for(const table of ['stock_movements','stock_balances','variant_stock_balances']){const {error}=await supabase.from(table).delete().eq('company_id',companyId);if(error)failed.push(table+': '+error.message);}}
    if(has('reports')){const sales=(await supabase.from('sales').select('id').eq('company_id',companyId)).data||[];const ids=sales.map((x:any)=>x.id);if(ids.length)await supabase.from('sale_items').delete().in('sale_id',ids);await supabase.from('payments').delete().eq('company_id',companyId);await supabase.from('sales').delete().eq('company_id',companyId);}
    if(has('catalog')){await supabase.from('products').update({status:'archived'}).eq('company_id',companyId);await supabase.from('categories').update({active:false}).eq('company_id',companyId);}
    if(has('customers'))await supabase.from('customers').update({active:false}).eq('company_id',companyId);
    if(has('suppliers'))await supabase.from('suppliers').update({active:false}).eq('company_id',companyId);
    if(has('purchases'))await supabase.from('purchase_orders').update({status:'cancelled'}).eq('company_id',companyId);
    if(has('cash'))await supabase.from('cash_sessions').update({status:'cancelled',closed_at:new Date().toISOString()}).eq('company_id',companyId);
    if(has('bank')){await supabase.from('bank_transactions').delete().eq('company_id',companyId);await supabase.from('bank_accounts').update({active:false}).eq('company_id',companyId);}
    if(has('users'))await supabase.from('employees').update({active:false}).eq('company_id',companyId);
    if(has('branches'))await supabase.from('warehouses').update({active:false}).eq('company_id',companyId);
    return {success:failed.length===0,failed};
  }catch(e:any){return {success:false,failed:[e?.message||String(e)]};}
}

export async function clearHistoryFromSupabase(){return clearSelectedDataFromSupabase(['reports'] as any);}
