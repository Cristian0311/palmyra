import { useReportsExport } from '../modules/reports/hooks/useReportsExport';
import { useShallow } from 'zustand/react/shallow';
import React, { lazy, Suspense, useCallback, useState, useMemo, useRef, useEffect } from "react";
import { 
  TrendingUp, DollarSign, Calendar, Calculator, Package, User, Users, Eye, EyeOff,
  X, ArrowDownRight, ArrowUpRight, ArrowLeftRight, ArrowRight, History, Download, Printer, CheckCircle2, 
  Clock, AlertCircle, AlertTriangle, FileSpreadsheet, ChevronDown, Check, Search,
  BarChart3, Brain, ListChecks, ShieldAlert, Loader2, Trash2,
  HelpCircle, Edit3, Save, FileText, CheckCircle, ArrowRightLeft
} from "lucide-react";
import { useStore } from "../store/useStore";
import { Transaction, Product, CashRegisterSession, CashMovement } from "../types";

import { ReportsSalesTab } from "../components/reports/ReportsSalesTab";
import { ReportsPayrollTab } from "../components/reports/ReportsPayrollTab";
import { CashMovementTicket } from "../components/cash/CashMovementTicket";
import { ReportsTransactionDetailModal } from "../components/reports/ReportsTransactionDetailModal";
import { buildCashMovementReceiptLines, buildDiscrepancyReceiptLines, buildShiftReceiptLines, buildTransferReceiptLines } from '../modules/reports/utils/reportReceiptLines';
import { getSessionDiscrepancyInfo as getSessionDiscrepancyInfoUtil } from '../modules/reports/utils/getSessionDiscrepancyInfo';
import { buildDetailedMovements, calculatePerfectSessionBalances, getCompletedTransactionsForSession } from '../modules/reports/utils/reportSessionCalculations';
import { useReportsPrinting } from '../modules/reports/hooks/useReportsPrinting';
import { cn } from "../lib/utils";
import { InfoTooltip } from "../components/InfoTooltip";
import MultiCurrencyTotal from "../components/reports/MultiCurrencyTotal";
import { ReportsStatBubbles } from "../components/reports/ReportsStatBubbles";
import { getLocalDateYMD } from "../utils/dateUtils";
import { matchesReportDateFilter } from '../modules/reports/utils/reportDateFilter';
import { findSessionEmployeeUser } from '../services/employeeCompensation';
import { flushLocalStateStorage } from "../services/localStateStorage";
import { useReportsContext } from "../modules/reports/useReportsContext";
import { useReportsPayroll } from "../modules/reports/useReportsPayroll";
import { useReportsSessions } from "../modules/reports/useReportsSessions";
import { useReportsAnalytics } from "../hooks/useReportsAnalytics";
import type { ExcelExportData } from "../utils/excelExport";
import { pullPosBootstrapFromSupabase } from "../services/supabaseSync/pull";
import { useReportVisibility } from "../modules/reports/hooks/useReportVisibility";
import { getOfflineQueueCount } from "../services/offlineQueue";
import PlanFeatureGate from "../components/PlanFeatureGate";
import { canUsePlanFeature } from "../services/planAccess";
import { loadSaaSContext } from "../services/saas";
import { getActiveTenant } from "../services/tenant";
import { loadCompensationSettings } from "../services/team";
import { printThermalReceipt, format58mmLine } from "../lib/escpos";

