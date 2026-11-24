import { useEffect } from 'react';
import { X, ArrowLeftRight, ArrowRight } from "lucide-react";

type ModalProps = Record<string, any>;

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  posted: 'En tránsito',
  in_transit: 'En tránsito',
  received: 'Recibido',
  completed: 'Recibido',
  cancelled: 'Cancelado',
};

const STATUS_BADGE: Record<string, string> = {
  Pendiente: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  'En tránsito': 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  Recibido: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  Cancelado: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
};

function normalizeStatus(raw: string | undefined | null): string {
  const key = (raw || 'in_transit').toLowerCase();
  return STATUS_LABEL[key] || 'En tránsito';
}

export default function ReportsSelectedTransferModal(props: ModalProps) {
  const { branches, selectedTransferModal, setSelectedTransferModal } = props;

  useEffect(() => {
    if (!selectedTransferModal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedTransferModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedTransferModal, setSelectedTransferModal]);

  return (
    <>
      {selectedTransferModal && (
        <div className="palmyra-overlay z-[var(--z-modal)] flex items-center justify-center p-4">
          <div className="palmyra-modal-panel palmyra-mobile-modal flex w-full max-w-lg flex-col overflow-hidden animate-in zoom-in-95 my-auto text-primary">
            <div className="shrink-0 bg-gradient-to-r from-violet-600 to-violet-800 p-5 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-white/10 rounded-2xl backdrop-blur-md">
                  <ArrowLeftRight className="w-6 h-6 text-white" />
                </div>
                <div>
                  <span className="text-[9px] font-black uppercase tracking-widest text-violet-200 block">
                    Transferencia de Inventario
                  </span>
                  <h3 className="text-base font-black text-white uppercase tracking-tight">
                    {selectedTransferModal.productName}
                  </h3>
                </div>
              </div>
              <button
                onClick={() => setSelectedTransferModal(null)}
                className="p-2 hover:bg-white/10 rounded-xl transition-all text-white/80 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 custom-scrollbar">
              {/* Origin to Dest visual block */}
              <div className="p-4 bg-subtle rounded-2xl border border-base flex items-center justify-between gap-3">
                <div className="flex-1 text-center">
                  <span className="text-[8px] font-black text-amber-600 uppercase tracking-wider block">Almacén Origen</span>
                  <p className="text-xs font-black text-primary uppercase mt-0.5">
                    {branches.find(b => b.id === selectedTransferModal.fromBranchId)?.name || selectedTransferModal.fromBranchName || 'Origen'}
                  </p>
                </div>

                <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                  <ArrowRight className="w-4 h-4" />
                </div>

                <div className="flex-1 text-center">
                  <span className="text-[8px] font-black text-emerald-600 uppercase tracking-wider block">Sucursal Destino</span>
                  <p className="text-xs font-black text-primary uppercase mt-0.5">
                    {branches.find(b => b.id === selectedTransferModal.toBranchId)?.name || selectedTransferModal.toBranchName || 'Destino'}
                  </p>
                </div>
              </div>

              {/* Meta information */}
              <div className="grid grid-cols-2 gap-3 text-left">
                <div className="bg-subtle p-3 rounded-xl border border-base">
                  <span className="text-[8px] font-black text-muted uppercase tracking-wider block mb-0.5">
                    Cantidad Transferida
                  </span>
                  <p className="text-sm font-black text-rose-600 dark:text-rose-400">
                    {selectedTransferModal.quantity} unidades
                  </p>
                </div>
                <div className="bg-subtle p-3 rounded-xl border border-base">
                  <span className="text-[8px] font-black text-muted uppercase tracking-wider block mb-0.5">
                    Fecha y Hora
                  </span>
                  <p className="text-[10px] font-bold text-primary">
                    {new Date(selectedTransferModal.date).toLocaleString('es-CU')}
                  </p>
                </div>
                <div className="bg-subtle p-3 rounded-xl border border-base col-span-2 flex items-center justify-between gap-2">
                  <span className="text-[8px] font-black text-muted uppercase tracking-wider">Estado</span>
                  <span
                    className={`palmyra-pill inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${
                      STATUS_BADGE[normalizeStatus(selectedTransferModal.status)] || 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                    }`}
                  >
                    {normalizeStatus(selectedTransferModal.status)}
                  </span>
                </div>
              </div>

              {/* Variants breakdown if any */}
              {selectedTransferModal.variants && selectedTransferModal.variants.length > 0 && (
                <div className="border border-base rounded-2xl overflow-hidden">
                  <div className="bg-subtle px-3.5 py-2 border-b border-base flex items-center justify-between">
                    <span className="text-[9px] font-black text-muted uppercase tracking-wider">
                      Desglose de Variantes
                    </span>
                    <span className="text-[9px] font-bold text-muted">
                      {selectedTransferModal.variants.length} variantes
                    </span>
                  </div>
                  <div className="divide-y divide-base">
                    {selectedTransferModal.variants.map((v, vIdx) => (
                      <div key={vIdx} className="p-2.5 flex items-center justify-between text-xs">
                        <span className="font-bold text-primary">{v.variantLabel || 'Variante'}</span>
                        <span className="font-black text-rose-600 dark:text-rose-400">{v.quantity} uds</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Footer buttons */}
              <div className="flex justify-end pt-2">
                <button
                  onClick={() => setSelectedTransferModal(null)}
                  className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-white rounded-xl text-xs font-black uppercase tracking-wider transition-all cursor-pointer shadow-md"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
