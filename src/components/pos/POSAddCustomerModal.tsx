import { useEffect, type FormEvent } from "react";

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
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="palmyra-overlay z-[var(--z-modal)] flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="palmyra-modal-panel palmyra-mobile-modal w-full max-w-xs max-h-[92dvh] overflow-hidden animate-in zoom-in-95">
        <div className="p-3 sm:p-5 space-y-2.5 sm:space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-black text-primary uppercase tracking-widest">
              Nuevo Cliente
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="text-muted hover:text-primary"
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>

          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="block text-[8px] font-black text-muted uppercase tracking-widest mb-1">
                Nombre Completo
              </label>
              <input
                required
                type="text"
                value={value.name}
                onChange={(e) => setValue({ ...value, name: e.target.value })}
                className="w-full px-3 py-2 bg-subtle border border-base rounded-xl focus:ring-1 focus:ring-indigo-100 outline-none text-xs font-bold"
              />
            </div>

            <div>
              <label className="block text-[8px] font-black text-muted uppercase tracking-widest mb-1">
                Teléfono
              </label>
              <input
                type="text"
                value={value.phone}
                onChange={(e) => setValue({ ...value, phone: e.target.value })}
                className="w-full px-3 py-2 bg-subtle border border-base rounded-xl focus:ring-1 focus:ring-indigo-100 outline-none text-xs font-bold"
              />
            </div>

            <div>
              <label className="block text-[8px] font-black text-muted uppercase tracking-widest mb-1">
                Email (Opcional)
              </label>
              <input
                type="email"
                value={value.email}
                onChange={(e) => setValue({ ...value, email: e.target.value })}
                className="w-full px-3 py-2 bg-subtle border border-base rounded-xl focus:ring-1 focus:ring-indigo-100 outline-none text-xs font-bold"
              />
            </div>

            <div>
              <label className="block text-[8px] font-black text-muted uppercase tracking-widest mb-1">
                CI o Pasaporte
              </label>
              <input
                type="text"
                value={value.taxId}
                onChange={(e) => setValue({ ...value, taxId: e.target.value })}
                className="w-full px-3 py-2 bg-subtle border border-base rounded-xl focus:ring-1 focus:ring-indigo-100 outline-none text-xs font-bold"
                placeholder="Número de identidad"
              />
            </div>

            <button
              type="submit"
              className="w-full py-3 bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:from-violet-700 hover:to-indigo-700 transition-all shadow-xl shadow-indigo-100 active:scale-95"
            >
              Guardar Cliente
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