import { ReportsOverview } from '../components/reports/ReportsOverview';
import { ReportsFilters } from '../components/reports/ReportsFilters';
import { ReportsVoidDialog } from '../components/reports/ReportsVoidDialog';
import { ReportsSessionDetailModal } from '../components/reports/ReportsSessionDetailModal';
import { canVoidSales } from '../store/utils/localVoidTransaction';
const ReportsCharts = lazy(() => import("../components/reports/ReportsCharts"));
const ReportsSelectedTransferModal = lazy(() => import("./ReportsSelectedTransferModal"));
const ReportsDiscrepancyDetailModal = lazy(() => import("./ReportsDiscrepancyDetailModal"));
const ReportsMovementDetailModal = lazy(() => import("./ReportsMovementDetailModal"));
const ReportsPrintableSession = lazy(() => import("./ReportsPrintableSession"));

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
    addNotification: state.addNotification,
    syncWithSupabase: state.syncWithSupabase,
    addSalarySettlement: state.addSalarySettlement,
    bankCards: state.bankCards,
    bankTransactions: state.bankTransactions,
    branches: state.branches,
    cancelSession: state.cancelSession,
    cashSessions: state.cashSessions,
    categories: state.categories,
    currencies: state.currencies,
    currentUser: state.currentUser,
    customers: state.customers,
    deleteTransaction: state.deleteTransaction,
    getBaseCurrency: state.getBaseCurrency,
    inventory: state.inventory,
    products: state.products,
    receiptConfig: state.receiptConfig,
    returns: state.returns,
    salarySettlements: state.salarySettlements,
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
  const handleEditTransactionDate = (transaction: import('../types').Transaction) => {
    const session = transaction.sessionId
      ? cashSessions.find(candidate => candidate.id === transaction.sessionId)
      : undefined;
    if (!session) {
      addNotification('Esta venta no tiene un turno de caja vinculado; no se puede mover su fecha de forma segura desde el detalle.', 'warning');
      return;
    }
    if (!navigator.onLine) {
      addNotification('Conecta el dispositivo a Internet para cambiar la fecha y sincronizar el turno y sus ventas relacionadas.', 'warning');
      return;
    }
    setSelectedDirectTxModal(null);
    setEditingSessionDateId(session.id);
    setNewSessionDate(getLocalDateYMD(session.openedAt));
  };

  const handleHideTransactionFromDetail = async (transaction: import('../types').Transaction) => {
    await hideTransactionReport(transaction);
    setSelectedDirectTxModal(null);
  };

  const openSessionDetail = (sessionId: string, origin: 'sales' | 'payroll' | 'sessions') => {
    setSessionDetailOrigin(origin);
    setExpandedSession(sessionId);
  };

  const handleVoidTransaction = (transaction: import('../types').Transaction) => {
    if (!canVoidSales(store.currentUser, transaction.branchId)) {
      addNotification('No tienes permiso para anular ventas en este almacén.', 'warning');
      return;
    }
    setVoidTarget(transaction);
  };

  const confirmVoidTransaction = async (reason: string) => {
    if (!voidTarget || isVoiding) return;
    setIsVoiding(true);
    try {
      const success = await store.deleteTransaction(voidTarget.id, reason);
      if (success) {
        setVoidTarget(null);
        setSelectedDirectTxModal(null);
        addNotification('Venta eliminada. Los productos volvieron a su almacén y los saldos quedaron actualizados.', 'success');
      } else {
        addNotification(
          'La anulación no pudo confirmarse ahora. La operación quedó protegida para reintento si corresponde.',
          'warning',
        );
      }
    } finally {
      setIsVoiding(false);
    }
  };


  const [activeTab, setActiveTab] = useState<'overview' | 'sales' | 'payroll' | 'sessions' | 'discrepancies' | 'movements' | 'transfers'>('overview');
  const [salesViewMode, setSalesViewMode] = useState<'by_shift' | 'all_tickets'>('by_shift');
  // Reports visibility lives in modules/reports/hooks/useReportVisibility:
  // Supabase (sales.metadata.report_visibility) is the source of truth and the
  // local list only mirrors the last known state for offline use.
  const { hiddenReportIds, hideTransactionReport, restoreTransactionReport, setSessionReportVisibility } = useReportVisibility(transactions, addNotification);
  const [transferFromFilter, setTransferFromFilter] = useState<string>('all');
  const [transferToFilter, setTransferToFilter] = useState<string>('all');
  const [transferSearch, setTransferSearch] = useState<string>('');
  const [selectedTransferModal, setSelectedTransferModal] = useState<import('../types').InventoryTransfer | null>(null);
  const [selectedDirectTxModal, setSelectedDirectTxModal] = useState<import('../types').Transaction | null>(null);
  const [voidTarget, setVoidTarget] = useState<import('../types').Transaction | null>(null);
  const [isVoiding, setIsVoiding] = useState(false);
  const [shiftVoidTarget, setShiftVoidTarget] = useState<CashRegisterSession | null>(null);
  const [shiftVoidReason, setShiftVoidReason] = useState('');
  const [isVoidingShift, setIsVoidingShift] = useState(false);
  const [isTogglingShiftVisibility, setIsTogglingShiftVisibility] = useState(false);
  const [discrepancyTypeFilter, setDiscrepancyTypeFilter] = useState<'all' | 'shortage' | 'overage' | 'deducted' | 'pending'>('all');
  const [movementTypeFilter, setMovementTypeFilter] = useState<'all' | 'expense' | 'income'>('all');
  const [movementCurrencyFilter, setMovementCurrencyFilter] = useState<string>('all');
  const [selectedDiscrepancyDetailSession, setSelectedDiscrepancyDetailSession] = useState<CashRegisterSession | null>(null);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionDetailOrigin, setSessionDetailOrigin] = useState<'sales' | 'payroll' | 'sessions'>('sales');
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

  const {
    categoryData,
    hourData,
    filteredTransfers,
    transferStats,
    filteredTransactions,
    salesSummary,
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
    sessionTurnMap,
    sortSessionsByTurn,
    closedSessions,
    filteredSessions,
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
    transactions,
    userById,
    userByName,
    productById,
    sessionTurnMap,
    selectedBranchFilter,
    selectedWorkerFilter,
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

  // Correct a mis-recorded cash movement and recompute the shift discrepancy.
  const handleSaveMovementCorrection = (
    movementId: string,
    patch: { type: 'income' | 'expense'; amount: number; currencyCode: string; description: string },
  ): boolean => {
    const session = selectedMovementDetail
      ? cashSessions.find(s => s.id === selectedMovementDetail.sessionId)
      : undefined;
    if (!session) {
      addNotification('No se encontró el turno del movimiento.', 'error');
      return false;
    }
    const previous = (session.movements || []).find(m => m.id === movementId);
    if (!previous) {
      addNotification('El movimiento ya no existe en el turno.', 'error');
      return false;
    }
    const movements = (session.movements || []).map(m => m.id === movementId ? { ...m, ...patch } : m);
    const entry = `[Corrección ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${store.currentUser?.name || 'Administrador'}] ${previous.type === 'income' ? 'Ingreso' : 'Egreso'} #${movementId.slice(0, 8)} corregido de ${formatMoney(previous.amount, previous.currencyCode)} a ${formatMoney(patch.amount, patch.currencyCode)}. Concepto: ${patch.description}`;
    const updates: Partial<CashRegisterSession> = {
      movements,
      auditNotes: [session.auditNotes, entry].filter(Boolean).join('\n'),
    };
    if (session.status === 'closed') {
      const recomputed = getSessionDiscrepancyInfo({
        ...session,
        movements,
        discrepancyDetails: [],
        hasDiscrepancy: false,
        isForcedClose: false,
        auditStatus: 'pending_review',
        auditNotes: '',
      });
      updates.discrepancyDetails = recomputed?.details || [];
      updates.hasDiscrepancy = Boolean(recomputed?.details?.length);
      updates.auditStatus = 'reviewed';
    }
    updateCashSession(session.id, updates);
    addNotification('Movimiento corregido. El descuadre del turno se recalculó con el nuevo importe.', 'success');
    return true;
  };

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
      if (selectedWorkerFilter !== 'all') {
        const workers = new Set(
          [session.userId, session.employeeId || '', ...(session.workingEmployeeIds || [])].filter(Boolean),
        );
        if (!workers.has(selectedWorkerFilter)) return false;
      }
      if (!matchesReportDateFilter(
        session.closingDate || session.closedAt || session.openedAt,
        selectedFilterDate,
        sessionFilter,
      )) return false;

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
  }, [allDiscrepancySessions, selectedBranchFilter, selectedWorkerFilter, selectedFilterDate, sessionFilter, discrepancyTypeFilter]);

  const allDetailedMovements = useMemo(
    () => buildDetailedMovements(cashSessions, sessionTurnMap, branches, users, sortSessionsByTurn),
    [cashSessions, sessionTurnMap, branches, users, sortSessionsByTurn],
  );

  const filteredDetailedMovements = useMemo(() => {
    const worker = selectedWorkerFilter !== 'all' ? userById.get(selectedWorkerFilter) : undefined;
    return allDetailedMovements.filter(m => {
      if (selectedBranchFilter !== 'all' && m.branchId !== selectedBranchFilter) {
        return false;
      }
      if (worker && m.workerName !== worker.name) {
        return false;
      }
      if (!matchesReportDateFilter(m.date, selectedFilterDate, sessionFilter)) return false;

      if (movementTypeFilter !== 'all' && m.type !== movementTypeFilter) {
        return false;
      }
      if (movementCurrencyFilter !== 'all' && m.currencyCode !== movementCurrencyFilter) {
        return false;
      }
      return true;
    });
  }, [allDetailedMovements, selectedBranchFilter, selectedWorkerFilter, userById, selectedFilterDate, sessionFilter, movementTypeFilter, movementCurrencyFilter]);

  const discrepancyTotals = useMemo(
    () => filteredDiscrepancySessions.reduce(
      (acc, { info }) => ({
        shortage: acc.shortage + info.totalShortageBase,
        overage: acc.overage + info.totalOverageBase,
        forced: acc.forced + (info.isForcedClose ? 1 : 0),
        pending: acc.pending + (info.auditStatus === 'pending_review' ? 1 : 0),
      }),
      { shortage: 0, overage: 0, forced: 0, pending: 0 },
    ),
    [filteredDiscrepancySessions],
  );

  const movementTotals = useMemo(() => {
    const rateByCode = new Map<string, number>(currencies.map(c => [c.code, Number(c.rateToBase) || 1]));
    let income = 0;
    let expense = 0;
    let incomeCount = 0;
    let expenseCount = 0;
    for (const movement of filteredDetailedMovements) {
      const amount = movement.amount * (rateByCode.get(movement.currencyCode) || 1);
      if (movement.type === 'income') {
        income += amount;
        incomeCount += 1;
      } else {
        expense += amount;
        expenseCount += 1;
      }
    }
    return { income, expense, net: income - expense, incomeCount, expenseCount };
  }, [filteredDetailedMovements, currencies]);

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
  useEffect(() => {
    if (canExcelExport) setShowExcelGate(false);
  }, [canExcelExport]);

  // State for Excel Export Menu
  const getExportData = (): ExcelExportData => {
    let dateFilterLabel = 'Todo el historial';
    if (selectedFilterDate) dateFilterLabel = `Fecha específica: ${selectedFilterDate}`;
    else if (sessionFilter === 'today') dateFilterLabel = `Hoy: ${new Date().toLocaleDateString('es-CU')}`;
    else if (sessionFilter === 'yesterday') { const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); dateFilterLabel = `Ayer: ${yesterday.toLocaleDateString('es-CU')}`; }
    const visibleTransactions = filteredTransactions.filter(tx => !hiddenReportIds.includes(tx.id));
    const visibleIds = new Set(visibleTransactions.map(tx => tx.id));
    return { businessName: receiptConfig?.businessName || 'PALMYRA', transactions: visibleTransactions, cashSessions: filteredCashSessions, salarySettlements, products, categories, currencies, branches, users, customers, bankTransactions, bankCards, inventory, transfers, returns: returns.filter(r => visibleIds.has(r.transactionId)), warranties: warranties.filter(w => visibleIds.has(w.transactionId)), baseCurrency, dateFilterLabel };
  };

  const { exportMenuRef, showExportMenu, setShowExportMenu, exportSuccess, handleExportFullExcel, handleExportSectionExcel } = useReportsExport(getExportData);

  // Find printable shift data
  const printSession = cashSessions.find(s => s.id === printSessionId);
  const printPayrollItem = printSession ? payrollList.find(p => p.sessionId === printSession.id) : null;
  const printBranch = printSession ? branches.find(b => b.id === printSession.branchId) : null;
  const expandedSessionRecord = expandedSession
    ? cashSessions.find(s => s.id === expandedSession) || null
    : null;

  const expandedSessionTickets = useMemo(
    () => (expandedSessionRecord ? getCompletedTransactionsForSession(expandedSessionRecord, transactions) : []),
    [expandedSessionRecord, transactions],
  );
  const expandedSessionHidden = expandedSessionTickets.length > 0 &&
    expandedSessionTickets.every(tx => hiddenReportIds.includes(tx.id));
  const shiftActionsAvailable = sessionDetailOrigin !== 'payroll';

  const handleSaveSessionDate = useCallback(async () => {
    if (!editingSessionDateId || !/^\d{4}-\d{2}-\d{2}$/.test(newSessionDate)) {
      addNotification('Selecciona una fecha válida para el turno.', 'warning');
      return;
    }

    const [year, month, day] = newSessionDate.split('-').map(Number);
    const candidate = new Date(year, month - 1, day);
    if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) {
      addNotification('La fecha seleccionada no es válida.', 'warning');
      return;
    }

    // La actualización en cascada todavía no dispone de una operación durable
    // de cola para sincronizar todos los registros relacionados sin conexión.
    // Bloquear el guardado offline evita aparentar una sincronización que no existe.
    if (!navigator.onLine) {
      addNotification('Para cambiar la fecha del turno y sincronizar sus ventas relacionadas, conecta el dispositivo a Internet antes de guardar.', 'warning');
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
      addNotification('Fecha del turno actualizada.', 'success');
      setEditingSessionDateId(null);
      setNewSessionDate('');
    } catch (error) {
      addNotification(error instanceof Error ? error.message : 'Error al actualizar la fecha del turno.', 'error');
    } finally {
      setIsUpdatingSessionDate(false);
    }
  }, [editingSessionDateId, newSessionDate, addNotification, store.updateCashSessionDateCascade]);

  const handleToggleSessionVisibility = async () => {
    if (!expandedSessionRecord || isTogglingShiftVisibility) return;
    setIsTogglingShiftVisibility(true);
    try {
      await setSessionReportVisibility(expandedSessionTickets, !expandedSessionHidden);
    } finally {
      setIsTogglingShiftVisibility(false);
    }
  };

  const handleRequestVoidShift = () => {
    if (!expandedSessionRecord) return;
    if (!canVoidSales(store.currentUser, expandedSessionRecord.branchId)) {
      addNotification('No tienes permiso para eliminar turnos en este almacén.', 'warning');
      return;
    }
    setShiftVoidReason('');
    setShiftVoidTarget(expandedSessionRecord);
  };

  const confirmVoidShift = async () => {
    if (!shiftVoidTarget || isVoidingShift) return;
    if (shiftVoidReason.trim().length < 3) {
      addNotification('Escribe un motivo de al menos 3 caracteres para eliminar el turno.', 'warning');
      return;
    }
    setIsVoidingShift(true);
    try {
      const ok = await store.cancelSession(shiftVoidTarget.id, shiftVoidReason.trim());
      if (ok) {
        setShiftVoidTarget(null);
        setShiftVoidReason('');
        setExpandedSession(current => (current === shiftVoidTarget.id ? null : current));
      }
    } finally {
      setIsVoidingShift(false);
    }
  };

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
                <div className="px-2.5 py-1.5 border-b border-subtle mb-1.5">
                  <p className="text-[9px] font-black uppercase tracking-widest text-muted">Exportar a Excel (.xlsx)</p>
                  <p className="text-[10px] font-bold text-primary">Elige el alcance de la descarga</p>
                </div>

                <button
                  type="button"
                  onClick={handleExportFullExcel}
                  className="w-full text-left px-2.5 py-2 rounded-xl text-[10px] font-black text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 transition-colors flex items-center justify-between mb-1.5"
                >
                  <span className="flex items-center gap-2">
                    <FileSpreadsheet className="w-4 h-4 text-emerald-600 dark:text-emerald-500" />
                    <span>Reporte completo (8 hojas)</span>
                  </span>
                  <span className="text-[8px] bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200 font-bold px-1.5 py-0.5 rounded">Todo</span>
                </button>

                <p className="px-1 pb-1 text-[8px] font-black uppercase tracking-wider text-muted">Solo una sección</p>
                <div className="grid grid-cols-2 gap-1">
                  {[
                    { key: 'sales', label: 'Ventas', icon: TrendingUp, tone: 'text-violet-600' },
                    { key: 'sessions', label: 'Cajas', icon: History, tone: 'text-amber-600' },
                    { key: 'payroll', label: 'Nómina', icon: Calculator, tone: 'text-blue-600' },
                    { key: 'products', label: 'Inventario', icon: Package, tone: 'text-teal-600' },
                    { key: 'summary', label: 'Resumen', icon: DollarSign, tone: 'text-emerald-600' },
                    { key: 'banks', label: 'Cuentas', icon: ArrowDownRight, tone: 'text-purple-600' },
                    { key: 'returns', label: 'Devoluciones', icon: Clock, tone: 'text-red-600' },
                    { key: 'discrepancies', label: 'Descuadres', icon: AlertTriangle, tone: 'text-red-600' },
                    { key: 'movements', label: 'Movimientos', icon: ArrowDownRight, tone: 'text-slate-700 dark:text-slate-300' },
                    { key: 'transfers', label: 'Traslados', icon: ArrowLeftRight, tone: 'text-blue-600' },
                  ].map(({ key, label, icon: Icon, tone }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleExportSectionExcel(key as Parameters<typeof handleExportSectionExcel>[0])}
                      className="w-full text-left px-2 py-1.5 rounded-lg text-[9px] font-bold text-primary hover:bg-subtle transition-colors flex items-center gap-1.5"
                    >
                      <Icon className={cn("w-3.5 h-3.5 shrink-0", tone)} />
                      <span className="truncate">{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
      </header>

      {/* Navigation Tabs - Dedicated full-width horizontal segmented bar */}
      <div className="rounded-2xl border border-base bg-secondary p-1 shadow-xs sm:overflow-x-auto sm:scroll-smooth sm:custom-scrollbar">
        <div className="grid grid-cols-3 gap-1.5 p-0.5 sm:flex sm:min-w-max sm:items-center">
          {[
            { id: 'overview', label: 'Resumen', icon: BarChart3 },
            { id: 'sales', label: 'Ventas', icon: TrendingUp },
            { id: 'payroll', label: 'Nómina', icon: Calculator },
            { id: 'sessions', label: 'Cajas', icon: History },
            { 
              id: 'discrepancies', 
              label: 'Descuadres', 
              icon: AlertTriangle, 
              badge: allDiscrepancySessions.length,
              badgeClass: 'bg-red-600 text-white shadow-xs'
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
                  "btn-compact h-8 w-full min-w-0 !text-[11px] font-black sm:w-auto sm:shrink-0 sm:whitespace-nowrap",
                  activeTab === tab.id 
                    ? "bg-[#6535C5] text-white shadow-md shadow-[#6535C5]/25" 
                    : "bg-subtle text-secondary hover:text-primary hover:bg-slate-200 dark:hover:bg-slate-800 border-none"
                )}
              >
                <Icon className="w-3 h-3" />
                {tab.label}
                {tab.badge !== undefined && tab.badge > 0 && (
                  <span className={cn(
                    "px-1.5 py-0.2 text-[7px] font-black rounded-full ml-1",
                    activeTab === tab.id ? "bg-white/30 text-white" : (tab.badgeClass || "bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300")
                  )}>
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <ReportsFilters
        branches={branches} users={users}
        branch={selectedBranchFilter} onBranch={setSelectedBranchFilter}
        worker={selectedWorkerFilter} onWorker={setSelectedWorkerFilter}
        period={sessionFilter} onPeriod={setSessionFilter}
        date={selectedFilterDate} onDate={setSelectedFilterDate}
        status={statusFilter} onStatus={setStatusFilter}
        showStatus={activeTab === 'sessions' || (activeTab === 'sales' && salesViewMode === 'by_shift')}
      />
      {activeTab === 'overview' && (
        <ReportsOverview
          summary={salesSummary}
          formatMoney={formatMoney}
          charts={(
            <Suspense fallback={null}>
              <ReportsCharts hourData={hourData} categoryData={categoryData} formatMoney={formatMoney} />
            </Suspense>
          )}
          onOpenSales={() => { setSalesViewMode('all_tickets'); setActiveTab('sales'); }}
          onOpenTransaction={setSelectedDirectTxModal}
        />
      )}

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
          onOpenSessionDetail={sessionId => openSessionDetail(sessionId, 'sales')}
          onPrintShiftTicket={handlePrintShiftTicket}
          onOpenTransactionDetail={setSelectedDirectTxModal}
          onVoidTransaction={handleVoidTransaction}
          hiddenReportIds={hiddenReportIds}
          onHideTransactionReport={hideTransactionReport}
          onRestoreTransactionReport={restoreTransactionReport}
        />
      )}

      {/* TAB 2: NÓMINA Y LIQUIDACIÓN DIARIA */}
      {activeTab === 'payroll' && (
        <ReportsPayrollTab
          payroll={filteredPayrollList}
          aggregatedByWorker={aggregatedPayrollByWorker}
          branches={branches}
          formatMoney={formatMoney}
          onTogglePayment={handleTogglePayment}
          onOpenSession={sessionId => openSessionDetail(sessionId, 'payroll')}
          onPrintShiftTicket={handlePrintShiftTicket}
        />
      )}

      {/* TAB 3: HISTORIAL DE CAJAS */}
      {activeTab === 'sessions' && (
        <div className="space-y-3 animate-in fade-in duration-200">
          <ReportsStatBubbles
            items={[
              { label: 'Turnos visibles', value: String(filteredCashSessions.length), hint: 'Según los filtros actuales', icon: History, tone: 'violet' },
              { label: 'Turnos abiertos', value: String(filteredCashSessions.filter(s => s.status === 'open').length), hint: 'En operación ahora', icon: Clock, tone: 'emerald' },
              { label: 'Turnos cerrados', value: String(filteredCashSessions.filter(s => s.status === 'closed').length), hint: 'Listos para revisión', icon: CheckCircle2, tone: 'blue' },
              { label: 'Con diferencia', value: String(filteredCashSessions.filter(s => getSessionDiscrepancyInfo(s)?.hasDiscrepancy).length), hint: 'Requieren auditoría', icon: AlertTriangle, tone: 'amber' },
            ]}
          />

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filteredCashSessions.map(session => {
              const branch = branches.find(b => b.id === session.branchId);
              const worker = findSessionEmployeeUser(session, users)?.name || session.workerName || 'Cajero';
              const initials = (worker.match(/\b\w/g) || []).slice(0, 2).join('').toUpperCase() || 'CA';
              const info = getSessionDiscrepancyInfo(session);
              const hasShortage = (info?.totalShortageBase || 0) > 0.01;
              const hasOverage = (info?.totalOverageBase || 0) > 0.01;
              return (
                <article key={session.id} className="flex flex-col rounded-2xl border border-base bg-secondary p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="inline-flex items-center rounded-lg border border-base bg-subtle px-2 py-0.5 font-black text-primary" style={{ fontSize: 12 }}>
                      {sessionTurnMap.get(session.id) || session.id}
                    </span>
                    <span className={cn(
                      'rounded-lg px-2 py-0.5 font-black uppercase',
                      session.status === 'open'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                        : session.status === 'cancelled'
                          ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300'
                          : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
                    )} style={{ fontSize: 11, letterSpacing: '0.06em' }}>
                      {session.status === 'open' ? 'Abierta' : session.status === 'cancelled' ? 'Cancelada' : 'Cerrada'}
                    </span>
                  </div>

                  <div className="mt-2.5 flex items-center gap-2.5">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 font-black text-white">{initials}</span>
                    <div className="min-w-0">
                      <p className="truncate font-black text-primary" style={{ fontSize: 14 }}>{worker}</p>
                      <p className="truncate font-bold text-muted" style={{ fontSize: 12 }}>{branch?.name || 'Sucursal principal'}</p>
                    </div>
                  </div>

                  <div className="mt-2.5 grid grid-cols-2 gap-2 rounded-xl border border-base bg-subtle p-2.5">
                    <div>
                      <p className="font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.06em' }}>Apertura</p>
                      <p className="font-bold text-primary" style={{ fontSize: 12 }}>{new Date(session.openedAt).toLocaleString('es-CU', { timeZone: 'America/Havana', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
                    </div>
                    <div>
                      <p className="font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.06em' }}>Cierre</p>
                      <p className="font-bold text-primary" style={{ fontSize: 12 }}>{session.closedAt ? new Date(session.closedAt).toLocaleString('es-CU', { timeZone: 'America/Havana', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</p>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.06em' }}>Fondo inicial</p>
                      <p className="font-black text-primary" style={{ fontSize: 14 }}>{formatMoney(session.openingBalance)}</p>
                    </div>
                    {hasShortage ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 font-black text-red-700 dark:bg-red-950/50 dark:text-red-300" style={{ fontSize: 12 }}>
                        <ArrowDownRight size={13} aria-hidden="true" /> Faltante {formatMoney(info?.totalShortageBase || 0)}
                      </span>
                    ) : hasOverage ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 font-black text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" style={{ fontSize: 12 }}>
                        <ArrowUpRight size={13} aria-hidden="true" /> Sobrante {formatMoney(info?.totalOverageBase || 0)}
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 font-black text-slate-600 dark:bg-slate-800 dark:text-slate-300" style={{ fontSize: 12 }}>
                        Sin diferencia
                      </span>
                    )}
                  </div>

                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2.5">
                    <button
                      type="button"
                      onClick={() => openSessionDetail(session.id, 'sessions')}
                      className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-base bg-subtle px-3 py-2 font-black uppercase text-primary transition-colors hover:bg-secondary"
                      style={{ fontSize: 11, letterSpacing: '0.06em' }}
                    >
                      <Eye size={14} aria-hidden="true" /> Detalle
                    </button>
                    {session.status === 'closed' && (
                      <button
                        type="button"
                        onClick={() => handlePrintShiftTicket(session.id)}
                        aria-label="Imprimir ticket de cierre"
                        className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-base bg-secondary text-primary transition-colors hover:bg-subtle"
                      >
                        <Printer size={16} aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingSessionDateId(session.id);
                        setNewSessionDate(getLocalDateYMD(session.openedAt));
                      }}
                      aria-label="Editar fecha del turno"
                      className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-base bg-secondary text-amber-700 transition-colors hover:bg-subtle dark:text-amber-400"
                    >
                      <Calendar size={16} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          {filteredCashSessions.length === 0 && (
            <div className="rounded-2xl border border-dashed border-base bg-secondary px-4 py-10 text-center">
              <p className="font-black uppercase text-muted" style={{ fontSize: 12 }}>No hay turnos para el filtro seleccionado.</p>
            </div>
          )}
        </div>
      )}

      {/* TAB: DESCUADRES Y CIERRES FORZADOS */}
      {activeTab === 'discrepancies' && (
        <div className="space-y-3 animate-in fade-in duration-200">
          <ReportsStatBubbles
            items={[
              { label: 'Turnos con descuadre', value: String(filteredDiscrepancySessions.length), hint: `${discrepancyTotals.forced} con cierre forzado`, icon: AlertTriangle, tone: 'violet' },
              { label: 'Dinero faltante', value: formatMoney(discrepancyTotals.shortage), hint: 'Declarado por debajo de lo esperado', icon: ArrowDownRight, tone: 'red' },
              { label: 'Dinero sobrante', value: formatMoney(discrepancyTotals.overage), hint: 'Declarado por encima de lo esperado', icon: ArrowUpRight, tone: 'emerald' },
              { label: 'Pendientes de revisión', value: String(discrepancyTotals.pending), hint: 'Sin causa documentada', icon: Clock, tone: 'amber' },
            ]}
          />

          <div className="flex flex-col gap-2 rounded-2xl border border-base bg-secondary p-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Filtrar descuadres">
              {[
                { id: 'all', label: `Todos ${allDiscrepancySessions.length}` },
                { id: 'shortage', label: 'Faltantes' },
                { id: 'overage', label: 'Sobrantes' },
                { id: 'deducted', label: 'Con descuento' },
                { id: 'pending', label: 'Pendientes' },
              ].map(filter => (
                <button
                  key={filter.id}
                  type="button"
                  role="tab"
                  aria-selected={discrepancyTypeFilter === filter.id}
                  onClick={() => setDiscrepancyTypeFilter(filter.id as any)}
                  className={cn(
                    'inline-flex min-h-9 items-center rounded-lg px-3 py-1.5 font-black uppercase tracking-wide transition-colors',
                    discrepancyTypeFilter === filter.id
                      ? 'bg-[#6535C5] text-white shadow-sm'
                      : 'bg-subtle text-secondary hover:text-primary',
                  )}
                  style={{ fontSize: 11 }}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <p className="font-bold text-muted" style={{ fontSize: 12 }}>
              Faltante = se declaró menos de lo esperado · Sobrante = se declaró de más
            </p>
          </div>

          <div className="overflow-hidden rounded-2xl border border-base bg-secondary">
            <ul className="divide-y divide-base">
              {filteredDiscrepancySessions.map(({ session, info }) => {
                const branch = branches.find(b => b.id === session.branchId);
                const worker = findSessionEmployeeUser(session, users)?.name || session.workerName || 'Cajero';
                const initials = (worker.match(/\b\w/g) || []).slice(0, 2).join('').toUpperCase() || 'CA';
                const turnLabel = sessionTurnMap.get(session.id) || session.id;
                const dateObj = new Date(session.closingDate || session.closedAt || session.openedAt);
                const whenLabel = `${branch?.name || 'Sucursal principal'} · ${dateObj.toLocaleDateString('es-CU', { day: '2-digit', month: 'short', year: 'numeric' })} ${dateObj.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' })}`;
                return (
                  <li key={session.id} className="flex flex-col gap-2 px-3 py-2.5 transition-colors hover:bg-subtle/60 sm:flex-row sm:items-center sm:gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-[11px] font-black text-white">{initials}</span>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <p className="truncate text-[13px] font-black text-primary" title={worker}>{worker}</p>
                          <span className="shrink-0 rounded-md border border-base bg-subtle px-1.5 py-0.5 text-[11px] font-black text-secondary">{turnLabel}</span>
                          {info.isForcedClose && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] font-black uppercase text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
                              <AlertTriangle size={11} aria-hidden="true" /> Forzado
                            </span>
                          )}
                        </div>
                        <p className="truncate text-[12px] font-bold text-muted" title={whenLabel}>{whenLabel}</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
                      {info.totalShortageBase > 0 && (
                        <span className="rounded-lg border border-red-200 bg-red-50 px-2 py-0.5 text-[12px] font-black text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
                          −{formatMoney(info.totalShortageBase)}
                        </span>
                      )}
                      {info.totalOverageBase > 0 && (
                        <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[12px] font-black text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
                          +{formatMoney(info.totalOverageBase)}
                        </span>
                      )}
                      {info.deducted && (
                        <span className="rounded-lg border border-base bg-subtle px-2 py-0.5 text-[11px] font-black uppercase text-secondary" title="Descuento aplicado al salario">
                          Salario −{formatMoney(info.deductionAmount)}
                        </span>
                      )}
                      {info.auditStatus === 'resolved' ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-black uppercase text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                          <CheckCircle2 size={12} aria-hidden="true" /> Conciliado
                        </span>
                      ) : info.auditStatus === 'reviewed' ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-black uppercase text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                          <Eye size={12} aria-hidden="true" /> Auditado
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-black uppercase text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                          <Clock size={12} aria-hidden="true" /> Pendiente
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setSelectedDiscrepancyDetailSession(session)}
                        className="inline-flex min-h-9 items-center justify-center gap-1 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 px-2.5 py-1.5 text-[11px] font-black uppercase text-white shadow-sm transition-all hover:shadow-md"
                        style={{ letterSpacing: '0.06em' }}
                      >
                        <Eye size={13} aria-hidden="true" /> Revisar
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePrintDiscrepancyTicket(session)}
                        aria-label="Imprimir comprobante de descuadre"
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-base bg-secondary text-primary transition-colors hover:bg-subtle"
                      >
                        <Printer size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {filteredDiscrepancySessions.length === 0 && (
            <div className="rounded-2xl border border-dashed border-base bg-secondary px-4 py-10 text-center">
              <p className="font-black uppercase text-muted" style={{ fontSize: 12 }}>
                No hay turnos con descuadre para el filtro seleccionado.
              </p>
            </div>
          )}
        </div>
      )}

      {/* TAB: MOVIMIENTOS DE CAJA (EGRESOS E INGRESOS DEL POS) */}
      {activeTab === 'movements' && (
        <div className="space-y-4 animate-in fade-in duration-200">
          {/* Top KPI Cards for Movements */}
          <ReportsStatBubbles
            items={[
              { label: 'Total egresos (gastos)', value: `-${formatMoney(movementTotals.expense)}`, hint: `${movementTotals.expenseCount} salidas registradas`, icon: ArrowDownRight, tone: 'red' },
              { label: 'Total ingresos (entradas)', value: `+${formatMoney(movementTotals.income)}`, hint: `${movementTotals.incomeCount} entradas registradas`, icon: ArrowUpRight, tone: 'emerald' },
              { label: 'Flujo neto en caja', value: `${movementTotals.net >= 0 ? '+' : ''}${formatMoney(movementTotals.net)}`, hint: 'Ingresos menos egresos', icon: ArrowLeftRight, tone: movementTotals.net >= 0 ? 'violet' : 'red' },
              { label: 'Operaciones totales', value: String(filteredDetailedMovements.length), hint: 'Comprobantes de caja', icon: History, tone: 'slate' },
            ]}
          />

          {/* Subfilters bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-secondary rounded-2xl border border-base">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-black uppercase text-muted tracking-wider mr-1">Filtrar por tipo:</span>
              {[
                { id: 'all', label: `Todos (${allDetailedMovements.length})` },
                { id: 'expense', label: 'Solo egresos (gastos)' },
                { id: 'income', label: 'Solo ingresos (entradas)' }
              ].map(f => (
                <button
                  key={f.id}
                  onClick={() => setMovementTypeFilter(f.id as any)}
                  className={cn(
                    "px-2.5 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider transition-all cursor-pointer",
                    movementTypeFilter === f.id
                      ? "bg-[#6535C5] text-white shadow-xs"
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
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black bg-subtle text-secondary border border-base tracking-wider">
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
                                : "bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400 border-red-200"
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
                              m.type === 'income' ? "text-emerald-600" : "text-red-600"
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
                              className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-violet-50 hover:bg-violet-100 dark:bg-violet-950/50 dark:hover:bg-violet-900/60 text-violet-700 dark:text-violet-300 text-[9px] font-black uppercase rounded-lg border border-violet-200 dark:border-violet-900/50 transition-all active:scale-95 shadow-2xs cursor-pointer"
                            >
                              <Eye className="w-3 h-3 text-violet-600 dark:text-violet-300" />
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
          <ReportsStatBubbles
            items={[
              { label: 'Total transferencias', value: String(transferStats.totalCount), hint: 'Envíos registrados', icon: ArrowLeftRight, tone: 'blue' },
              { label: 'Unidades movidas', value: `${transferStats.totalUnits} u.`, hint: 'Artículos transferidos', icon: Package, tone: 'violet' },
              { label: 'Mayor almacén origen', value: String(transferStats.topOrigin[0] || '—'), hint: `${transferStats.topOrigin[1]} uds despachadas`, icon: ArrowUpRight, tone: 'amber' },
              { label: 'Mayor sucursal destino', value: String(transferStats.topDest[0] || '—'), hint: `${transferStats.topDest[1]} uds recibidas`, icon: ArrowDownRight, tone: 'emerald' },
            ]}
          />

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
                  className="w-full pl-2.5 pr-2 py-1 bg-subtle border border-base rounded-lg text-[8px] font-bold text-primary placeholder:text-muted outline-none focus:border-violet-500"
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
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black bg-subtle text-secondary border border-base">
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
                            className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-violet-50 hover:bg-violet-100 dark:bg-violet-950/50 dark:hover:bg-violet-900/60 text-violet-700 dark:text-violet-300 text-[9px] font-black uppercase rounded-lg border border-violet-200 dark:border-violet-900/50 transition-all mx-auto active:scale-95 shadow-2xs cursor-pointer"
                          >
                            <Eye className="w-3 h-3 text-violet-600 dark:text-violet-300" />
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
        onHideTransaction={handleHideTransactionFromDetail}
        onEditDate={handleEditTransactionDate}
      />

      {/* Modal: Detalle de Transferencia entre Sucursales */}
      {selectedTransferModal && (
        <Suspense fallback={null}>
          <ReportsSelectedTransferModal {...{ branches, selectedTransferModal, setSelectedTransferModal }} />
        </Suspense>
      )}

      {/* Modal: Anular venta (motivo auditado + stock exacto a reponer) */}
      {voidTarget && (
        <ReportsVoidDialog
          transaction={voidTarget}
          returns={returns}
          bankTransactions={bankTransactions}
          busy={isVoiding}
          onCancel={() => { if (!isVoiding) setVoidTarget(null); }}
          onConfirm={confirmVoidTransaction}
        />
      )}

      {/* Modal: Eliminar turno completo (motivo auditado + reposición de stock) */}
      {shiftVoidTarget && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm animate-in fade-in duration-150"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !isVoidingShift) setShiftVoidTarget(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="void-shift-title"
            className="w-full max-w-md overflow-hidden rounded-3xl border border-base bg-secondary shadow-2xl"
          >
            <div className="flex items-start gap-2.5 border-b border-base bg-rose-50/60 px-4 py-3.5 dark:bg-rose-950/30">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">
                <Trash2 size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 id="void-shift-title" className="text-sm font-black uppercase tracking-tight text-primary">Eliminar turno completo</h3>
                <p className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">
                  Turno {sessionTurnMap.get(shiftVoidTarget.id) || shiftVoidTarget.id} · {shiftVoidTarget.workerName || 'Cajero'}
                </p>
              </div>
            </div>
            <div className="space-y-3 px-4 py-3.5">
              <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-bold text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
                Se anularán todas las ventas del turno, el stock volverá al inventario y se eliminará la liquidación salarial asociada. Esta acción no se puede deshacer.
              </p>
              <label className="block">
                <span className="mb-1 block text-[9px] font-black uppercase tracking-widest text-muted">Motivo (queda auditado)</span>
                <textarea
                  value={shiftVoidReason}
                  onChange={event => setShiftVoidReason(event.target.value)}
                  rows={3}
                  maxLength={500}
                  disabled={isVoidingShift}
                  placeholder="Ej: turno duplicado por error de apertura"
                  className="w-full resize-none rounded-xl border border-base bg-subtle px-3 py-2 text-[12px] font-semibold text-primary outline-none focus:border-rose-400 disabled:opacity-60"
                />
              </label>
              {!navigator.onLine && (
                <p className="text-[10px] font-bold text-amber-700 dark:text-amber-300">
                  Sin conexión: necesitas Internet para que la nube confirme la eliminación del turno.
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-base bg-subtle px-4 py-3">
              <button
                type="button"
                onClick={() => setShiftVoidTarget(null)}
                disabled={isVoidingShift}
                className="min-h-10 rounded-xl border border-base bg-secondary px-3 text-[10px] font-black uppercase tracking-wider text-primary hover:bg-subtle disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmVoidShift()}
                disabled={isVoidingShift || shiftVoidReason.trim().length < 3}
                className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-3 text-[10px] font-black uppercase tracking-wider text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {isVoidingShift ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
                {isVoidingShift ? 'Eliminando…' : 'Eliminar turno'}
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Modal: Detalle del Turno (horario, cobros, movimientos y productos) */}
      {expandedSessionRecord && (
        <ReportsSessionDetailModal
          session={expandedSessionRecord}
          transactions={transactions}
          users={users}
          currencies={currencies}
          formatMoney={formatMoney}
          sessionTurnLabel={sessionTurnMap.get(expandedSessionRecord.id) || expandedSessionRecord.id}
          payrollItem={payrollList.find(item => item.sessionId === expandedSessionRecord.id) || null}
          discrepancyInfo={getSessionDiscrepancyInfo(expandedSessionRecord)}
          showDiscrepancy={shiftActionsAvailable}
          showShiftActions={shiftActionsAvailable}
          sessionHidden={expandedSessionHidden}
          onHideSession={shiftActionsAvailable ? handleToggleSessionVisibility : undefined}
          onVoidSession={shiftActionsAvailable ? handleRequestVoidShift : undefined}
          onClose={() => setExpandedSession(null)}
          onOpenDiscrepancy={session => {
            setExpandedSession(null);
            setSelectedDiscrepancyDetailSession(session);
          }}
          onEditDate={session => {
            setEditingSessionDateId(session.id);
            setNewSessionDate(getLocalDateYMD(session.openedAt));
          }}
          onPrint={sessionId => void handlePrintShiftTicket(sessionId)}
          onOpenTransaction={setSelectedDirectTxModal}
        />
      )}

      {/* Modal: Detalle y Auditoría de Descuadre y Cierre Forzado */}
      {selectedDiscrepancyDetailSession && (
        <Suspense fallback={null}>
          <ReportsDiscrepancyDetailModal {...{ addNotification, baseCurrency, branches, currencies, currentUser: store.currentUser, formatMoney, getSessionDiscrepancyInfo, handlePrintDiscrepancyTicket, handlePrintShiftTicket, selectedDiscrepancyDetailSession, sessionTurnMap, setSelectedDiscrepancyDetailSession, transactions, updateCashSession, users }} />
        </Suspense>
      )}

      {/* Modal: Detalle de Movimiento de Caja (Egreso / Ingreso) */}
      {selectedMovementDetail && (
        <Suspense fallback={null}>
          <ReportsMovementDetailModal {...{ baseCurrency, currencies, formatMoney, handlePrintCashMovementTicket, onSaveCorrection: handleSaveMovementCorrection, selectedMovementDetail, setSelectedMovementDetail }} />
        </Suspense>
      )}

      {/* Hidden Thermal Printer Area */}
      {printSession && (
        <Suspense fallback={null}>
          <ReportsPrintableSession {...{ formatMoney, getProductName, printBranch, printPayrollItem, printSession, products, sessionTurnMap, transactions, users }} />
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