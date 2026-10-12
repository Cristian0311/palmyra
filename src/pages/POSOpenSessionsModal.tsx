import { Search, Wifi, WifiOff, RefreshCw, Plus, Minus, CreditCard, Receipt, Trash2, ShoppingCart, ShieldCheck, DollarSign, Banknote, QrCode, ArrowLeftRight, UserPlus, X, Lock, Unlock, Camera, AlertCircle, TrendingUp, Wallet, MessageSquare, Mail, HelpCircle, Calculator, ArrowRight, Package, User, RotateCcw, Printer, Bluetooth, Usb, Smartphone, Send, Copy, Check, CheckCircle, Share2, Store, ChevronDown, ChevronUp, Filter } from "lucide-react";
import { cn, generateId } from "../lib/utils";

type ModalProps = Record<string, any>;

export default function POSOpenSessionsModal(props: ModalProps) {
  const { branches, isRefreshingOpenSessions, joiningSessionId, openSessionsForResume, refreshOpenSessions, setJoiningSessionId, setJoiningSessionPassword, setPosError, setShowOpenSessionsModal, showOpenSessionsModal } = props;
  return (
    <>
      {showOpenSessionsModal && !joiningSessionId && (
            <div className="fixed inset-0 z-[65] bg-slate-950/55 backdrop-blur-sm flex items-center justify-center p-3">
              <div className="w-full max-w-[min(94vw,31rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                <div className="flex items-center gap-2.5 border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-white px-3 py-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm"><Wallet className="w-4 h-4" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5"><h3 className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-900">Turnos abiertos</h3><span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[6px] font-black text-emerald-700">{openSessionsForResume.length}</span></div>
                    <p className="mt-0.5 text-[6.5px] font-bold text-slate-400">Selecciona una caja para continuar.</p>
                  </div>
                  <button type="button" onClick={() => void refreshOpenSessions()} disabled={isRefreshingOpenSessions} className="h-7 w-7 shrink-0 rounded-lg border border-slate-200 bg-white text-slate-500 flex items-center justify-center hover:border-emerald-300 hover:text-emerald-600 disabled:opacity-50" title="Actualizar"><RefreshCw className={cn("w-3 h-3", isRefreshingOpenSessions && "animate-spin")} /></button>
                  <button type="button" onClick={() => setShowOpenSessionsModal(false)} className="h-7 w-7 shrink-0 rounded-lg border border-slate-200 bg-white text-slate-500 flex items-center justify-center hover:bg-slate-50" aria-label="Cerrar"><X className="w-3.5 h-3.5" /></button>
                </div>
                <div className="p-2.5 max-h-[min(62vh,25rem)] overflow-y-auto custom-scrollbar">
                  {openSessionsForResume.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-7 text-center">
                      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-white border border-slate-200 text-slate-400 shadow-sm"><Wallet className="w-4 h-4" /></div>
                      <p className="mt-2 text-[8px] font-black uppercase tracking-[0.1em] text-slate-600">No hay turnos visibles</p>
                      <p className="mt-1 text-[6.5px] font-bold leading-4 text-slate-400">Actualiza para volver a consultar las cajas abiertas.</p>
                      <button type="button" onClick={() => void refreshOpenSessions()} disabled={isRefreshingOpenSessions} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[7px] font-black uppercase tracking-tight text-white disabled:opacity-50"><RefreshCw className={cn("w-3 h-3", isRefreshingOpenSessions && "animate-spin")} />{isRefreshingOpenSessions ? "Buscando…" : "Actualizar"}</button>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {openSessionsForResume.map((session) => {
                        const branchName = branches.find(b => b.id === session.branchId)?.name || "Almacén principal";
                        const openedLabel = session.openedAt ? new Date(session.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
                        return (
                          <div key={session.id} className="grid grid-cols-[auto,minmax(0,1fr),auto] items-center gap-2 rounded-xl border border-slate-100 bg-slate-50/80 px-2.5 py-2">
                            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white border border-slate-200 text-[8px] font-black text-slate-700 shadow-xs">T{session.turnNumber || "—"}</div>
                            <div className="min-w-0"><p className="text-[8px] font-black text-slate-900 truncate">{session.workerName || "Administrador"}</p><div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[6.5px] font-bold text-slate-500"><span>{branchName}</span><span>·</span><span>Abierto {openedLabel}</span></div></div>
                            <button type="button" onClick={() => { setShowOpenSessionsModal(false); setJoiningSessionId(session.id); setJoiningSessionPassword(""); setPosError(""); }} className="shrink-0 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[7px] font-black uppercase tracking-tight text-white shadow-sm hover:bg-emerald-700 active:scale-[0.98]">Reanudar</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
    </>
  );
}
