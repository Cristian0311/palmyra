import { Search, Wifi, WifiOff, RefreshCw, Plus, Minus, CreditCard, Receipt, Trash2, ShoppingCart, ShieldCheck, DollarSign, Banknote, QrCode, ArrowLeftRight, UserPlus, X, Lock, Unlock, Camera, AlertCircle, TrendingUp, Wallet, MessageSquare, Mail, HelpCircle, Calculator, ArrowRight, Package, User, RotateCcw, Printer, Bluetooth, Usb, Smartphone, Send, Copy, Check, CheckCircle, Share2, Store, ChevronDown, ChevronUp, Filter } from "lucide-react";
import { cn, generateId } from "../lib/utils";
import EmployeeAvatar from "../components/team/EmployeeAvatar";

type ModalProps = Record<string, any>;

export default function POSOpenSessionsModal(props: ModalProps) {
  const { branches, isOnline, isRefreshingOpenSessions, joiningSessionId, openSessionsForResume, refreshOpenSessions, setJoiningSessionId, setJoiningSessionPassword, setPosError, setShowOpenSessionsModal, showOpenSessionsModal } = props;
  // Sin red no podemos distinguir «no hay turnos» de «no se pudo consultar»:
  // mostramos un estado recuperable en lugar de una lista vacía engañosa.
  const offlineEmptyState = isOnline === false && (openSessionsForResume || []).length === 0;
  return (
    <>
      {showOpenSessionsModal && !joiningSessionId && (
            <div className="fixed inset-0 z-[65] bg-slate-950/55 backdrop-blur-sm flex items-center justify-center p-3">
              <div role="dialog" aria-modal="true" aria-label="Turnos abiertos" className="w-full max-w-[min(94vw,31rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                <div className="flex items-center gap-2.5 border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-white px-3 py-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm"><Wallet className="w-4 h-4" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5"><h3 className="text-[12px] font-black uppercase tracking-[0.12em] text-slate-900">Turnos abiertos</h3><span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-black text-emerald-700">{openSessionsForResume.length}</span></div>
                    <p className="mt-0.5 text-[10px] font-bold text-slate-400">Selecciona una caja para continuar.</p>
                  </div>
                  <button type="button" onClick={() => void refreshOpenSessions()} disabled={isRefreshingOpenSessions} className="h-9 w-9 shrink-0 rounded-lg border border-slate-200 bg-white text-slate-500 flex items-center justify-center hover:border-emerald-300 hover:text-emerald-600 disabled:opacity-50" title="Actualizar" aria-label="Actualizar turnos abiertos"><RefreshCw className={cn("w-4 h-4", isRefreshingOpenSessions && "animate-spin")} /></button>
                  <button type="button" onClick={() => setShowOpenSessionsModal(false)} className="h-9 w-9 shrink-0 rounded-lg border border-slate-200 bg-white text-slate-500 flex items-center justify-center hover:bg-slate-50" aria-label="Cerrar"><X className="w-4 h-4" /></button>
                </div>
                <div className="p-3 max-h-[min(62vh,25rem)] overflow-y-auto custom-scrollbar">
                  {openSessionsForResume.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-7 text-center">
                      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-white border border-slate-200 text-slate-400 shadow-sm"><Wallet className="w-4 h-4" /></div>
                      <p className="mt-2 text-[11px] font-black uppercase tracking-[0.1em] text-slate-600">{offlineEmptyState ? "Sin conexión, reintentando…" : "No hay turnos visibles"}</p>
                      <p className="mt-1 text-[10px] font-bold leading-snug text-slate-400">{offlineEmptyState ? "Este dispositivo no puede consultar las cajas abiertas ahora. Las que ya estaban guardadas siguen disponibles al reconectar." : "Actualiza para volver a consultar las cajas abiertas."}</p>
                      <button type="button" onClick={() => void refreshOpenSessions()} disabled={isRefreshingOpenSessions} className="mt-3 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-[10px] font-black uppercase tracking-tight text-white disabled:opacity-50"><RefreshCw className={cn("w-3.5 h-3.5", isRefreshingOpenSessions && "animate-spin")} />{isRefreshingOpenSessions ? "Reintentando…" : offlineEmptyState ? "Reintentar" : "Actualizar"}</button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {openSessionsForResume.map((session) => {
                        const branchName = branches.find(b => b.id === session.branchId)?.name || "Almacén principal";
                        const openedLabel = session.openedAt ? new Date(session.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
                        return (
                          <div key={session.id} className="grid grid-cols-[auto,minmax(0,1fr),auto] items-center gap-2 rounded-xl border border-slate-100 bg-slate-50/80 px-2.5 py-2.5">
                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white border border-slate-200 text-[10px] font-black text-slate-700 shadow-xs">T{session.turnNumber || "—"}</div>
                            <div className="flex min-w-0 items-center gap-2">
                              <EmployeeAvatar name={session.workerName || "Administrador"} seed={session.userId || session.workerName || session.id} size="sm" inShift className="!h-8 !w-8 !rounded-lg !text-[10px]" />
                              <div className="min-w-0"><p className="text-[11px] font-black text-slate-900 truncate" title={session.workerName || "Administrador"}>{session.workerName || "Administrador"}</p><div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[9px] font-bold text-slate-500"><span className="truncate max-w-full">{branchName}</span><span>·</span><span className="whitespace-nowrap">Abierto {openedLabel}</span></div></div>
                            </div>
                            <button type="button" onClick={() => { setShowOpenSessionsModal(false); setJoiningSessionId(session.id); setJoiningSessionPassword(""); setPosError(""); }} className="shrink-0 min-h-[40px] rounded-lg bg-emerald-600 px-3 py-2 text-[10px] font-black uppercase tracking-tight text-white shadow-sm hover:bg-emerald-700 active:scale-[0.98]">Reanudar</button>
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
