-- Fix for Users table (add supervisor_id)
ALTER TABLE users ADD COLUMN IF NOT EXISTS supervisor_id uuid REFERENCES users(id);

-- Fix for Salary Settlements
CREATE TABLE IF NOT EXISTS salary_settlements (
  id text primary key,
  user_id uuid references users(id),
  user_name text not null,
  session_id text,
  base_salary numeric not null,
  commissions numeric not null,
  total numeric not null,
  date timestamp with time zone not null,
  status text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Note: session_id is text because cash_sessions id from frontend is 'SESS-XXX'

ALTER TABLE salary_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for salary_settlements" ON salary_settlements FOR ALL USING (true);
