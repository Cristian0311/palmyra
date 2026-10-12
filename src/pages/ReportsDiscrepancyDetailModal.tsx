import { 
  TrendingUp, DollarSign, Calendar, Calculator, Package, User, Users, Eye,
  X, ArrowDownRight, ArrowUpRight, ArrowLeftRight, ArrowRight, History, Download, Printer, CheckCircle2, 
  Clock, AlertCircle, AlertTriangle, FileSpreadsheet, ChevronDown, Check, Plus, Search,
  BarChart3, Brain, ListChecks, ShieldAlert, Loader2, Trash2,
  HelpCircle, Edit3, Save, FileText, CheckCircle, Minus
} from "lucide-react";
import { buildDetailedMovements, calculatePerfectSessionBalances } from '../modules/reports/utils/reportSessionCalculations';
import { cn } from "../lib/utils";

type ModalProps = Record<string, any>;

export default function ReportsDiscrepancyDetailModal(props: ModalProps) {
  const { addNotification, auditActionMode, auditCurrencyCode, auditPaymentMethod, auditPrice, auditProductId, auditProductSearch, auditQuantity, baseCurrency, branches, currencies, editingAuditNotes, editingAuditStatus, formatMoney, getSessionDiscrepancyInfo, handlePrintDiscrepancyTicket, handlePrintShiftTicket, isAddingAuditProduct, products, selectedDiscrepancyDetailSession, sessionTurnMap, setAuditActionMode, setAuditCurrencyCode, setAuditPaymentMethod, setAuditPrice, setAuditProductId, setAuditProductSearch, setAuditQuantity, setEditingAuditNotes, setEditingAuditStatus, setIsAddingAuditProduct, setSelectedDiscrepancyDetailSession, store, transactions, updateCashSession, users } = props;
  return (
    <>
      {selectedDiscrepancyDetailSession && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[95] flex items-center justify-center p-2 sm:p-4 overflow-hidden animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-2xl max-h-[94vh] sm:max-h-[90vh] flex flex-col overflow-hidden border border-base">
            {(() => {
              const session = selectedDiscrepancyDetailSession;
              const info = getSessionDiscrepancyInfo(session);
              const branch = branches.find(b => b.id === session.branchId);
              const sequentialTurn = sessionTurnMap.get(session.id) || session.id;
              const workerName = session.workerName || users.find(u => u.id === session.userId)?.name || 'Cajero';
              const openDate = new Date(session.openedAt);
              const closeDate = new Date(session.closingDate || session.closedAt || session.openedAt);

              // Turn transactions
              const sessionTx = transactions.filter(t => 
                t.sessionId 
                  ? t.sessionId === session.id
                  : (t.branchId === session.branchId && 
                     new Date(t.date).getTime() >= openDate.getTime() && 
                     (!session.closedAt || new Date(t.date).getTime() <= closeDate.getTime()))
              );
              const totalSalesInSession = sessionTx.reduce((sum, tx) => sum + (tx.total || 0), 0);
              const movementsInSession = session.movements || [];

              return (
                <>
                  {/* Header */}
                  <div className="p-4 sm:p-5 border-b border-base flex items-center justify-between bg-rose-50/40 dark:bg-rose-950/30 shrink-0">
                    <div className="flex items-center gap-2.5">
                      <div className={cn(
                        "p-2.5 rounded-2xl shrink-0 flex items-center justify-center",
                        info?.isForcedClose
                          ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                          : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                      )}>
                        {info?.isForcedClose ? <AlertTriangle className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] font-black text-rose-700 dark:text-rose-300 uppercase bg-white dark:bg-slate-800 px-2 py-0.5 rounded border border-rose-200 dark:border-rose-900">
                            {sequentialTurn}
                          </span>
                          {info?.isForcedClose ? (
                            <span className="text-[8px] font-black uppercase text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/60 px-2 py-0.5 rounded border border-rose-200 dark:border-rose-900 flex items-center gap-1">
                              <AlertTriangle className="w-2.5 h-2.5" /> Cierre Forzado
                            </span>
                          ) : (
                            <span className="text-[8px] font-black uppercase text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/60 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-900">
                              Cuadre con Diferencia
                            </span>
                          )}
                          <span className="text-[8px] font-bold text-muted uppercase">
                            {branch?.name || 'Sucursal Principal'}
                          </span>
                        </div>
                        <h3 className="text-sm font-black text-primary uppercase tracking-tight mt-0.5">
                          Auditoría de Descuadre — {workerName}
                        </h3>
                      </div>
                    </div>
                    <button 
                      onClick={() => setSelectedDiscrepancyDetailSession(null)}
                      className="p-1.5 hover:bg-subtle rounded-full transition-colors text-muted hover:text-primary cursor-pointer"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  {/* Scrollable Body */}
                  <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 custom-scrollbar text-primary">
                    {/* Turn Dates & General Meta */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[9px]">
                      <div className="bg-subtle p-2.5 rounded-xl border border-base">
                        <span className="text-muted font-black uppercase block text-[7px]">Apertura</span>
                        <p className="font-bold text-primary mt-0.5">{openDate.toLocaleString('es-CU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
                      </div>
                      <div className="bg-subtle p-2.5 rounded-xl border border-base">
                        <span className="text-muted font-black uppercase block text-[7px]">Cierre</span>
                        <p className="font-bold text-primary mt-0.5">{closeDate.toLocaleString('es-CU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
                      </div>
                      <div className="bg-subtle p-2.5 rounded-xl border border-base">
                        <span className="text-muted font-black uppercase block text-[7px]">Fondo Inicial</span>
                        <p className="font-bold text-primary mt-0.5">{formatMoney(session.openingBalance, baseCurrency.code)}</p>
                      </div>
                      <div className="bg-subtle p-2.5 rounded-xl border border-base">
                        <span className="text-muted font-black uppercase block text-[7px]">Ventas Totales</span>
                        <p className="font-black text-rose-600 dark:text-rose-400 mt-0.5">{formatMoney(totalSalesInSession, baseCurrency.code)}</p>
                      </div>
                    </div>

                    {/* Reason if forced close */}
                    {info?.isForcedClose && (
                      <div className="p-3 rounded-2xl bg-rose-50/70 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 flex items-start gap-2.5">
                        <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[8px] font-black uppercase tracking-wider text-rose-800 dark:text-rose-300">
                            Motivo de Cierre Forzado de Turno:
                          </p>
                          <p className="text-xs font-bold text-rose-950 dark:text-rose-200 mt-0.5">
                            {session.forcedCloseReason || session.discrepancyNote || session.notes || 'Cierre forzado directamente por el operador con diferencias pendientes de conciliar.'}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* KPI summary */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                      <div className="p-3 rounded-xl bg-subtle border border-base">
                        <span className="text-[8px] font-black uppercase text-muted tracking-wider block">Faltante en Caja</span>
                        <p className="text-sm sm:text-base font-black text-rose-600 mt-0.5">
                          {info && info.totalShortageBase > 0 ? `-${formatMoney(info.totalShortageBase)}` : '$0'}
                        </p>
                        <span className="text-[7px] font-bold text-muted uppercase">Dinero no justificado</span>
                      </div>

                      <div className="p-3 rounded-xl bg-subtle border border-base">
                        <span className="text-[8px] font-black uppercase text-muted tracking-wider block">Sobrante en Caja</span>
                        <p className="text-sm sm:text-base font-black text-emerald-600 mt-0.5">
                          {info && info.totalOverageBase > 0 ? `+${formatMoney(info.totalOverageBase)}` : '$0'}
                        </p>
                        <span className="text-[7px] font-bold text-muted uppercase">Dinero en exceso</span>
                      </div>

                      <div className="p-3 rounded-xl bg-subtle border border-base col-span-2 sm:col-span-1">
                        <span className="text-[8px] font-black uppercase text-muted tracking-wider block">Descuento Salarial</span>
                        <p className="text-sm sm:text-base font-black text-amber-600 mt-0.5">
                          {info && info.deducted ? `-${formatMoney(info.deductionAmount)}` : 'Sin Deducción'}
                        </p>
                        <span className="text-[7px] font-bold text-muted uppercase">
                          {info?.deducted ? 'Deducido en liquidación nómina' : 'Pendiente o exonerado'}
                        </span>
                      </div>
                    </div>

                    {/* Desglose de diferencias por moneda y método */}
                    <div>
                      <div className="text-[9px] font-black text-muted uppercase tracking-widest mb-2 flex items-center justify-between">
                        <span>Diferencias Detalladas por Moneda y Método</span>
                        <span className="text-[8px] font-bold text-muted">{info?.details.length || 0} desajustes</span>
                      </div>

                      <div className="border border-base rounded-2xl overflow-hidden">
                        <table className="w-full text-left border-collapse text-[10px]">
                          <thead>
                            <tr className="bg-subtle border-b border-base text-[8px] font-black text-muted uppercase tracking-wider">
                              <th className="px-3 py-2">Moneda / Método</th>
                              <th className="px-3 py-2 text-right">Saldo Esperado</th>
                              <th className="px-3 py-2 text-right">Saldo Declarado</th>
                              <th className="px-3 py-2 text-right">Diferencia</th>
                              <th className="px-3 py-2 text-right">Equivalente CUP</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-base">
                            {(info?.details || []).map((d, i) => {
                              const rate = currencies.find(c => c.code === d.currencyCode)?.rateToBase || 1;
                              const cupDiff = d.difference * rate;
                              return (
                                <tr key={i} className="hover:bg-subtle/40 transition-colors">
                                  <td className="px-3 py-2">
                                    <span className="font-black text-primary">{d.currencyCode}</span>
                                    <span className="ml-1.5 text-[8px] uppercase font-bold text-muted bg-subtle px-1.5 py-0.5 rounded border border-base">
                                      {d.method === 'cash' ? 'Efectivo' : 'Transferencia'}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono text-muted">
                                    {formatMoney(d.expected, d.currencyCode)}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono font-bold text-primary">
                                    {formatMoney(d.actual, d.currencyCode)}
                                  </td>
                                  <td className={cn("px-3 py-2 text-right font-mono font-black", d.difference > 0 ? "text-emerald-600" : "text-rose-600")}>
                                    {d.difference > 0 ? '+' : ''}{formatMoney(d.difference, d.currencyCode)}
                                  </td>
                                  <td className={cn("px-3 py-2 text-right font-mono font-black", cupDiff > 0 ? "text-emerald-600" : "text-rose-600")}>
                                    {cupDiff > 0 ? '+' : ''}{formatMoney(cupDiff, baseCurrency.code)}
                                  </td>
                                </tr>
                              );
                            })}
                            {(!info || info.details.length === 0) && (
                              <tr>
                                <td colSpan={5} className="px-4 py-4 text-center text-muted text-[9px] font-bold uppercase">
                                  No se registraron diferencias aritméticas en las monedas.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Posible producto coincidente */}
                    {info && info.matchingProducts && info.matchingProducts.length > 0 && (
                      <div className="p-3 rounded-2xl bg-amber-50/60 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 space-y-1.5">
                        <div className="text-[8px] font-black text-amber-800 dark:text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                          <Brain className="w-3.5 h-3.5 text-amber-600" />
                          <span>Detección de Coincidencia de Catálogo:</span>
                        </div>
                        <p className="text-[9px] text-muted font-medium">
                          El monto del descuadre coincide con el precio de los siguientes productos:
                        </p>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {info.matchingProducts.map((m, idx) => (
                            <div key={idx} className="flex flex-wrap gap-1">
                              {m.matchedProducts.map((p: any) => (
                                <span key={p.id} className="text-[8px] font-black bg-white dark:bg-slate-800 text-primary px-2 py-0.5 rounded-lg border border-amber-300 dark:border-amber-800 shadow-2xs">
                                  {p.name} (${p.price} {m.currencyCode})
                                </span>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="p-3 rounded-2xl border border-base bg-secondary">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <div className="p-2.5 rounded-xl bg-subtle border border-base">
                          <div className="text-[7px] font-black uppercase text-muted">1 · Arqueo</div>
                          <div className="text-[8px] font-bold text-primary mt-0.5">Confirmar el efectivo/transferencias declarados.</div>
                        </div>
                        <div className="p-2.5 rounded-xl bg-subtle border border-base">
                          <div className="text-[7px] font-black uppercase text-muted">2 · Investigar</div>
                          <div className="text-[8px] font-bold text-primary mt-0.5">Buscar error de registro, venta omitida o duplicada.</div>
                        </div>
                        <div className="p-2.5 rounded-xl bg-subtle border border-base">
                          <div className="text-[7px] font-black uppercase text-muted">3 · Corregir</div>
                          <div className="text-[8px] font-bold text-primary mt-0.5">Solo ajustar stock cuando la causa sea física.</div>
                        </div>
                      </div>
                    </div>

                    {/* Panel de Auditoría y Resolución Editable */}
                    <div className="p-3.5 rounded-2xl bg-subtle border border-base space-y-3">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          <ListChecks className="w-4 h-4 text-rose-600" />
                          <div>
                            <span className="text-[9px] font-black uppercase text-primary tracking-wider block">
                              Revisión del descuadre
                            </span>
                            <span className="text-[7px] font-bold text-muted uppercase">Registrar la causa y decidir si requiere corrección documental.</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <span className="text-[8px] font-bold text-muted uppercase">Estado:</span>
                          <select
                            value={editingAuditStatus}
                            onChange={(e) => setEditingAuditStatus(e.target.value as any)}
                            className="px-2.5 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider bg-secondary border border-base outline-none cursor-pointer text-primary"
                          >
                            <option value="pending_review">⚠️ Pendiente de Revisión</option>
                            <option value="reviewed">✓ Auditado / Aclarado</option>
                            <option value="resolved">★ Resuelto y Cuadrado</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <textarea
                          value={editingAuditNotes}
                          onChange={(e) => setEditingAuditNotes(e.target.value)}
                          placeholder="Escriba las conclusiones de la auditoría, justificación del descuadre o acuerdos tomados con el cajero..."
                          rows={3}
                          className="w-full bg-secondary border border-base rounded-xl p-2.5 text-xs text-primary placeholder:text-muted focus:border-rose-500 outline-none resize-none transition-colors"
                        />
                      </div>

                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => {
                            // 1. Recalcular saldos esperados para esta sesión
                            const perfectBalances = calculatePerfectSessionBalances(session, {
                              baseCurrencyCode: baseCurrency.code,
                              currencies,
                              transactions,
                            });

                            // 2. Actualizar el turno para un Cuadre Perfecto
                            updateCashSession(session.id, {
                              closingBalances: perfectBalances,
                              discrepancyDetails: [],
                              hasDiscrepancy: false,
                              isForcedClose: false,
                              forcedCloseReason: '',
                              auditStatus: 'resolved',
                              auditNotes: 'Auditoría cerrada con Cuadre Perfecto aplicado manualmente por el auditor.'
                            });

                            setSelectedDiscrepancyDetailSession({
                              ...session,
                              closingBalances: perfectBalances,
                              discrepancyDetails: [],
                              hasDiscrepancy: false,
                              isForcedClose: false,
                              forcedCloseReason: '',
                              auditStatus: 'resolved',
                              auditNotes: 'Auditoría cerrada con Cuadre Perfecto aplicado manualmente por el auditor.'
                            });

                            if (addNotification) addNotification("Cuadre perfecto aplicado. La diferencia ha quedado en 0.", "success");
                          }}
                          className="px-3.5 py-1.5 bg-emerald-650 hover:bg-emerald-700 text-white rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer shadow-sm active:scale-95 mr-2"
                          title="Alinear saldo declarado con saldo esperado para fijar descuadre a 0"
                        >
                          <CheckCircle className="w-3.5 h-3.5" />
                          <span>Cuadre Perfecto</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            updateCashSession(session.id, {
                              auditStatus: editingAuditStatus,
                              auditNotes: editingAuditNotes
                            });
                            setSelectedDiscrepancyDetailSession({
                              ...session,
                              auditStatus: editingAuditStatus,
                              auditNotes: editingAuditNotes
                            });
                            if (addNotification) addNotification("Notas y estado de auditoría guardados", "success");
                          }}
                          className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer shadow-sm active:scale-95"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>Guardar Auditoría</span>
                        </button>
                      </div>
                    </div>

                    {/* Sección para registrar productos faltantes o restar productos duplicados del turno */}
                    <div className={cn(
                      "p-4 rounded-2xl border transition-all space-y-3.5",
                      auditActionMode === 'add'
                        ? "bg-amber-500/5 border-amber-500/20"
                        : "bg-rose-500/5 border-rose-500/20"
                    )}>
                      {/* Tabs de Modo de Auditoría */}
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base/50 pb-2.5">
                        <div className="flex items-center gap-1.5 p-1 bg-secondary rounded-xl border border-base">
                          <button
                            type="button"
                            onClick={() => setAuditActionMode('add')}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer",
                              auditActionMode === 'add'
                                ? "bg-amber-600 text-white shadow-xs"
                                : "text-muted hover:text-primary"
                            )}
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Registrar venta omitida · Ajustar stock</span>                          </button>
                          <button
                            type="button"
                            onClick={() => setAuditActionMode('subtract')}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer",
                              auditActionMode === 'subtract'
                                ? "bg-rose-600 text-white shadow-xs"
                                : "text-muted hover:text-primary"
                            )}
                          >
                            <Minus className="w-3.5 h-3.5" />
                            <span>Eliminar venta duplicada · Reponer stock</span>
                          </button>
                        </div>

                        {auditProductSearch && (
                          <button
                            type="button"
                            onClick={() => setAuditProductSearch("")}
                            className="text-[8px] font-bold text-muted hover:text-primary hover:underline cursor-pointer uppercase"
                          >
                            Limpiar Búsqueda
                          </button>
                        )}
                      </div>

                      {/* Banner Informativo Dinámico */}
                      <div className={cn(
                        "p-2.5 rounded-xl text-left border",
                        auditActionMode === 'add'
                          ? "bg-amber-50 dark:bg-amber-950/20 border-amber-200/40 text-amber-900 dark:text-amber-300"
                          : "bg-rose-50 dark:bg-rose-950/20 border-rose-200/40 text-rose-900 dark:text-rose-300"
                      )}>
                        <p className="text-[8px] font-semibold uppercase leading-relaxed">
                          {auditActionMode === 'add' ? (
                            <><strong>VENTA OMITIDA:</strong> úsalo cuando existe evidencia de una venta que no quedó registrada. Se crea la regularización del turno y <strong>se descuenta del inventario</strong>.</>
                          ) : (
                            <><strong>VENTA DUPLICADA:</strong> úsalo cuando la operación quedó registrada dos veces. Se crea una corrección negativa y <strong>se repone el inventario</strong>.</>
                          )}
                        </p>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {/* Buscador de Producto */}
                        <div className="space-y-1">
                          <label className="block text-[8px] font-black uppercase text-slate-500 tracking-wider">
                            Buscar Producto:
                          </label>
                          <input
                            type="text"
                            value={auditProductSearch}
                            onChange={(e) => setAuditProductSearch(e.target.value)}
                            placeholder="Nombre o SKU..."
                            className="w-full px-3 py-1.5 bg-secondary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-2 focus:ring-amber-500/20"
                          />
                        </div>

                        {/* Selector de Producto */}
                        <div className="space-y-1">
                          <label className="block text-[8px] font-black uppercase text-slate-500 tracking-wider">
                            Seleccionar Producto:
                          </label>
                          {(() => {
                            const query = (auditProductSearch || "").toLowerCase().trim();
                            const filtered = products.filter(p => 
                              !query || 
                              (p.name && p.name.toLowerCase().includes(query)) ||
                              (p.sku && p.sku.toLowerCase().includes(query))
                            );

                            return (
                              <select
                                value={auditProductId}
                                onChange={(e) => {
                                  const pId = e.target.value;
                                  setAuditProductId(pId);
                                  const prod = products.find(p => p.id === pId);
                                  if (prod) {
                                    setAuditPrice(prod.price || 0);
                                  }
                                }}
                                className="w-full px-3 py-1.5 bg-secondary border border-base rounded-xl text-xs font-bold text-primary outline-none cursor-pointer"
                              >
                                <option value="">-- Selecciona un producto ({filtered.length}) --</option>
                                {filtered.map(p => (
                                  <option key={p.id} value={p.id}>
                                    {p.name} {p.sku ? `(${p.sku})` : ''} — ${p.price?.toLocaleString()} CUP
                                  </option>
                                ))}
                              </select>
                            );
                          })()}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {/* Cantidad */}
                        <div className="space-y-1">
                          <label className="block text-[8px] font-black uppercase text-slate-500 tracking-wider">
                            Cantidad:
                          </label>
                          <input
                            type="number"
                            min="1"
                            value={auditQuantity}
                            onChange={(e) => setAuditQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))}
                            className="w-full px-3 py-1.5 bg-secondary border border-base rounded-xl text-xs font-black font-mono text-primary outline-none"
                          />
                        </div>

                        {/* Precio */}
                        <div className="space-y-1">
                          <label className="block text-[8px] font-black uppercase text-slate-500 tracking-wider">
                            Precio Unitario (CUP):
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={auditPrice}
                            onChange={(e) => setAuditPrice(Math.max(0, parseFloat(e.target.value) || 0))}
                            className="w-full px-3 py-1.5 bg-secondary border border-base rounded-xl text-xs font-black font-mono text-primary outline-none"
                          />
                        </div>

                        {/* Método Pago */}
                        <div className="space-y-1">
                          <label className="block text-[8px] font-black uppercase text-slate-500 tracking-wider">
                            Método Pago:
                          </label>
                          <select
                            value={auditPaymentMethod}
                            onChange={(e) => setAuditPaymentMethod(e.target.value as any)}
                            className="w-full px-3 py-1.5 bg-secondary border border-base rounded-xl text-xs font-bold text-primary outline-none cursor-pointer"
                          >
                            <option value="cash">Efectivo</option>
                            <option value="transfer">Transferencia</option>
                          </select>
                        </div>

                        {/* Moneda */}
                        <div className="space-y-1">
                          <label className="block text-[8px] font-black uppercase text-slate-500 tracking-wider">
                            Moneda:
                          </label>
                          <select
                            value={auditCurrencyCode}
                            onChange={(e) => setAuditCurrencyCode(e.target.value)}
                            className="w-full px-3 py-1.5 bg-secondary border border-base rounded-xl text-xs font-bold text-primary outline-none cursor-pointer"
                          >
                            {currencies.map(c => (
                              <option key={c.code} value={c.code}>{c.code}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                        <button
                          type="button"
                          disabled={isAddingAuditProduct || !auditProductId || auditQuantity <= 0}
                          onClick={async () => {
                            const prod = products.find(p => p.id === auditProductId);
                            if (!prod) {
                              if (addNotification) addNotification('Selecciona un producto válido', 'warning');                              return;
                            }
                            setIsAddingAuditProduct(true);
                            try {
                              const isDeduction = auditActionMode === 'subtract';
                              const res = isDeduction
                                ? await store.subtractInformationalProductFromSession(session.id, {
                                    productId: prod.id,
                                    productName: prod.name,
                                    quantity: auditQuantity,
                                    price: auditPrice,
                                    userId: session.userId,
                                    workerName: session.workerName,
                                    paymentMethod: auditPaymentMethod,
                                    currencyCode: auditCurrencyCode
                                  }, true)
                                : await store.addInformationalSoldProductToSession(session.id, {
                                    productId: prod.id,
                                    productName: prod.name,
                                    quantity: auditQuantity,
                                    price: auditPrice,
                                    userId: session.userId,
                                    workerName: session.workerName,
                                    paymentMethod: auditPaymentMethod,
                                    currencyCode: auditCurrencyCode
                                  }, true, false);

                              if (res.success) {
                                if (addNotification) {
                                  if (isDeduction) {
                                    addNotification(`Producto ${prod.name} (${auditQuantity} uds) restado del turno y SUMADO nuevamente al inventario de almacén.`, 'success');
                                  } else {
                                    addNotification(`Producto ${prod.name} (${auditQuantity} uds) registrado en el turno y descontado de inventario.`, 'success');
                                  }
                                }
                                
                                // Limpiar campos locales
                                setAuditProductId("");
                                setAuditProductSearch("");
                                setAuditQuantity(1);
                                setAuditPrice(0);
                                
                                // Actualizar el estado de la sesión local en el modal
                                setSelectedDiscrepancyDetailSession({
                                  ...session,
                                  movements: session.movements // trigger re-render
                                });
                              } else {
                                if (addNotification) addNotification('No se pudo realizar el ajuste en el informe.', 'error');
                              }
                            } catch (err: any) {
                              if (addNotification) addNotification(err.message || 'Error al procesar ajuste de auditoría', 'error');
                            } finally {
                              setIsAddingAuditProduct(false);
                            }
                          }}
                          className={cn(
                            "px-4 py-2 text-white rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-sm active:scale-95",
                            auditActionMode === 'add' ? "bg-amber-600 hover:bg-amber-700" : "bg-rose-600 hover:bg-rose-700"
                          )}
                        >
                          {isAddingAuditProduct ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>Procesando Auditoría...</span>
                            </>
                          ) : auditActionMode === 'add' ? (
                            <>
                              <Plus className="w-3.5 h-3.5" />
                              <span>Agregar Faltante a Turno (Descontar de Almacén)</span>
                            </>
                          ) : (
                            <>
                              <Minus className="w-3.5 h-3.5" />
                              <span>Restar Producto Duplicado (Devolver y Sumar a Almacén)</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Tickets y Movimientos en este Turno */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[9px]">
                      {/* Tickets del Turno */}
                      <div className="p-3 bg-secondary rounded-2xl border border-base space-y-2">
                        <div className="flex items-center justify-between text-muted font-black uppercase text-[8px] tracking-wider">
                          <span>Ventas del Turno ({sessionTx.length})</span>
                          <span className="text-primary font-black">{formatMoney(totalSalesInSession)}</span>
                        </div>
                        <div className="max-h-36 overflow-y-auto space-y-1 custom-scrollbar">
                          {sessionTx.map(t => (
                            <div key={t.id} className="p-1.5 bg-subtle rounded-lg border border-base flex items-center justify-between text-[8px]">
                              <div>
                                <span className="font-bold text-primary">#{t.id}</span>
                                <span className="text-muted ml-1 font-mono">{new Date(t.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                              </div>
                              <span className="font-black text-rose-600 dark:text-rose-400">{formatMoney(t.total)}</span>
                            </div>
                          ))}
                          {sessionTx.length === 0 && (
                            <p className="text-center py-4 text-muted text-[8px]">Sin ventas en este turno.</p>
                          )}
                        </div>
                      </div>

                      {/* Movimientos del Turno */}
                      <div className="p-3 bg-secondary rounded-2xl border border-base space-y-2">
                        <div className="flex items-center justify-between text-muted font-black uppercase text-[8px] tracking-wider">
                          <span>Movimientos de Caja ({movementsInSession.length})</span>
                          <span className="text-muted text-[7px]">Egresos / Ingresos</span>
                        </div>
                        <div className="max-h-36 overflow-y-auto space-y-1 custom-scrollbar">
                          {movementsInSession.map(m => (
                            <div key={m.id} className="p-1.5 bg-subtle rounded-lg border border-base flex items-center justify-between text-[8px]">
                              <div className="truncate mr-2">
                                <span className={cn("font-black mr-1", m.type === 'income' ? "text-emerald-600" : "text-rose-600")}>
                                  {m.type === 'income' ? '+IN' : '-OUT'}
                                </span>
                                <span className="text-primary font-medium">{m.description}</span>
                              </div>
                              <span className={cn("font-black shrink-0 font-mono", m.type === 'income' ? "text-emerald-600" : "text-rose-600")}>
                                {formatMoney(m.amount, m.currencyCode)}
                              </span>
                            </div>
                          ))}
                          {movementsInSession.length === 0 && (
                            <p className="text-center py-4 text-muted text-[8px]">Sin movimientos de caja registrados.</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="p-3 sm:p-4 bg-subtle border-t border-base shrink-0 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handlePrintDiscrepancyTicket(session)}
                        className="px-3 py-1.5 bg-rose-50 dark:bg-rose-950/60 hover:bg-rose-100 text-rose-700 dark:text-rose-300 rounded-xl text-[9px] font-black uppercase tracking-wider border border-rose-200 dark:border-rose-800 transition-all flex items-center gap-1.5 cursor-pointer shadow-2xs active:scale-95"
                      >
                        <Printer className="w-3.5 h-3.5" />
                        <span>Imprimir Comprobante Descuadre</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePrintShiftTicket(session.id)}
                        className="px-3 py-1.5 bg-secondary hover:bg-subtle text-primary rounded-xl text-[9px] font-black uppercase tracking-wider border border-base transition-all flex items-center gap-1.5 cursor-pointer shadow-2xs active:scale-95"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        <span>Ticket Completo Turno</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => setSelectedDiscrepancyDetailSession(null)}
                      className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-white rounded-xl text-[9px] font-black uppercase tracking-wider transition-all cursor-pointer shadow-sm active:scale-95"
                    >
                      Cerrar
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </>
  );
}
