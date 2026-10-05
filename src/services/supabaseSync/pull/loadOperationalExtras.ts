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

export async function loadReturnsWarrantiesQuotesTimePayroll() {
  const tenant = await getActiveTenant();
  const supabase = getSupabase()!;
  const [rr,w,qs,ts,pr,pi,aa] = await Promise.all([
    supabase.from('sales_returns').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}).limit(1000),
    supabase.from('warranties').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}).limit(1000),
    supabase.from('quotes').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}).limit(1000),
    supabase.from('employee_time_shifts').select('*').eq('company_id',tenant.companyId).order('clock_in',{ascending:false}).limit(1000),
    supabase.from('payroll_runs').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}).limit(500),
    supabase.from('payroll_items').select('*').eq('company_id',tenant.companyId),
    supabase.from('inventory_audits').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}).limit(500),
  ]);
  for(const x of [rr,w,qs,ts,pr,pi,aa]) if(x.error) throw x.error;

  const returnIds = (rr.data || []).map((row:any) => row.id).filter(Boolean);
  const quoteIds = (qs.data || []).map((row:any) => row.id).filter(Boolean);
  const auditIds = (aa.data || []).map((row:any) => row.id).filter(Boolean);
  const [ri,qi,ai] = await Promise.all([
    returnIds.length
      ? supabase.from('sales_return_items').select('*').in('return_id', returnIds)
      : Promise.resolve({ data: [], error: null }),
    quoteIds.length
      ? supabase.from('quote_items').select('*').in('quote_id', quoteIds)
      : Promise.resolve({ data: [], error: null }),
    auditIds.length
      ? supabase.from('inventory_audit_items').select('*').in('audit_id', auditIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for(const x of [ri,qi,ai]) if(x.error) throw x.error;

  const productRes = await supabase.from('products').select('id,name').eq('company_id',tenant.companyId);
  if(productRes.error) throw productRes.error;
  const customerRes = await supabase.from('customers').select('id,name').eq('company_id',tenant.companyId);
  if(customerRes.error) throw customerRes.error;
  const employeeRes = await supabase.from('employees').select('id,full_name').eq('company_id',tenant.companyId);
  if(employeeRes.error) throw employeeRes.error;

  const pMap = new Map(productRes.data?.map((p:any)=>[p.id,p.name]) || []);
  const eMap = new Map(employeeRes.data?.map((e:any)=>[e.id,e.full_name]) || []);
  const cMap = new Map(customerRes.data?.map((c:any)=>[c.id,c.name]) || []);

  const returns:ReturnItem[]=[];
  for(const r of rr.data||[]) for(const item of (ri.data||[]).filter((x:any)=>x.return_id===r.id)){
    returns.push({
      id:item.id,
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
      refundMethod:r.refund_method||undefined
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
    sessionId:'',
    baseSalary:Number(x.base_salary)||0,
    commissions:Number(x.commission_amount)||0,
    total:Number(x.total_amount)||0,
    date:(pr.data||[]).find((run:any)=>run.id===x.payroll_run_id)?.created_at||new Date().toISOString(),
    status:(pr.data||[]).find((run:any)=>run.id===x.payroll_run_id)?.status==='paid'?'paid':'pending'
  }));

  const audits:InventoryAudit[]=(aa.data||[]).map((x:any)=>({
    id:x.id,
    date:x.created_at,
    branchId:x.warehouse_id,
    userId:x.created_by,
    status:x.status==='approved'?'completed':'pending',
    mode:'cycle_count',
    blindCount:Boolean(x.blind_count),
    submittedAt:x.submitted_at,
    reviewedBy:x.reviewed_by,
    reviewedAt:x.reviewed_at,
    notes:x.notes||'',
    items:(ai.data||[]).filter((it:any)=>it.audit_id===x.id).map((it:any)=>({
      productId:it.product_id,
      productName:pMap.get(it.product_id)||'Producto',
      expected:Number(it.expected_quantity)||0,
      counted:Number(it.counted_quantity),
      difference:Number(it.difference)||0
    }))
  }));

  return {returns,warranties,quotes,timeShifts,salarySettlements,audits};
}
