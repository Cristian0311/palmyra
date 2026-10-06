import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://mszojsqwilfqqcaycxch.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zem9qc3F3aWxmcXFjYXljeGNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MzkzODksImV4cCI6MjA5ODQxNTM4OX0.BSdhqmNwEMT5exDnu7H_gY_TSLSgzy1Cs4V2V2gSnvc';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function test() {
  const { data, error } = await supabase.from('users').select('*').limit(1);
  console.log("SELECT error:", error);
  console.log("SELECT data:", data);

  const { data: iData, error: iError } = await supabase.from('users').insert([{
    id: 'test-123',
    name: 'Test',
    email: 'test@example.com',
    role: 'cashier',
    commission_rate: 0,
    base_salary: 0
  }]);
  console.log("INSERT error:", iError);
  console.log("INSERT data:", iData);
}

test();
