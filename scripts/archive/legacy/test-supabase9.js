import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
const supabaseUrl = 'https://mszojsqwilfqqcaycxch.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zem9qc3F3aWxmcXFjYXljeGNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MzkzODksImV4cCI6MjA5ODQxNTM4OX0.BSdhqmNwEMT5exDnu7H_gY_TSLSgzy1Cs4V2V2gSnvc';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function test() {
  const { data: iData, error: iError } = await supabase.from('transaction_payments').insert([{
    transaction_id: crypto.randomUUID(),
    currency_code: 'USD',
    amount: 10,
    exchange_rate: 1,
    method: 'cash'
  }]);
  console.log("Tx Payments INSERT error:", iError);
}
test();
