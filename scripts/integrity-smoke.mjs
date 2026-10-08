import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = (p) => fs.readFileSync(p, 'utf8');
const store = read('src/store/useStore.ts');
const offline = read('src/services/offlineSync.ts');
const pos = read('src/pages/POS.tsx');
const server = read('server.ts');
const reports = read('src/pages/Reports.tsx');
const migrations = fs.readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql'));

for (const contract of ['callProcessTransactionRPC','callVoidTransactionRPC','callCompleteReturnRPC','callTransferInventoryRPC','callReceiveSupplierOrderRPC','callCompleteInventoryAuditRPC']) {
  assert.match(store, new RegExp(contract));
}
assert.match(pos, /saleConfirmed/);
assert.match(pos, /processTransaction/);
for (const operation of ['void_transaction','return_complete','transfer','supplier_receive','audit_complete']) {
  assert.match(offline, new RegExp("['\\\"]" + operation + "['\\\"]"));
}
assert.match(server, /app\\.use\\('\/api\/ai-'/);
assert.match(server, /rateLimitExchange/);
assert.doesNotMatch(server, /MARÉ|OmniSync POS|Mi Tienda POS/i);
assert.doesNotMatch(reports, /MARÉ|OmniSync POS|Mi Tienda POS/i);
for (const required of ['process_pos_transaction_v2','void_pos_transaction_v2','complete_return_v2','process_inventory_transfer_v2','receive_supplier_order_v2','complete_inventory_audit_v2']) {
  assert.ok(migrations.some((name) => read('supabase/migrations/' + name).includes(required)), 'Missing migration contract: ' + required);
}
assert.ok(migrations.some((name) => name.includes('enterprise_security_hardening')), 'Missing enterprise security migration');
console.log('PALMYRA integrity smoke: PASS');
