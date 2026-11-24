import { getSupabase } from '../../../lib/supabase';
import { getActiveTenant } from '../../tenant';
import type {
  ReturnItem,
  Warranty,
  Quote,
  TimeShift,
  SalarySettlement,
  InventoryAudit,
} from '../../../types';

export type OperationalExtrasOptions = {
  /** Cliente inyectable (pruebas o cliente que cuenta solicitudes). */
  client?: any;
  tenant?: { companyId: string };
  /** Ventana de arranque: solo filas creadas desde esta fecha. */
  sinceIso?: string;
  /** Tope de filas por consulta (nunca sin límite en la ventana). */
  limit?: number;
  /** Tope de filas para tablas hijas (líneas/cuentas). */
  itemsLimit?: number;
  /** Mapas ya cargados por el catálogo: evitan consultas repetidas. */
  refs?: {
    productNames?: Map<string, string>;
    customerNames?: Map<string, string>;
    employeeNames?: Map<string, string>;
  };
};

export async function loadReturnsWarrantiesQuotesTimePayroll(options: OperationalExtrasOptions = {}) {
  const tenant = (options.tenant || await getActiveTenant()) as { companyId: string };
  const supabase = options.client || getSupabase()!;
  const since = options.sinceIso;
  const rowLimit = Math.max(1, Math.trunc(options.limit ?? 1000));
  const itemsLimit = Math.max(1, Math.trunc(options.itemsLimit ?? 1000));

  const withWindow = (query: any, column: string) => {
    let q = query;
    if (since) q = q.gte(column, since);
    return q.limit(rowLimit);
  };

  const [rr,w,qs,ts,pr,aa] = await Promise.all([
    withWindow(supabase.from('sales_returns').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}), 'created_at'),
    withWindow(supabase.from('warranties').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}), 'created_at'),
    withWindow(supabase.from('quotes').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}), 'created_at'),
    withWindow(supabase.from('employee_time_shifts').select('*').eq('company_id',tenant.companyId).order('clock_in',{ascending:false}), 'clock_in'),
    withWindow(supabase.from('payroll_runs').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}), 'created_at'),
    withWindow(supabase.from('inventory_audits').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}), 'created_at'),
  ]);
  for(const x of [rr,w,qs,ts,pr,aa]) if(x.error) throw x.error;

  const runIds = (pr.data || []).map((run:any) => run.id).filter(Boolean);
  const pi = since
    ? (runIds.length
        ? await supabase.from('payroll_items').select('*').eq('company_id',tenant.companyId).in('payroll_run_id', runIds).limit(itemsLimit)
        : { data: [], error: null })
    : await supabase.from('payroll_items').select('*').eq('company_id',tenant.companyId);
  if (pi.error) throw pi.error;

  const returnIds = (rr.data || []).map((row:any) => row.id).filter(Boolean);
  const quoteIds = (qs.data || []).map((row:any) => row.id).filter(Boolean);
  const auditIds = (aa.data || []).map((row:any) => row.id).filter(Boolean);
  const [ri,qi,ai] = await Promise.all([
    returnIds.length
      ? supabase.from('sales_return_items').select('*').in('return_id', returnIds).limit(itemsLimit)
      : Promise.resolve({ data: [], error: null }),
    quoteIds.length
      ? supabase.from('quote_items').select('*').in('quote_id', quoteIds).limit(itemsLimit)
      : Promise.resolve({ data: [], error: null }),
    auditIds.length
      ? supabase.from('inventory_audit_items').select('*').in('audit_id', auditIds).limit(itemsLimit)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for(const x of [ri,qi,ai]) if(x.error) throw x.error;

  const pMap = options.refs?.productNames || await (async () => {
    const productRes = await supabase.from('products').select('id,name').eq('company_id',tenant.companyId);
    if(productRes.error) throw productRes.error;
    return new Map(productRes.data?.map((p:any)=>[p.id,p.name]) || []);
  })();
  const cMap = options.refs?.customerNames || await (async () => {
    const customerRes = await supabase.from('customers').select('id,name').eq('company_id',tenant.companyId);
    if(customerRes.error) throw customerRes.error;
    return new Map(customerRes.data?.map((c:any)=>[c.id,c.name]) || []);
  })();
  const eMap = options.refs?.employeeNames || await (async () => {
    const employeeRes = await supabase.from('employees').select('id,full_name').eq('company_id',tenant.companyId);
    if(employeeRes.error) throw employeeRes.error;
    return new Map(employeeRes.data?.map((e:any)=>[e.id,e.full_name]) || []);
  })();

  const returns:ReturnItem[]=[];
  for(const r of rr.data||[]) for(const item of (ri.data||[]).filter((x:any)=>x.return_id===r.id)){
    returns.push({
      id:item.id,
      serverReturnId:r.id,
      transactionId:r.sale_id,
      productId:item.product_id,
      quantity:Number(item.quantity)||0,
      reason:r.reason||'',
      date:r.created_at,
      status:r.status||'pending',
      type:r.return_type||'refund',
      notes:r.reason||'',
      branchId:undefined,
      processedBy:r.created_by,
      refundStatus:r.refund_status||'not_required',
      refundAmount:Number(r.refund_amount)||0,
      refundCurrencyCode:r.refund_currency_code||undefined,
      refundMethod:r.refund_method||undefined,
      refundBankCardId:r.refund_bank_card_id||undefined,
      refundTransactionId:r.refund_transaction_id||undefined,
      refundedAt:r.refunded_at||undefined
    });
  }

  const warranties:Warranty[]=(w.data||[]).map((x:any)=>({
    id:x.id,
    productId:'',
    productName:'',
    transactionId:'',
    purchaseDate:x.starts_at,
    expiryDate:x.expires_at,
    status:x.status||'active'
  }));

  const quotes:Quote[]=(qs.data||[]).map((x:any):Quote=>({
    id:x.id,
    branchId:x.warehouse_id,
    userId:x.created_by||'',
    customerId:x.customer_id||undefined,
    date:x.created_at,
    subtotal:Number(x.total)||0,
    tax:0,
    total:Number(x.total)||0,
    status:x.status==='converted'?'converted':x.status==='expired'?'expired':'pending',
    notes:x.notes||'',
    items:(qi.data||[]).filter((it:any)=>it.quote_id===x.id).map((it:any)=>({
      id:it.id,
      product:{
        id:it.product_id,
        name:pMap.get(it.product_id)||'Producto',
        sku:'',
        costPrice:0,
        price:Number(it.unit_price)||0,
        margin:0,
        categoryId:'',
        color:'bg-rose-50 text-rose-700',
        commissionValue:0
      },
      quantity:Number(it.quantity)||0,
      price:Number(it.unit_price)||0,
      total:Number(it.line_total)||0
    }))
  }));

  const timeShifts:TimeShift[]=(ts.data||[]).map((x:any)=>({
    id:x.id,
    userId:x.employee_id,
    clockIn:x.clock_in,
    clockOut:x.clock_out||undefined,
    notes:x.notes||undefined
  }));

  const salarySettlements:SalarySettlement[]=(pi.data||[]).map((x:any)=>({
    id:x.id,
    userId:x.employee_id,
    userName:eMap.get(x.employee_id)||'Empleado',
    sessionId:String(x.details?.session_id || ''),
    baseSalary:Number(x.base_salary)||0,
    commissions:Number(x.commission_amount)||0,
    discrepancyDeduction:Math.max(0, Number(x.details?.discrepancy_deduction ?? -(Number(x.adjustments)||0)) || 0),
    total:Number(x.total_amount)||0,
    date:(pr.data||[]).find((run:any)=>run.id===x.payroll_run_id)?.created_at||new Date().toISOString(),
    status:(pr.data||[]).find((run:any)=>run.id===x.payroll_run_id)?.status==='paid'?'paid':'pending'
  }));

  const reviewStatusFor=(status:string):InventoryAudit['reviewStatus']=>
    status==='approved'||status==='completed'?'approved'
    :status==='submitted'?'pending_approval'
    :status==='recount_requested'?'recount_requested'
    :'counting';

  const audits:InventoryAudit[]=(aa.data||[]).map((x:any)=>({
    id:x.id,
    date:x.created_at,
    branchId:x.warehouse_id,
    userId:x.created_by,
    status:x.status==='approved'||x.status==='completed'?'completed':'pending',
    mode:x.mode==='physical'?'physical':'cycle_count',
    blindCount:Boolean(x.blind_count),
    snapshotAt:x.snapshot_at||undefined,
    submittedAt:x.submitted_at||undefined,
    reviewStatus:reviewStatusFor(String(x.status||'')),
    reviewedBy:x.reviewed_by||undefined,
    reviewedAt:x.reviewed_at||undefined,
    adjustmentPostedAt:reviewStatusFor(String(x.status||''))==='approved'?(x.reviewed_at||undefined):undefined,
    notes:x.notes||'',
    items:(ai.data||[]).filter((it:any)=>it.audit_id===x.id).map((it:any)=>({
      productId:it.product_id,
      productName:pMap.get(it.product_id)||'Producto',
      variantLabel:it.variant_label||undefined,
      expected:Number(it.expected_quantity)||0,
      counted:it.counted_quantity==null?null:Number(it.counted_quantity),
      difference:it.difference==null?0:Number(it.difference)||0
    }))
  }));

  // cMap se mantiene por compatibilidad con la firma histórica del loader.
  return {returns,warranties,quotes,timeShifts,salarySettlements,audits};
}
