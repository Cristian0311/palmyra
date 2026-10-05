// PALMYRA synchronization remains warehouse-scoped and company-currency aware.
import { getSupabase } from '../../lib/supabase';
import { getActiveTenant } from '../tenant';
import type {
  Product, Category, Branch, InventoryLevel, User,
  BankCard, Customer, Transaction, CashRegisterSession,
  Warranty, ReturnItem, InventoryTransfer,
  TimeShift, Quote, BankTransaction, SupplierOrder, InventoryAudit, SalarySettlement, Supplier,
} from '../../types';
import { fetchAllRows, type SyncResult } from './core';
import { loadSaaSContext } from '../saas';
import { loadReturnsWarrantiesQuotesTimePayroll } from './pull/loadOperationalExtras';
import { mapBranch, mapProduct, mapUser, normalizeSaleItem } from './pull/mappers';

async function loadCatalog() {
  const tenant = await getActiveTenant();
  const supabase = getSupabase()!;

  const [warehousesRes, categoriesRes, productsRes, employeesRes, accessRes, companyRes, variantsRes, barcodeRes, kitRes, currenciesRes] = await Promise.all([
    supabase.from('warehouses').select('*').eq('company_id', tenant.companyId).eq('active', true).order('created_at', { ascending: true }),
    supabase.from('categories').select('*').eq('company_id', tenant.companyId).eq('active', true).order('created_at', { ascending: true }),
    supabase.from('products').select('*').eq('company_id', tenant.companyId).neq('status', 'archived').order('created_at', { ascending: true }),
    supabase.from('employees').select('*').eq('company_id', tenant.companyId).eq('active', true).order('created_at', { ascending: true }),
    supabase.from('employee_warehouse_access').select('*').eq('company_id', tenant.companyId),
    supabase.from('companies').select('id,name,default_currency_code,timezone').eq('id', tenant.companyId).single(),
    supabase.from('product_variants').select('*').eq('company_id', tenant.companyId).eq('active', true),
    supabase.from('product_barcodes').select('*').eq('company_id', tenant.companyId).eq('active', true),
    supabase.from('product_kit_components').select('*').eq('company_id', tenant.companyId),
    supabase.from('currencies').select('*').eq('active', true).order('code'),
  ]);

  const firstError = [warehousesRes,categoriesRes,productsRes,employeesRes,accessRes,companyRes,variantsRes,barcodeRes,kitRes,currenciesRes].find(r => r.error)?.error;
  if (firstError) throw firstError;

  const variantsByProduct = new Map<string, any[]>();
  for (const v of variantsRes.data || []) {
    const arr = variantsByProduct.get(v.product_id) || [];
    arr.push(v);
    variantsByProduct.set(v.product_id, arr);
  }
  const kitsByProduct = new Map<string, any[]>();
  for (const k of kitRes.data || []) {
    const arr = kitsByProduct.get(k.kit_product_id) || [];
    arr.push(k);
    kitsByProduct.set(k.kit_product_id, arr);
  }
  const productById = new Map<string, Product>();
  const products = (productsRes.data || []).map((p:any) => {
    const firstBarcode = (barcodeRes.data || []).find((b:any) => b.product_id === p.id)?.barcode || '';
    const item = mapProduct(p, firstBarcode, kitsByProduct.get(p.id) || []);
    productById.set(item.id, item);
    return item;
  });

  const ctx = await loadSaaSContext();
  const users: User[] = [
    ...(ctx?.user && ctx.roleKey === 'admin' ? [{
      ...ctx.user,
      id: ctx.authUserId,
      email: ctx.user.email || '',
      role: 'admin' as const,
      baseSalary: 0,
      permissions: ['pos_access','reports_access','inventory_access','admin_access','cash_audit'],
      isActive: true,
    }] : []),
    ...(employeesRes.data || []).map((e:any) => mapUser(e, accessRes.data || []))
  ];

  const branches = (warehousesRes.data || []).map(mapBranch);

  const currencies = (currenciesRes.data || []).map((c:any) => ({
    code: c.code,
    name: c.name || c.code,
    symbol: c.symbol || c.code,
    rateToBase: c.code === (companyRes.data?.default_currency_code || 'USD') ? 1 : 1,
    isBase: c.code === (companyRes.data?.default_currency_code || 'USD'),
  }));

  const { data: companySettings, error: settingsError } = await supabase
    .from('company_settings')
    .select('settings')
    .eq('company_id', tenant.companyId)
    .maybeSingle();
  if (settingsError) throw settingsError;

  const settings = companySettings?.settings && typeof companySettings.settings === 'object'
    ? companySettings.settings
    : {};
  const storeConfig = settings.storeConfig || {
    storeName: companyRes.data?.name || 'PALMYRA POS',
    address: '',
    phone: '',
    receiptNotes: '',
    darkMode: false,
    manualOfflineSync: true
  };
  const receiptConfig = settings.receiptConfig || {
    showLogo: false, showAddress: true, showPhone: true, showFooter: true,
    footerText: 'Gracias por su compra.',
    businessName: companyRes.data?.name || 'PALMYRA POS',
    businessAddress: '',
    businessPhone: '',
    printerWidth: '80mm',
    autoPrint: false
  };

  return { tenant, warehouses: warehousesRes.data || [], branches, categories: categoriesRes.data || [], products, users, currencies, storeConfig, receiptConfig };
}

