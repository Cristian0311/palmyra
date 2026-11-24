import { Search, Wifi, WifiOff, RefreshCw, Plus, Minus, CreditCard, Receipt, Trash2, ShoppingCart, ShieldCheck, DollarSign, Banknote, QrCode, ArrowLeftRight, UserPlus, X, Lock, Unlock, Camera, AlertCircle, TrendingUp, Wallet, MessageSquare, Mail, HelpCircle, Calculator, ArrowRight, Package, User, RotateCcw, Printer, Bluetooth, Usb, Smartphone, Send, Copy, Check, CheckCircle, Share2, Store, ChevronDown, ChevronUp, Filter } from "lucide-react";
import { cn, generateId } from "../lib/utils";
import { formatMoney } from "../modules/pos/utils/paymentMath";
import POSOpenSessionsModal from "./POSOpenSessionsModal";
import EmployeeAvatar from "../components/team/EmployeeAvatar";

 type StartupProps = Record<string, any>;

export default function POSStartupScreen(props: StartupProps) {
  const { activeCashSessions, allowedBranches, baseCurrency, branches, currencies, currentSession, currentUser, detectedWorker, employeePickerOpen, employeePickerRef, employeePickerSearch, handleJoinExistingSession, handleOpenSession, handlePrintClosureThermal, isBranchLocked, isOnline, isOpeningSession, isRefreshingOpenSessions, joiningSessionId, joiningSessionPassword, lastClosedSession, logout, navigate, openSessionForWorker, openSessionsForResume, openingAmount, pendingQuoteBanner, posError, posSuccess, refreshOpenSessions, sessionBranchId, sessionPassword, sessionWorkerName, setEmployeePickerOpen, setEmployeePickerSearch, setJoiningSessionId, setJoiningSessionPassword, setOpeningAmount, setPosError, setPosSuccess, setSessionBranchId, setSessionPassword, setSessionWorkerId, setSessionWorkerName, setShowOpenSessionsModal, setShowOpenShiftModal, showOpenSessionsModal, showOpenShiftModal, users } = props;

  const branchName = (id?: string) => (branches || []).find((b: any) => b.id === id)?.name || '';
  const pickerQuery = String(employeePickerSearch || '').trim().toLowerCase();
  const pickerUsers = (users || [])
    .filter((u: any) => u.isActive !== false)
    .slice()
    .sort((a: any, b: any) => {
      const openDiff = (openSessionForWorker(b.id) ? 1 : 0) - (openSessionForWorker(a.id) ? 1 : 0);
      if (openDiff !== 0) return openDiff;
      return String(a.name || '').localeCompare(String(b.name || ''), 'es');
    })
    .filter((u: any) => !pickerQuery || String(u.name || '').toLowerCase().includes(pickerQuery));
  const selectedPickerUser = (users || []).find((u: any) => String(u.name || '').trim() === String(sessionWorkerName || '').trim());
  const selectedOpenSession = selectedPickerUser ? openSessionForWorker(selectedPickerUser.id) : null;

  return (<>{!currentSession && (
        <div
          className={cn("pos-keyboard-overlay pos-modal-layer fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex flex-col items-center justify-center px-3 py-5 sm:px-4 sm:py-6", "overflow-y-auto overscroll-contain")}
          style={{ paddingBottom: '28px' }}>
          <POSOpenSessionsModal {...{ branches, isOnline, isRefreshingOpenSessions, joiningSessionId, openSessionsForResume, refreshOpenSessions, setJoiningSessionId, setJoiningSessionPassword, setPosError, setShowOpenSessionsModal, showOpenSessionsModal }} />
          {joiningSessionId ? (
            /* Modal Formulario de Ingreso a Turno Abierto Existente */
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Reanudar turno existente"
              className="palmyra-mobile-modal keyboard-modal-surface bg-white dark:bg-slate-900 p-4 rounded-2xl shadow-2xl text-center max-w-[min(94vw,24rem)] w-full border border-white/20"
              style={{ transform: 'translateY(clamp(0px, calc(var(--keyboard-inset, 0px) * 0.12), 24px))' }}
            >
              <div className="w-9 h-9 bg-amber-50 dark:bg-amber-950/40 rounded-xl flex items-center justify-center mx-auto mb-2">
                <Lock className="w-4 h-4 text-amber-600" />
              </div>
              <h3 className="text-[13px] font-black text-slate-900 dark:text-slate-100 uppercase tracking-tight leading-none mb-1">
                Reanudar turno
              </h3>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">
                Turno de {(activeCashSessions || []).find(s => s.id === joiningSessionId)?.workerName || 'Empleado'}
                {(() => {
                  const joining = (activeCashSessions || []).find((s: any) => s.id === joiningSessionId);
                  const name = joining ? branchName(joining.branchId) : '';
                  return name ? ` · ${name}` : '';
                })()}
              </p>

              {posError && (
                <div className="mb-2 p-2 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-[10px] font-bold text-left flex items-center gap-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-600" />
                  <span className="text-[10px] leading-tight">{posError}</span>
                </div>
              )}

              <form onSubmit={handleJoinExistingSession} className="space-y-2">
                <div className="text-left">
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">
                    Contraseña para reanudar el turno
                  </label>
                  <input
                    type="password"
                    required={isOnline}
                    value={joiningSessionPassword}
                    onChange={e => {
                      setJoiningSessionPassword(e.target.value);
                      if (posError) setPosError("");
                    }}
                    autoComplete="current-password"
                    aria-label="Contraseña para reanudar el turno"
                    placeholder="Contraseña para reanudar"
                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-100 dark:bg-slate-800 dark:border-slate-700 rounded-lg text-[12px] font-bold text-slate-900 dark:text-slate-100 outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-300"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => {
                      setJoiningSessionId(null);
                      setJoiningSessionPassword("");
                      setPosError("");
                    }}
                    className="min-h-[44px] py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-[10px] uppercase tracking-wider transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="min-h-[44px] py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg text-[10px] uppercase tracking-tight transition-colors shadow-sm"
                  >
                    Entrar al Turno
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <>
              {lastClosedSession && !showOpenShiftModal ? (
                /* Pantalla visual de Turno Finalizado / Cierre */
                <div className="bg-white p-5 sm:p-6 rounded-[2rem] shadow-2xl text-center max-w-md w-full animate-in zoom-in-95 border border-white/20 my-auto">
                  <div className="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-3 border border-emerald-100 shadow-sm">
                    <CheckCircle className="w-6 h-6 text-emerald-600" />
                  </div>
                  <h3 className="text-lg font-black text-slate-900 uppercase tracking-tight leading-none mb-1">Turno Finalizado</h3>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">
                    {lastClosedSession.id} • {lastClosedSession.workerName || 'Empleado'}
                  </p>

                  <div className="bg-slate-50 border border-slate-100 rounded-2xl p-3 text-left space-y-1.5 mb-4">
                    <div className="flex justify-between items-center text-[11px]">
                      <span className="text-slate-500 font-bold">Sucursal:</span>
                      <span className="font-black text-slate-900">{branches.find(b => b.id === lastClosedSession.branchId)?.name || 'Central'}</span>
                    </div>
                    <div className="flex justify-between items-center text-[11px]">
                      <span className="text-slate-500 font-bold">Cierre:</span>
                      <span className="font-bold text-slate-700">{new Date(lastClosedSession.closingDate || lastClosedSession.closedAt || new Date()).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between items-center text-[11px] pt-1 border-t border-slate-200">
                      <span className="text-slate-500 font-bold">Fondo Inicial:</span>
                      <span className="font-mono font-bold text-slate-800">{formatMoney(lastClosedSession.openingBalance || 0, baseCurrency.symbol)}</span>
                    </div>
                    {lastClosedSession.closingBalances && lastClosedSession.closingBalances.length > 0 && (
                      <div className="pt-1.5 border-t border-slate-200 space-y-1">
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block">Arqueo Declarado</span>
                        {lastClosedSession.closingBalances.map((b, bIdx) => (
                          <div key={bIdx} className="flex justify-between items-center text-[11px]">
                            <span className="text-slate-600 capitalize">{b.currencyCode} ({b.method === 'transfer' ? 'Transferencia' : 'Efectivo'}):</span>
                            <span className="font-mono font-black text-emerald-700">{formatMoney(b.amount, currencies.find(c => c.code === b.currencyCode)?.symbol || '')}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {pendingQuoteBanner}

                  {/* Botones de impresión y acciones */}
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-2 gap-2">
                      <button                        type="button"
                        onClick={() => handlePrintClosureThermal(lastClosedSession)}
                        className="min-h-[44px] py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-black text-[10px] uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 active:scale-95"
                      >
                        <Printer className="w-3 h-3 text-slate-500" />
                        Ticket 58mm
                      </button>
                      
                    </div>

                    <button
                      type="button"
                      onClick={() => setShowOpenShiftModal(true)}
                      className="w-full min-h-[44px] py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black text-[10px] uppercase tracking-widest transition-all shadow-lg shadow-indigo-100 active:scale-95 flex items-center justify-center gap-2"
                    >
                      <DollarSign className="w-3.5 h-3.5" />
                      Abrir Nuevo Turno / Caja
                    </button>

                    {currentUser?.role === 'admin' ? (
                      <button 
                        type="button"
                        onClick={() => navigate('/')}
                        className="w-full min-h-[44px] py-2 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                      >
                        Volver al Menú Principal
                      </button>
                    ) : (
                      <button 
                        type="button"
                        onClick={() => logout()}
                        className="w-full min-h-[44px] py-2 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                      >
                        Cerrar Sesión del Empleado
                      </button>
                    )}
                  </div>
                </div>

              ) : (
                /* Modal Formulario de Apertura de Caja */
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label="Apertura de caja"
                  className="palmyra-mobile-modal palmyra-open-cash-modal p-3 sm:p-4 rounded-2xl shadow-2xl text-center w-full max-w-[min(96vw,27rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto animate-in zoom-in-95 my-auto"
                >
                  <div className="flex items-center gap-2 mb-2.5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white shadow-sm">
                      <DollarSign className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-1.5">
                        <h3 className="text-[13px] font-black text-slate-900 uppercase tracking-tight leading-none">Apertura de caja</h3>
                        <span className="palmyra-pill border-[color-mix(in_srgb,var(--primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary)_12%,var(--bg-secondary))] text-[var(--primary)]">Configurar</span>
                      </div>
                      <p className="mt-1 text-[9.5px] font-bold leading-tight text-slate-400">Operador · almacén · fondo inicial</p>
                    </div>
                  </div>

                  <div className="mb-2.5 grid grid-cols-3 gap-1 rounded-xl border border-slate-100 bg-slate-50/80 p-1">
                    <div className="rounded-lg bg-white px-1.5 py-1.5 border border-slate-100">
                      <p className="text-[8px] font-black uppercase tracking-wider text-slate-400">01</p>
                      <p className="mt-0.5 text-[9.5px] font-black text-slate-700">Operador</p>
                    </div>
                    <div className="rounded-lg bg-white px-1.5 py-1.5 border border-slate-100">
                      <p className="text-[8px] font-black uppercase tracking-wider text-slate-400">02</p>
                      <p className="mt-0.5 text-[9.5px] font-black text-slate-700">Almacén</p>
                    </div>
                    <div className="rounded-lg bg-white px-1.5 py-1.5 border border-slate-100">
                      <p className="text-[8px] font-black uppercase tracking-wider text-slate-400">03</p>
                      <p className="mt-0.5 text-[9.5px] font-black text-slate-700">Fondo</p>
                    </div>
                  </div>                  {/* Inline Modal Alert */}
                  {posError && (
                    <div className="mb-2.5 p-2 sm:p-2.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-[10px] font-bold flex items-start justify-between gap-1.5 animate-in fade-in zoom-in-95">
                      <div className="flex items-center gap-2 text-left">
                        <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
                        <span className="text-[10px] font-bold leading-4 break-words">{posError}</span>
                      </div>
                      <button type="button" onClick={() => setPosError("")} className="p-1 hover:bg-rose-100 rounded-lg text-rose-500 shrink-0">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  {posSuccess && (
                    <div className="mb-2 p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl text-xs font-bold flex items-center justify-between gap-2 animate-in fade-in zoom-in-95">
                      <div className="flex items-center gap-2 text-left">
                        <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
                        <span className="text-[11px] font-bold">{posSuccess}</span>
                      </div>
                      <button type="button" onClick={() => setPosSuccess("")} className="p-1 hover:bg-emerald-100 rounded-lg text-emerald-500 shrink-0">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}                    <button
                      type="button"
                      onClick={() => {
                        setShowOpenSessionsModal(true);
                        void refreshOpenSessions();
                      }}
                      className="group w-full min-h-[44px] mb-2 flex items-center gap-2 rounded-xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-white px-2.5 py-2 text-left transition-all hover:border-emerald-300 hover:shadow-sm active:scale-[0.99]"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-sm">
                        <Wallet className="w-3.5 h-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="text-[10px] font-black uppercase tracking-[0.1em] text-emerald-900">Turnos abiertos</span>
                          <span className="palmyra-badge palmyra-badge-success tabular-nums">{isRefreshingOpenSessions ? "…" : openSessionsForResume.length}</span>
                        </span>
                        <span className="mt-0.5 block text-[9px] font-bold leading-tight text-emerald-700/75">
                          {openSessionsForResume.length > 0 ? "Ver cajas en curso y reanudar" : "Buscar cajas en curso"}
                        </span>
                      </span>
                      {isRefreshingOpenSessions ? <RefreshCw className="w-3 h-3 shrink-0 animate-spin text-emerald-600" /> : <ArrowRight className="w-3 h-3 shrink-0 text-emerald-600 transition-transform group-hover:translate-x-0.5" />}
                    </button>
                    {pendingQuoteBanner}
              <form onSubmit={handleOpenSession} className="space-y-2">
                    <div className="text-left space-y-2">
                      {!false && (
                      <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">
                          Empleado del turno
                        </label>
                        <div className="space-y-1.5">
                          <div className="relative" ref={employeePickerRef}>
                            <div className="relative">
                              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                                                            <input
                                type="text"
                                value={employeePickerOpen ? employeePickerSearch : sessionWorkerName}
                                inputMode={employeePickerOpen ? "search" : "none"}
                                readOnly={!employeePickerOpen}
                                onFocus={() => {
                                  if (!employeePickerOpen) {
                                    setEmployeePickerSearch("");
                                    setEmployeePickerOpen(true);
                                  }
                                }}
                                onClick={() => {
                                  if (!employeePickerOpen) {
                                    setEmployeePickerSearch("");
                                    setEmployeePickerOpen(true);
                                  }
                                }}
                                onChange={e => {
                                  setEmployeePickerSearch(e.target.value);
                                  setSessionWorkerName('');
                                  setSessionPassword('');
                                  setPosError('');
                                  setEmployeePickerOpen(true);
                                }}
                                placeholder="Seleccionar empleado"
                                className="w-full pl-9 pr-10 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-bold text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                                autoComplete="off"
                                aria-label="Seleccionar empleado"
                              />
                              {employeePickerOpen ? (
                                <button
                                  type="button"
                                  aria-label="Cerrar buscador de empleados"
                                  title="Cerrar buscador"
                                  onMouseDown={e => e.preventDefault()}
                                  onClick={() => {
                                    setEmployeePickerOpen(false);
                                    setEmployeePickerSearch("");
                                  }}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-lg text-slate-400 hover:bg-slate-200 hover:text-slate-700 transition-colors"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              ) : (
                                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                              )}
                            </div>

                            {employeePickerOpen && (
                              <div className="palmyra-popover absolute left-0 right-0 top-full z-[var(--z-dropdown)] mt-1">
                                <div className="max-h-[30vh] overflow-y-auto custom-scrollbar p-1">
                                  {pickerUsers
                                    .map((u: any) => {
                                      const isSelected = sessionWorkerName === (u.name || '');
                                      const open = openSessionForWorker(u.id);
                                      const workerBranch = branchName(u.branchId) || ((u.allowedBranches || []).map(branchName).filter(Boolean).join(' · '));
                                      return (
                                        <button
                                          key={u.id}
                                          type="button"
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            const workerName = (u.name || '').trim();
                                            setSessionWorkerName(workerName);
                                            setSessionWorkerId(u.id);
                                            setEmployeePickerSearch(workerName);
                                            setEmployeePickerOpen(false);
                                            setSessionPassword('');
                                            const openSession = openSessionForWorker(u.id);
                                            if (openSession?.branchId) setSessionBranchId(openSession.branchId);
                                            else if (u.branchId) setSessionBranchId(u.branchId);
                                            else if ((u.allowedBranches || []).length === 1) setSessionBranchId(u.allowedBranches![0]);
                                            setPosError('');
                                            if (openSession) {
                                              setJoiningSessionId(openSession.id);
                                              setJoiningSessionPassword("");
                                            }
                                          }}
                                          className={cn(
                                            "w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left transition-colors",
                                            isSelected ? "bg-rose-100 text-rose-900" : "hover:bg-slate-50 text-slate-900"
                                          )}
                                        >
                                          <EmployeeAvatar
                                            name={u.name || 'Trabajador'}
                                            seed={u.id || u.name}
                                            size="sm"
                                            active={u.isActive !== false}
                                            inShift={Boolean(open)}
                                            className="!h-8 !w-8 !rounded-xl !text-[10px]"
                                          />
                                          <div className="min-w-0 flex-1">
                                            <span className="block text-[10px] font-black uppercase tracking-tight leading-tight whitespace-normal break-words">
                                              {u.name || 'Trabajador'}
                                            </span>
                                            <span className={cn(
                                              "block text-[8.5px] font-black uppercase tracking-wider mt-0.5",
                                              u.role === 'admin' ? "text-rose-700" : "text-slate-400"
                                            )}>
                                              {u.role === 'admin' ? "ADMINISTRADOR" : "EMPLEADO"}
                                              {workerBranch ? <span className="text-slate-400"> · {workerBranch}</span> : null}
                                            </span>
                                          </div>
                                          <span className={cn(
                                            "shrink-0 px-1.5 py-0.5 rounded-md border text-[8px] font-black uppercase tracking-wider",
                                            open ? "bg-emerald-100 border-emerald-300 text-emerald-700" : "bg-slate-100 border-slate-200 text-slate-400"
                                          )}>
                                            {open ? "ABIERTO" : "DISPONIBLE"}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  {pickerUsers.length === 0 && (
                                    <div className="px-3 py-4 text-center text-[9px] font-bold text-slate-400 uppercase">
                                      No se encontraron empleados.
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>

                          {selectedOpenSession && !employeePickerOpen && (
                            <button
                              type="button"
                              onClick={() => {
                                setJoiningSessionId(selectedOpenSession.id);
                                setJoiningSessionPassword("");
                              }}
                              className="flex w-full min-h-[44px] items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-2 text-left active:scale-[0.99]"
                            >
                              <Wallet className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                              <span className="text-[9.5px] font-black uppercase tracking-wide text-emerald-800">
                                Caja abierta{branchName(selectedOpenSession.branchId) ? ` en ${branchName(selectedOpenSession.branchId)}` : ''} · Reanudar turno
                              </span>
                            </button>
                          )}

                        </div>
                      </div>
                      )}

                      <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">
                          {currentUser?.role === 'admin' && detectedWorker?.id === currentUser.id
                            ? 'Contraseña de PALMYRA (Administrador)'
                            : 'Contraseña del Empleado'}
                        </label>
                        <input
                          type="password"
                          required
                          autoComplete="current-password"
                          value={sessionPassword}
                          onChange={e => setSessionPassword(e.target.value)}
                          placeholder={
                            currentUser?.role === 'admin' && detectedWorker?.id === currentUser.id
                              ? "La misma contraseña con la que entras a PALMYRA"
                              : detectedWorker
                                ? `Ingresa la contraseña de ${detectedWorker?.name || 'trabajador'}`
                                : "Ingresa la contraseña del trabajador"
                          }
                          className="w-full px-3 py-2.5 bg-slate-50 border border-slate-100 rounded-xl text-[11px] font-bold text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                        />
                      </div>
                    </div>

                    {false && (
                      <div className="p-1.5 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-1.5 text-left">
                        <Package className="w-3 h-3 text-amber-600 shrink-0" />
                        <p className="text-[8px] font-black text-amber-800 uppercase tracking-tight">
                          Empleado Independiente (PALMYRA) • Almacén exclusivo bloqueado
                        </p>
                      </div>
                    )}


                      {(allowedBranches || []).length > 0 ? (
                      <div className="space-y-2.5">
                        <div className="text-left">
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">
                              Sucursal / Almacén a Operar
                            </label>
                            {isBranchLocked && (
                              <span className="flex items-center gap-1 text-[8.5px] font-black text-amber-700 uppercase bg-amber-100 px-1.5 py-0.5 rounded border border-amber-300">
                                <Lock className="w-2.5 h-2.5" /> Bloqueado
                              </span>
                            )}
                          </div>
                          <select 
                            value={sessionBranchId}
                            disabled={isBranchLocked}
                            onChange={(e) => setSessionBranchId(e.target.value)}
                            aria-label="Sucursal o almacén a operar"
                            className={cn(
                              "w-full px-2.5 py-2.5 border rounded-lg text-[11px] font-bold text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 transition-all appearance-none",
                              isBranchLocked ? "bg-amber-50/70 border-amber-200 cursor-not-allowed text-amber-900 font-black" : "bg-slate-50 border-slate-100"
                            )}
                          >
                            {allowedBranches.map(b => (
                              <option key={b.id} value={b.id}>{b.name}</option>
                            ))}
                          </select>
                          {isBranchLocked && (
                            <p className="text-[9.5px] font-bold text-amber-700 mt-1 uppercase leading-snug">
                              El vendedor tiene un almacén fijo asignado y no puede vender desde otro almacén.
                            </p>
                          )}
                        </div>
                        
                        <div className="text-left">
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">
                              Fondo Inicial ({baseCurrency.code})
                            </label>
                            <span className="text-[9px] font-bold text-slate-400 uppercase">0 permitido</span>
                          </div>
                          <div className="relative">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                              <span className="text-slate-400 font-bold text-[11px]">{baseCurrency.symbol}</span>
                            </div>
                            <input 
                              type="number" 
                              min="0"
                              step="0.01"
                              aria-label={`Fondo inicial en ${baseCurrency.code}`}
                              value={openingAmount}
                              onFocus={(e) => e.target.select()}
                              onChange={e => setOpeningAmount(e.target.value)}
                              className="w-full pl-8 pr-2.5 py-2 bg-slate-50 border border-slate-100 rounded-lg text-[13px] font-black text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 transition-all tabular-nums"
                              placeholder="0"
                            />
                          </div>
                        </div>

                        <div className="space-y-1.5 pt-1">
                          <button 
                            type="submit"
                            disabled={isOpeningSession}
                            className="w-full min-h-[44px] py-2.5 bg-violet-600 text-white rounded-xl font-black text-[11px] uppercase tracking-widest hover:bg-violet-700 transition-all shadow-lg shadow-violet-600/20 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            {isOpeningSession ? "Abriendo Caja..." : "Abrir Caja y Comenzar"}
                          </button>

                          {lastClosedSession && (
                            <button
                              type="button"
                              onClick={() => setShowOpenShiftModal(false)}
                              className="w-full min-h-[44px] py-2 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                            >
                              Ver Resumen de Turno Anterior
                            </button>
                          )}

                          {currentUser?.role === 'admin' ? (
                            <button 
                              type="button"
                              onClick={() => navigate('/')}
                              className="w-full min-h-[44px] py-2.5 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                            >
                              Volver al Menú
                            </button>
                          ) : (
                            <button 
                              type="button"
                              onClick={() => logout()}
                              className="w-full min-h-[44px] py-2.5 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                            >
                              Cerrar Sesión
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-4 space-y-4">
                        <div className="bg-red-50 text-red-600 p-4 rounded-xl text-xs font-bold">
                          No tienes sucursales asignadas.
                        </div>
                        {currentUser?.role === 'admin' ? (
                          <button 
                            type="button"
                            onClick={() => navigate('/')}
                            className="w-full min-h-[44px] py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                          >
                            Volver al Menú
                          </button>
                        ) : (
                          <button 
                            type="button"
                            onClick={() => logout()}
                            className="w-full min-h-[44px] py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                          >
                            Cerrar Sesión
                          </button>
                        )}
                      </div>
                    )}
                  </form>
                </div>
              )}

            </>
          )}
        </div>
      )}</>);
}
