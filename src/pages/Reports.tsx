import { useReportsExport } from '../modules/reports/hooks/useReportsExport';
import { useShallow } from 'zustand/react/shallow';
import React, { lazy, Suspense, useCallback, useState, useMemo, useRef, useEffect } from "react";
import { 
  TrendingUp, DollarSign, Calendar, Calculator, Package, User, Users, Eye,
  X, ArrowDownRight, ArrowUpRight, ArrowLeftRight, ArrowRight, History, Download, Printer, CheckCircle2, 
  Clock, AlertCircle, AlertTriangle, FileSpreadsheet, ChevronDown, Check, Plus, Search,
  BarChart3, Brain, ListChecks, ShieldAlert, Loader2, Trash2,
  HelpCircle, Edit3, Save, FileText, CheckCircle, Minus
} from "lucide-react";
import { useStore } from "../store/useStore";
import { Transaction, Product, CashRegisterSession, CashMovement } from "../types";

import { ReportsSalesTab } from "../components/reports/ReportsSalesTab";
import { CashMovementTicket } from "../components/cash/CashMovementTicket";
import { ReportsTransactionDetailModal } from "../components/reports/ReportsTransactionDetailModal";
import { buildCashMovementReceiptLines, buildDiscrepancyReceiptLines, buildShiftReceiptLines, buildTransferReceiptLines } from '../modules/reports/utils/reportReceiptLines';
import { getSessionDiscrepancyInfo as getSessionDiscrepancyInfoUtil } from '../modules/reports/utils/getSessionDiscrepancyInfo';
import { buildDetailedMovements, calculatePerfectSessionBalances } from '../modules/reports/utils/reportSessionCalculations';
import { useReportsPrinting } from '../modules/reports/hooks/useReportsPrinting';
import { cn } from "../lib/utils";
import { InfoTooltip } from "../components/InfoTooltip";
import MultiCurrencyTotal from "../components/reports/MultiCurrencyTotal";
import { getLocalDateYMD } from "../utils/dateUtils";
import { useReportsContext } from "../modules/reports/useReportsContext";
import { useReportsPayroll } from "../modules/reports/useReportsPayroll";
import { useReportsSessions } from "../modules/reports/useReportsSessions";
import { useReportsAnalytics } from "../hooks/useReportsAnalytics";
import type { ExcelExportData } from "../utils/excelExport";
import { pullPosBootstrapFromSupabase } from "../services/supabaseSync/pull";
import { getOfflineQueueCount } from "../services/offlineQueue";
import PlanFeatureGate from "../components/PlanFeatureGate";
import { canUsePlanFeature } from "../services/planAccess";
import { loadSaaSContext } from "../services/saas";
import { getActiveTenant } from "../services/tenant";
import { loadCompensationSettings } from "../services/team";
import { printThermalReceipt, format58mmLine } from "../lib/escpos";

const AddItemToShiftModal = lazy(() => import("../components/reports/AddItemToShiftModal"));
const ReportsCharts = lazy(() => import("../components/reports/ReportsCharts"));
const ReportsSelectedTransferModal = lazy(() => import("./ReportsSelectedTransferModal"));
const ReportsDiscrepancyDetailModal = lazy(() => import("./ReportsDiscrepancyDetailModal"));
const ReportsMovementDetailModal = lazy(() => import("./ReportsMovementDetailModal"));
const ReportsPrintableSession = lazy(() => import("./ReportsPrintableSession"));
const ReportsCloseSessionModal = lazy(() => import("./ReportsCloseSessionModal"));