async function loadInventory(branchId?: string) {
  const tenant = await getActiveTenant();
  const supabase = getSupabase()!;
  let q = supabase.from('stock_balances').select('*').eq('company_id', tenant.companyId);
  if (branchId) q = q.eq('warehouse_id', branchId);
  const { data: baseRows, error: baseErr } = await q;
  if (baseErr) throw baseErr;

  let vq = supabase.from('variant_stock_balances').select('*,product_variants(name)').eq('company_id', tenant.companyId);
  if (branchId) vq = vq.eq('warehouse_id', branchId);
  const { data: variantRows, error: variantErr } = await vq;
  if (variantErr) throw variantErr;

  const productsRes = await supabase.from('products').select('id,minimum_stock').eq('company_id', tenant.companyId);
  if (productsRes.error) throw productsRes.error;  const minByProduct = new Map<string, number>((productsRes.data || []).map((p:any) => [p.id, Number(p.minimum_stock) || 0]));

  const inventory: InventoryLevel[] = [];
  for (const r of baseRows || []) {
    inventory.push({
      id: `${r.warehouse_id}-${r.product_id}-base`,
      productId: r.product_id,
      branchId: r.warehouse_id,
      quantity: Number(r.quantity) || 0,
      minQuantity: minByProduct.get(r.product_id) || 0
    });
  }
  for (const r of variantRows || []) {
    inventory.push({
      id: `${r.warehouse_id}-${r.product_id}-${r.variant_id}`,
      productId: r.product_id,
      branchId: r.warehouse_id,
      variantLabel: r.product_variants?.name || r.variant_id,
      quantity: Number(r.quantity) || 0,
      minQuantity: minByProduct.get(r.product_id) || 0    });
  }
  return inventory;
}

