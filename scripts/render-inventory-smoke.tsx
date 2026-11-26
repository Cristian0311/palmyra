/**
 * Smoke test de renderizado (solo lectura, sin DOM ni red):
 * renderiza <Inventory /> con el estado inicial del store y comprueba
 * que el conmutador de vista, la tabla y las tarjetas queden en el HTML.
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import { useStore } from '../src/store/useStore';
import Inventory from '../src/pages/Inventory';

// zustand usa getInitialState() como snapshot del servidor (misma referencia
// siempre); mutamos ese objeto in-place para que el render SSR vea la data.
Object.assign(useStore.getInitialState() as any, {
  products: [{
    id: 'p1', name: 'Ron Santiago de Cuba', sku: 'RSDC-001', barcode: '8500001234567',
    price: 1250, costPrice: 950, categoryId: 'c1', commissionValue: 50,
    availableSizes: ['700ml'], availableColors: [], warrantyDays: 30, unit: 'botella',
    minStockAlert: 5, color: 'bg-amber-100', image: ''
  }],
  inventory: [{ id: 'i1', productId: 'p1', branchId: 'b1', quantity: 8, minQuantity: 3 }],
  branches: [{ id: 'b1', name: 'Almacén Central' }],
  categories: [{ id: 'c1', name: 'Licores' }],
});

let html = '';
try {
  html = renderToString(React.createElement(Inventory));
} catch (error) {
  console.error('FALLO AL RENDERIZAR Inventory:', error);
  process.exit(1);
}

const checks: Record<string, boolean> = {
  'conmutador de vista (grupo aria)': html.includes('Cambiar vista del inventario'),
  'botón tabla': html.includes('Ver como tabla de escritorio'),
  'botón tarjetas': html.includes('Ver como tarjetas'),
  'tabla de productos': html.includes('Productos del inventario'),
  'tabla con ancho mínimo': html.includes('table-fixed'),
  'nombre en tabla (sin truncar, con wrap)': html.includes('whitespace-normal break-words'),
  'tarjeta móvil con nombre completo': html.includes('Gestionar stock de Ron Santiago de Cuba'),
  'tarjeta con avatar de iniciales': html.includes('RS'),
  'precio en tarjeta': html.includes('1,250.00'),
};

let failed = false;
for (const [label, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed = true;
}
console.log(`HTML renderizado: ${html.length} caracteres`);
process.exit(failed ? 1 : 0);
