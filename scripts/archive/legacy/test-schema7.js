import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.VITE_SUPABASE_URL || 'https://mszojsqwilfqqcaycxch.supabase.co', process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zem9qc3F3aWxmcXFjYXljeGNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MzkzODksImV4cCI6MjA5ODQxNTM4OX0.BSdhqmNwEMT5exDnu7H_gY_TSLSgzy1Cs4V2V2gSnvc');
async function test() {
  const { data, error } = await supabase.from('transaction_items').insert([{
    id: crypto.randomUUID(),
    transaction_id: 'fa883daf-a2ef-4d8d-a86a-d1b1cca108a6', // valid transaction
    cart_item_id: crypto.randomUUID(),
    product_id: '92938e69-60f3-48ec-b490-202b8bfc8b04',
    quantity: 1,
    serial_number: 'a',
    warranty_code: 'b',
    selected_size: 'c',
    selected_color: 'd',
    variant_label: 'e'
  }]);
  console.log('Error:', error);
}
test();
