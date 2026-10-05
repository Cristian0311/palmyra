import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = 'https://mszojsqwilfqqcaycxch.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zem9qc3F3aWxmcXFjYXljeGNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MzkzODksImV4cCI6MjA5ODQxNTM4OX0.BSdhqmNwEMT5exDnu7H_gY_TSLSgzy1Cs4V2V2gSnvc';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function test() {
  const uuid = crypto.randomUUID();
  const { data: iData, error: iError } = await supabase.from('users').insert([{
    id: uuid,
    name: 'Test',
    email: 'test' + uuid + '@example.com',
    role: 'cashier',
    commission_rate: 0,
    base_salary: 0
  }]);
  console.log("INSERT error:", iError);
}
test();
