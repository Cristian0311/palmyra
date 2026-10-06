import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.VITE_SUPABASE_URL || 'https://mszojsqwilfqqcaycxch.supabase.co', process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zem9qc3F3aWxmcXFjYXljeGNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MzkzODksImV4cCI6MjA5ODQxNTM4OX0.BSdhqmNwEMT5exDnu7H_gY_TSLSgzy1Cs4V2V2gSnvc');
async function test() {
  const { data: users } = await supabase.from('users').select('id').limit(1);
  const { data: branches } = await supabase.from('branches').select('id').limit(1);
  const { data: products } = await supabase.from('products').select('id').limit(1);
  
  if(!users || !branches || !products) return console.log('missing setup');
  
  const txId = crypto.randomUUID();
  const res = await supabase.from('transactions').insert([{
    id: txId,
    branch_id: branches[0].id,
    user_id: users[0].id,
    date: new Date().toISOString(),
    subtotal: 100,
    tax: 0,
    total: 100,
    status: 'completed',
    change_given: 0
  }]);
  console.log('Tx insert:', res.error);
  
  const res2 = await supabase.from('transaction_items').insert([{
    id: crypto.randomUUID(),
    transaction_id: txId,
    cart_item_id: crypto.randomUUID(),
    product_id: products[0].id,
    quantity: 5
  }]);
  console.log('Item insert:', res2.error);
  
  await supabase.from('transaction_items').delete().eq('transaction_id', txId);
  await supabase.from('transactions').delete().eq('id', txId);
}
test();
