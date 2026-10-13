import { Trash2 } from "lucide-react";

type Props = {
  open: boolean;
  isCancelling: boolean;
  onCancel: () => void;
  onClose: () => void;
};

export function POSCancelShiftModal({
  open,
  isCancelling,
  onCancel,
  onClose,
}: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[200] flex items-center justify-center p-4">
      <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-sm overflow-hidden animate-in zoom-in-95 border border-rose-100">
        <div className="p-8 text-center space-y-6">
          <div className="w-20 h-20 bg-rose-100 text-rose-600 rounded-3xl flex items-center justify-center mx-auto rotate-12 shadow-lg shadow-rose-100">
            <Trash2 className="w-10 h-10" />
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-black text-slate-900 uppercase tracking-tighter">¿Cancelar turno?</h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-4">
              Esta acción anulará las ventas de este turno y revertirá el inventario. El turno quedará registrado como cancelado en el historial.
            </p>
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={onClose} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-colors">
              Cancelar
            </button>
            <button type="button" onClick={onCancel} disabled={isCancelling} className="flex-[2] py-4 bg-rose-600 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-rose-700 transition-all shadow-lg shadow-rose-200 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed">
              {isCancelling ? "Cancelando..." : "Aceptar cancelación"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
