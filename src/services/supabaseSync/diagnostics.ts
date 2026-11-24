import { getSupabase, getSupabaseCredentials } from '../../lib/supabase';
import { getActiveTenant } from '../tenant';
import {
  pushBankCardToSupabase,
  pushBranchToSupabase,
  pushCashSessionToSupabase,
  pushCategoryToSupabase,
  pushCurrencyToSupabase,
  pushCustomerToSupabase,
  pushInventoryAuditToSupabase,
  pushProductToSupabase,
  pushQuoteToSupabase,
  pushReceiptConfigToSupabase,
  pushReturnRefundToSupabase,
  pushReturnToSupabase,
  pushSalarySettlementToSupabase,
  pushStoreConfigToSupabase,
  pushSupplierOrderToSupabase,
  pushSupplierToSupabase,
  pushTimeShiftToSupabase,
  pushUserToSupabase,
  pushWarrantyToSupabase,
} from './mutations';

export interface TableTestResult {
  table:string; label:string; status:'ok'|'warning'|'error'; message:string; count:number; canRead:boolean; canWrite:boolean;
}
export interface SupabaseDiagnosticReport {
  connected:boolean; url:string; companyId?:string; tables:TableTestResult[]; summary:string; timestamp:string;
}

const TABLES=[
  ['companies','Empresa'],['company_memberships','Membresía'],['warehouses','Almacenes'],['employees','Empleados'],
  ['employee_warehouse_access','Acceso a almacenes'],['categories','Categorías'],['products','Productos'],
  ['stock_balances','Stock'],['sales','Ventas'],['cash_sessions','Cajas/turnos'],['customers','Clientes'],
  ['suppliers','Proveedores'],['bank_accounts','Cuentas bancarias'],['company_catalogs','Configuración'],
  ['subscriptions','Suscripción'],['plans','Planes']
] as const;

export async function testSupabaseTables():Promise<SupabaseDiagnosticReport>{
  const supabase=getSupabase();const {url}=getSupabaseCredentials();
  if(!supabase)return {connected:false,url,tables:[],summary:'Cliente Supabase no configurado.',timestamp:new Date().toISOString()};
  try{
    const tenant=await getActiveTenant();
    const results:TableTestResult[]=[];
    for(const [table,label] of TABLES){
      try{
        let query:any=supabase.from(table).select('*',{count:'exact',head:false}).limit(5);
        if(['warehouses','employees','employee_warehouse_access','categories','products','stock_balances','sales','cash_sessions','customers','suppliers','bank_accounts','company_catalogs','subscriptions'].includes(table))query=query.eq('company_id',tenant.companyId);
        const {data,count,error}=await query;
        if(error)results.push({table,label,status:'error',message:error.message,count:0,canRead:false,canWrite:false});
        else results.push({table,label,status:'ok',message:'Lectura correcta.',count:count??data?.length??0,canRead:true,canWrite:false});
      }catch(e:any){results.push({table,label,status:'error',message:e?.message||String(e),count:0,canRead:false,canWrite:false});}
    }
    const ok=results.filter(x=>x.status==='ok').length;
    return {connected:true,url,companyId:tenant.companyId,tables:results,summary:ok+' de '+results.length+' recursos canónicos accesibles.',timestamp:new Date().toISOString()};
  }catch(e:any){return {connected:true,url,tables:[],summary:e?.message||'No hay empresa activa.',timestamp:new Date().toISOString()};}
}

/**
 * Empuja el estado local completo a Supabase con las funciones push canónicas
 * (upserts y RPC idempotentes por id/operation_id). Es el contrato que usa
 * "Importar respaldo" (authActions.importData): si algo no se confirma en la
 * nube, devuelve success:false y errors para que el importador revierta.
 *
 * No se empujan: inventario (el stock solo viaja por RPC de ajuste/reconciliación,
 * un snapshot antiguo revertiría cambios remotos), ventas (pasan por
 * palmyra_record_sale con su operación atómica de stock), transferencias
 * (RPC de dos fases) ni movimientos bancarios. Es el mismo alcance deliberado
 * que tenía la implementación pre-refactor; esas entidades se sincronizan por
 * su ruta de escritura propia y por la cola offline.
 */
export async function pushAllToSupabase(_isFull:boolean=false):Promise<{success:boolean;pushed:Record<string,number>;errors:string[]}>{
  const pushed:Record<string,number>={};
  const errors:string[]=[];
  try{
    const supabase=getSupabase();
    if(!supabase)return {success:false,pushed,errors:['Supabase no está configurado.']};
    await getActiveTenant();
    // Import diferido: evita un ciclo de módulos con useStore en tiempo de carga.
    const {useStore}=await import('../../store/useStore');
    const store=useStore.getState() as any;
    const counts:Record<string,number>={};

    const pushSection=async (label:string, items:any[], fn:(item:any)=>Promise<any>) => {
      let ok=0;
      for(const item of items||[]){
        const id=String(item?.id||item?.code||'?');
        try{
          const result=await fn(item);
          if(result===true)ok+=1;
          else if(result&&typeof result==='object'&&result.success===true)ok+=1;
          else{
            const reason=result&&typeof result==='object'&&result.error?String(result.error):'rechazado';
            errors.push(`${label} ${id}: ${reason}`);
          }
        }catch(e:any){
          errors.push(`${label} ${id}: ${e?.message||String(e)}`);
        }
      }
      counts[label]=ok;
    };

    // Orden de dependencias: almacenes → catálogo → personas → documentos → cierres.
    await pushSection('branches',store.branches,pushBranchToSupabase);
    await pushSection('categories',store.categories,pushCategoryToSupabase);
    await pushSection('products',store.products,pushProductToSupabase);
    await pushSection('customers',store.customers,pushCustomerToSupabase);
    await pushSection('suppliers',store.suppliers,pushSupplierToSupabase);
    await pushSection('bankCards',store.bankCards,pushBankCardToSupabase);
    await pushSection('currencies',store.currencies,pushCurrencyToSupabase);
    await pushSection('users',store.users,pushUserToSupabase);
    await pushSection('supplierOrders',store.supplierOrders,pushSupplierOrderToSupabase);
    await pushSection('quotes',store.quotes,pushQuoteToSupabase);
    await pushSection('timeShifts',store.timeShifts,pushTimeShiftToSupabase);
    await pushSection('warranties',store.warranties,pushWarrantyToSupabase);
    await pushSection('returns',store.returns,pushReturnToSupabase);
    await pushSection('refunds',store.returns,pushReturnRefundToSupabase);
    await pushSection('salarySettlements',store.salarySettlements,pushSalarySettlementToSupabase);
    await pushSection('inventoryAudits',store.inventoryAudits,pushInventoryAuditToSupabase);
    // Solo turnos cerrados: los abiertos/cancelados se gestionan por RPC de
    // apertura/cierre; reabrirlos desde un respaldo corrompería la caja actual.
    await pushSection('cashSessions',(store.cashSessions||[]).filter((s:any)=>s.status==='closed'),pushCashSessionToSupabase);
    if(store.receiptConfig)await pushSection('receiptConfig',[store.receiptConfig],pushReceiptConfigToSupabase);
    if(store.storeConfig)await pushSection('storeConfig',[store.storeConfig],pushStoreConfigToSupabase);

    for(const key of Object.keys(counts))pushed[key]=counts[key];
    return {success:errors.length===0,pushed,errors};
  }catch(e:any){
    errors.push(`Error en push total: ${e?.message||String(e)}`);
    return {success:false,pushed,errors};
  }
}
