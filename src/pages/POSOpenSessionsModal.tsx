import { useEffect } from "react";
import { Search, Wifi, WifiOff, RefreshCw, Plus, Minus, CreditCard, Receipt, Trash2, ShoppingCart, ShieldCheck, DollarSign, Banknote, QrCode, ArrowLeftRight, UserPlus, X, Lock, Unlock, Camera, AlertCircle, TrendingUp, Wallet, MessageSquare, Mail, HelpCircle, Calculator, ArrowRight, Package, User, RotateCcw, Printer, Bluetooth, Usb, Smartphone, Send, Copy, Check, CheckCircle, Share2, Store, ChevronDown, ChevronUp, Filter } from "lucide-react";
import { cn, generateId } from "../lib/utils";
import EmployeeAvatar from "../components/team/EmployeeAvatar";

type ModalProps = Record<string, any>;

export default function POSOpenSessionsModal(props: ModalProps) {
  const { branches, isOnline, isRefreshingOpenSessions, joiningSessionId, openSessionsForResume, refreshOpenSessions, setJoiningSessionId, setJoiningSessionPassword, setPosError, setShowOpenSessionsModal, showOpenSessionsModal } = props;
  // Sin red no podemos distinguir «no hay turnos» de «no se pudo consultar»:
  // mostramos un estado recuperable en lugar de una lista vacía engañosa.
  const offlineEmptyState = isOnline === false && (openSessionsForResume || []).length === 0;
  useEffect(() => {
    if (!showOpenSessionsModal) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowOpenSessionsModal(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showOpenSessionsModal, setShowOpenSessionsModal]);
  return (
    <>
      {showOpenSessionsModal && !joiningSessionId && (
            <div
              className="palmyra-overlay z-[var(--z-modal)] flex items-center justify-center p-3"
              role="presentation"
              onMouseDown={event => { if (event.target === event.currentTarget) setShowOpenSessionsModal(false); }}
            >
              <div role="dialog" aria-modal="true" aria-label="Turnos abiertos" className="palmyra-modal-panel palmyra-mobile-modal w-full max-w-[min(94vw,31rem)] max-h-[92dvh] overflow-hidden">
                <div className="flex items-center gap-2.5 border-b border-base bg-secondary px-3 py-2.5 sm:px-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-sm"><Wallet className="h-4 w-4" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5"><h3 className="truncate text-sm sm:text-base font-black uppercase tracking-[0.08em] text-primary">Turnos abiertos</h3><span className="palmyra-badge shrink-0">{openSessionsForResume.length}</span></div>
                    <p className="mt-0.5 truncate text-[10px] font-bold text-muted">Selecciona una caja para continuar.</p>
                  </div>
                  <button type="button" onClick={() => void refreshOpenSessions()} disabled={isRefreshingOpenSessions} className="h-8 w-8 shrink-0 rounded-lg border border-base bg-secondary text-muted flex items-center justify-center hover:border-emerald-300 hover:text-emerald-600 disabled:opacity-50" title="Actualizar" aria-label="Actualizar turnos abiertos"><RefreshCw className={cn("h-4 w-4", isRefreshingOpenSessions && "animate-spin")} /></button>
                  <button type="button" onClick={() => setShowOpenSessionsModal(false)} className="h-8 w-8 shrink-0 rounded-lg border border-base bg-secondary text-muted flex items-center justify-center hover:bg-subtle hover:text-primary" aria-label="Cerrar"><X className="h-4 w-4" /></button>
                </div>
                <div className="p-2.5 sm:p-3 max-h-[min(60vh,24rem)] overflow-y-auto custom-scrollbar">
                  {openSessionsForResume.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-base bg-subtle px-4 py-6 text-center">
                      <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-xl bg-secondary border border-base text-muted shadow-sm"><Wallet className="h-4 w-4" /></div>
                      <p className="mt-2 text-[11px] font-black uppercase tracking-[0.1em] text-primary">{offlineEmptyState ? "Sin conexión, reintentando…" : "No hay turnos visibles"}</p>
                      <p className="mt-1 text-[10px] font-bold leading-snug text-muted">{offlineEmptyState ? "Este dispositivo no puede consultar las cajas abiertas ahora. Las que ya estaban guardadas siguen disponibles al reconectar." : "Actualiza para volver a consultar las cajas abiertas."}</p>
                      <button type="button" onClick={() => void refreshOpenSessions()} disabled={isRefreshingOpenSessions} className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-[10px] font-black uppercase tracking-tight text-white disabled:opacity-50"><RefreshCw className={cn("h-3.5 w-3.5", isRefreshingOpenSessions && "animate-spin")} />{isRefreshingOpenSessions ? "Reintentando…" : offlineEmptyState ? "Reintentar" : "Actualizar"}</button>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {openSessionsForResume.map((session) => {
                        const branchName = branches.find(b => b.id === session.branchId)?.name || "Almacén principal";
                        const openedLabel = session.openedAt ? new Date(session.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
                        return (
                          <div key={session.id} className="grid grid-cols-[auto,minmax(0,1fr),auto] items-center gap-2 rounded-xl border border-base bg-subtle px-2 py-2">
                            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary border border-base text-[10px] font-black text-primary shadow-xs tabular-nums">T{session.turnNumber || "—"}</div>
                            <div className="flex min-w-0 items-center gap-2">
                              <EmployeeAvatar name={session.workerName || "Administrador"} seed={session.userId || session.workerName || session.id} size="sm" inShift className="!h-7 !w-7 !rounded-lg !text-[9px]" />
                              <div className="min-w-0"><p className="truncate text-[11px] sm:text-xs font-black text-primary" title={session.workerName || "Administrador"}>{session.workerName || "Administrador"}</p><div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[9px] font-bold text-muted"><span className="truncate max-w-full">{branchName}</span><span>·</span><span className="whitespace-nowrap tabular-nums">Abierto {openedLabel}</span></div></div>
                            </div>
                            <button type="button" onClick={() => { setShowOpenSessionsModal(false); setJoiningSessionId(session.id); setJoiningSessionPassword(""); setPosError(""); }} className="h-8 shrink-0 rounded-lg border border-base bg-secondary px-2.5 text-[10px] font-black uppercase tracking-tight text-emerald-600 hover:bg-subtle dark:text-emerald-400 active:scale-[0.98]">Reanudar</button>
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
