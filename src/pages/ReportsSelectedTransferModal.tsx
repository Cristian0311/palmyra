import { 
  TrendingUp, DollarSign, Calendar, Calculator, Package, User, Users, Eye,
  X, ArrowDownRight, ArrowUpRight, ArrowLeftRight, ArrowRight, History, Download, Printer, CheckCircle2, 
  Clock, AlertCircle, AlertTriangle, FileSpreadsheet, ChevronDown, Check, Plus, Search,
  BarChart3, Brain, ListChecks, ShieldAlert, Loader2, Trash2,
  HelpCircle, Edit3, Save, FileText, CheckCircle, Minus
} from "lucide-react";

type ModalProps = Record<string, any>;

export default function ReportsSelectedTransferModal(props: ModalProps) {
  const { branches, selectedTransferModal, setSelectedTransferModal } = props;
  return (
    <>
      {selectedTransferModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 border border-base my-auto text-primary">
            <div className="bg-gradient-to-r from-blue-600 to-rose-600 p-5 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-white/10 rounded-2xl backdrop-blur-md">
                  <ArrowLeftRight className="w-6 h-6 text-white" />
                </div>
                <div>
                  <span className="text-[9px] font-black uppercase tracking-widest text-blue-200 block">
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

            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
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
