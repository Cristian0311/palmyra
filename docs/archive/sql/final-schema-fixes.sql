-- 1. Fix transaction_items
ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS cart_item_id text;
ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS serial_number text;
ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS warranty_code text;
ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS selected_size text;
ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS selected_color text;

-- 2. Fix products
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price numeric;
ALTER TABLE products ADD COLUMN IF NOT EXISTS margin numeric;
ALTER TABLE products ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_type text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_value numeric;
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_stock_alert integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS has_serial boolean;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_kit boolean;
ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty_days integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS device_color text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS available_sizes jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS available_colors jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS next_serial integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image text;

ALTER TABLE products ALTER COLUMN cost DROP NOT NULL;
ALTER TABLE products ALTER COLUMN stock DROP NOT NULL;
ALTER TABLE products ALTER COLUMN min_stock DROP NOT NULL;

-- 3. Fix categories
ALTER TABLE categories ADD COLUMN IF NOT EXISTS department text;

-- 4. Fix branches
ALTER TABLE branches ADD COLUMN IF NOT EXISTS address text;

-- 5. Fix bank_transactions
ALTER TABLE bank_transactions ALTER COLUMN original_transaction_id TYPE text;


ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for settings" ON settings FOR ALL USING (true);
