import type { FormEvent } from "react";

type CustomerForm = {
  name: string;
  phone: string;
  email: string;
  taxId: string;
};

type Props = {
  open: boolean;
  value: CustomerForm;
  setValue: (next: CustomerForm) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
};

export function POSAddCustomerModal({
  open,
  value,
  setValue,
  onSubmit,
  onClose,
}: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="palmyra-mobile-modal bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden animate-in zoom-in-95 border border-white/20">
        <div className="p-3 sm:p-5 space-y-2.5 sm:space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest">
              Nuevo Cliente
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600"
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>

          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">
                Nombre Completo
              </label>
              <input
                required
                type="text"
                value={value.name}
                onChange={(e) => setValue({ ...value, name: e.target.value })}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl focus:ring-1 focus:ring-indigo-100 outline-none text-xs font-bold"
              />
            </div>

            <div>
              <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">
                Teléfono
              </label>
              <input
                type="text"
                value={value.phone}
                onChange={(e) => setValue({ ...value, phone: e.target.value })}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl focus:ring-1 focus:ring-indigo-100 outline-none text-xs font-bold"
              />
            </div>

            <div>
              <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">
                Email (Opcional)
              </label>
              <input
                type="email"
                value={value.email}
                onChange={(e) => setValue({ ...value, email: e.target.value })}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl focus:ring-1 focus:ring-indigo-100 outline-none text-xs font-bold"
              />
            </div>

            <div>
              <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">
                CI o Pasaporte
              </label>
              <input
                type="text"
                value={value.taxId}
                onChange={(e) => setValue({ ...value, taxId: e.target.value })}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl focus:ring-1 focus:ring-indigo-100 outline-none text-xs font-bold"
                placeholder="Número de identidad"
              />
            </div>

            <button
              type="submit"
              className="w-full py-3 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 active:scale-95"
            >
              Guardar Cliente
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
