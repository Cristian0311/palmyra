import { createClient } from '@supabase/supabase-js';
const supabaseUrl = 'https://mszojsqwilfqqcaycxch.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zem9qc3F3aWxmcXFjYXljeGNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MzkzODksImV4cCI6MjA5ODQxNTM4OX0.BSdhqmNwEMT5exDnu7H_gY_TSLSgzy1Cs4V2V2gSnvc';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const tables = [
  'time_shifts', 'quote_items', 'quotes', 'salary_settlements',
  'inventory_audit_items', 'inventory_audits', 'bank_transactions', 'bank_cards',
  'supplier_order_items', 'supplier_orders', 'suppliers',
  'inventory_transfers', 'cash_movements', 'cash_sessions',
  'warranties', 'returns', 'transaction_items', 'transaction_payments', 'transactions',
  'customers', 'inventory_levels', 'products', 'categories', 'branches', 'users'
];

async function test() {
  for (const table of tables) {
    const { error } = await supabase.from(table).insert([{ id: "test-id" }]);
    if (error && error.message.includes('uuid: "test-id"')) {
      console.log(table, "requires UUID");
    } else {
      console.log(table, "accepts text");
    }
  }
}
test();