export default function Reports() {
  const [companyCompensation, setCompanyCompensation] = useState<{ mode: 'fixed_product' | 'sales_percent'; percentRate: number }>({ mode: 'fixed_product', percentRate: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tenant = await getActiveTenant();
        if (!tenant?.companyId) return;
        const settings = await loadCompensationSettings(tenant.companyId);
        if (!cancelled) setCompanyCompensation({ mode: settings.mode, percentRate: Math.max(0, Math.min(100, Number(settings.percentRate) || 0)) });
      } catch (error) {
        console.warn('[Reports] No se pudo cargar la compensación global:', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const store = useStore(useShallow((state) => ({
    addInformationalSoldProductToSession: state.addInformationalSoldProductToSession,
    addNotification: state.addNotification,
    syncWithSupabase: state.syncWithSupabase,
    addSalarySettlement: state.addSalarySettlement,
    bankCards: state.bankCards,
    bankTransactions: state.bankTransactions,
    branches: state.branches,
    cashSessions: state.cashSessions,
    categories: state.categories,
    currencies: state.currencies,
    customers: state.customers,
    deleteTransaction: state.deleteTransaction,
    forceCloseSessionFromReports: state.forceCloseSessionFromReports,
    getBaseCurrency: state.getBaseCurrency,
    inventory: state.inventory,
    products: state.products,
    receiptConfig: state.receiptConfig,
    returns: state.returns,
    salarySettlements: state.salarySettlements,
    subtractInformationalProductFromSession: state.subtractInformationalProductFromSession,
    supplierOrders: state.supplierOrders,
    transactions: state.transactions,
    transfers: state.transfers,
    updateCashSession: state.updateCashSession,
    updateCashSessionDateCascade: state.updateCashSessionDateCascade,
    updateSalarySettlement: state.updateSalarySettlement,
    users: state.users,
    warranties: state.warranties,
  })));

  // Keep stable references on local state changes so heavy report analytics do not
  // recompute merely because a modal, filter or input changed.
  const transactions = useMemo(() => (store.transactions || []).filter(t => !t.deletedAt), [store.transactions]);
  const cashSessions = useMemo(() => (store.cashSessions || []).filter(s => !s.deletedAt), [store.cashSessions]);
  const users = store.users || [];
  const branches = store.branches || [];
  const currencies = store.currencies || [];
  const warranties = store.warranties || [];
  const returns = store.returns || [];
  const supplierOrders = store.supplierOrders || [];
  const products = store.products || [];
  const inventory = store.inventory || [];
  const transfers = store.transfers || [];
  const bankTransactions = store.bankTransactions || [];
  const bankCards = store.bankCards || [];
  const customers = store.customers || [];
  const categories = store.categories || [];
  const salarySettlements = store.salarySettlements || [];

  const getBaseCurrency = store.getBaseCurrency;

  const {
    currencyByCode,
    userById,
    productById,
    branchById,
    bankCardById,
    userByName,
    transactionsBySession,
    baseCurrency,
    totalSales,
    allMovements,
    totalCashIncomes,
    totalCashExpenses,
    bankPaymentsReceived,
    bankOtherDeposits,
    bankSupplierPayments,
    bankOtherWithdrawals,
    totalBankDeposits,
    totalBankWithdrawals,
    totalIncomes,
    totalExpenses,
    netFlow,
    txCount,
    formatMoney,
    getProductName,
  } = useReportsContext({
    transactions,
    cashSessions,
    users,
    branches,
    currencies,
    warranties,
    returns,
    supplierOrders,
    products,
    inventory,
    transfers,
    bankTransactions,
    bankCards,
    customers,
    categories,
    salarySettlements,
    getBaseCurrency,
  });

  const addNotification = store.addNotification;
  const addSalarySettlement = store.addSalarySettlement;
  const updateSalarySettlement = store.updateSalarySettlement;
  const updateCashSession = store.updateCashSession;
  const receiptConfig = store.receiptConfig;
  const handleVoidTransaction = async (transaction: import('../types').Transaction) => {
    const confirmed = window.confirm(
      `¿Anular la venta ${transaction.id}? Se repondrá el inventario y la operación quedará registrada como anulada.`,
    );
    if (!confirmed) return;

    const success = await store.deleteTransaction(
      transaction.id,
      'Anulación de venta desde Reportes',
    );

    if (success) {
      setSelectedDirectTxModal(null);
      addNotification('Venta anulada correctamente.', 'success');
    } else {
      addNotification(
        'La anulación no pudo confirmarse ahora. La operación quedó protegida para reintento si corresponde.',
        'warning',
      );
    }
  };


  const [activeTab, setActiveTab] = useState<'sales' | 'payroll' | 'sessions' | 'discrepancies' | 'movements' | 'transfers'>('sales');
  const [salesViewMode, setSalesViewMode] = useState<'by_shift' | 'all_tickets'>('by_shift');
  const [transferFromFilter, setTransferFromFilter] = useState<string>('all');
  const [transferToFilter, setTransferToFilter] = useState<string>('all');
  const [transferSearch, setTransferSearch] = useState<string>('');
  const [selectedTransferModal, setSelectedTransferModal] = useState<import('../types').InventoryTransfer | null>(null);
  const [selectedDirectTxModal, setSelectedDirectTxModal] = useState<import('../types').Transaction | null>(null);
  const [discrepancyTypeFilter, setDiscrepancyTypeFilter] = useState<'all' | 'shortage' | 'overage' | 'deducted' | 'pending'>('all');
  const [movementTypeFilter, setMovementTypeFilter] = useState<'all' | 'expense' | 'income'>('all');
  const [movementCurrencyFilter, setMovementCurrencyFilter] = useState<string>('all');
  const [editingAuditSessionId, setEditingAuditSessionId] = useState<string | null>(null);
  const [editingAuditNotes, setEditingAuditNotes] = useState<string>("");
  const [editingAuditStatus, setEditingAuditStatus] = useState<'pending_review' | 'reviewed' | 'resolved'>('pending_review');
  const [selectedDiscrepancyDetailSession, setSelectedDiscrepancyDetailSession] = useState<CashRegisterSession | null>(null);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<'all' | 'today' | 'yesterday' | 'custom'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed' | 'cancelled'>('all');
  const [selectedWorkerFilter, setSelectedWorkerFilter] = useState<string>('all');
  const [selectedFilterDate, setSelectedFilterDate] = useState<string>('');
  const [selectedBranchFilter, setSelectedBranchFilter] = useState<string>('all');


  const [printSessionId, setPrintSessionId] = useState<string | null>(null);
  const [selectedMovementDetail, setSelectedMovementDetail] = useState<{
    id: string;
    sessionId: string;
    turnLabel: string;
    branchId: string;
    branchName: string;
    workerName: string;
    type: 'income' | 'expense';
    amount: number;
    currencyCode: string;
    description: string;
    date: string;
    session: CashRegisterSession;
  } | null>(null);
  const [editingSessionDateId, setEditingSessionDateId] = useState<string | null>(null);
  const [newSessionDate, setNewSessionDate] = useState<string>("");
  const [isUpdatingSessionDate, setIsUpdatingSessionDate] = useState(false);

  // Estados para Cierre de Turno desde Reportes
  const [sessionToCloseModal, setSessionToCloseModal] = useState<CashRegisterSession | null>(null);
  const [sessionClosingBalances, setSessionClosingBalances] = useState<{ [key: string]: number }>({});
  const [sessionClosingDateInput, setSessionClosingDateInput] = useState<string>(new Date().toISOString().split('T')[0]);
  const [sessionClosingNotesInput, setSessionClosingNotesInput] = useState<string>("");
  const [isClosingShiftFromReports, setIsClosingShiftFromReports] = useState(false);
  const [showChartsOnMobile, setShowChartsOnMobile] = useState(false);
  const [isReportsMobile, setIsReportsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsReportsMobile(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  // Estados para Añadir Producto Vendido al Informe (Sin tocar stock físico)
  const [addItemToShiftModal, setAddItemToShiftModal] = useState<CashRegisterSession | null>(null);
  const [manualItemProductSearch, setManualItemProductSearch] = useState<string>("");
  const [manualItemProductId, setManualItemProductId] = useState<string>("");
  const [manualItemQuantity, setManualItemQuantity] = useState<number>(1);
  const [manualItemPrice, setManualItemPrice] = useState<number>(0);
  const [manualItemWorkerId, setManualItemWorkerId] = useState<string>("");
  const [manualItemPaymentMethod, setManualItemPaymentMethod] = useState<'cash' | 'transfer'>('cash');
  const [manualItemCurrencyCode, setManualItemCurrencyCode] = useState<string>('CUP');
  const [isAddingManualItem, setIsAddingManualItem] = useState(false);

  const handleAddManualItemToShift = useCallback(async (affectStock: boolean) => {
    if (!addItemToShiftModal) return;
    const prod = products.find(p => p.id === manualItemProductId);
    if (!prod) {
      addNotification('Selecciona un producto válido', 'warning');
      return;
    }
    setIsAddingManualItem(true);
    try {
      const worker = users.find(u => u.id === manualItemWorkerId) || users.find(u => u.id === addItemToShiftModal.userId);
      const res = await store.addInformationalSoldProductToSession(addItemToShiftModal.id, {
        productId: prod.id,
        productName: prod.name,
        quantity: manualItemQuantity,
        price: manualItemPrice,
        userId: worker?.id || addItemToShiftModal.userId,
        workerName: worker?.name || addItemToShiftModal.workerName,
        paymentMethod: manualItemPaymentMethod,
        currencyCode: manualItemCurrencyCode
      }, affectStock);

      if (res.success) {
        addNotification(
          affectStock
            ? `Producto ${prod.name} (${manualItemQuantity} uds) añadido al informe y stock descontado.`
            : `Producto ${prod.name} (${manualItemQuantity} uds) añadido al informe (sin afectar stock).`,
          'success'
        );
        setAddItemToShiftModal(null);
      } else {
        addNotification('No se pudo añadir el producto al informe.', 'error');
      }
    } catch (err: any) {
      addNotification(err?.message || 'Error al añadir producto', 'error');
    } finally {
      setIsAddingManualItem(false);
    }
  }, [
    addItemToShiftModal, products, manualItemProductId, manualItemQuantity, manualItemPrice,
    manualItemWorkerId, manualItemPaymentMethod, manualItemCurrencyCode, addNotification, store
  ]);

  // Estados para adición de productos faltantes dentro del modal de auditoría de descuadre (Afectando stock físico)
  const [auditProductSearch, setAuditProductSearch] = useState<string>("");
  const [auditProductId, setAuditProductId] = useState<string>("");
  const [auditQuantity, setAuditQuantity] = useState<number>(1);
  const [auditPrice, setAuditPrice] = useState<number>(0);
  const [auditPaymentMethod, setAuditPaymentMethod] = useState<'cash' | 'transfer'>('cash');
  const [auditCurrencyCode, setAuditCurrencyCode] = useState<string>('CUP');
  const [auditActionMode, setAuditActionMode] = useState<'add' | 'subtract'>('add');
  const [isAddingAuditProduct, setIsAddingAuditProduct] = useState(false);

  const {
    categoryData,
    hourData,
    branchData,
    filteredTransfers,
    transferStats,
    filteredTransactions,
  } = useReportsAnalytics({
    transactions,
    products,
    categories,
    branches,
    users,
    transfers,
    selectedBranchFilter,
    selectedFilterDate,
    sessionFilter,
    selectedWorkerFilter,
    transferFromFilter,
    transferToFilter,
    transferSearch
  });

  const {
    reconciledSessions,
    sessionTurnMap,
    getSessionTurnNumber,
    sortSessionsByTurn,
    closedSessions,
    filteredSessions,
    filteredClosedSessions,
  } = useReportsSessions({
    cashSessions,
    transactions,
    userById,
    userByName,
    statusFilter,
    selectedBranchFilter,
    selectedWorkerFilter,
    selectedFilterDate,
    sessionFilter,
  });

  const filteredCashSessions = filteredSessions;

  const { payrollList, filteredPayrollList, aggregatedPayrollByWorker } = useReportsPayroll({
    closedSessions,
    salarySettlements,
    transactionsBySession,
    userById,
    userByName,
    productById,
    sessionTurnMap,
    selectedBranchFilter,
    selectedFilterDate,
    sessionFilter,
    companyCompensation,
  });

  // Toggle payment status handler
  const handleTogglePayment = (item: typeof payrollList[0]) => {
    const nextStatus: 'pending' | 'paid' = item.status === 'paid' ? 'pending' : 'paid';
    if (item.settlementId) {
      updateSalarySettlement(item.settlementId, { status: nextStatus });
    } else {
      const newSettlement: import("../types").SalarySettlement = {
        id: crypto.randomUUID(),
        sessionId: item.sessionId,
        userId: item.userId || '',
        userName: item.workerName,
        baseSalary: item.baseSalary,
        commissions: item.commissions,
        discrepancyDeduction: Math.max(0, Number((item as any).discrepancyDeduction) || 0),
        total: item.totalSalary,
        date: item.date,
        status: nextStatus
      };
      addSalarySettlement(newSettlement);
    }
  };

  // Helper de discrepancias con dependencias explícitas para mantener Reports desacoplado.
  const getSessionDiscrepancyInfo = (session: typeof cashSessions[0]) =>
    getSessionDiscrepancyInfoUtil(session, {
      currencies,
      salarySettlements,
      baseCurrency,
      transactions,
      products,
    });

  const allDiscrepancySessions = useMemo(() => {
    const list: {
      session: typeof cashSessions[0];      info: NonNullable<ReturnType<typeof getSessionDiscrepancyInfo>>;
    }[] = [];

    cashSessions.forEach(s => {
      const info = getSessionDiscrepancyInfo(s);
      if (info && info.hasDiscrepancy) {
        list.push({ session: s, info });
      }
    });

    return list.sort((a, b) => sortSessionsByTurn(a.session, b.session));
  }, [cashSessions, transactions, baseCurrency, currencies, salarySettlements, products, sortSessionsByTurn]);

  const filteredDiscrepancySessions = useMemo(() => {
    return allDiscrepancySessions.filter(({ session, info }) => {
      if (selectedBranchFilter !== 'all' && session.branchId !== selectedBranchFilter) {
        return false;
      }
      const dateObj = new Date(session.closingDate || session.closedAt || session.openedAt);
      if (selectedFilterDate) {
        if (dateObj.toISOString().split('T')[0] !== selectedFilterDate) return false;
      } else if (sessionFilter === 'today') {
        if (dateObj.toLocaleDateString() !== new Date().toLocaleDateString()) return false;
      }

      if (discrepancyTypeFilter === 'shortage') {
        return info.totalShortageBase > 0;
      }
      if (discrepancyTypeFilter === 'overage') {
        return info.totalOverageBase > 0;
      }
      if (discrepancyTypeFilter === 'deducted') {
        return info.deducted;
      }
      if (discrepancyTypeFilter === 'pending') {
        return info.auditStatus === 'pending_review';
      }
      return true;
    });
  }, [allDiscrepancySessions, selectedBranchFilter, selectedFilterDate, sessionFilter, discrepancyTypeFilter]);

  const allDetailedMovements = useMemo(
    () => buildDetailedMovements(cashSessions, sessionTurnMap, branches, users, sortSessionsByTurn),
    [cashSessions, sessionTurnMap, branches, users, sortSessionsByTurn],
  );

  const filteredDetailedMovements = useMemo(() => {
    return allDetailedMovements.filter(m => {
      if (selectedBranchFilter !== 'all' && m.branchId !== selectedBranchFilter) {
        return false;
      }
      const dateObj = new Date(m.date);
      if (selectedFilterDate) {
        if (dateObj.toISOString().split('T')[0] !== selectedFilterDate) return false;
      } else if (sessionFilter === 'today') {
        if (dateObj.toLocaleDateString() !== new Date().toLocaleDateString()) return false;
      }

      if (movementTypeFilter !== 'all' && m.type !== movementTypeFilter) {
        return false;
      }
      if (movementCurrencyFilter !== 'all' && m.currencyCode !== movementCurrencyFilter) {
        return false;
      }
      return true;
    });
  }, [allDetailedMovements, selectedBranchFilter, selectedFilterDate, sessionFilter, movementTypeFilter, movementCurrencyFilter]);

  const {
    handlePrintShiftTicket,
    handlePrintDiscrepancyTicket,
    handlePrintCashMovementTicket,
    handlePrintTransferTicket,
  } = useReportsPrinting({
    cashSessions,
    branches,
    users,
    transactions,
    products,
    payrollList,
    sessionTurnMap,
    receiptConfig,
    getProductName: product => getProductName(product as any),
    formatMoney,
    getSessionDiscrepancyInfo,
    addNotification,
    setPrintSessionId,
  });

  const [planCode, setPlanCode] = useState<string | null>(null);
  const [showExcelGate, setShowExcelGate] = useState(false);
  useEffect(() => {
    let active = true;
    void loadSaaSContext().then(ctx => { if (active) setPlanCode(ctx?.subscription?.planCode || null); }).catch(() => { if (active) setPlanCode(null); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const hydrateReports = async () => {
      try {
        const { waitForOfflineQueueReady } = await import('../services/offlineQueue');
        await waitForOfflineQueueReady();
        if (!active || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
        // Reports is an authoritative view. Refresh after the outbox is hydrated
        // so remote pulls never erase a locally durable offline sale/session.
        await store.syncWithSupabase();
      } catch (error) {
        if (active) console.warn('[Reports] No se pudo actualizar el informe desde Supabase:', error);
      }
    };
    void hydrateReports();
    return () => { active = false; };
  }, [store.syncWithSupabase]);
  const canExcelExport = canUsePlanFeature(planCode, "excel_exports");

  // State for Excel Export Menu
  const getExportData = (): ExcelExportData => {
    let dateFilterLabel = 'Todo el historial';
    if (selectedFilterDate) dateFilterLabel = `Fecha específica: ${selectedFilterDate}`;
    else if (sessionFilter === 'today') dateFilterLabel = `Hoy: ${new Date().toLocaleDateString('es-CU')}`;
    return { businessName: receiptConfig?.businessName || 'PALMYRA', transactions, cashSessions, salarySettlements, products, categories, currencies, branches, users, customers, bankTransactions, bankCards, inventory, transfers, returns, warranties, baseCurrency, dateFilterLabel };
  };

  const { exportMenuRef, showExportMenu, setShowExportMenu, exportSuccess, handleExportFullExcel, handleExportSectionExcel } = useReportsExport(getExportData);

  // Find printable shift data
  const printSession = cashSessions.find(s => s.id === printSessionId);
  const printPayrollItem = printSession ? payrollList.find(p => p.sessionId === printSession.id) : null;
  const printBranch = printSession ? branches.find(b => b.id === printSession.branchId) : null;

  const handleSaveSessionDate = useCallback(async () => {
    if (!editingSessionDateId || !/^\\d{4}-\\d{2}-\\d{2}$/.test(newSessionDate)) {
      addNotification('Selecciona una fecha válida para el turno.', 'warning');
      return;
    }

    const [year, month, day] = newSessionDate.split('-').map(Number);
    const candidate = new Date(year, month - 1, day);
    if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) {
      addNotification('La fecha seleccionada no es válida.', 'warning');
      return;
    }

    setIsUpdatingSessionDate(true);
    try {
      const updated = await store.updateCashSessionDateCascade(editingSessionDateId, newSessionDate);
      if (!updated) {
        addNotification('No se pudo actualizar la fecha del turno. Comprueba que el turno siga existiendo.', 'error');
        return;
      }
      await flushLocalStateStorage();
      addNotification(
        navigator.onLine
          ? 'Fecha del turno actualizada. La sincronización con el servidor se ha intentado.'
          : 'Fecha actualizada localmente. La sincronización queda pendiente al recuperar conexión.',
        'success'
      );
      setEditingSessionDateId(null);
      setNewSessionDate('');
    } catch (error) {
      addNotification(error instanceof Error ? error.message : 'Error al actualizar la fecha del turno.', 'error');
    } finally {
      setIsUpdatingSessionDate(false);
    }
  }, [editingSessionDateId, newSessionDate, addNotification, store.updateCashSessionDateCascade]);

  return (
    <div className="reportes-page space-y-3 sm:space-y-4 animate-in fade-in duration-300 w-full min-w-0 max-w-[1400px] mx-auto pb-12 overflow-x-hidden">
      {showExcelGate && !canExcelExport && (
        <div className="mb-2">
          <PlanFeatureGate feature="excel_exports" title="Descargas de reportes en Excel" description="Descarga reportes completos y por secciones en formato Microsoft Excel para análisis y control externo. Disponible desde Ciudadela." />
        </div>
      )}

      {/* Header */}
      <header className="flex items-center justify-between gap-3 bg-secondary p-2.5 sm:p-3 rounded-2xl shadow-sm border border-base">
        <div className="px-1 sm:px-2 min-w-0">
          <h2 data-palmi-content="reports" className="text-sm sm:text-base font-black text-primary tracking-tight flex items-center gap-2 uppercase truncate">
            Reportes
            <InfoTooltip text="Panel integral de reportes comerciales, registro de ventas por turno, nómina y liquidación diaria del personal." position="bottom" />
          </h2>
          <p className="text-[8px] font-black text-muted uppercase tracking-[0.2em] mt-0.5 truncate">Control Financiero</p>
        </div>
        
        {/* Excel Export Menu */}
        <div className="relative shrink-0" ref={exportMenuRef}>
            <div className="flex items-center h-9 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm shadow-emerald-200 transition-all">
              <button 
                type="button"
                onClick={() => canExcelExport ? handleExportFullExcel() : setShowExcelGate(true)}
                className="btn-compact !bg-transparent !shadow-none hover:!bg-emerald-700 active:scale-95 text-white"
                title="Exportar todo el reporte completo a Excel (.xlsx) con tablas estructuradas"
              >
                {exportSuccess ? <Check className="w-3.5 h-3.5" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
                <span>{exportSuccess ? '¡Listo!' : 'Excel'}</span>
              </button>
              <button
                type="button"
                onClick={() => canExcelExport ? setShowExportMenu(!showExportMenu) : setShowExcelGate(true)}
                className="px-1.5 py-1.5 border-l border-emerald-500/60 hover:bg-emerald-800 rounded-r-xl transition-colors"
                title="Opciones de exportación por sección"
              >
                <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showExportMenu && "rotate-180")} />
              </button>
            </div>

            {showExportMenu && (
              <div className="absolute right-0 mt-1.5 w-72 bg-secondary rounded-2xl shadow-2xl border border-base p-2 z-50 animate-in zoom-in-95">
                <div className="px-2.5 py-1.5 border-b border-subtle mb-1">
                  <p className="text-[8px] font-black uppercase tracking-widest text-muted">Exportar a Microsoft Excel (.xlsx)</p>
                  <p className="text-[10px] font-bold text-primary">Elige qué deseas exportar:</p>
                </div>

                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={handleExportFullExcel}
                    className="w-full text-left px-2.5 py-2 rounded-xl text-[10px] font-black text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors flex items-center justify-between"
                  >
                    <span className="flex items-center gap-2">
                      <FileSpreadsheet className="w-4 h-4 text-emerald-600 dark:text-emerald-500" />
                      <span>Reporte Completo (8 Hojas Estructuradas)</span>
                    </span>
                    <span className="text-[8px] bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200 font-bold px-1.5 py-0.5 rounded">Multi-Hoja</span>
                  </button>

                  <div className="border-t border-subtle my-1"></div>
                  <p className="px-2.5 pt-1 text-[8px] font-black uppercase tracking-wider text-muted">Exportar Sección Específica:</p>

                  <button
                    type="button"
                    onClick={() => handleExportSectionExcel('sales')}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-[9px] font-bold text-primary hover:bg-subtle transition-colors flex items-center gap-2"
                  >
                    <TrendingUp className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
                    <span>Solo Ventas y Facturas (Totales)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportSectionExcel('sessions')}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-[9px] font-bold text-primary hover:bg-subtle transition-colors flex items-center gap-2"
                  >
                    <History className="w-3.5 h-3.5 text-amber-600" />
                    <span>Solo Cierres de Caja y Arqueos</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportSectionExcel('payroll')}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-[9px] font-bold text-primary hover:bg-subtle transition-colors flex items-center gap-2"
                  >
                    <Calculator className="w-3.5 h-3.5 text-blue-600" />
                    <span>Solo Nómina y Liquidaciones</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportSectionExcel('products')}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-[9px] font-bold text-primary hover:bg-subtle transition-colors flex items-center gap-2"
                  >
                    <Package className="w-3.5 h-3.5 text-teal-600" />
                    <span>Solo Catálogo e Inventario</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportSectionExcel('summary')}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-[9px] font-bold text-primary hover:bg-subtle transition-colors flex items-center gap-2"
                  >
                    <DollarSign className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Solo Resumen Ejecutivo y KPIs</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportSectionExcel('banks')}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-[9px] font-bold text-primary hover:bg-subtle transition-colors flex items-center gap-2"
                  >
                    <ArrowDownRight className="w-3.5 h-3.5 text-purple-600" />
                    <span>Solo Cuentas y Transferencias</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportSectionExcel('returns')}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-[9px] font-bold text-primary hover:bg-subtle transition-colors flex items-center gap-2"
                  >
                    <Clock className="w-3.5 h-3.5 text-rose-600" />
                    <span>Solo Devoluciones y Garantías</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportSectionExcel('discrepancies')}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-[9px] font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors flex items-center gap-2"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
                    <span>Solo Descuadres y Cierres Forzados</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportSectionExcel('movements')}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-[9px] font-bold text-slate-700 dark:text-slate-300 hover:bg-subtle transition-colors flex items-center gap-2"
                  >
                    <ArrowDownRight className="w-3.5 h-3.5 text-slate-700 dark:text-slate-300" />
                    <span>Solo Egresos e Ingresos POS</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportSectionExcel('transfers')}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-[9px] font-bold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors flex items-center gap-2"
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    <span>Solo Transferencias entre Sucursales</span>
                  </button>
                </div>
              </div>
            )}
          </div>
      </header>

      {/* Navigation Tabs - Dedicated full-width horizontal segmented bar */}
      <div className="bg-secondary p-1 rounded-2xl border border-base shadow-xs overflow-x-auto custom-scrollbar scroll-smooth">
        <div className="flex items-center gap-1.5 min-w-max p-0.5">
          {[
            { id: 'sales', label: 'Ventas', icon: TrendingUp },
            { id: 'payroll', label: 'Nómina', icon: Calculator },
            { id: 'sessions', label: 'Cajas', icon: History },
            { 
              id: 'discrepancies', 
              label: 'Descuadres', 
              icon: AlertTriangle, 
              badge: allDiscrepancySessions.length,
              badgeClass: 'bg-rose-600 text-white shadow-xs'
            },
            { 
              id: 'movements', 
              label: 'Movimientos', 
              icon: ArrowDownRight, 
              badge: allDetailedMovements.length,
              badgeClass: 'bg-slate-700 text-white'
            },
            { 
              id: 'transfers', 
              label: 'Transferencias', 
              icon: ArrowLeftRight, 
              badge: filteredTransfers.length,
              badgeClass: 'bg-blue-600 text-white'
            },
          ].map(tab => {
            const Icon = tab.icon;
            return (
              <button 
                key={tab.id} 
                onClick={() => setActiveTab(tab.id as any)} 
                className={cn(
                  "btn-compact h-8 shrink-0 whitespace-nowrap !text-[11px] font-black",
                  activeTab === tab.id 
                    ? "bg-rose-600 text-white shadow-md shadow-rose-600/20" 
                    : "bg-subtle text-secondary hover:text-primary hover:bg-slate-200 dark:hover:bg-slate-800 border-none"
                )}
              >
                <Icon className="w-3 h-3" />
                {tab.label}
                {tab.badge !== undefined && tab.badge > 0 && (
                  <span className={cn(
                    "px-1.5 py-0.2 text-[7px] font-black rounded-full ml-1",
                    activeTab === tab.id ? "bg-white/30 text-white" : (tab.badgeClass || "bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-300")
                  )}>
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Visual Analytics Toggle for Mobile */}
      <div className="md:hidden flex items-center justify-between p-2.5 bg-secondary rounded-2xl border border-base shadow-xs">
        <span className="text-[11px] font-black text-primary uppercase tracking-tight flex items-center gap-1.5">
          <BarChart3 className="w-3.5 h-3.5 text-rose-600" />
          Gráficos y Tendencias
        </span>
        <button
          onClick={() => setShowChartsOnMobile(v => !v)}
          className="px-2.5 py-1 text-[9px] font-black uppercase tracking-wider rounded-lg bg-subtle hover:bg-secondary border border-base text-primary transition-all cursor-pointer"
        >
          {showChartsOnMobile ? 'Ocultar' : 'Ver Gráficos'}
        </button>
      </div>

      {/* Visual Analytics Section */}
      {(showChartsOnMobile || !isReportsMobile) && (
        <Suspense fallback={
          <div className="hidden md:flex items-center justify-center p-5 bg-secondary rounded-[2rem] border border-base text-[10px] font-black text-muted uppercase">
            Cargando gráficos…
          </div>
        }>
          <ReportsCharts
            hourData={hourData}
            categoryData={categoryData}
            formatMoney={formatMoney}
          />
        </Suspense>
      )}
      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-secondary p-3 rounded-2xl shadow-sm border border-base flex items-start gap-3">
          <div className="w-7 h-7 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
            <DollarSign className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[7px] font-black text-muted uppercase tracking-widest truncate">Ingresos Ventas</p>
            <MultiCurrencyTotal amount={totalSales} currencies={currencies} />
          </div>
        </div>

        <div className="bg-secondary p-3 rounded-2xl shadow-sm border border-base flex items-start gap-3">
          <div className="w-7 h-7 rounded-lg bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0">
            <ArrowDownRight className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[7px] font-black text-muted uppercase tracking-widest truncate">Gastos / Egresos</p>
            <MultiCurrencyTotal amount={totalExpenses} currencies={currencies} />
          </div>
        </div>
        
        <div className="bg-secondary p-3 rounded-2xl shadow-sm border border-base flex items-start gap-3">
          <div className="w-7 h-7 rounded-lg bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0">
            <TrendingUp className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[7px] font-black text-muted uppercase tracking-widest truncate">Flujo Neto</p>
            <MultiCurrencyTotal amount={netFlow} currencies={currencies} />
          </div>
        </div>

        <div className="bg-secondary p-3 rounded-2xl shadow-sm border border-base flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-blue-50 dark:bg-blue-950/50 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0">
            <Package className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <p className="text-[7px] font-black text-muted uppercase tracking-widest truncate">Transacciones Totales</p>
            <h3 className="text-base font-black text-primary truncate">{txCount}</h3>
          </div>
        </div>
      </div>

      {/* Currency Breakdown */}
      <div className="bg-secondary p-3 rounded-2xl shadow-sm border border-base">
        <h3 className="text-[8px] font-black text-muted uppercase tracking-[0.3em] mb-3 px-1">Desglose por Divisas</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {currencies.map(c => {
            // Mantener el desglose monetario alineado con Ingresos Ventas:
            // solo ventas completadas, no eliminadas y no ajustes de auditoría.
            const validSalesTransactions = transactions.filter(
              tx =>
                tx.status === 'completed' &&
                !tx.deletedAt &&
                !String(tx.notes || '').startsWith('AJUSTE_')
            );
            const cashTotal = validSalesTransactions.reduce((sum, tx) => {
              const payment = tx.payments.find(p => p.currencyCode === c.code && p.method === 'cash');
              const change = tx.changePayments?.find(cp => cp.currencyCode === c.code && cp.method === 'cash');
              return sum + (payment?.amount || 0) - (change?.amount || 0);
            }, 0);
            const transferTotal = validSalesTransactions.reduce((sum, tx) => {
              const payment = tx.payments.find(p => p.currencyCode === c.code && p.method === 'transfer');
              const change = tx.changePayments?.find(cp => cp.currencyCode === c.code && cp.method === 'transfer');
              return sum + (payment?.amount || 0) - (change?.amount || 0);
            }, 0);

            if (cashTotal === 0 && transferTotal === 0) return null;

            return (
              <div key={c.code} className="p-2 bg-subtle/50 rounded-xl border border-base/50">
                <p className="text-[9px] font-black text-primary mb-1.5 flex items-center justify-between">
                  {c.code}
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800"></span>
                </p>
                <div className="space-y-1">
                  {cashTotal > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-[7px] font-black text-muted uppercase">Cash</span>
                      <span className="text-[9px] font-black text-emerald-600 dark:text-emerald-400 tracking-tighter">{formatMoney(cashTotal, c.code)}</span>
                    </div>
                  )}
                  {transferTotal > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-[7px] font-black text-muted uppercase">Transf</span>
                      <span className="text-[9px] font-black text-blue-600 dark:text-blue-400 tracking-tighter">{formatMoney(transferTotal, c.code)}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Global Filter Toolbar: Sucursales, Vendedor, Estado, Periodo, Fecha */}
      <div className="bg-secondary p-2 rounded-2xl shadow-sm border border-base overflow-x-auto custom-scrollbar">
        <div className="flex flex-nowrap items-center gap-1.5 min-w-max">
          {/* Filtro Sucursal */}
          <div className="flex items-center gap-1 bg-subtle border border-base rounded-lg px-1.5 py-1 shrink-0 whitespace-nowrap">
            <span className="text-[8px] font-black text-muted uppercase tracking-widest">Almacén:</span>
            <select
              value={selectedBranchFilter}
              onChange={(e) => setSelectedBranchFilter(e.target.value)}
              className="bg-transparent text-[8px] leading-none font-black text-primary uppercase outline-none cursor-pointer max-w-[8rem] sm:max-w-[12rem] truncate"
            >
              <option value="all" className="bg-secondary">Todos</option>              {branches.map(b => (
                <option key={b.id} value={b.id} className="bg-secondary">{b.name}</option>
              ))}
            </select>
          </div>

          {/* Filtro Vendedor / Trabajador */}
          <div className="flex items-center gap-1 bg-subtle border border-base rounded-lg px-2 py-1 shrink-0 whitespace-nowrap">
            <span className="text-[8px] font-black text-muted uppercase tracking-widest">Vendedor:</span>
            <select
              value={selectedWorkerFilter}
              onChange={(e) => setSelectedWorkerFilter(e.target.value)}
              className="bg-transparent text-[9px] font-black text-primary uppercase outline-none cursor-pointer max-w-[8rem] truncate"
            >
              <option value="all" className="bg-secondary">Todos</option>
              {(users || []).map(u => (
                <option key={u.id} value={u.id} className="bg-secondary">{u.name}</option>
              ))}
            </select>
          </div>

          {/* Filtro Estado del Turno */}
          <div className="flex items-center gap-1 bg-subtle border border-base rounded-lg p-0.5 shrink-0 whitespace-nowrap">
            <button
              onClick={() => setStatusFilter('all')}
              className={cn(
                "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider transition-all",
                statusFilter === 'all' ? "bg-rose-600 text-white shadow-sm" : "text-secondary hover:text-primary hover:bg-secondary"
              )}
            >
              Todos
            </button>
            <button
              onClick={() => setStatusFilter('open')}
              className={cn(
                "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider transition-all",
                statusFilter === 'open' ? "bg-emerald-600 text-white shadow-sm" : "text-secondary hover:text-primary hover:bg-secondary"
              )}
            >
              Abiertos
            </button>
            <button
              onClick={() => setStatusFilter('closed')}
              className={cn(
                "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider transition-all",
                statusFilter === 'closed' ? "bg-slate-700 text-white shadow-sm" : "text-secondary hover:text-primary hover:bg-secondary"
              )}
            >
              Cerrados
            </button>
            <button
              onClick={() => setStatusFilter('cancelled')}
              className={cn(
                "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider transition-all",
                statusFilter === 'cancelled' ? "bg-rose-600 text-white shadow-sm" : "text-secondary hover:text-primary hover:bg-secondary"
              )}
            >
              Cancelados
            </button>
          </div>

          {/* Filtro Fecha */}
          <div className="flex items-center gap-1 bg-subtle border border-base rounded-lg p-0.5 shrink-0 whitespace-nowrap">
            <button
              onClick={() => { setSessionFilter('all'); setSelectedFilterDate(''); }}
              className={cn(
                "px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all",
                sessionFilter === 'all' && !selectedFilterDate ? "bg-rose-600 text-white shadow-sm" : "text-secondary hover:text-primary hover:bg-secondary"
              )}
            >
              Histórico ({reconciledSessions.length})
            </button>
            <button
              onClick={() => { setSessionFilter('today'); setSelectedFilterDate(''); }}
              className={cn(
                "px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all",
                sessionFilter === 'today' ? "bg-rose-600 text-white shadow-sm" : "text-secondary hover:text-primary hover:bg-secondary"
              )}
            >
              Hoy
            </button>
            <button
              onClick={() => { setSessionFilter('yesterday'); setSelectedFilterDate(''); }}
              className={cn(
                "px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all",
                sessionFilter === 'yesterday' ? "bg-rose-600 text-white shadow-sm" : "text-secondary hover:text-primary hover:bg-secondary"
              )}
            >
              Ayer
            </button>
            <div className="flex items-center gap-1 px-2 py-0.5 border-l border-base">
              <Calendar className="w-3 h-3 text-muted" />
              <input 
                type="date" 
                value={selectedFilterDate}
                onChange={(e) => {
                  setSelectedFilterDate(e.target.value);
                  setSessionFilter('custom');
                }}
                className="bg-transparent text-[10px] font-bold text-primary outline-none"
              />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="flex items-center gap-1.5 text-[8px] font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-widest bg-emerald-50 dark:bg-emerald-950/30 px-2.5 py-1 rounded-full border border-emerald-100 dark:border-emerald-900/30">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
            Sistema Local Protegido
          </span>
        </div>
      </div>

      {activeTab === "sales" && (
        <ReportsSalesTab
          sessions={filteredSessions}
          transactions={filteredTransactions}
          payroll={filteredPayrollList}
          users={users}
          branches={branches}
          sessionTurnMap={sessionTurnMap}
          salesViewMode={salesViewMode}
          setSalesViewMode={setSalesViewMode}
          formatMoney={formatMoney}
          onRequestCloseSession={(session) => {
            setSessionClosingBalances({});
            setSessionClosingDateInput(new Date().toISOString().split("T")[0]);
            setSessionClosingNotesInput("");
            setSessionToCloseModal(session);
          }}
          onOpenSessionDetail={setExpandedSession}
          onPrintShiftTicket={handlePrintShiftTicket}
          onOpenTransactionDetail={setSelectedDirectTxModal}
          onVoidTransaction={handleVoidTransaction}
        />
      )}

      {/* TAB 2: NÓMINA Y LIQUIDACIÓN DIARIA */}
      {activeTab === 'payroll' && (
        <div className="space-y-4">
          {/* Payroll KPI Header */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-secondary p-3 rounded-2xl shadow-sm border border-base">
              <span className="text-[8px] font-black text-muted uppercase tracking-widest block">Total Nómina Liquidada</span>
              <p className="text-base font-black text-rose-600 dark:text-rose-400 mt-0.5">
                {formatMoney(filteredPayrollList.reduce((sum, item) => sum + item.totalSalary, 0))}
              </p>
            </div>
            <div className="bg-secondary p-3 rounded-2xl shadow-sm border border-base">
              <span className="text-[8px] font-black text-muted uppercase tracking-widest block">Total Comisiones</span>
              <p className="text-base font-black text-emerald-600 dark:text-emerald-400 mt-0.5">
                {formatMoney(filteredPayrollList.reduce((sum, item) => sum + item.commissions, 0))}
              </p>
            </div>
            <div className="bg-secondary p-3 rounded-2xl shadow-sm border border-base">
              <span className="text-[8px] font-black text-muted uppercase tracking-widest block">Total Salarios Base</span>
              <p className="text-base font-black text-primary mt-0.5">
                {formatMoney(filteredPayrollList.reduce((sum, item) => sum + item.baseSalary, 0))}
              </p>
            </div>
            <div className="bg-secondary p-3 rounded-2xl shadow-sm border border-base">
              <span className="text-[8px] font-black text-muted uppercase tracking-widest block">Turnos Computados</span>
              <p className="text-base font-black text-primary mt-0.5">
                {filteredPayrollList.length} Turnos
              </p>
            </div>
          </div>

          {/* Liquidación por Turno Cerrado Table */}
          <div className="bg-secondary rounded-2xl shadow-sm border border-base overflow-hidden">
            <div className="p-3.5 border-b border-base flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-rose-50/20 dark:bg-rose-950/20">
              <div>
                <h3 className="text-xs font-black text-primary uppercase tracking-wider flex items-center gap-2">
                  <Calculator className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                  Liquidación Diaria de Salarios por Turno Cerrado
                </h3>
                <p className="text-[8px] font-bold text-muted uppercase tracking-widest mt-0.5">
                  Fecha de salario, turno lineal consecutivo, ventas, comisiones y liquidación exacta
                </p>
              </div>
              <span className="text-[9px] font-black text-rose-600 dark:text-rose-400 uppercase tracking-wider">
                {filteredPayrollList.length} liquidaciones
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-subtle border-b border-base text-[8px] font-black text-muted uppercase tracking-[0.15em]">
                    <th className="px-3 py-2.5">Turno</th>
                    <th className="px-3 py-2.5">Fecha Salario</th>
                    <th className="px-3 py-2.5">Trabajador / Sucursal</th>
                    <th className="px-3 py-2.5 text-right">Ventas Turno</th>
                    <th className="px-3 py-2.5 text-right">Salario Base</th>
                    <th className="px-3 py-2.5 text-right">Comisión Prods</th>
                    <th className="px-3 py-2.5 text-right">Salario Total</th>
                    <th className="px-3 py-2.5 text-center">Estado Pago</th>
                    <th className="px-3 py-2.5 text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base">
                  {filteredPayrollList.map((item, idx) => {
                    const dateObj = new Date(item.date);
                    const branchName = branches.find(b => b.id === item.branchId)?.name || 'Sucursal Principal';
                    return (
                      <tr key={`${item.sessionId || 'pay'}-${item.date || ''}-${idx}`} className="hover:bg-subtle transition-colors">
                        {/* Turno lineal */}
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border border-rose-100 dark:border-rose-900/50 tracking-wider">
                            {item.turnLabel}
                          </span>
                        </td>

                        {/* Fecha del salario y hora lineal */}
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="flex items-center gap-1.5 text-[11px] font-bold text-primary">
                            <span>{dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                            <span className="text-[9px] font-medium text-muted">{dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                        </td>

                        {/* Trabajador y Sucursal lineal */}
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-black text-primary uppercase">{item.workerName}</span>
                            <span className="text-[8px] font-bold text-muted uppercase bg-subtle px-1.5 py-0.5 rounded border border-base">
                              {branchName}
                            </span>
                          </div>
                        </td>

                        {/* Ventas Turno lineal */}
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1 text-[10px]">
                            <span className="font-black text-primary">{formatMoney(item.totalSales)}</span>
                            <span className="text-[8px] font-bold text-muted">({item.totalItems}p)</span>
                          </div>
                        </td>

                        {/* Salario Base */}
                        <td className="px-3 py-2 text-right text-[10px] font-bold text-primary whitespace-nowrap opacity-80">
                          {formatMoney(item.baseSalary)}
                        </td>

                        {/* Comisión Productos */}
                        <td className="px-3 py-2 text-right text-[10px] font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                          +{formatMoney(item.commissions)}
                        </td>

                        {/* Total Salario a Liquidar */}
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <span className="text-xs font-black text-emerald-700 dark:text-emerald-400 tracking-tight bg-emerald-50 dark:bg-emerald-950/50 px-2 py-0.5 rounded-lg border border-emerald-100 dark:border-emerald-900/30">
                            {formatMoney(item.totalSalary)}
                          </span>
                        </td>

                        {/* Estado */}
                        <td className="px-3 py-2 text-center whitespace-nowrap">
                          <button
                            onClick={() => handleTogglePayment(item)}
                            className={cn(
                              "px-2.5 py-0.5 rounded-full text-[8px] font-black uppercase tracking-wider transition-all border",
                              item.status === 'paid'
                                ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 hover:bg-emerald-100 dark:hover:bg-emerald-900/70"
                                : "bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900/50 hover:bg-amber-100 dark:hover:bg-amber-900/70"
                            )}
                          >
                            {item.status === 'paid' ? '✓ Pagado' : '⏳ Pendiente'}
                          </button>
                        </td>

                        {/* Acciones */}
                        <td className="px-3 py-2 text-center whitespace-nowrap">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => setExpandedSession(item.sessionId)}
                              title="Ver Detalle del Turno y Liquidación"
                              className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 text-rose-700 dark:text-rose-300 text-[9px] font-black uppercase rounded-lg border border-rose-200 dark:border-rose-900/50 transition-all active:scale-95 shadow-2xs cursor-pointer"
                            >
                              <Eye className="w-3 h-3 text-rose-600 dark:text-rose-400" />                              <span>Detalle</span>
                            </button>
                            <button
                              onClick={() => handlePrintShiftTicket(item.sessionId)}
                              title="Imprimir Comprobante de Liquidación"
                              className="h-7 w-7 p-0 inline-flex items-center justify-center bg-subtle text-primary rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 transition-all border border-base active:scale-95 cursor-pointer shadow-2xs"
                            >
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {filteredPayrollList.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-6 py-10 text-center text-muted font-bold uppercase text-[10px]">
                        No hay turnos cerrados con nómina calculada para el filtro seleccionado.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Resumen Consolidado por Trabajador */}
          <div className="bg-secondary rounded-2xl shadow-sm border border-base overflow-hidden">
            <div className="p-3.5 border-b border-base bg-subtle/50">
              <h3 className="text-[11px] font-black text-primary uppercase tracking-wider flex items-center gap-2">
                <User className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
                Resumen Acumulado por Trabajador
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-subtle border-b border-base text-[8px] font-black text-muted uppercase tracking-[0.15em]">
                    <th className="px-3 py-2.5">Trabajador</th>
                    <th className="px-3 py-2.5 text-center">Turnos Realizados</th>
                    <th className="px-3 py-2.5 text-right">Ventas Totales</th>
                    <th className="px-3 py-2.5 text-right">Salario Base Acumulado</th>
                    <th className="px-3 py-2.5 text-right">Comisiones Totales</th>
                    <th className="px-3 py-2.5 text-right">Total Ganado</th>
                    <th className="px-3 py-2.5 text-right">Pendiente de Pago</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {aggregatedPayrollByWorker.map((agg, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/60 transition-colors">
                      <td className="px-3 py-2 text-[11px] font-black text-slate-900 uppercase tracking-tight whitespace-nowrap">
                        {agg.workerName}
                      </td>
                      <td className="px-3 py-2 text-center text-[10px] font-black text-slate-700 whitespace-nowrap">
                        {agg.shiftsCount} turnos
                      </td>
                      <td className="px-3 py-2 text-right text-[10px] font-bold text-slate-700 whitespace-nowrap">
                        {formatMoney(agg.totalSales)}
                      </td>
                      <td className="px-3 py-2 text-right text-[10px] font-bold text-slate-700 whitespace-nowrap">
                        {formatMoney(agg.totalBaseSalary)}
                      </td>
                      <td className="px-3 py-2 text-right text-[10px] font-bold text-emerald-600 whitespace-nowrap">
                        +{formatMoney(agg.totalCommissions)}
                      </td>
                      <td className="px-3 py-2 text-right text-xs font-black text-slate-900 whitespace-nowrap">
                        {formatMoney(agg.totalSalary)}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <span className={cn(
                          "text-[11px] font-black",
                          agg.pendingSalary > 0 ? "text-amber-600" : "text-emerald-600"
                        )}>
                          {formatMoney(agg.pendingSalary)}
                        </span>
                      </td>
                    </tr>
                  ))}

                  {aggregatedPayrollByWorker.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-6 py-6 text-center text-slate-400 text-[10px] font-bold uppercase">
                        No hay acumulación registrada de trabajadores.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: HISTORIAL DE CAJAS */}
      {activeTab === 'sessions' && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-3.5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
            <h3 className="text-[10px] font-black text-slate-900 uppercase tracking-widest flex items-center gap-2">
              <Calculator className="w-3.5 h-3.5 text-rose-600" />
              Historial de Aperturas y Cierres de Caja
            </h3>
            <span className="text-[9px] font-black text-slate-500 uppercase tracking-wider">
              {filteredCashSessions.length} registros
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/80 border-b border-slate-100 text-[8px] font-black text-slate-400 uppercase tracking-[0.15em]">
                  <th className="px-3 py-2.5">Turno</th>
                  <th className="px-3 py-2.5">Usuario / Sucursal</th>
                  <th className="px-3 py-2.5">Apertura</th>
                  <th className="px-3 py-2.5">Cierre</th>
                  <th className="px-3 py-2.5">Fondo Inicial</th>
                  <th className="px-3 py-2.5">Estado</th>
                  <th className="px-3 py-2.5 text-center">Detalle / Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredCashSessions.map((session, idx) => (
                  <tr key={`${session.id || 'cash'}-${session.openedAt || ''}-${idx}`} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black bg-rose-50 text-rose-700 border border-rose-100 tracking-wider">
                        {sessionTurnMap.get(session.id) || session.id}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-black text-slate-900 uppercase">
                          {session.workerName || users.find(u => u.id === session.userId)?.name || session.userId}
                        </span>
                        <span className="text-[8px] font-bold text-slate-400 uppercase bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200/50">
                          {branches.find(b => b.id === session.branchId)?.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[10px] font-bold text-slate-600 whitespace-nowrap">
                      {new Date(session.openedAt).toLocaleString('es-CU', { timeZone: 'America/Havana', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-3 py-2 text-[10px] font-bold text-slate-600 whitespace-nowrap">
                      {session.closedAt ? new Date(session.closedAt).toLocaleString('es-CU', { timeZone: 'America/Havana', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}
                    </td>
                    <td className="px-3 py-2 font-black text-slate-900 text-[10px] whitespace-nowrap">
                      {formatMoney(session.openingBalance)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={cn(
                        "px-2 py-0.5 rounded text-[7px] font-black uppercase tracking-widest",
                        session.status === 'open' ? "bg-emerald-50 text-emerald-700 border border-emerald-100" : session.status === 'cancelled' ? "bg-rose-50 text-rose-700 border border-rose-100" : "bg-slate-100 text-slate-600 border border-slate-200/50"
                      )}>
                        {session.status === 'open' ? 'Abierta' : session.status === 'cancelled' ? 'Cancelada' : 'Cerrada'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <div className="flex items-center justify-center gap-1.5">
                        {session.status === 'closed' && (
                          <>
                            <button
                              onClick={() => setExpandedSession(session.id)}
                              title="Ver Detalle Completo del Turno"
                              className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 text-rose-700 dark:text-rose-300 text-[9px] font-black uppercase rounded-lg border border-rose-200 dark:border-rose-900/50 transition-all active:scale-95 shadow-2xs cursor-pointer"
                            >                              <Eye className="w-3 h-3 text-rose-600 dark:text-rose-400" />
                              <span>Detalle</span>
                            </button>
                            <button
                              onClick={() => handlePrintShiftTicket(session.id)}
                              title="Imprimir Ticket de Cierre"
                              className="h-7 w-7 p-0 inline-flex items-center justify-center bg-subtle hover:bg-slate-200 dark:hover:bg-slate-800 text-primary rounded-lg transition-all border border-base active:scale-95 cursor-pointer shadow-2xs"
                            >
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => {
                            setEditingSessionDateId(session.id);
                            setNewSessionDate(getLocalDateYMD(session.openedAt));
                          }}
                          title="Editar Fecha del Turno (Cascada)"
                          className="h-7 w-7 p-0 inline-flex items-center justify-center bg-amber-50 hover:bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:hover:bg-amber-900/60 dark:text-amber-400 rounded-lg transition-all active:scale-95 border border-amber-200 dark:border-amber-800/40 cursor-pointer shadow-2xs"
                        >
                          <Calendar className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredCashSessions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-6 py-8 text-center text-slate-500 text-[10px] font-bold uppercase">
                      No hay registros de caja para el filtro seleccionado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB: AUDITORÍA DE DESCUADRES Y CIERRES FORZADOS */}
      {activeTab === 'discrepancies' && (
        <div className="space-y-4 animate-in fade-in duration-200">
          {/* Top KPI Cards for Discrepancies */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0">
                <AlertTriangle className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Cierres con Descuadre</p>
                <p className="text-base font-black text-rose-600 mt-0.5">{filteredDiscrepancySessions.length}</p>
                <p className="text-[7px] font-bold text-muted uppercase">{filteredDiscrepancySessions.filter(d => d.info.isForcedClose).length} Forzados</p>
              </div>
            </div>

            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0">
                <ArrowDownRight className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Total Faltante (Caja)</p>
                <p className="text-base font-black text-rose-600 mt-0.5">
                  -{formatMoney(filteredDiscrepancySessions.reduce((acc, d) => acc + d.info.totalShortageBase, 0))}
                </p>
                <p className="text-[7px] font-bold text-rose-400 uppercase">Dinero de menos</p>
              </div>
            </div>

            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                <ArrowUpRight className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Total Sobrante (Caja)</p>
                <p className="text-base font-black text-emerald-600 mt-0.5">
                  +{formatMoney(filteredDiscrepancySessions.reduce((acc, d) => acc + d.info.totalOverageBase, 0))}
                </p>
                <p className="text-[7px] font-bold text-emerald-500 uppercase">Dinero de más</p>
              </div>
            </div>

            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-amber-50 dark:bg-amber-950/50 flex items-center justify-center text-amber-600 dark:text-amber-400 shrink-0">
                <Calculator className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Descontado Salarios</p>
                <p className="text-base font-black text-amber-600 mt-0.5">
                  {formatMoney(filteredDiscrepancySessions.reduce((acc, d) => acc + d.info.deductionAmount, 0))}
                </p>
                <p className="text-[7px] font-bold text-amber-500 uppercase">Deducido en liquidación</p>
              </div>
            </div>
          </div>

          {/* Subfilters bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-secondary rounded-2xl border border-base">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-black uppercase text-muted tracking-wider mr-1">Filtrar por:</span>
              {[
                { id: 'all', label: `Todos (${allDiscrepancySessions.length})` },
                { id: 'shortage', label: '⚠️ Solo Faltantes' },
                { id: 'overage', label: '💵 Solo Sobrantes' },
                { id: 'deducted', label: '📉 Con Descuento Salario' },
                { id: 'pending', label: '⏳ Pendientes Auditoría' }
              ].map(f => (
                <button
                  key={f.id}
                  onClick={() => setDiscrepancyTypeFilter(f.id as any)}
                  className={cn(
                    "px-2.5 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider transition-all cursor-pointer",
                    discrepancyTypeFilter === f.id
                      ? "bg-rose-600 text-white shadow-xs"
                      : "bg-subtle text-secondary hover:text-primary"
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="text-[9px] font-bold text-muted">
              Mostrando {filteredDiscrepancySessions.length} cierres con descuadre
            </div>
          </div>

          {/* Discrepancy Sessions Table */}
          <div className="bg-secondary rounded-2xl shadow-xs border border-base overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-subtle border-b border-base text-[8px] font-black text-muted uppercase tracking-[0.15em]">
                    <th className="px-3 py-2.5">Turno / Tipo Cierre</th>
                    <th className="px-3 py-2.5">Cajero / Sucursal</th>
                    <th className="px-3 py-2.5">Fecha y Hora</th>
                    <th className="px-3 py-2.5">Descuadre por Moneda</th>
                    <th className="px-3 py-2.5 text-right">Faltante / Sobrante Total</th>
                    <th className="px-3 py-2.5 text-center">Descuento Salario</th>
                    <th className="px-3 py-2.5 text-center">Estado Auditoría</th>
                    <th className="px-3 py-2.5 text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base text-sm">
                  {filteredDiscrepancySessions.map(({ session, info }) => {
                    const branch = branches.find(b => b.id === session.branchId);
                    const turnLabel = sessionTurnMap.get(session.id) || session.id;
                    const dateObj = new Date(session.closingDate || session.closedAt || session.openedAt);

                    return (
                      <tr key={session.id} className="hover:bg-subtle/50 transition-colors">
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex flex-col gap-1">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border border-rose-100 dark:border-rose-900/50 tracking-wider w-fit">
                              {turnLabel}
                            </span>
                            {info.isForcedClose ? (
                              <span className="inline-flex items-center gap-1 text-[7px] font-black uppercase tracking-wider text-rose-600 bg-rose-50 dark:bg-rose-950/40 px-1.5 py-0.5 rounded border border-rose-200 dark:border-rose-900/40 w-fit">
                                <AlertTriangle className="w-2.5 h-2.5" /> Forzado
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[7px] font-black uppercase tracking-wider text-slate-500 bg-subtle px-1.5 py-0.5 rounded border border-base w-fit">
                                Cuadre con dif.
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-black text-primary uppercase">
                              {session.workerName || users.find(u => u.id === session.userId)?.name || 'Vendedor'}
                            </span>
                            <span className="text-[8px] font-bold text-muted uppercase bg-subtle px-1.5 py-0.5 rounded border border-base">
                              {branch?.name}
                            </span>
                          </div>
                        </td>

                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="text-[10px] font-bold text-primary">
                            {dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                          </div>
                          <div className="text-[8px] font-mono text-muted">
                            {dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </td>

                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1 max-w-xs">
                            {info.details.map((d, i) => (
                              <span
                                key={i}
                                className={cn(
                                  "px-1.5 py-0.5 rounded text-[8px] font-black font-mono border",
                                  d.difference > 0
                                    ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800"
                                    : "bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-800"
                                )}
                              >
                                {d.currencyCode} ({d.method === 'cash' ? 'Ef' : 'Tr'}): {d.difference > 0 ? '+' : ''}{d.difference.toLocaleString('es-CU', { minimumFractionDigits: 2 })}
                              </span>
                            ))}
                          </div>
                        </td>

                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          {info.totalShortageBase > 0 && (
                            <div className="text-xs font-black text-rose-600">
                              -{formatMoney(info.totalShortageBase)}
                            </div>
                          )}
                          {info.totalOverageBase > 0 && (
                            <div className="text-xs font-black text-emerald-600">
                              +{formatMoney(info.totalOverageBase)}
                            </div>
                          )}
                        </td>

                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          {info.deducted ? (
                            <span className="inline-flex items-center gap-1 text-[8px] font-black uppercase text-amber-700 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-full border border-amber-200">
                              <CheckCircle className="w-2.5 h-2.5" /> -{formatMoney(info.deductionAmount)}
                            </span>
                          ) : (
                            <span className="text-[8px] font-bold text-muted uppercase">No descontado</span>
                          )}
                        </td>

                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          <select
                            value={info.auditStatus}
                            onChange={(e) => {
                              const newStatus = e.target.value as any;
                              updateCashSession(session.id, { auditStatus: newStatus });
                              addNotification(`Turno ${turnLabel} marcado como ${newStatus === 'resolved' ? 'Resuelto' : newStatus === 'reviewed' ? 'Auditado' : 'Pendiente'}`, 'info');
                            }}
                            className={cn(
                              "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider border outline-none cursor-pointer",
                              info.auditStatus === 'resolved'
                                ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 border-emerald-200"
                                : info.auditStatus === 'reviewed'
                                ? "bg-blue-50 dark:bg-blue-950/40 text-blue-700 border-blue-200"
                                : "bg-amber-50 dark:bg-amber-950/40 text-amber-700 border-amber-200"
                            )}
                          >
                            <option value="pending_review">⚠️ Pendiente</option>
                            <option value="reviewed">✓ Auditado</option>
                            <option value="resolved">★ Resuelto</option>
                          </select>
                        </td>

                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => {
                                setSelectedDiscrepancyDetailSession(session);
                                setEditingAuditSessionId(session.id);
                                setEditingAuditNotes(session.auditNotes || "");
                                setEditingAuditStatus(info.auditStatus || 'pending_review');
                              }}
                              title="Ver Detalle de Auditoría de Descuadre"
                              className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 text-rose-700 dark:text-rose-300 text-[9px] font-black uppercase rounded-lg border border-rose-200 dark:border-rose-900/50 transition-all active:scale-95 shadow-2xs cursor-pointer"
                            >
                              <Eye className="w-3 h-3 text-rose-600 dark:text-rose-400" />
                              <span>Auditoría</span>
                            </button>
                            <button
                              onClick={() => handlePrintDiscrepancyTicket(session)}
                              title="Imprimir Comprobante de Descuadre (58mm)"
                              className="h-7 w-7 p-0 inline-flex items-center justify-center bg-subtle hover:bg-slate-200 dark:hover:bg-slate-800 text-primary rounded-lg transition-all border border-base active:scale-95 cursor-pointer shadow-2xs"
                            >
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {filteredDiscrepancySessions.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-6 py-12 text-center text-muted text-[10px] font-bold uppercase">
                        No hay cierres con descuadre o forzados registrados para el filtro seleccionado.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB: MOVIMIENTOS DE CAJA (EGRESOS E INGRESOS DEL POS) */}
      {activeTab === 'movements' && (
        <div className="space-y-4 animate-in fade-in duration-200">
          {/* Top KPI Cards for Movements */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0">
                <ArrowDownRight className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Total Egresos (Gastos)</p>
                <p className="text-base font-black text-rose-600 mt-0.5">
                  -{formatMoney(filteredDetailedMovements.filter(m => m.type === 'expense').reduce((acc, m) => acc + (m.amount * (currencies.find(c => c.code === m.currencyCode)?.rateToBase || 1)), 0))}
                </p>
                <p className="text-[7px] font-bold text-rose-400 uppercase">{filteredDetailedMovements.filter(m => m.type === 'expense').length} salidas registradas</p>
              </div>
            </div>

            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                <ArrowUpRight className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Total Ingresos (Entradas)</p>
                <p className="text-base font-black text-emerald-600 mt-0.5">
                  +{formatMoney(filteredDetailedMovements.filter(m => m.type === 'income').reduce((acc, m) => acc + (m.amount * (currencies.find(c => c.code === m.currencyCode)?.rateToBase || 1)), 0))}
                </p>
                <p className="text-[7px] font-bold text-emerald-500 uppercase">{filteredDetailedMovements.filter(m => m.type === 'income').length} entradas registradas</p>
              </div>
            </div>

            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0">
                <ArrowLeftRight className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Flujo Neto en Caja</p>
                {(() => {
                  const inc = filteredDetailedMovements.filter(m => m.type === 'income').reduce((acc, m) => acc + (m.amount * (currencies.find(c => c.code === m.currencyCode)?.rateToBase || 1)), 0);
                  const exp = filteredDetailedMovements.filter(m => m.type === 'expense').reduce((acc, m) => acc + (m.amount * (currencies.find(c => c.code === m.currencyCode)?.rateToBase || 1)), 0);
                  const net = inc - exp;
                  return (
                    <p className={cn("text-base font-black mt-0.5", net >= 0 ? "text-emerald-600" : "text-rose-600")}>
                      {net >= 0 ? '+' : ''}{formatMoney(net)}
                    </p>
                  );
                })()}
                <p className="text-[7px] font-bold text-muted uppercase">Ingresos menos Egresos</p>
              </div>
            </div>

            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-700 dark:text-slate-300 shrink-0">
                <History className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Operaciones Totales</p>
                <p className="text-base font-black text-primary mt-0.5">{filteredDetailedMovements.length}</p>
                <p className="text-[7px] font-bold text-muted uppercase">Comprobantes de caja</p>
              </div>
            </div>
          </div>

          {/* Subfilters bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-secondary rounded-2xl border border-base">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-black uppercase text-muted tracking-wider mr-1">Filtrar por tipo:</span>
              {[
                { id: 'all', label: `Todos (${allDetailedMovements.length})` },
                { id: 'expense', label: '🔻 Solo Egresos (Gastos)' },
                { id: 'income', label: '🔺 Solo Ingresos (Entradas)' }
              ].map(f => (
                <button
                  key={f.id}
                  onClick={() => setMovementTypeFilter(f.id as any)}
                  className={cn(
                    "px-2.5 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider transition-all cursor-pointer",
                    movementTypeFilter === f.id
                      ? "bg-rose-600 text-white shadow-xs"
                      : "bg-subtle text-secondary hover:text-primary"
                  )}
                >
                  {f.label}
                </button>
              ))}

              <div className="w-px h-4 bg-base mx-1 hidden sm:block" />

              <select
                value={movementCurrencyFilter}
                onChange={(e) => setMovementCurrencyFilter(e.target.value)}
                className="px-2.5 py-1 bg-subtle border border-base rounded-lg text-[8px] font-black uppercase text-primary outline-none cursor-pointer"
              >
                <option value="all">Todas las Monedas</option>
                {currencies.map(c => (
                  <option key={c.code} value={c.code}>{c.code}</option>
                ))}
              </select>
            </div>

            <div className="text-[9px] font-bold text-muted">
              Mostrando {filteredDetailedMovements.length} movimientos
            </div>
          </div>

          {/* Movements Table */}
          <div className="bg-secondary rounded-2xl shadow-xs border border-base overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-subtle border-b border-base text-[8px] font-black text-muted uppercase tracking-[0.15em]">
                    <th className="px-3 py-2.5">Fecha y Hora</th>
                    <th className="px-3 py-2.5">Turno</th>
                    <th className="px-3 py-2.5">Cajero / Sucursal</th>
                    <th className="px-3 py-2.5 text-center">Tipo de Movimiento</th>
                    <th className="px-3 py-2.5">Concepto / Descripción</th>
                    <th className="px-3 py-2.5 text-right">Importe Moneda</th>
                    <th className="px-3 py-2.5 text-right">Equivalente CUP</th>
                    <th className="px-3 py-2.5 text-center">Detalle / Vale</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base text-sm">
                  {filteredDetailedMovements.map((m) => {
                    const dateObj = new Date(m.date);
                    const curr = currencies.find(c => c.code === m.currencyCode);
                    const rate = curr?.rateToBase || 1;
                    const cupAmount = m.amount * rate;

                    return (
                      <tr key={m.id} className="hover:bg-subtle/50 transition-colors">
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="text-[10px] font-bold text-primary">
                            {dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                          </div>
                          <div className="text-[8px] font-mono text-muted">
                            {dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </td>

                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border border-rose-100 dark:border-rose-900/50 tracking-wider">
                            {m.turnLabel}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-black text-primary uppercase">
                              {m.workerName}
                            </span>
                            <span className="text-[8px] font-bold text-muted uppercase bg-subtle px-1.5 py-0.5 rounded border border-base">
                              {m.branchName}
                            </span>
                          </div>
                        </td>

                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[8px] font-black uppercase tracking-wider border",
                              m.type === 'income'
                                ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border-emerald-200"
                                : "bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-400 border-rose-200"
                            )}
                          >
                            {m.type === 'income' ? <ArrowUpRight className="w-2.5 h-2.5" /> : <ArrowDownRight className="w-2.5 h-2.5" />}
                            {m.type === 'income' ? 'Ingreso (Entrada)' : 'Egreso (Gasto)'}
                          </span>
                        </td>

                        <td className="px-3 py-2.5">
                          <span className="text-[11px] font-bold text-primary block max-w-sm break-words">
                            {m.description}
                          </span>
                        </td>

                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <span
                            className={cn(
                              "text-xs font-black font-mono",
                              m.type === 'income' ? "text-emerald-600" : "text-rose-600"
                            )}
                          >
                            {m.type === 'income' ? '+' : '-'}{formatMoney(m.amount, m.currencyCode)}
                          </span>
                        </td>

                        <td className="px-3 py-2.5 text-right whitespace-nowrap font-bold text-[10px] text-muted">
                          {formatMoney(cupAmount, baseCurrency.code)}
                        </td>

                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => setSelectedMovementDetail(m)}
                              title="Ver Detalle del Movimiento"
                              className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 text-rose-700 dark:text-rose-300 text-[9px] font-black uppercase rounded-lg border border-rose-200 dark:border-rose-900/50 transition-all active:scale-95 shadow-2xs cursor-pointer"
                            >
                              <Eye className="w-3 h-3 text-rose-600 dark:text-rose-400" />
                              <span>Detalle</span>
                            </button>
                            <button
                              onClick={() => handlePrintCashMovementTicket(m)}
                              title="Imprimir Vale de Movimiento (58mm)"
                              className="h-7 w-7 p-0 inline-flex items-center justify-center bg-subtle hover:bg-slate-200 dark:hover:bg-slate-800 text-primary rounded-lg transition-all border border-base active:scale-95 cursor-pointer shadow-2xs"
                            >
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {filteredDetailedMovements.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-6 py-12 text-center text-muted text-[10px] font-bold uppercase">
                        No hay movimientos de caja registrados para el filtro seleccionado.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB: TRANSFERENCIAS ENTRE SUCURSALES */}
      {activeTab === 'transfers' && (
        <div className="space-y-4 animate-in fade-in duration-200">
          {/* Top KPI Cards for Transfers */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-blue-50 dark:bg-blue-950/50 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0">
                <ArrowLeftRight className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Total Transferencias</p>
                <p className="text-base font-black text-primary mt-0.5">{transferStats.totalCount}</p>
                <p className="text-[7px] font-bold text-muted uppercase">Envíos registrados</p>
              </div>
            </div>

            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0">
                <Package className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Unidades Movidas</p>
                <p className="text-base font-black text-rose-600 dark:text-rose-400 mt-0.5">{transferStats.totalUnits} u.</p>
                <p className="text-[7px] font-bold text-muted uppercase">Artículos transferidos</p>
              </div>
            </div>

            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-amber-50 dark:bg-amber-950/50 flex items-center justify-center text-amber-600 dark:text-amber-400 shrink-0">
                <ArrowUpRight className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Mayor Almacén Origen</p>
                <p className="text-xs font-black text-primary mt-0.5 truncate">{transferStats.topOrigin[0]}</p>
                <p className="text-[7px] font-bold text-amber-600 uppercase">{transferStats.topOrigin[1]} uds despachadas</p>
              </div>
            </div>

            <div className="bg-secondary p-3.5 rounded-2xl shadow-xs border border-base flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                <ArrowDownRight className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-black text-muted uppercase tracking-widest truncate">Mayor Sucursal Destino</p>
                <p className="text-xs font-black text-primary mt-0.5 truncate">{transferStats.topDest[0]}</p>
                <p className="text-[7px] font-bold text-emerald-600 uppercase">{transferStats.topDest[1]} uds recibidas</p>
              </div>
            </div>
          </div>

          {/* Subfilters bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-secondary rounded-2xl border border-base">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Origin Branch Filter */}
              <div className="flex items-center gap-1">
                <span className="text-[8px] font-black uppercase text-muted tracking-wider">Desde:</span>
                <select
                  value={transferFromFilter}
                  onChange={(e) => setTransferFromFilter(e.target.value)}
                  className="px-2 py-1 bg-subtle border border-base rounded-lg text-[8px] font-black uppercase text-primary outline-none cursor-pointer"
                >
                  <option value="all">Todos los Orígenes</option>
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>

              {/* Destination Branch Filter */}
              <div className="flex items-center gap-1">
                <span className="text-[8px] font-black uppercase text-muted tracking-wider">Hacia:</span>
                <select
                  value={transferToFilter}
                  onChange={(e) => setTransferToFilter(e.target.value)}
                  className="px-2 py-1 bg-subtle border border-base rounded-lg text-[8px] font-black uppercase text-primary outline-none cursor-pointer"
                >
                  <option value="all">Todos los Destinos</option>
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}                </select>
              </div>

              {/* Text Search */}
              <div className="relative min-w-[160px]">
                <input
                  type="text"
                  placeholder="Buscar producto..."
                  value={transferSearch}
                  onChange={(e) => setTransferSearch(e.target.value)}
                  className="w-full pl-2.5 pr-2 py-1 bg-subtle border border-base rounded-lg text-[8px] font-bold text-primary placeholder:text-muted outline-none focus:border-rose-500"
                />
              </div>
            </div>

            <div className="text-[9px] font-bold text-muted">
              Mostrando {filteredTransfers.length} transferencias
            </div>
          </div>

          {/* Transfers Table */}
          <div className="bg-secondary rounded-2xl shadow-xs border border-base overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-subtle border-b border-base text-[8px] font-black text-muted uppercase tracking-[0.15em]">
                    <th className="px-3 py-2.5">Fecha y Hora</th>
                    <th className="px-3 py-2.5">Producto & Variante</th>
                    <th className="px-3 py-2.5">Almacén Origen</th>
                    <th className="px-3 py-2.5 text-center"></th>
                    <th className="px-3 py-2.5">Sucursal Destino</th>
                    <th className="px-3 py-2.5 text-center">Cantidad</th>
                    <th className="px-3 py-2.5">Responsable</th>
                    <th className="px-3 py-2.5 text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base text-sm">
                  {filteredTransfers.map((t) => {
                    const dateObj = new Date(t.date);
                    const fromBranch = branches.find(b => b.id === t.fromBranchId);
                    const toBranch = branches.find(b => b.id === t.toBranchId);
                    const worker = users.find(u => u.id === t.userId);
                    const workerName = worker?.name || 'Sistema';

                    return (
                      <tr key={t.id} className="hover:bg-subtle/50 transition-colors">
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="text-[10px] font-bold text-primary">
                            {dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                          </div>
                          <div className="text-[8px] font-mono text-muted">
                            {dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </td>

                        <td className="px-3 py-2.5">
                          <span className="text-[11px] font-black text-primary uppercase block">
                            {t.productName}
                          </span>
                          {t.variantLabel && (
                            <span className="text-[8px] font-bold text-muted uppercase">
                              Variante: {t.variantLabel}
                            </span>
                          )}
                        </td>

                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="text-[9px] font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-900/40 uppercase">
                            {fromBranch?.name || t.fromBranchName || 'Origen'}
                          </span>
                        </td>

                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          <ArrowRight className="w-3.5 h-3.5 text-muted inline-block" />
                        </td>

                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="text-[9px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-900/40 uppercase">
                            {toBranch?.name || t.toBranchName || 'Destino'}
                          </span>
                        </td>

                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border border-rose-100 dark:border-rose-900/50">
                            {t.quantity} uds
                          </span>
                        </td>

                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="text-[10px] font-bold text-muted uppercase">
                            {workerName}
                          </span>
                        </td>

                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          <button
                            onClick={() => setSelectedTransferModal(t)}
                            title="Ver Detalle de Transferencia"
                            className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 text-rose-700 dark:text-rose-300 text-[9px] font-black uppercase rounded-lg border border-rose-200 dark:border-rose-900/50 transition-all mx-auto active:scale-95 shadow-2xs cursor-pointer"
                          >
                            <Eye className="w-3 h-3 text-rose-600 dark:text-rose-400" />
                            <span>Detalle</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}

                  {filteredTransfers.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-6 py-12 text-center text-muted text-[10px] font-bold uppercase">
                        No hay transferencias de inventario registradas para el filtro seleccionado.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <ReportsTransactionDetailModal
        transaction={selectedDirectTxModal}
        products={products}
        users={users}
        branches={branches}
        getProductName={getProductName}
        formatMoney={formatMoney}
        onClose={() => setSelectedDirectTxModal(null)}
        onPrintShiftTicket={handlePrintShiftTicket}
        onVoidTransaction={handleVoidTransaction}
      />

      {/* Modal: Detalle de Transferencia entre Sucursales */}
      {selectedTransferModal && (
        <Suspense fallback={null}>
          <ReportsSelectedTransferModal {...{ branches, selectedTransferModal, setSelectedTransferModal }} />
        </Suspense>
      )}

      {/* Modal: Detalle del Turno Cerrado */}
      {expandedSession && cashSessions.find(s => s.id === expandedSession) && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[90] flex items-center justify-center p-2 sm:p-4 overflow-hidden animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-lg max-h-[94vh] sm:max-h-[90vh] flex flex-col overflow-hidden border border-base">
            {(() => {
              const session = cashSessions.find(s => s.id === expandedSession)!;
              const sessionTx = transactions.filter(t => 
                t.sessionId 
                  ? t.sessionId === session.id
                  : (t.branchId === session.branchId && 
                     new Date(t.date).getTime() >= new Date(session.openedAt).getTime() && 
                     (!session.closedAt || new Date(t.date).getTime() <= new Date(session.closedAt).getTime()))
              );
              const sequentialTurn = sessionTurnMap.get(session.id) || session.id;
              const dateToDisplay = new Date(session.closingDate || session.closedAt || session.openedAt);
              const totalSalesInSession = sessionTx.reduce((sum, tx) => sum + (tx.total || 0), 0);
              const pItem = payrollList.find(p => p.sessionId === session.id);
              const discInfo = getSessionDiscrepancyInfo(session);

              // Group items by product
              const groupedItems: {[key: string]: {name: string, quantity: number, total: number}} = {};
              sessionTx.forEach(tx => {
                (tx.items || []).forEach(item => {
                  const prodObj = typeof item.product === 'object' ? item.product : products.find(p => p.id === (item.product as unknown as string));
                  const prodName = prodObj?.name || getProductName(item.product);
                  if (!groupedItems[prodName]) {
                    groupedItems[prodName] = { name: prodName, quantity: 0, total: 0 };
                  }
                  groupedItems[prodName].quantity += (item.quantity || 0);
                  const price = item.price ?? prodObj?.price ?? 0;
                  groupedItems[prodName].total += (price * (item.quantity || 0));
                });
              });

              return (
                <>
                  <div className="p-4 sm:p-5 border-b border-base flex items-center justify-between bg-rose-50/40 dark:bg-rose-950/30 shrink-0">
                    <div>
                      <div className="text-sm font-black text-primary uppercase tracking-tight">
                        {dateToDisplay.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] font-black text-rose-700 dark:text-rose-300 uppercase bg-white dark:bg-slate-800 px-2 py-0.5 rounded border border-rose-200 dark:border-rose-900">
                          {sequentialTurn}
                        </span>                        <span className="text-[9px] font-bold text-muted uppercase">
                          {session.workerName || users.find(u => u.id === session.userId)?.name || 'Vendedor'}
                        </span>
                      </div>
                    </div>
                    <button 
                      onClick={() => setExpandedSession(null)}
                      className="p-1.5 hover:bg-subtle rounded-full transition-colors text-muted hover:text-primary cursor-pointer"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="p-4 sm:p-5 flex-1 overflow-y-auto space-y-4 custom-scrollbar text-primary">
                    {/* Discrepancy warning banner if applicable */}
                    {discInfo && (
                      <div className="p-3 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                          <div className="min-w-0">
                            <span className="text-[8px] font-black uppercase text-amber-800 dark:text-amber-300 block">
                              {discInfo.isForcedClose ? 'Cierre Forzado' : 'Turno con Descuadre'}
                            </span>
                            <span className="text-[9px] font-bold text-amber-950 dark:text-amber-200 truncate block">
                              {discInfo.totalShortageBase > 0 ? `Faltante: -${formatMoney(discInfo.totalShortageBase)}` : ''}
                              {discInfo.totalOverageBase > 0 ? `Sobrante: +${formatMoney(discInfo.totalOverageBase)}` : ''}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedSession(null);
                            setSelectedDiscrepancyDetailSession(session);
                            setEditingAuditSessionId(session.id);
                            setEditingAuditNotes(session.auditNotes || "");
                            setEditingAuditStatus(discInfo.auditStatus || 'pending_review');
                          }}
                          className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white text-[8px] font-black uppercase rounded-lg transition-all shrink-0 cursor-pointer shadow-2xs"
                        >
                          Ver Auditoría
                        </button>
                      </div>
                    )}

                    <div>
                      <div className="text-[9px] font-black text-muted uppercase tracking-widest mb-2">
                        Ventas por Método de Pago
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {currencies.map(c => {
                          const cash = sessionTx.reduce((sum, tx) => {
                            const payments = (tx.payments || []).filter(pay => pay.currencyCode === c.code && pay.method === 'cash');
                            const changes = tx.changePayments?.filter(chp => chp.currencyCode === c.code && chp.method === 'cash') || [];
                            const paySum = payments.reduce((s, p) => s + p.amount, 0);
                            const changeSum = changes.reduce((s, p) => s + p.amount, 0);
                            return sum + paySum - changeSum;
                          }, 0);
                          const transfer = sessionTx.reduce((sum, tx) => {
                            const payments = (tx.payments || []).filter(pay => pay.currencyCode === c.code && pay.method === 'transfer');
                            const changes = tx.changePayments?.filter(chp => chp.currencyCode === c.code && chp.method === 'transfer') || [];
                            const paySum = payments.reduce((s, p) => s + p.amount, 0);
                            const changeSum = changes.reduce((s, p) => s + p.amount, 0);
                            return sum + paySum - changeSum;
                          }, 0);

                          if (Math.abs(cash) < 0.01 && Math.abs(transfer) < 0.01) return null;

                          return (
                            <div key={c.code} className="p-2 bg-subtle rounded-xl border border-base">
                              <div className="text-[9px] font-black text-primary uppercase border-b border-base/50 pb-1 mb-1">{c.code}</div>
                              {Math.abs(cash) > 0.01 && (
                                <div className="flex justify-between text-[8px] font-bold text-muted">
                                  <span>EFECTIVO:</span>
                                  <span className="text-emerald-600 dark:text-emerald-400 font-mono">{formatMoney(cash, c.code)}</span>
                                </div>
                              )}
                              {Math.abs(transfer) > 0.01 && (
                                <div className="flex justify-between text-[8px] font-bold text-muted">
                                  <span>TRANSF:</span>
                                  <span className="text-blue-600 dark:text-blue-400 font-mono">{formatMoney(transfer, c.code)}</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[9px] font-black text-muted uppercase tracking-widest">
                          Egresos, gastos e ingresos ({(session.movements || []).length})
                        </div>
                        <span className="text-[8px] font-bold text-muted">Comprobantes separados de las ventas</span>
                      </div>
                      {(session.movements || []).length > 0 ? (
                        <div className="space-y-1.5">
                          {[...(session.movements || [])]
                            .sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                            .map((movement) => (
                              <CashMovementTicket
                                key={movement.id}
                                movement={movement}
                                workerName={session.workerName}
                                formatMoney={formatMoney}
                                compact
                              />
                            ))}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed border-base p-3 text-center text-[8px] font-bold text-muted">
                          No hay movimientos de caja registrados en este turno.
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[9px] font-black text-muted uppercase tracking-widest">
                          Productos Vendidos ({Object.keys(groupedItems).length})
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setManualItemProductId("");
                            setManualItemProductSearch("");
                            setManualItemQuantity(1);
                            setManualItemPrice(0);
                            setManualItemWorkerId(session.userId || "");
                            setManualItemPaymentMethod('cash');
                            setManualItemCurrencyCode('CUP');
                            setAddItemToShiftModal(session);
                          }}
                          className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300 rounded-lg text-[8px] font-black uppercase tracking-wider transition-all border border-rose-200 dark:border-rose-900/50 flex items-center gap-1 active:scale-95 cursor-pointer shadow-2xs"
                          title="Permite registrar productos vendidos en este turno sin alterar el stock físico de inventario"
                        >
                          <Plus className="w-3 h-3" />
                          <span>+ Regularizar una venta del turno (Sin afectar stock)</span>
                        </button>
                      </div>
                      <div className="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar">
                        {Object.values(groupedItems).map((item, idx) => (
                          <div key={idx} className="flex items-center justify-between p-2.5 bg-subtle rounded-xl border border-base">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="w-6 h-6 bg-secondary rounded-lg flex items-center justify-center text-[9px] font-black text-rose-600 dark:text-rose-400 border border-base shrink-0">
                                {item.quantity}
                              </div>
                              <span className="text-[9px] font-black text-primary uppercase tracking-tight truncate">{item.name}</span>
                            </div>
                            <span className="text-[10px] font-black text-primary shrink-0 ml-2">{formatMoney(item.total)}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {Object.keys(groupedItems).length === 0 && (
                      <p className="text-center py-6 text-xs font-bold text-muted uppercase">No hay productos vendidos en este turno.</p>
                    )}

                    {pItem && (
                      <div className="mt-4 p-3.5 bg-emerald-50/60 dark:bg-emerald-950/30 rounded-2xl border border-emerald-200 dark:border-emerald-900/40 space-y-1.5">
                        <div className="text-[9px] font-black text-emerald-800 dark:text-emerald-300 uppercase tracking-widest flex items-center justify-between">
                          <span>Liquidación Salarial del Turno</span>
                          <span className={cn(
                            "px-2 py-0.5 rounded text-[8px] font-black",
                            pItem.status === 'paid' ? "bg-emerald-200 dark:bg-emerald-900 text-emerald-900 dark:text-emerald-100" : "bg-amber-100 dark:bg-amber-900 text-amber-900 dark:text-amber-100"
                          )}>
                            {pItem.status === 'paid' ? 'Pagado' : 'Pendiente'}
                          </span>
                        </div>
                        <div className="flex justify-between text-[10px] text-muted">
                          <span>Salario Base:</span>
                          <span className="font-bold text-primary">{formatMoney(pItem.baseSalary)}</span>
                        </div>
                        <div className="flex justify-between text-[10px] text-emerald-700 dark:text-emerald-400">
                          <span>Comisiones Productos:</span>
                          <span className="font-bold">+{formatMoney(pItem.commissions)}</span>
                        </div>
                        <div className="flex justify-between text-xs font-black text-primary border-t border-emerald-200/60 dark:border-emerald-900/60 pt-1">
                          <span>Total Salario:</span>
                          <span className="text-emerald-700 dark:text-emerald-400">{formatMoney(pItem.totalSalary)}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="p-4 sm:p-5 bg-subtle border-t border-base shrink-0 flex items-center justify-between">
                    <div>
                      <span className="text-[8px] font-black text-muted uppercase tracking-widest block">Total Ventas Turno</span>
                      <span className="text-base font-black text-rose-600 dark:text-rose-400">{formatMoney(totalSalesInSession)}</span>
                    </div>
                    <div className="flex items-center gap-2">                      {session.status === 'open' && (
                        <button
                          onClick={() => {
                            setExpandedSession(null);
                            setSessionClosingBalances({});
                            setSessionClosingDateInput(new Date().toISOString().split('T')[0]);
                            setSessionClosingNotesInput("");
                            setSessionToCloseModal(session);
                          }}
                          className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 shadow-sm cursor-pointer active:scale-95"
                        >
                          <CheckCircle className="w-4 h-4" />
                          <span>Cerrar Turno Ahora</span>
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setEditingSessionDateId(session.id);
                          setNewSessionDate(new Date(session.openedAt).toISOString().split('T')[0]);
                        }}
                        className="px-3.5 py-2 bg-amber-50 hover:bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 rounded-xl transition-all border border-amber-200 dark:border-amber-900/60 active:scale-95 cursor-pointer flex items-center gap-1 text-[9px] font-black uppercase tracking-wider"
                        title="Editar Fecha del Turno"
                      >
                        <Calendar className="w-4 h-4" />
                        <span>Editar Fecha</span>
                      </button>
                      <button
                        onClick={() => handlePrintShiftTicket(session.id)}
                        className="px-3.5 py-2 bg-rose-600 text-white rounded-xl text-[9px] font-black uppercase tracking-wider hover:bg-rose-700 transition-all flex items-center gap-1.5 shadow-sm cursor-pointer active:scale-95"
                      >
                        <Printer className="w-4 h-4" />
                        Imprimir Ticket
                      </button>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Modal: Detalle y Auditoría de Descuadre y Cierre Forzado */}
      {selectedDiscrepancyDetailSession && (
        <Suspense fallback={null}>
          <ReportsDiscrepancyDetailModal {...{ addNotification, auditActionMode, auditCurrencyCode, auditPaymentMethod, auditPrice, auditProductId, auditProductSearch, auditQuantity, baseCurrency, branches, currencies, editingAuditNotes, editingAuditStatus, formatMoney, getSessionDiscrepancyInfo, handlePrintDiscrepancyTicket, handlePrintShiftTicket, isAddingAuditProduct, products, selectedDiscrepancyDetailSession, sessionTurnMap, setAuditActionMode, setAuditCurrencyCode, setAuditPaymentMethod, setAuditPrice, setAuditProductId, setAuditProductSearch, setAuditQuantity, setEditingAuditNotes, setEditingAuditStatus, setIsAddingAuditProduct, setSelectedDiscrepancyDetailSession, store, transactions, updateCashSession, users }} />
        </Suspense>
      )}

      {/* Modal: Detalle de Movimiento de Caja (Egreso / Ingreso) */}
      {selectedMovementDetail && (
        <Suspense fallback={null}>
          <ReportsMovementDetailModal {...{ baseCurrency, currencies, formatMoney, handlePrintCashMovementTicket, selectedMovementDetail, setSelectedMovementDetail }} />
        </Suspense>
      )}

      {/* Hidden Thermal Printer Area */}
      {printSession && (
        <Suspense fallback={null}>
          <ReportsPrintableSession {...{ formatMoney, getProductName, printBranch, printPayrollItem, printSession, products, sessionTurnMap, transactions, users }} />
        </Suspense>
      )}

      {/* Modal: Cerrar Turno de Caja desde Reportes */}
      {sessionToCloseModal && (
        <Suspense fallback={null}>
          <ReportsCloseSessionModal {...{ branches, currencies, formatMoney, isClosingShiftFromReports, sessionClosingBalances, sessionClosingDateInput, sessionClosingNotesInput, sessionToCloseModal, sessionTurnMap, setIsClosingShiftFromReports, setSessionClosingBalances, setSessionClosingDateInput, setSessionClosingNotesInput, setSessionToCloseModal, store, transactions }} />
        </Suspense>
      )}

      {/* Modal: Añadir Producto Vendido al Informe (Sin afectar stock físico) */}
      {addItemToShiftModal && (
        <Suspense
          fallback={
            <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-xs z-[100] flex items-center justify-center p-4">
              <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 shadow-2xl text-center text-xs font-bold text-slate-500">
                Cargando corrección de venta…
              </div>
            </div>
          }        >
          <AddItemToShiftModal
            session={addItemToShiftModal}
            sessionLabel={sessionTurnMap.get(addItemToShiftModal.id) || addItemToShiftModal.id}
            branches={branches}
            products={products}
            users={users}
            currencies={currencies}
            formatMoney={formatMoney}
            manualItemProductSearch={manualItemProductSearch}
            manualItemProductId={manualItemProductId}
            manualItemQuantity={manualItemQuantity}
            manualItemPrice={manualItemPrice}
            manualItemWorkerId={manualItemWorkerId}
            manualItemPaymentMethod={manualItemPaymentMethod}
            manualItemCurrencyCode={manualItemCurrencyCode}
            isAddingManualItem={isAddingManualItem}
            onSearchChange={setManualItemProductSearch}
            onProductChange={(pId) => {
              setManualItemProductId(pId);
              const prod = products.find(p => p.id === pId);
              if (prod) setManualItemPrice(prod.price || 0);
            }}
            onQuantityChange={setManualItemQuantity}
            onPriceChange={setManualItemPrice}
            onWorkerChange={setManualItemWorkerId}
            onPaymentMethodChange={setManualItemPaymentMethod}
            onCurrencyChange={setManualItemCurrencyCode}
            onSubmit={handleAddManualItemToShift}
            onCancel={() => setAddItemToShiftModal(null)}
          />
        </Suspense>
      )}
      {/* Modal: Editar fecha del turno */}
      {editingSessionDateId && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-slate-950/60 p-4" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !isUpdatingSessionDate) setEditingSessionDateId(null);
        }}>
          <section className="w-full max-w-md rounded-2xl border border-base bg-secondary p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="edit-session-date-title">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 id="edit-session-date-title" className="text-sm font-black text-primary">Editar fecha del turno</h3>
                <p className="mt-1 text-xs text-muted">Se ajustará la fecha del turno y de los registros relacionados que gestione la actualización en cascada.</p>
              </div>
              <button type="button" onClick={() => setEditingSessionDateId(null)} disabled={isUpdatingSessionDate} className="rounded-lg p-2 text-muted hover:bg-subtle disabled:opacity-50" aria-label="Cerrar">
                <X className="h-4 w-4" />
              </button>
            </div>
            <label htmlFor="reports-session-date" className="mb-1 block text-xs font-bold text-primary">Nueva fecha</label>
            <input
              id="reports-session-date"
              type="date"
              value={newSessionDate}
              onChange={(event) => setNewSessionDate(event.target.value)}
              disabled={isUpdatingSessionDate}
              className="w-full rounded-xl border border-base bg-primary px-3 py-2 text-sm text-primary"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setEditingSessionDateId(null)} disabled={isUpdatingSessionDate} className="rounded-xl border border-base px-4 py-2 text-xs font-bold text-secondary disabled:opacity-50">Cancelar</button>
              <button type="button" onClick={() => void handleSaveSessionDate()} disabled={isUpdatingSessionDate || !newSessionDate} className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-xs font-black text-white disabled:opacity-50">
                {isUpdatingSessionDate ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isUpdatingSessionDate ? 'Guardando…' : 'Guardar fecha'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}