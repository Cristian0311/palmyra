const fs = require('fs');
let code = fs.readFileSync('src/pages/Settings.tsx', 'utf-8');

const storeConfigBlock = `
        {/* Información de la Tienda */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 space-y-4 lg:col-span-3">
          <div className="flex items-center gap-3 border-b border-slate-50 pb-3">
            <div className="bg-blue-50 p-2 rounded-lg text-blue-600">
              <Building2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider">Información de la Tienda Física</h3>
              <p className="text-[8px] font-bold text-slate-400 uppercase tracking-tight">Datos generales y ubicación</p>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Nombre de la Tienda</label>
              <input type="text" value={config.storeName || ''} onChange={e => setConfig({...config, storeName: e.target.value})} className="w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-100" />
            </div>
            <div>
              <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Teléfono Principal</label>
              <input type="text" value={config.phone || ''} onChange={e => setConfig({...config, phone: e.target.value})} className="w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-100" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Dirección</label>
              <input type="text" value={config.address || ''} onChange={e => setConfig({...config, address: e.target.value})} className="w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-100" />
            </div>
            <div className="md:col-span-2 flex items-center justify-between bg-slate-50 p-4 rounded-xl border border-slate-100">
              <div>
                <h4 className="text-xs font-bold text-slate-900">Ubicación GPS (Catálogo)</h4>
                <p className="text-[10px] text-slate-500 mt-1">
                  {config.latitude && config.longitude ? \`Coordenadas: \${config.latitude}, \${config.longitude}\` : 'No se ha detectado ubicación.'}
                </p>
              </div>
              <button 
                onClick={() => {
                  if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                      (position) => {
                        setConfig({...config, latitude: position.coords.latitude, longitude: position.coords.longitude});
                      },
                      (error) => {
                        alert("Error al obtener ubicación: " + error.message);
                      }
                    );
                  } else {
                    alert("Geolocalización no soportada en este navegador.");
                  }
                }}
                className="px-4 py-2 bg-white border border-slate-200 text-indigo-600 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-slate-50 transition-colors shadow-sm active:scale-95 flex items-center gap-2"
              >
                <Store className="w-4 h-4" />
                Detectar Mi Ubicación
              </button>
            </div>
          </div>
          
          <div className="pt-4 border-t border-slate-50">
            <button 
              onClick={handleSaveConfig}
              className="w-full sm:w-auto px-8 py-3 bg-blue-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-700 transition-all shadow-xl shadow-blue-100 active:scale-95 flex items-center justify-center gap-2"
            >
              <Save className="w-3.5 h-3.5" />
              Guardar Información de la Tienda
            </button>
          </div>
        </div>
`;

code = code.replace('{/* Configuración de Ticket / Recibo */}', storeConfigBlock + '\n        {/* Configuración de Ticket / Recibo */}');

fs.writeFileSync('src/pages/Settings.tsx', code);
