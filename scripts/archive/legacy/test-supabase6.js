import { createClient } from '@supabase/supabase-js';
const supabaseUrl = 'https://mszojsqwilfqqcaycxch.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zem9qc3F3aWxmcXFjYXljeGNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MzkzODksImV4cCI6MjA5ODQxNTM4OX0.BSdhqmNwEMT5exDnu7H_gY_TSLSgzy1Cs4V2V2gSnvc';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function test() {
  const { data: iData, error: iError } = await supabase.from('returns').insert([{
    id: "DEV-0001",
    transaction_id: "test",
    date: new Date().toISOString(),
    status: 'pending'
  }]);
  console.log("Return INSERT error:", iError);
}
test();
