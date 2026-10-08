import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = (p) => fs.readFileSync(p, 'utf8');
const store = read('src/store/useStore.ts');
const sync = read('src/services/supabaseSync.ts');
const syncRpc = read('src/services/supabaseSync/rpc.ts');
const syncPull = read('src/services/supabaseSync/pull.ts');
const offline = read('src/services/offlineSync.ts');
const pos = read('src/pages/POS.tsx');
const server = read('server.ts');
const reports = read('src/pages/Reports.tsx');
const migrations = fs.readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql'));

assert.match(store, /processTransaction: async/);
assert.match(store, /callProcessTransactionRPC\\(transaction\\)/);
assert.match(store, /applyLocalCompletedSale\\(transaction\\)/);
assert.match(store, /callVoidTransactionRPC/);
assert.match(store, /callCompleteReturnRPC/);
assert.match(store, /callTransferInventoryRPC/);
assert.match(store, /callReceiveSupplierOrderRPC/);
assert.match(store, /callCompleteInventoryAuditRPC/);
assert.match(pos, /const saleConfirmed = await processTransaction\\(tx\\)/);
assert.match(offline, /'void_transaction'/);
assert.match(offline, /'return_complete'/);
assert.match(offline, /'transfer'/);
assert.match(offline, /'supplier_receive'/);
assert.match(offline, /'audit_complete'/);
assert.match(syncRpc, /kit_components: item\\.product\\?\\.kitComponents/);
assert.match(syncPull, /fetchAllRows\\(supabase, 'transactions', 'date'\\)/);
assert.doesNotMatch(sync, /from\\('transactions'\\)\\.delete\\(\\)/);
assert.match(server, /app\\.use\\('\/api\/ai-', requireAuthenticatedRequest\\)/);
assert.match(server, /rateLimitExchange/);
assert.doesNotMatch(server, /MARÉ|OmniSync POS|Mi Tienda POS/i);
assert.doesNotMatch(reports, /MARÉ|OmniSync POS|Mi Tienda POS/i);
for (const required of ['process_pos_transaction_v2','void_pos_transaction_v2','complete_return_v2','process_inventory_transfer_v2','receive_supplier_order_v2','complete_inventory_audit_v2']) {
  assert.ok(migrations.some((name) => read('supabase/migrations/' + name).includes(required)), 'Missing migration contract: ' + required);
}
assert.ok(migrations.some((name) => name.includes('enterprise_security_hardening')), 'Missing enterprise security migration');
console.log('PALMYRA integrity smoke: PASS');
