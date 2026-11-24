import { useShallow } from 'zustand/react/shallow';
import React, { useRef, useState } from 'react';
import { Product } from '../types';
import { QRCodeSVG } from 'qrcode.react';
import { Printer, Minus, Plus, RefreshCw } from 'lucide-react';
import { useStore } from '../store/useStore';
import { formatMoney } from '../lib/utils';

export function PrintLabels() {
  const { products, getBaseCurrency, addNotification } = useStore(useShallow((state) => ({ products: state.products, getBaseCurrency: state.getBaseCurrency, addNotification: state.addNotification })));
  const baseCurrency = getBaseCurrency();
  const [selectedProduct, setSelectedProduct] = useState<string>('');
  const [quantity, setQuantity] = useState(1);
  const printRef = useRef<HTMLDivElement>(null);

  const product = products.find(p => p.id === selectedProduct);

  const handlePrint = () => {
    if (!product || !printRef.current) return;
    
    const printContent = printRef.current.innerHTML;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      // El navegador bloqueó la pestaña: antes la pantalla quedaba muda.
      addNotification('Permite las ventanas emergentes de este sitio para imprimir las etiquetas.', 'warning');
      return;
    }
    
    printWindow.document.write(`
      <html>
        <head>
          <title>Imprimir Etiquetas</title>
          <style>
            @media print {
              body { margin: 0; padding: 0; }
              @page { size: auto; margin: 0mm; }
            }
            body { font-family: monospace; }
            .label-grid { display: flex; flex-wrap: wrap; gap: 10px; padding: 10px; }
            .label-item { 
              width: 40mm; height: 30mm; 
              border: 1px dashed #ccc; 
              padding: 5px; box-sizing: border-box; 
              display: flex; flex-direction: column; align-items: center; justify-content: center;
              text-align: center;
            }
            .name { font-size: 10px; font-weight: bold; margin-bottom: 2px; max-height: 12px; overflow: hidden; }
            .price { font-size: 12px; font-weight: bold; margin-bottom: 2px; }
            .sku { font-size: 8px; margin-top: 2px; }
          </style>
        </head>
        <body>
          <div class="label-grid">
            ${printContent}
          </div>
          <script>
            window.onload = () => {
              window.print();
              window.close();
            }
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  return (
    <div className="bg-secondary rounded-2xl shadow-sm border border-base p-4 sm:p-6 flex flex-col gap-4 sm:gap-6">
      <div className="flex flex-wrap justify-between items-center gap-3 border-b border-base pb-4">
        <div>
          <h2 className="text-base sm:text-lg font-black text-primary uppercase tracking-tight">Impresión de Etiquetas</h2>
          <p className="text-[10px] font-black text-muted uppercase tracking-widest">Genera QR y Códigos de Barras</p>
        </div>
        <button 
          onClick={handlePrint}
          disabled={!product || quantity < 1}
          className="min-h-11 bg-violet-600 text-white px-5 py-3 rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-violet-700 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Printer className="w-4 h-4" /> Imprimir
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="space-y-4">
          <div>
            <label className="block text-[10px] font-black text-muted uppercase tracking-widest mb-1">Producto</label>
            <select 
              value={selectedProduct}
              onChange={(e) => setSelectedProduct(e.target.value)}
              className="w-full min-h-11 bg-subtle border border-base text-primary rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-violet-500 outline-none"
            >
              <option value="">Selecciona un producto...</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.name} - {formatMoney(p.price, baseCurrency.symbol)}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-black text-muted uppercase tracking-widest mb-1">Cantidad de Etiquetas</label>
            <div className="flex items-center gap-4">
              <button 
                onClick={() => setQuantity(Math.max(1, quantity - 1))}
                className="w-11 h-11 bg-subtle border border-base rounded-xl flex items-center justify-center text-secondary hover:text-violet-600 transition-colors"
              >
                <Minus className="w-4 h-4" />
              </button>
              <span className="text-xl font-black text-primary w-12 text-center tabular-nums">{quantity}</span>
              <button 
                onClick={() => setQuantity(quantity + 1)}
                className="w-11 h-11 bg-subtle border border-base rounded-xl flex items-center justify-center text-secondary hover:text-violet-600 transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="bg-subtle rounded-2xl border border-base p-6 flex items-center justify-center min-h-[260px] sm:min-h-[300px]">
          {product ? (
            <div className="text-center">
              <p className="text-[10px] font-black text-muted uppercase tracking-widest mb-4">Vista Previa de Etiqueta (40x30mm)</p>
              <div className="w-[40mm] h-[30mm] bg-white text-slate-900 border border-slate-300 shadow-sm flex flex-col items-center justify-center p-2 mx-auto">
                <div className="text-[9px] font-bold text-slate-800 leading-tight mb-1 truncate w-full px-1">{product.name}</div>
                <div className="text-[12px] font-black text-slate-900 mb-1">{formatMoney(product.price, baseCurrency.symbol)}</div>
                <QRCodeSVG value={product.barcode || product.sku || product.id} size={40} />
                <div className="text-[6px] text-slate-500 mt-1">{product.sku}</div>
              </div>
            </div>
          ) : (
            <div className="text-center text-muted">
              <RefreshCw className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs font-bold uppercase tracking-widest">Selecciona un producto</p>
            </div>
          )}
        </div>
      </div>

      {/* Hidden print container */}
      <div className="hidden">
        <div ref={printRef}>
          {product && Array.from({ length: quantity }).map((_, i) => (
            <div key={i} className="label-item">
              <div className="name">{product.name.substring(0, 20)}</div>
              <div className="price">{formatMoney(product.price, baseCurrency.symbol)}</div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <QRCodeSVG value={product.barcode || product.sku || product.id} size={50} />
              </div>
              <div className="sku">{product.sku}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