async function loadSales(branchId?: string, limit = 500) {
  const tenant = await getActiveTenant();
  const supabase = getSupabase()!;
  let salesQ = supabase.from('sales').select('*').eq('company_id', tenant.companyId).order('created_at', { ascending: false }).limit(limit);
  if (branchId) salesQ = salesQ.eq('warehouse_id', branchId);
  const { data: sales, error: salesErr } = await salesQ;
  if (salesErr) throw salesErr;

  const ids = (sales || []).map((s:any) => s.id);
  if (!ids.length) return [] as Transaction[];

  const [itemsRes, paymentsRes, productsRes, variantsRes, companyRes] = await Promise.all([
    supabase.from('sale_items').select('*').in('sale_id', ids),
    supabase.from('payments').select('*').in('sale_id', ids),
    supabase.from('products').select('*').eq('company_id', tenant.companyId),
    supabase.from('product_variants').select('id,name').eq('company_id', tenant.companyId),
    supabase.from('companies').select('default_currency_code').eq('id', tenant.companyId).single(),
  ]);
  if (itemsRes.error) throw itemsRes.error;
  if (paymentsRes.error) throw paymentsRes.error;
  if (productsRes.error) throw productsRes.error;
  if (variantsRes.error) throw variantsRes.error;
  if (companyRes.error) throw companyRes.error;
  const defaultCurrencyCode = companyRes.data?.default_currency_code || 'CUP';

  const barcodeRes = await supabase.from('product_barcodes').select('product_id,barcode').eq('company_id', tenant.companyId).eq('active', true);
  const productMap = new Map<string,Product>();
  for (const p of productsRes.data || []) productMap.set(p.id, mapProduct(p, (barcodeRes.data || []).find((b:any)=>b.product_id===p.id)?.barcode || ''));
  const variantMap = new Map<string,string>((variantsRes.data || []).map((v:any)=>[v.id,v.name]));

  const itemsBySale = new Map<string, any[]>();
  for (const item of itemsRes.data || []) {
    const arr = itemsBySale.get(item.sale_id) || [];
    arr.push(item);
    itemsBySale.set(item.sale_id, arr);
  }
  const paymentsBySale = new Map<string, any[]>();
  for (const p of paymentsRes.data || []) {
    const arr = paymentsBySale.get(p.sale_id) || [];
    arr.push(p);
    paymentsBySale.set(p.sale_id, arr);
  }

  const employeeNames = new Map<string,string>();
  const employeesRes = await supabase.from('employees').select('id,full_name,user_id').eq('company_id',tenant.companyId);
  for (const e of employeesRes.data || []) employeeNames.set(e.id,e.full_name);

  return (sales || []).map((s:any) => {
    const itemRows = itemsBySale.get(s.id) || [];
    const pRows = paymentsBySale.get(s.id) || [];
    const payments = pRows.map((p:any) => ({
      method: p.method || 'cash',
      amount: Number(p.amount) || 0,
      currencyCode: p.currency_code || s.currency_code || defaultCurrencyCode,
      exchangeRate: Number(p.exchange_rate) || 1,
      bankCardId: undefined
    }));
    const userId = s.employee_id || s.seller_user_id || '';
    return {
      id: s.id,
      branchId: s.warehouse_id,
      userId,
      cashierName: employeeNames.get(s.employee_id) || undefined,
      date: s.created_at,
      subtotal: Number(s.total) || 0,
      tax: 0,
      discount: 0,
      total: Number(s.total) || 0,
      payments,
      items: itemRows.map((it:any,i:number)=>normalizeSaleItem(it,productMap,variantMap,s.id,i)),
      status: s.status === 'refunded' ? 'refunded' : 'completed',
      customerId: s.customer_id || undefined,
      sessionId: s.cash_session_id || undefined,
      notes: s.notes || '',
      paymentMethod: payments[0]?.method || 'cash',
    } as Transaction;
  });
}

