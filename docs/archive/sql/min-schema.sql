create extension if not exists "uuid-ossp";
create table if not exists branches (
  id text primary key,
  name text not null,
  address text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists categories (
  id text primary key,
  name text not null,
  department text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists products (
  id text primary key,
  name text not null,
  sku text not null,
  barcode text,
  cost_price numeric not null default 0,
  price numeric not null default 0,
  margin numeric not null default 0,
  category_id text references categories(id),
  color text,
  commission_type text,
  commission_value numeric,
  unit text,
  status text default 'active',
  min_stock_alert integer,
  has_serial boolean default false,
  is_kit boolean default false,
  warranty_days integer,
  device_color text,
  available_sizes jsonb,
  available_colors jsonb,
  next_serial integer,
  image text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists inventory_levels (
  id text primary key,
  product_id text references products(id) on delete cascade,
  branch_id text references branches(id) on delete cascade,
  variant_label text,
  quantity integer not null default 0,
  min_quantity integer not null default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (product_id, branch_id, variant_label)
);
alter table branches enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table inventory_levels enable row level security;
create policy "Allow public read for branches" on branches for select using (true);
create policy "Allow public read for categories" on categories for select using (true);
create policy "Allow public read for products" on products for select using (true);
create policy "Allow public read for inventory_levels" on inventory_levels for select using (true);
create policy "Allow all for branches" on branches for all using (true);
create policy "Allow all for categories" on categories for all using (true);
create policy "Allow all for products" on products for all using (true);
create policy "Allow all for inventory_levels" on inventory_levels for all using (true);
create table if not exists customers (
  id text primary key,
  name text not null,
  email text not null,
  phone text not null,
  tax_id text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists users (
  id text primary key,
  name text not null,
  email text not null unique,
  role text not null default 'cashier',
  password text,
  commission_rate numeric not null default 0,
  base_salary numeric not null default 0,
  phone text,
  branch_id text references branches(id),
  supervisor_id text references users(id),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists transactions (
  id text primary key,
  branch_id text references branches(id),
  user_id text references users(id),
  date timestamp with time zone not null,
  subtotal numeric not null default 0,
  tax numeric not null default 0,
  total numeric not null default 0,
  status text not null default 'completed',
  customer_id text references customers(id),
  ncf text,
  ncf_type text,
  change_given numeric,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists transaction_payments (
  id text primary key,
  transaction_id text references transactions(id) on delete cascade,
  currency_code text not null,
  amount numeric not null,
  exchange_rate numeric not null,
  method text not null,
  bank_card_id text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists transaction_items (
  id text primary key,
  transaction_id text references transactions(id) on delete cascade,
  cart_item_id text,
  product_id text references products(id),
  quantity integer not null,
  serial_number text,
  warranty_code text,
  selected_size text,
  selected_color text,
  variant_label text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
alter table customers enable row level security;
alter table users enable row level security;
alter table transactions enable row level security;
alter table transaction_payments enable row level security;
alter table transaction_items enable row level security;
create policy "Allow all for customers" on customers for all using (true);
create policy "Allow all for users" on users for all using (true);
create policy "Allow all for transactions" on transactions for all using (true);
create policy "Allow all for transaction_payments" on transaction_payments for all using (true);
create policy "Allow all for transaction_items" on transaction_items for all using (true);
create table if not exists returns (
  id text primary key,
  transaction_id text references transactions(id),
  product_id text references products(id),
  quantity integer not null,
  reason text not null,
  date timestamp with time zone not null,
  status text not null,
  type text not null,
  notes text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists warranties (
  id text primary key,
  product_id text references products(id),
  product_name text not null,
  transaction_id text references transactions(id),
  customer_id text references customers(id),
  customer_name text,
  purchase_date timestamp with time zone not null,
  expiry_date timestamp with time zone not null,
  serial_number text,
  status text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists cash_sessions (
  id text primary key,
  branch_id text references branches(id),
  opened_at timestamp with time zone not null,
  closed_at timestamp with time zone,
  opening_balance numeric not null,
  expected_balance numeric,
  status text not null,
  user_id text references users(id),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists cash_movements (
  id text primary key,
  session_id text references cash_sessions(id) on delete cascade,
  type text not null,
  amount numeric not null,
  currency_code text not null,
  description text not null,
  date timestamp with time zone not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists inventory_transfers (
  id text primary key,
  product_id text references products(id),
  product_name text not null,
  from_branch_id text references branches(id),
  from_branch_name text,
  to_branch_id text references branches(id),
  to_branch_name text,
  variant_label text,
  quantity integer not null,
  variants jsonb,
  date timestamp with time zone not null,
  user_id text references users(id),
  status text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists suppliers (
  id text primary key,
  name text not null,
  rnc text,
  email text,
  phone text,
  address text,
  type_of_merchandise text,
  rating integer,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists supplier_orders (
  id text primary key,
  supplier_id text references suppliers(id),
  date timestamp with time zone not null,
  expected_delivery_date timestamp with time zone,
  total numeric not null,
  status text not null,
  branch_id text references branches(id),
  transport_details text,
  transport_cost numeric,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists supplier_order_items (
  id text primary key,
  order_id text references supplier_orders(id) on delete cascade,
  product_id text references products(id),
  product_name text not null,
  variant_label text,
  quantity integer not null,
  cost numeric not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists bank_cards (
  id text primary key,
  name text not null,
  bank text not null,
  last_four text,
  balance numeric not null,
  currency text not null,
  is_active boolean default true,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists bank_transactions (
  id text primary key,
  card_id text references bank_cards(id),
  type text not null,
  amount numeric not null,
  date timestamp with time zone not null,
  reference text,
  description text not null,
  original_transaction_id uuid,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
alter table returns enable row level security;
alter table warranties enable row level security;
alter table cash_sessions enable row level security;
alter table cash_movements enable row level security;
alter table inventory_transfers enable row level security;
alter table suppliers enable row level security;
alter table supplier_orders enable row level security;
alter table supplier_order_items enable row level security;
alter table bank_cards enable row level security;
alter table bank_transactions enable row level security;
create policy "Allow all for returns" on returns for all using (true);
create policy "Allow all for warranties" on warranties for all using (true);
create policy "Allow all for cash_sessions" on cash_sessions for all using (true);
create policy "Allow all for cash_movements" on cash_movements for all using (true);
create policy "Allow all for inventory_transfers" on inventory_transfers for all using (true);
create policy "Allow all for suppliers" on suppliers for all using (true);
create policy "Allow all for supplier_orders" on supplier_orders for all using (true);
create policy "Allow all for supplier_order_items" on supplier_order_items for all using (true);
create policy "Allow all for bank_cards" on bank_cards for all using (true);
create policy "Allow all for bank_transactions" on bank_transactions for all using (true);
create table if not exists inventory_audits (
  id text primary key,
  date timestamp with time zone not null,
  branch_id text references branches(id),
  user_id text references users(id),
  status text not null,
  notes text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists inventory_audit_items (
  id text primary key,
  audit_id text references inventory_audits(id) on delete cascade,
  product_id text references products(id),
  product_name text not null,
  variant_label text,
  expected integer not null,
  actual integer not null,
  difference integer not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists salary_settlements (
  id text primary key,
  user_id text references users(id),
  user_name text not null,
  session_id text references cash_sessions(id),
  base_salary numeric not null,
  commissions numeric not null,
  total numeric not null,
  date timestamp with time zone not null,
  status text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
alter table inventory_audits enable row level security;
alter table inventory_audit_items enable row level security;
alter table salary_settlements enable row level security;
create policy "Allow all for inventory_audits" on inventory_audits for all using (true);
create policy "Allow all for inventory_audit_items" on inventory_audit_items for all using (true);
create policy "Allow all for salary_settlements" on salary_settlements for all using (true);
create table if not exists quotes (
  id text primary key,
  branch_id text references branches(id),
  user_id text references users(id),
  customer_id text references customers(id),
  date timestamp with time zone not null,
  subtotal numeric not null,
  tax numeric not null,
  total numeric not null,
  status text not null,
  notes text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists quote_items (
  id text primary key,
  quote_id text references quotes(id) on delete cascade,
  product_id text references products(id),
  product_name text not null,
  quantity integer not null,
  price numeric not null,
  tax numeric not null,
  variant_label text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create table if not exists time_shifts (
  id text primary key,
  user_id text references users(id),
  clock_in timestamp with time zone not null,
  clock_out timestamp with time zone,
  notes text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
alter table quotes enable row level security;
alter table quote_items enable row level security;
alter table time_shifts enable row level security;
create policy "Allow all for quotes" on quotes for all using (true);
create policy "Allow all for quote_items" on quote_items for all using (true);
create policy "Allow all for time_shifts" on time_shifts for all using (true);
