sed -i '/{activeTab === '"'details'"' && (/i \
      {activeTab === '"'products'"' && (\
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">\
          <div className="p-4 border-b border-slate-100">\
            <h3 className="text-[10px] font-black text-slate-900 uppercase tracking-widest flex items-center gap-2">\
              <Package className="w-3.5 h-3.5 text-indigo-600" />\
              Productos Vendidos\
            </h3>\
          </div>\
          <div className="overflow-x-auto">\
            <table className="w-full text-left border-collapse">\
              <thead>\
                <tr className="bg-slate-50/50 border-b border-slate-100">\
                  <th className="px-4 py-3 text-[8px] font-black text-slate-400 uppercase tracking-[0.2em]">Producto</th>\
                  <th className="px-4 py-3 text-[8px] font-black text-slate-400 uppercase tracking-[0.2em]">Categoría</th>\
                  <th className="px-4 py-3 text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] text-center">Cantidad</th>\
                  <th className="px-4 py-3 text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] text-right">Ingresos Brutos ({baseCurrency.code})</th>\
                </tr>\
              </thead>\
              <tbody className="divide-y divide-slate-100">\
                {(() => {\
                  const productMap: Record<string, { product: any, quantity: number, total: number }> = {};\
                  transactions.forEach(tx => {\
                    tx.items.forEach(item => {\
                      const id = typeof item.product === '"'string'"' ? item.product : item.product.id;\
                      const prodObj = typeof item.product === '"'string'"' ? products.find(p => p.id === id) : item.product;\
                      if (!productMap[id]) {\
                        productMap[id] = { product: prodObj || { name: '"'Desconocido'"', categoryId: '"'"' }, quantity: 0, total: 0 };\
                      }\
                      productMap[id].quantity += item.quantity;\
                      productMap[id].total += ((prodObj?.price || 0) * item.quantity);\
                    });\
                  });\
                  return Object.values(productMap).sort((a, b) => b.quantity - a.quantity).map((stat, idx) => (\
                    <tr key={idx} className="hover:bg-slate-50/50 transition-colors">\
                      <td className="px-4 py-3 text-[10px] font-black text-slate-900 uppercase tracking-tighter">{stat.product.name}</td>\
                      <td className="px-4 py-3 text-[8px] font-black text-slate-500 uppercase tracking-widest">{categories.find(c => c.id === stat.product.categoryId)?.name || '"'Sin Categoría'"'}</td>\
                      <td className="px-4 py-3 text-[11px] font-black text-slate-900 text-center">{stat.quantity}</td>\
                      <td className="px-4 py-3 text-[10px] font-black text-indigo-600 text-right tracking-tighter">{formatMoney(stat.total)}</td>\
                    </tr>\
                  ));\
                })()}\
              </tbody>\
            </table>\
          </div>\
        </div>\
      )}\
' src/pages/Reports.tsx