async function loadCashSessions(branchId?: string) {
  const tenant = await getActiveTenant();
  const supabase = getSupabase()!;
  const [registersRes, employeesRes, companyRes] = await Promise.all([
    supabase.from('cash_registers').select('*').eq('company_id',tenant.companyId).eq('active',true),
    supabase.from('employees').select('id,full_name,user_id').eq('company_id',tenant.companyId),
    supabase.from('companies').select('default_currency_code').eq('id',tenant.companyId).single()
  ]);
  if (registersRes.error) throw registersRes.error;
  if (employeesRes.error) throw employeesRes.error;
  if (companyRes.error) throw companyRes.error;
  const registerMap = new Map<string,any>((registersRes.data || []).map((r:any)=>[r.id,r]));
  const employeeMap = new Map<string,string>((employeesRes.data || []).map((e:any)=>[e.id,e.full_name]));
  const employeeUserMap = new Map<string,string>((employeesRes.data || []).filter((e:any)=>e.user_id).map((e:any)=>[e.id,e.user_id]));
  const defaultCurrencyCode = companyRes.data?.default_currency_code || 'CUP';

  let q=supabase.from('cash_sessions').select('*').eq('company_id',tenant.companyId).order('opened_at',{ascending:false}).limit(50);
  const { data, error }=await q;
  if(error) throw error;
  return (data||[]).filter((s:any)=>{
    const reg=registerMap.get(s.cash_register_id);
    return !branchId || reg?.warehouse_id===branchId;
  }).map((s:any):CashRegisterSession=>({
    id:s.id,
    turnNumber:Number(s.turn_number)||undefined,
    branchId:registerMap.get(s.cash_register_id)?.warehouse_id || '',
    openedAt:s.opened_at,
    closedAt:s.closed_at || undefined,
    openingBalance:Number(s.opening_amount)||0,
    openingAmount:Number(s.opening_amount)||0,
    status:s.status || 'open',
    userId:employeeUserMap.get(s.employee_id) || s.opened_by || s.employee_id || '',
    workerName:(s.metadata?.workerName || employeeMap.get(s.employee_id)) || undefined,
    workingEmployeeIds:Array.isArray(s.metadata?.workingEmployeeIds) && s.metadata.workingEmployeeIds.length
      ? s.metadata.workingEmployeeIds
      : (s.employee_id ? [employeeUserMap.get(s.employee_id) || s.employee_id] : (s.opened_by ? [s.opened_by] : [])),
    closingBalances:Array.isArray(s.metadata?.closingBalances)
      ? s.metadata.closingBalances
      : (s.physical_cash == null ? [] : [{method:'cash',amount:Number(s.physical_cash)||0,currencyCode:defaultCurrencyCode,exchangeRate:1}]),
    isForcedClose:Boolean(s.metadata?.isForcedClose),
    forcedCloseReason:s.metadata?.forcedCloseReason || undefined,
    discrepancyNote:s.metadata?.discrepancyNote || undefined,
    hasDiscrepancy:Boolean(s.metadata?.hasDiscrepancy),
    discrepancyDetails:Array.isArray(s.metadata?.discrepancyDetails)?s.metadata.discrepancyDetails:[],
    discrepancyDeductionApplied:Number(s.metadata?.discrepancyDeductionApplied)||0,
    deductedFromSalary:Boolean(s.metadata?.deductedFromSalary),
    aiDiagnostic:s.metadata?.aiDiagnostic || undefined,
    matchingProductsAnalysis:Array.isArray(s.metadata?.matchingProductsAnalysis)?s.metadata.matchingProductsAnalysis:[],
    auditStatus:s.metadata?.auditStatus || 'pending_review',
    auditNotes:s.metadata?.auditNotes || '',
    expectedBalance:s.metadata?.expectedBalance != null ? Number(s.metadata.expectedBalance) : (s.expected_cash == null ? undefined : Number(s.expected_cash)),
  }));
}

async function loadTransfers(branchId?: string) {
  const tenant=await getActiveTenant();
  const supabase=getSupabase()!;
  let q=supabase.from('transfers').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}).limit(500);
  if(branchId) q=q.or(`origin_warehouse_id.eq.${branchId},destination_warehouse_id.eq.${branchId}`);
  const {data,error}=await q;if(error)throw error;
  const ids=(data||[]).map((t:any)=>t.id);
  if(!ids.length)return [] as InventoryTransfer[];
  const [itemsRes,productsRes,warehousesRes]=await Promise.all([
    supabase.from('transfer_items').select('*').in('transfer_id',ids),
    supabase.from('products').select('id,name').eq('company_id',tenant.companyId),
    supabase.from('warehouses').select('id,name').eq('company_id',tenant.companyId)
  ]);
  if(itemsRes.error)throw itemsRes.error;if(productsRes.error)throw productsRes.error;if(warehousesRes.error)throw warehousesRes.error;
  const pMap=new Map<string,string>((productsRes.data||[]).map((p:any)=>[p.id,p.name]));
  const wMap=new Map<string,string>((warehousesRes.data||[]).map((w:any)=>[w.id,w.name]));
  const rows:InventoryTransfer[]=[];
  for(const t of data||[]){
    const tis=(itemsRes.data||[]).filter((i:any)=>i.transfer_id===t.id);
    for(const i of tis){
      rows.push({
        id:i.id,operationId:t.id,productId:i.product_id,productName:pMap.get(i.product_id)||'Producto',
        fromBranchId:t.origin_warehouse_id,fromBranchName:wMap.get(t.origin_warehouse_id)||'Origen',
        toBranchId:t.destination_warehouse_id,toBranchName:wMap.get(t.destination_warehouse_id)||'Destino',
        variantLabel:i.variant_id||undefined,quantity:Number(i.quantity)||0,variants:[],
        date:t.created_at,userId:t.created_by||'',status:t.status||'completed'
      });
    }
  }
  return rows;
}

