import crypto from 'crypto';

const categories = [
  { name: 'Ropa', department: 'Moda' },
  { name: 'Calzado', department: 'Moda' },
  { name: 'Electrónica', department: 'Tecnología' }
];

const productTemplates = [
  { 
    name: 'Camiseta de Algodón Básico', 
    prefix: 'TSHIRT', 
    category: 'Ropa', 
    basePrice: 15,
    sizes: ['S', 'M', 'L', 'XL'],
    colors: ['Blanco', 'Negro', 'Gris', 'Azul Marino'],
    image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&h=400&fit=crop'
  },
  { 
    name: 'Jeans Clásicos Rectos', 
    prefix: 'JEANS', 
    category: 'Ropa', 
    basePrice: 45,
    sizes: ['28', '30', '32', '34', '36'],
    colors: ['Azul Claro', 'Azul Oscuro', 'Negro'],
    image: 'https://images.unsplash.com/photo-1542272604-780c823f6634?w=400&h=400&fit=crop'
  },
  { 
    name: 'Zapatillas Deportivas Ultra', 
    prefix: 'SNEAKER', 
    category: 'Calzado', 
    basePrice: 85,
    sizes: ['38', '39', '40', '41', '42', '43', '44'],
    colors: ['Blanco/Rojo', 'Negro/Gris', 'Azul/Amarillo'],
    image: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&h=400&fit=crop'
  },
  { 
    name: 'Smartwatch Pro Series', 
    prefix: 'WATCH', 
    category: 'Electrónica', 
    basePrice: 199,
    sizes: ['40mm', '44mm'],
    colors: ['Plata', 'Gris Espacial', 'Oro Rosa'],
    image: 'https://images.unsplash.com/photo-1579586337278-3befd40fd17a?w=400&h=400&fit=crop'
  }
];

const catMap = new Map();
let sql = '';

sql += `-- =========================================\n`;
sql += `-- SCRIPT DE VARIEDADES DE PRODUCTOS (SEED)\n`;
sql += `-- =========================================\n\n`;

sql += `-- 1. Insertar Categorías\n`;
categories.forEach(cat => {
  const id = crypto.randomUUID();
  catMap.set(cat.name, id);
  sql += `INSERT INTO categories (id, name, department) VALUES ('${id}', '${cat.name}', '${cat.department}') ON CONFLICT DO NOTHING;\n`;
});

sql += `\n-- 2. Insertar Productos y sus Niveles de Inventario\n`;
let productCount = 1;

productTemplates.forEach(template => {
  const catId = catMap.get(template.category);
  
  // For each template, we create products for combinations of size/color
  template.colors.forEach(color => {
    template.sizes.forEach(size => {
      const id = crypto.randomUUID();
      const variantName = `${template.name} - ${color} - Talla ${size}`;
      const sku = `${template.prefix}-${color.substring(0,3).toUpperCase()}-${size.toUpperCase()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
      const barcode = Math.floor(Math.random() * 1000000000000).toString().padStart(12, '0');
      
      // Slight price variation based on size/color just for fun
      const priceModifier = size === 'XL' || size === '44' || size === '44mm' ? 1.1 : 1.0;
      const costPrice = (template.basePrice * priceModifier).toFixed(2);
      const price = (template.basePrice * priceModifier * 1.4).toFixed(2); // 40% markup
      const margin = 40;

      // Available arrays for UI
      const availableColors = `["${color}"]`;
      const availableSizes = `["${size}"]`;
      
      sql += `INSERT INTO products (id, name, sku, barcode, cost_price, price, margin, category_id, status, image, available_colors, available_sizes, created_at) VALUES ('${id}', '${variantName}', '${sku}', '${barcode}', ${costPrice}, ${price}, ${margin}, '${catId}', 'active', '${template.image}', '${availableColors}', '${availableSizes}', NOW());\n`;
      
      // Inventory Level
      const invId = crypto.randomUUID();
      // Random stock between 5 and 50
      const stock = Math.floor(Math.random() * 45) + 5;
      sql += `INSERT INTO inventory_levels (id, product_id, branch_id, quantity, min_quantity) VALUES ('${invId}', '${id}', (SELECT id FROM branches LIMIT 1), ${stock}, 10) ON CONFLICT DO NOTHING;\n\n`;
      
      productCount++;
    });
  });
});

sql += `-- Total de variantes de productos generadas: ${productCount - 1}\n`;

console.log(sql);
