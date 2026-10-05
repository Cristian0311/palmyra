import crypto from 'crypto';

const categories = [
  { name: 'Electrodomésticos', department: 'Hogar' },
  { name: 'Ferretería', department: 'Construcción' },
  { name: 'Textil', department: 'Moda' },
  { name: 'Calzado', department: 'Moda' },
  { name: 'Higiene', department: 'Personal' },
  { name: 'Alimentos', department: 'Consumo' },
  { name: 'Bebidas', department: 'Consumo' },
  { name: 'Muebles', department: 'Hogar' },
  { name: 'Telefonía', department: 'Tecnología' },
  { name: 'Computación', department: 'Tecnología' }
];

const productTemplates = [
  { name: 'Nevera', prefix: 'NEV', category: 'Electrodomésticos', basePrice: 500, image: 'https://images.unsplash.com/photo-1571175439168-9663e4406584?w=400&h=400&fit=crop' },
  { name: 'Lavadora', prefix: 'LAV', category: 'Electrodomésticos', basePrice: 350, image: 'https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=400&h=400&fit=crop' },
  { name: 'Taladro', prefix: 'FER-TAL', category: 'Ferretería', basePrice: 75, image: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=400&h=400&fit=crop' },
  { name: 'Martillo', prefix: 'FER-MAR', category: 'Ferretería', basePrice: 15, image: 'https://images.unsplash.com/photo-1586864387917-f5814b82938e?w=400&h=400&fit=crop' },
  { name: 'Camisa', prefix: 'TEX-CAM', category: 'Textil', basePrice: 25, image: 'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=400&h=400&fit=crop' },
  { name: 'Pantalón', prefix: 'TEX-PAN', category: 'Textil', basePrice: 40, image: 'https://images.unsplash.com/photo-1541099649105-f69ad21f3246?w=400&h=400&fit=crop' },
  { name: 'Zapatillas', prefix: 'CAL-ZAP', category: 'Calzado', basePrice: 60, image: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&h=400&fit=crop' },
  { name: 'Jabón Líquido', prefix: 'HIG-JAB', category: 'Higiene', basePrice: 5, image: 'https://images.unsplash.com/photo-1600857062241-98e5dba7f214?w=400&h=400&fit=crop' },
  { name: 'Arroz', prefix: 'ALI-ARR', category: 'Alimentos', basePrice: 2, image: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=400&h=400&fit=crop' },
  { name: 'Refresco', prefix: 'BEB-REF', category: 'Bebidas', basePrice: 1.5, image: 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=400&h=400&fit=crop' },
  { name: 'Sofá', prefix: 'MUE-SOF', category: 'Muebles', basePrice: 450, image: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&h=400&fit=crop' },
  { name: 'Smartphone', prefix: 'TEL-SMA', category: 'Telefonía', basePrice: 800, image: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400&h=400&fit=crop' },
  { name: 'Laptop', prefix: 'COM-LAP', category: 'Computación', basePrice: 1200, image: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=400&h=400&fit=crop' }
];

const catMap = new Map();
let sql = '';

// Branches (assuming at least one exists)
const branchId = 'b1'; // Standard ID used in initial data if not using UUID yet in DB

sql += `-- Insert Categories\n`;
categories.forEach(cat => {
  const id = crypto.randomUUID();
  catMap.set(cat.name, id);
  sql += `INSERT INTO categories (id, name, department) VALUES ('${id}', '${cat.name}', '${cat.department}') ON CONFLICT DO NOTHING;\n`;
});

sql += `\n-- Insert Products\n`;
for (let i = 1; i <= 100; i++) {
  const template = productTemplates[Math.floor(Math.random() * productTemplates.length)];
  const id = crypto.randomUUID();
  const name = `${template.name} Modelo ${Math.floor(Math.random() * 1000)}`;
  const sku = `${template.prefix}-${Math.floor(Math.random() * 100000).toString().padStart(6, '0')}`;
  const barcode = Math.floor(Math.random() * 1000000000000).toString().padStart(12, '0');
  const catId = catMap.get(template.category);
  const costPrice = template.basePrice;
  const price = costPrice * 1.35;
  const margin = 35;
  
  sql += `INSERT INTO products (id, name, sku, barcode, cost_price, price, margin, category_id, status, image, created_at) VALUES ('${id}', '${name}', '${sku}', '${barcode}', ${costPrice}, ${price}, ${margin}, '${catId}', 'active', '${template.image}', NOW());\n`;
  
  // Inventory Level
  const invId = crypto.randomUUID();
  sql += `INSERT INTO inventory_levels (id, product_id, branch_id, quantity, min_quantity) VALUES ('${invId}', '${id}', (SELECT id FROM branches LIMIT 1), ${Math.floor(Math.random() * 100)}, 10) ON CONFLICT DO NOTHING;\n`;
}

console.log(sql);