async function loadCustomers() {
  const tenant=await getActiveTenant(); const supabase=getSupabase()!;
  const {data,error}=await supabase.from('customers').select('*').eq('company_id',tenant.companyId).eq('active',true).order('name').limit(5000);
  if(error)throw error;
  return (data||[]).map((c:any):Customer=>({id:c.id,name:c.name||'',email:c.email||'',phone:c.phone||'',taxId:c.tax_id||''}));
}
async function loadBanks() {
  const tenant=await getActiveTenant(); const supabase=getSupabase()!;
  const [a,t]=await Promise.all([
    supabase.from('bank_accounts').select('*').eq('company_id',tenant.companyId).eq('active',true).order('created_at',{ascending:false}),    supabase.from('bank_transactions').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}).limit(1000)
  ]);
  if(a.error)throw a.error;if(t.error)throw t.error;
  return {
    bankCards:(a.data||[]).map((x:any):BankCard=>({id:x.id,name:x.name,bank:x.bank_name,bankName:x.bank_name,cardHolder:'',lastFour:x.last_four,lastFourDigits:x.last_four,balance:Number(x.balance)||0,currency:x.currency_code||'USD',isActive:x.active!==false})),
    bankTransactions:(t.data||[]).map((x:any):BankTransaction=>({id:x.id,cardId:x.bank_account_id,type:x.transaction_type,amount:Number(x.amount)||0,date:x.created_at,reference:x.reference||'',description:x.note||'',transactionId:x.reference_id||undefined}))
  };
}
async function loadSuppliersOrders() {
  const tenant=await getActiveTenant(); const supabase=getSupabase()!;
  const [s,o] = await Promise.all([
    supabase.from('suppliers').select('*').eq('company_id',tenant.companyId).eq('active',true).order('name'),
    supabase.from('purchase_orders').select('*').eq('company_id',tenant.companyId).order('created_at',{ascending:false}).limit(1000),
  ]);
  if(s.error)throw s.error;if(o.error)throw o.error;
  const orderIds=(o.data||[]).map((x:any)=>x.id).filter(Boolean);
  const i=orderIds.length
    ? await supabase.from('purchase_items').select('*').in('purchase_order_id',orderIds)
    : {data:[],error:null};
  if(i.error)throw i.error;
  const productsRes=await supabase.from('products').select('id,name').eq('company_id',tenant.companyId);
  if(productsRes.error)throw productsRes.error;
  const pMap=new Map<string,string>((productsRes.data||[]).map((p:any)=>[p.id,p.name]));
  const supplierMap=new Map<string,string>((s.data||[]).map((x:any)=>[x.id,x.name]));
  return {
    suppliers:(s.data||[]).map((x:any):Supplier=>({id:x.id,name:x.name||'',phone:x.phone||'',address:x.address||'',email:x.email||'',rating:Number(x.rating)||0,typeOfMerchandise:x.merchandise_type||''})),
    supplierOrders:(o.data||[]).map((x:any):SupplierOrder=>({
      id:x.id,supplierId:x.supplier_id,date:x.created_at,expectedDeliveryDate:x.expected_delivery_date||undefined,
      branchId:x.warehouse_id,total:Number(x.total)||0,status:x.status||'pending',transportDetails:x.transport_details||undefined,transportCost:Number(x.transport_cost)||0,
      items:(i.data||[]).filter((it:any)=>it.purchase_order_id===x.id).map((it:any)=>({productId:it.product_id,productName:pMap.get(it.product_id)||'Producto',quantity:Number(it.quantity)||0,cost:Number(it.unit_cost)||0}))
    }))
  };
}

