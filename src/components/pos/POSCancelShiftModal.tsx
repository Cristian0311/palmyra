import type { KeyboardEvent } from "react";
import { Lock, Trash2 } from "lucide-react";

type Props = {
  open: boolean;
  password: string;
  setPassword: (value: string) => void;
  isCancelling: boolean;
  onCancel: () => void;
  onClose: () => void;
};

export function POSCancelShiftModal({
  open,
  password,
  setPassword,
  isCancelling,
  onCancel,
  onClose,
}: Props) {
  if (!open) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") onCancel();
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[200] flex items-center justify-center p-4">
      <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-sm overflow-hidden animate-in zoom-in-95 border border-rose-100">
        <div className="p-8 text-center space-y-6">
          <div className="w-20 h-20 bg-rose-100 text-rose-600 rounded-3xl flex items-center justify-center mx-auto rotate-12 shadow-lg shadow-rose-100">
            <Trash2 className="w-10 h-10" />
          </div>

          <div className="space-y-2">
            <h3 className="text-xl font-black text-slate-900 uppercase tracking-tighter">
              ¿Cancelar Turno?
            </h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-4">
              Esta acción anulará las ventas de este turno, revertirá el inventario y conservará el turno como "Cancelado" en el historial. Se requiere contraseña.
            </p>
          </div>

          <div className="space-y-4">
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="password"
                autoFocus
                placeholder="Contraseña del Trabajador"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full px-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-4 focus:ring-rose-500/10 focus:border-rose-500 transition-all font-black text-center tracking-[0.5em]"
              />
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-colors"
              >
                Volver
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={isCancelling}
                className="flex-[2] py-4 bg-rose-600 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-rose-700 transition-all shadow-lg shadow-rose-200 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isCancelling ? "Cancelando..." : "Confirmar Anulación"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
