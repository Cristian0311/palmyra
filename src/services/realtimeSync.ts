import { getSupabase } from '../lib/supabase';
import { useStore } from '../store/useStore';
import { getOfflineQueueCount } from './offlineQueue';

let realtimeChannel:any=null;
let pollIntervalId:any=null;
let refreshTimeout:any=null;
let isSyncInProgress=false;
let bootstrappedTenantKey='';
let lastOperationalRefreshAt=0;
let lastGlobalRefreshAt=0;
const OP_MS=5000;
const GLOBAL_MS=15000;

const GLOBAL_TABLES=new Set([
  'warehouses','categories','products','product_variants','product_barcodes','product_kit_components',
  'employees','employee_warehouse_access','currencies'
]);
const OP_TABLES=new Set([
  'stock_balances','variant_stock_balances','stock_movements','sales','sale_items','payments',
  'cash_registers','cash_sessions','cash_movements','transfers','transfer_items','sales_returns',
  'sales_return_items','warranties','purchase_orders','purchase_items','quotes','quote_items',
  'inventory_audits','inventory_audit_items','bank_accounts','bank_transactions','employee_time_shifts',
  'payroll_runs','payroll_items'
]);

async function getTenantState(){
  const { getActiveTenant } = await import('./tenant');
  const tenant = await getActiveTenant();
  return { companyId: tenant.companyId, branchId: useStore.getState().currentBranchId, bootstrapPosFromSupabase: async()=>{ const {pullPosBootstrapFromSupabase}=await import('./supabaseSync'); const r=await pullPosBootstrapFromSupabase(useStore.getState().currentBranchId); if(r.success){useStore.setState(r.data);return true;} return false; }, refreshBranchOperationalData:()=>useStore.getState().refreshBranchOperationalData(), refreshGlobalCatalogData:()=>useStore.getState().refreshGlobalCatalogData() };
}

async function refresh(force=false){
  if(typeof navigator!=='undefined'&&!navigator.onLine)return;
  if(isSyncInProgress)return;
  if(getOfflineQueueCount()>0){
    isSyncInProgress=true;
    let replayRemaining = getOfflineQueueCount();
    try{
      const {processOfflineQueue}=await import('./offlineSync');
      const result = await processOfflineQueue();
      replayRemaining = result.remaining;
    }catch(e){
      console.warn('[PALMYRA] offline replay failed',e);
    }finally{
      isSyncInProgress=false;
    }

    // Una eliminación (u otra mutación global) puede ser confirmada justo
    // durante el replay. No dejamos al dispositivo con el catálogo anterior:
    // cuando la cola queda vacía, hacemos una lectura canónica inmediata para
    // que el cambio se refleje también en otras pestañas/dispositivos aunque
    // Realtime no haya entregado el evento a tiempo.
    if(replayRemaining===0){
      try{
        const state=await getTenantState();
        await state.refreshGlobalCatalogData();
      }catch(e){
        console.warn('[PALMYRA] No se pudo refrescar el catálogo tras vaciar la cola offline:',e);
      }
    }
    return;
  }
  const state=await getTenantState();
  const key=state.companyId+'|'+state.branchId;
  if(force||key!==bootstrappedTenantKey){
    const ok=await state.bootstrapPosFromSupabase();
    if(ok)bootstrappedTenantKey=key;
  }else{
    await state.refreshBranchOperationalData();
  }
}

function schedule(kind:'operational'|'global'|'all'='operational',delay=500){
  if(refreshTimeout)clearTimeout(refreshTimeout);
  refreshTimeout=setTimeout(async()=>{
    if(!navigator.onLine)return;
    const now=Date.now();
    if(kind==='operational'&&now-lastOperationalRefreshAt<OP_MS)return;
    if(kind==='global'&&now-lastGlobalRefreshAt<GLOBAL_MS)return;
    if(kind==='operational')lastOperationalRefreshAt=now;else if(kind==='global')lastGlobalRefreshAt=now;
    if(kind==='all'){lastOperationalRefreshAt=now;lastGlobalRefreshAt=now;}
    const state=await getTenantState();
    if(getOfflineQueueCount()>0){await refresh(false);return;}
    try{
      if(kind==='global')await state.refreshGlobalCatalogData();
      else if(kind==='all')await state.bootstrapPosFromSupabase();
      else await state.refreshBranchOperationalData();
    }catch(e){console.warn('[PALMYRA] realtime refresh failed',e);}
  },delay);
}

export function triggerBackgroundSync(force=false){return refresh(force);}

export function scheduleDebouncedSync(delayMs=1200){schedule('all',delayMs);}

export function initMultiDeviceRealtimeSync():()=>void{
  if(typeof window==='undefined')return ()=>{};
  const supabase=getSupabase();
  if(!supabase)return ()=>{};

  const subscribe=async ()=>{
    if(realtimeChannel)return;
    const state=await getTenantState();
    const tenant=state.companyId;
    const channel=supabase.channel('palmyra-tenant-'+(tenant||'anon'));
    for(const table of [...GLOBAL_TABLES,...OP_TABLES]){
      const cfg:any={event:'*',schema:'public',table};
      if(tenant)cfg.filter='company_id=eq.'+tenant;
      channel.on('postgres_changes',cfg,(payload:any)=>{
        window.dispatchEvent(new CustomEvent('remote_data_changed',{detail:payload}));
        const tableName=payload?.table;
        if(OP_TABLES.has(tableName))schedule('operational',400);
        else if(GLOBAL_TABLES.has(tableName))schedule('global',700);
      });
    }
    channel.subscribe((status:string)=>{
      if(status==='SUBSCRIBED')schedule('all',300);
      else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')console.warn('[PALMYRA] Realtime:',status);
    });
    realtimeChannel=channel;
  };

  const onOffline=()=>{
    bootstrappedTenantKey='';
    if(realtimeChannel){try{supabase.removeChannel(realtimeChannel);}catch{}realtimeChannel=null;}
  };
  const onOnline=()=>{void subscribe();refresh(false).catch(()=>{});};
  const onFocus=()=>{if(document.visibilityState!=='hidden')schedule('operational',300);};
  const onVisibility=()=>{if(document.visibilityState==='visible')schedule('all',300);};

  window.addEventListener('online',onOnline);
  window.addEventListener('offline',onOffline);
  window.addEventListener('focus',onFocus);
  document.addEventListener('visibilitychange',onVisibility);
  if(navigator.onLine){subscribe();refresh(false).catch(()=>{});}

  pollIntervalId=setInterval(()=>{if(navigator.onLine)refresh(false).catch(()=>{});},120000);

  return ()=>{
    window.removeEventListener('online',onOnline);
    window.removeEventListener('offline',onOffline);
    window.removeEventListener('focus',onFocus);
    document.removeEventListener('visibilitychange',onVisibility);
    if(pollIntervalId)clearInterval(pollIntervalId);
    if(refreshTimeout)clearTimeout(refreshTimeout);
    if(realtimeChannel){try{supabase.removeChannel(realtimeChannel);}catch{}realtimeChannel=null;}
  };
}