async function loadAllData(branchId?:string) {
  const catalog=await loadCatalog();
  const [inventory,transactions,cashSessions,transfers,customers,banks,extras,suppliersOrders]=await Promise.all([
    loadInventory(),
    loadSales(undefined,1000),
    loadCashSessions(),
    loadTransfers(),
    loadCustomers(),
    loadBanks(),
    loadReturnsWarrantiesQuotesTimePayroll(),
    loadSuppliersOrders()  ]);
  const lastTurnNumber = cashSessions.reduce((m:number,s:any)=>Math.max(m,Number(s.turnNumber)||0),0);
  return {
    products:catalog.products,categories:catalog.categories,inventory,branches:catalog.branches,users:catalog.users,
    currencies:catalog.currencies,customers,bankCards:banks.bankCards,bankTransactions:banks.bankTransactions,
    transactions,cashSessions,transfers,warranties:extras.warranties,returns:extras.returns,quotes:extras.quotes,
    timeShifts:extras.timeShifts,salarySettlements:extras.salarySettlements,inventoryAudits:extras.audits,
    suppliers:suppliersOrders.suppliers,supplierOrders:suppliersOrders.supplierOrders,
    receiptConfig:catalog.receiptConfig,storeConfig:catalog.storeConfig,lastTurnNumber
  };
}

export async function pullBranchInventoryFromSupabase(branchId?: string) {
  try { return { success:true, inventory:await loadInventory(branchId) }; }
  catch(e:any){ return {success:false,inventory:[],message:e?.message||'No se pudo actualizar el inventario'}; }
}

export async function pullTransferHistoryFromSupabase() {
  try { return {success:true,transfers:await loadTransfers()}; }
  catch(e:any){ return {success:false,transfers:[],message:e?.message||'No se pudo actualizar el historial de transferencias'}; }
}

export async function pullBankDataFromSupabase() {
  try { return {success:true,...await loadBanks()}; }
  catch(e:any){ return {success:false,bankCards:[],bankTransactions:[],message:e?.message||'No se pudieron actualizar las cuentas bancarias'}; }
}

export async function pullBranchOperationalDataFromSupabase(branchId:string, options?:{sessionId?:string;transactionLimit?:number;transferLimit?:number}) {
  try {
    const transactions=await loadSales(branchId,options?.transactionLimit||250);
    const cashSessions=(await loadCashSessions(branchId)).filter((s:any)=>!options?.sessionId || s.id===options.sessionId);
    const inventory=await loadInventory(branchId);
    const transfers=await loadTransfers(branchId);
    return {success:true,transactions,cashSessions,inventory,transfers};
  } catch(e:any){
    return {success:false,transactions:[],cashSessions:[],inventory:[],transfers:[],message:e?.message||'No se pudieron actualizar los datos operativos'};
  }
}

export async function pullGlobalCatalogDataFromSupabase() {
  try {
    const c=await loadCatalog();
    return {success:true,data:{branches:c.branches,categories:c.categories,products:c.products,users:c.users,currencies:c.currencies,receiptConfig:c.receiptConfig,storeConfig:c.storeConfig}};
  } catch(e:any){ return {success:false,message:e?.message||'No se pudo actualizar el catálogo remoto'}; }
}

export async function pullPosBootstrapFromSupabase(branchId?:string) {
  try { return {success:true,data:await loadAllData(branchId)}; }
  catch(e:any){ return {success:false,data:null,message:e?.message||'No se pudo cargar PALMYRA'}; }
}

export async function pullAllFromSupabase():Promise<{data:any;result:SyncResult}> {
  try {
    const data=await loadAllData();
    const result:SyncResult={
      success:true,message:'Datos de PALMYRA cargados desde la empresa activa.',
      counts:{
        products:data.products.length,categories:data.categories.length,inventory:data.inventory.length,
        branches:data.branches.length,users:data.users.length,bankCards:data.bankCards.length,
        customers:data.customers.length,currencies:data.currencies.length,transactions:data.transactions.length,
        cashSessions:data.cashSessions.length
      }
    };
    return {data,result};
  } catch(e:any){
    return {data:null,result:{success:false,message:e?.message||'Error al sincronizar PALMYRA',errors:[e?.message||String(e)]}};
  }
}