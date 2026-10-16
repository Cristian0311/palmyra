import React, { lazy, Suspense, useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { Search, Wifi, WifiOff, RefreshCw, Plus, Minus, CreditCard, Receipt, Trash2, ShoppingCart, ShieldCheck, DollarSign, Banknote, QrCode, ArrowLeftRight, UserPlus, X, Lock, Unlock, Camera, AlertCircle, TrendingUp, Wallet, MessageSquare, Mail, HelpCircle, Calculator, ArrowRight, Package, User, RotateCcw, Printer, Bluetooth, Usb, Smartphone, Send, Copy, Check, CheckCircle, Share2, Store, ChevronDown, ChevronUp, Filter } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn, generateId } from "../lib/utils";
import { useStore } from "../store/useStore";
import { Product, Payment, Transaction, CashRegisterSession } from "../types";
import { InfoTooltip } from "../components/InfoTooltip";
import { getOfflineQueue, waitForOfflineQueueReady } from "../services/offlineQueue";
import { getActiveTenant } from "../services/tenant";
import { loadCompensationSettings } from "../services/team";
import { flushLocalStateStorage } from "../services/localStateStorage";
import { getPalmyraLocalScope } from "../services/localScope";
import { usePOSOfflineStatus } from "../modules/pos/hooks/usePOSOfflineStatus";
import { POSCatalog } from "../components/POSCatalog";
import { formatMoney } from "../modules/pos/utils/paymentMath";
import { verifySaaSPosAccessPassword } from "../services/saas";
import { verifyEmployeePosAccessPassword } from "../services/team";
import { usePOSPayments } from "../modules/pos/hooks/usePOSPayments";
import { usePOSScanner } from "../modules/pos/hooks/usePOSScanner";
import { usePOSPrinter } from "../modules/pos/hooks/usePOSPrinter";
import { POSConfigProductModal } from "../components/pos/POSConfigProductModal";
import { CashMovementTicket } from "../components/cash/CashMovementTicket";
import { POSAddCustomerModal } from "../components/pos/POSAddCustomerModal";
import { POSCancelShiftModal } from "../components/pos/POSCancelShiftModal";
import { POSClosurePrintArea } from "../components/pos/POSClosurePrintArea";
import { getAuthorizedWarehouseIds, getWarehouseId } from "../modules/warehouse/warehouseScope";
import { pullOpenCashSessionsFromSupabase } from "../services/supabaseSync";
import { calculateExpectedSessionBalances } from "../modules/pos/utils/cashMath";
import { aggregateTransferPayments, buildTransactionTicketId, finalizeCheckoutPayments } from '../modules/pos/utils/checkoutUtils';
import { rememberOfflinePosCredential, verifyOfflinePosCredential, rememberOfflinePosResumeGrant, verifyOfflinePosResumeGrant } from "../services/offlinePosAuth";
const POSStartupScreen = lazy(() => import("./POSStartupScreen"));
const CheckoutModal = lazy(() => import("../components/pos/CheckoutModal"));

const POSReceiptModal = lazy(() => import("../components/POSReceiptModal"));
const POSPrinterSetupModal = lazy(() => import("../components/POSPrinterSetupModal"));
const POSCashManagementModal = lazy(() => import("./POSCashManagementModal"));
const POSSalarySummaryModal = lazy(() => import("./POSSalarySummaryModal"));

const EMPTY_TRANSACTIONS: Transaction[] = [];
const EMPTY_CASH_SESSIONS: CashRegisterSession[] = [];

export default function POS() {
  const [showCashManagementModal, setShowCashManagementModal] = useState(false);
  const [lastClosedSession, setLastClosedSession] = useState<CashRegisterSession | null>(null);
  const [showOpenShiftModal, setShowOpenShiftModal] = useState(false);
  const [joiningSessionId, setJoiningSessionId] = useState<string | null>(null);
  const [showOpenSessionsModal, setShowOpenSessionsModal] = useState(false);
  const [isRefreshingOpenSessions, setIsRefreshingOpenSessions] = useState(false);
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
        console.warn('[POS] No se pudo cargar la compensación global:', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Suscripción única al estado operativo del POS. currentBranchId es el alias
  // interno existente del almacén activo y no reintroduce la capa legacy.
  const {
    products,
    cart,
    addToCart,
    updateCartQty,
    clearCart,
    processTransaction,
    branches,
    currentBranchId,
    setCurrentBranch,
    activeSessionId,
    setActiveSessionId,
    currencies,
    getBaseCurrency,
    currentCustomerId,
    setCartCustomer,
    currentUser,
    pendingOrders,
    removePendingOrder,
    getCurrentSession,
    openSession,
    closeSession,
    addCashMovement,
    removeCashMovement,
    inventory,
    addCustomer,
    bankCards,
    addBankTransaction,
    customers,
    users,
    logout,
    createReturn,
    processReturn,
    receiptConfig,
    addNotification,
    joinOpenSession,
    salarySettlements,
  } = useStore(useShallow((state) => ({
    products: state.products,
    cart: state.cart,
    addToCart: state.addToCart,
    updateCartQty: state.updateCartQty,
    clearCart: state.clearCart,
    processTransaction: state.processTransaction,
    branches: state.branches,
    currentBranchId: state.currentBranchId,
    setCurrentBranch: state.setCurrentBranch,
    activeSessionId: state.activeSessionId,
    setActiveSessionId: state.setActiveSessionId,
    currencies: state.currencies,
    getBaseCurrency: state.getBaseCurrency,
    currentCustomerId: state.currentCustomerId,
    setCartCustomer: state.setCartCustomer,
    currentUser: state.currentUser,
    pendingOrders: state.pendingOrders,
    removePendingOrder: state.removePendingOrder,
    getCurrentSession: state.getCurrentSession,
    openSession: state.openSession,
    closeSession: state.closeSession,
    addCashMovement: state.addCashMovement,
    removeCashMovement: state.removeCashMovement,
    inventory: state.inventory,
    addCustomer: state.addCustomer,
    bankCards: state.bankCards,
    addBankTransaction: state.addBankTransaction,
    customers: state.customers,
    users: state.users,
    logout: state.logout,
    createReturn: state.createReturn,
    processReturn: state.processReturn,
    receiptConfig: state.receiptConfig,
    addNotification: state.addNotification,
    joinOpenSession: state.joinOpenSession,
    salarySettlements: state.salarySettlements,
  })));

  // Heavy administrative collections subscribe only while their UI is visible.
  // Normal sales therefore do not re-render because a transaction/session changed elsewhere.
  const needsTransactions = showCashManagementModal || !!lastClosedSession;
  const transactions = useStore((state) => needsTransactions ? state.transactions : EMPTY_TRANSACTIONS);
  // cash_sessions es un conjunto pequeño y crítico para el selector/apertura.
  // Debe permanecer reactivo para mostrar inmediatamente qué trabajador ya tiene turno abierto.
  const cashSessions = useStore((state) => state.cashSessions);
  const activeCashSessions = useMemo(() => cashSessions.filter(s => !s.deletedAt), [cashSessions]);
  const openSessionForWorker = useCallback((workerId: string) => {
    return activeCashSessions.find(s =>
      s.status === 'open' &&
      (s.userId === workerId || s.workingEmployeeIds?.includes(workerId))
    ) || null;
  }, [activeCashSessions]);
  const activeTransactions = useMemo(() => transactions.filter(t => !t.deletedAt), [transactions]);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showReceiptModal, setShowReceiptModal] = useState<Transaction | null>(null);
  const [returnConfirm, setReturnConfirm] = useState<{ tx: Transaction, item: any } | null>(null);




  const {
    isOnline,
    pendingOfflineCount,
    offlineConflictCount,
    isSyncingOffline,
    handleManualSync,
    refreshOfflineCounts,
  } = usePOSOfflineStatus(addNotification);

  // Cash Management State
  const [cashManagementTab, setCashManagementTab] = useState<'movements' | 'close' | 'sales'>('movements');
  const [closingBalances, setClosingBalances] = useState<{ [key: string]: number }>({});
  const [showDiscrepancyModal, setShowDiscrepancyModal] = useState(false);
  const [finalBalancesToClose, setFinalBalancesToClose] = useState<Payment[]>([]);
  const [movementData, setMovementData] = useState({ type: 'expense' as 'income' | 'expense', amount: '', currencyCode: 'CUP', description: '' });

  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [showCameraScanner, setShowCameraScanner] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', email: '', taxId: '' });
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [configData, setConfigData] = useState<{ serialNumber?: string; selectedSize?: string; selectedColor?: string }>({});
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null);
  
  const [showMobileCart, setShowMobileCart] = useState(false);
  const [isBottomBarMinimized, setIsBottomBarMinimized] = useState(false);
  
  const queryParams = new URLSearchParams(window.location.search);
  
  
  const navigate = useNavigate();

  // Cada entrada al módulo POS debe volver a autenticar la caja. Esto evita
  // que un activeSessionId antiguo restaurado desde un snapshot previo permita
  // saltarse la contraseña de reanudación.
  useEffect(() => {
    setActiveSessionId(null);
  }, []);

  const fallbackSessionBranchId = currentBranchId || getWarehouseId(currentUser) || branches[0]?.id || '';

  const refreshOpenSessions = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
    setIsRefreshingOpenSessions(true);
    try {
      await waitForOfflineQueueReady();
      const remoteCash = await pullOpenCashSessionsFromSupabase();
      if (!remoteCash.success) return false;

      // La cuenta que está autenticada en este dispositivo ya ha sido
      // autorizada por el servidor para ver los turnos devueltos por el RPC.
      // Guardamos un permiso local por turno, no una contraseña, para que el
      // mismo terminal pueda reanudarlo si la red vuelve a caer inmediatamente.
      const localUser = useStore.getState().currentUser;
      let resumeCompanyId = '';
      try {
        resumeCompanyId = (await getActiveTenant()).companyId;
      } catch {}
      if (localUser?.id && resumeCompanyId) {
        for (const session of remoteCash.cashSessions || []) {
          const canResumeThisSession =
            localUser.role === 'admin' ||
            session.userId === localUser.id ||
            session.workingEmployeeIds?.includes(localUser.id);
          if (canResumeThisSession) {
            rememberOfflinePosResumeGrant(
              resumeCompanyId,
              localUser.id,
              session.id
            );
          }
        }
      }

      // Una vez que el terminal recibe conexión, no descargamos únicamente el
      // encabezado del turno: cacheamos también sus movimientos, ventas e
      // inventario de la sucursal. Así, si la conexión vuelve a caer, el mismo
      // turno puede reanudarse y continuar desde el último estado conocido.
      const queue = getOfflineQueue();
      const pendingSessionIds = new Set(
        queue
          .filter(item => item.type === 'cash_session')
          .map(item => String(item.data?.id || item.actionId))
      );
      const pendingTransactionIds = new Set(
        queue
          .filter(item => item.type === 'transaction' || item.type === 'void_transaction')
          .map(item => String(item.data?.id || item.actionId))
      );

      useStore.setState(state => {
        const sessionMap = new Map<string, CashRegisterSession>(
          (state.cashSessions || []).map(session => [String(session.id), session])
        );
        for (const session of remoteCash.cashSessions || []) {
          const id = String(session.id);
          // No pisar una mutación de caja que todavía está pendiente localmente.
          if (pendingSessionIds.has(id)) continue;
          sessionMap.set(id, session);
        }

        // Las ventas locales y remotas pueden representar la misma operación
        // con un id local/ticket y un remoteId UUID diferente. Indexamos por
        // remoteId cuando existe para no duplicar una venta al hidratar el turno.
        const transactionMap = new Map<string, Transaction>();
        const transactionKey = (transaction: Transaction) =>
          String(transaction.remoteId || transaction.id);
        for (const transaction of state.transactions || []) {
          transactionMap.set(transactionKey(transaction), transaction);
        }
        for (const transaction of remoteCash.transactions || []) {
          const key = transactionKey(transaction);
          const local = transactionMap.get(key);
          const localIds = new Set([
            String(transaction.id),
            String(transaction.remoteId || ''),
            String(local?.id || ''),
            String(local?.remoteId || '')
          ].filter(Boolean));
          // Las ventas pendientes son la autoridad local hasta que el outbox
          // confirme/reconcilie la operación. Evitamos que un pull intermedio
          // la haga desaparecer o retroceda de estado.
          if ([...localIds].some(id => pendingTransactionIds.has(id)) || local?.offlinePending === true) continue;
          transactionMap.set(key, transaction);
        }

        const inventoryMap = new Map<string, any>();
        for (const item of state.inventory || []) {
          inventoryMap.set(`${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item);
        }

        // Si existen ventas/cambios de caja pendientes para una sucursal, no
        // pisamos su stock local con un snapshot remoto potencialmente anterior.
        const pendingBranchIds = new Set<string>();
        for (const item of queue) {
          const data: any = item.data || {};
          [data.branchId, data.warehouseId, data.fromBranchId, data.toBranchId]
            .filter(Boolean)
            .forEach((id: string) => pendingBranchIds.add(String(id)));
        }
        for (const item of remoteCash.inventory || []) {
          const branchId = String(item.branchId || '');
          if (!branchId || pendingBranchIds.has(branchId)) continue;
          inventoryMap.set(
            `${item.productId}:${item.branchId}:${item.variantLabel || ''}`,
            item
          );
        }

        return {
          cashSessions: Array.from(sessionMap.values()),
          transactions: Array.from(transactionMap.values()),
          inventory: Array.from(inventoryMap.values())
        };
      });

      // Persistencia explícita: el snapshot debe estar físicamente duradero
      // antes de permitir que el operador vuelva a quedar sin red.
      await flushLocalStateStorage();
      return true;
    } catch (error) {
      console.warn('[POS] No se pudo descargar el snapshot offline de los turnos abiertos:', error);
      return false;
    } finally {
      setIsRefreshingOpenSessions(false);
    }
  }, []);
  // La reanudación de una caja persistida siempre es explícita.  // La reanudación de una caja persistida siempre es explícita. El ID de
  // activeSessionId solo representa la sesión validada en esta pestaña.
  const currentSession = useMemo(() => {
    if (!activeSessionId) return null;
    return cashSessions.find(s => s.id === activeSessionId && s.status === 'open' && !s.deletedAt) || null;
  }, [activeSessionId, cashSessions]);

  useEffect(() => {
    if (currentSession || !currentUser || !fallbackSessionBranchId || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
    let cancelled = false;
    const hydrateOpenCash = async () => {
      try {
        setCurrentBranch(fallbackSessionBranchId);
        await useStore.getState().refreshBranchOperationalData();
      } catch (error) {
        if (!cancelled) console.warn('[POS] Reintento de hidratación de turnos abiertos:', error);
      }
    };
    void hydrateOpenCash();
    return () => { cancelled = true; };
  }, [currentSession?.id, currentUser?.id, fallbackSessionBranchId, setCurrentBranch]);

  // Los turnos abiertos se muestran para reanudar y exigir contraseña después
  // de una recarga. No activamos una caja abandonada automáticamente.

  // Al entrar al POS/volver al foco, actualizar operaciones de caja y catálogo.
  // Esto evita que un selector abierto durante horas conserve una lista vieja.
  useEffect(() => {
    if (!currentUser || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
    const run = async () => {
      try {
        // La cola offline debe estar completamente hidratada antes de cualquier
        // pull remoto. De lo contrario, una recarga puede traer transactions
        // antiguas desde Supabase y sobrescribir temporalmente una venta que
        // todavía vive únicamente en el outbox local.
        await waitForOfflineQueueReady();
        await useStore.getState().restoreTransactionsFromBackup();
        await useStore.getState().refreshGlobalCatalogData();
        await useStore.getState().refreshBranchOperationalData(
          currentSession?.id ? { sessionId: currentSession.id, transactionLimit: 250, transferLimit: 100 } : { transactionLimit: 250, transferLimit: 100 }
        );

        // Recuperación específica de cajas: al recuperar conexión se
        // descarga siempre el snapshot completo de todos los turnos abiertos que
        // el servidor exponga a este terminal. Así quedan preparados para una
        // nueva caída de red sin depender de que el turno sea el seleccionado.
        await refreshOpenSessions();
      } catch (error) {
        console.warn('[POS] No se pudo refrescar el estado operativo al entrar:', error);
      }
    };
    void run();
  }, [currentUser?.id, fallbackSessionBranchId, refreshOpenSessions]);

  // Cuando la red vuelve, descargar inmediatamente el snapshot de los turnos
  // abiertos. También al volver al foco para cubrir móviles que recuperan red
  // mientras la aplicación estaba en segundo plano.
  useEffect(() => {
    if (!currentUser) return;
    const refresh = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        void refreshOpenSessions();
      }
    };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [currentUser?.id, refreshOpenSessions]);

  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [showSalarySummary, setShowSalarySummary] = useState(false);
  const [isSubmittingCheckout, setIsSubmittingCheckout] = useState(false);
  const [salesFilter, setSalesFilter] = useState<'all' | 'usd' | 'transfer' | 'cash_cup' | 'mixed'>('all');
  const [salesSubTab, setSalesSubTab] = useState<'tickets' | 'products' | 'movements'>('tickets');

  const [posError, setPosError] = useState("");
  const [posSuccess, setPosSuccess] = useState("");
  const [openingAmount, setOpeningAmount] = useState("");
  const [sessionWorkerName, setSessionWorkerName] = useState("");
  const [sessionWorkerId, setSessionWorkerId] = useState("");
  // La identidad del trabajador debe reconstruirse desde la sesión persistida
  // después de cambiar de módulo, recargar la página o rehidratar Zustand.
  useEffect(() => {
    // Mantener la selección manual del vendedor mientras se prepara la apertura.
    // No hay sesión abierta todavía, por lo que currentSession es null y no debe
    // borrar sessionWorkerName justo después de que el usuario lo selecciona.
    if (!currentSession) return;
    if (sessionWorkerName !== (currentSession.workerName || "")) {
      setSessionWorkerName(currentSession.workerName || "");
    }
    if (sessionWorkerId !== (currentSession.userId || "")) {
      setSessionWorkerId(currentSession.userId || "");
    }
    if (currentBranchId !== currentSession.branchId) {
      setCurrentBranch(currentSession.branchId);
    }
  }, [currentSession?.id, currentSession?.userId, currentSession?.workerName, currentSession?.branchId, sessionWorkerName, sessionWorkerId, currentBranchId, setCurrentBranch]);
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [employeePickerSearch, setEmployeePickerSearch] = useState("");
  const employeePickerRef = useRef<HTMLDivElement>(null);
  const [sessionPassword, setSessionPassword] = useState("");

  useEffect(() => {
    if (!employeePickerOpen) return;

    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && employeePickerRef.current?.contains(target)) return;
      setEmployeePickerOpen(false);
      setEmployeePickerSearch("");
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setEmployeePickerOpen(false);
      setEmployeePickerSearch("");
    };

    document.addEventListener("pointerdown", handleOutsidePointer);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [employeePickerOpen]);
  const [isOpeningSession, setIsOpeningSession] = useState(false);
  const [isClosingSession, setIsClosingSession] = useState(false);

  const [joiningSessionPassword, setJoiningSessionPassword] = useState("");
  const [isNewEmployee, setIsNewEmployee] = useState(false);

  // Empleados de la empresa activa y almacenes autorizados.
  const detectedWorker = React.useMemo(() => {
    if (sessionWorkerId) return (users || []).find(u => u.id === sessionWorkerId) || null;
    const name = (sessionWorkerName || '').trim().toLowerCase();
    return name ? (users || []).find(u => (u.name || '').trim().toLowerCase() === name) || null : null;
  }, [sessionWorkerId, sessionWorkerName, users]);

  const workerAssignedWarehouseIds = React.useMemo(
    () => getAuthorizedWarehouseIds(detectedWorker),
    [detectedWorker]
  );
  const workerAssignedBranchId =
    getWarehouseId(detectedWorker) ||
    (workerAssignedWarehouseIds.length === 1 ? workerAssignedWarehouseIds[0] : null);

  const currentSessionWorker = currentSession
    ? (users || []).find(u =>
        u.id === currentSession.userId ||
        (!!u.name && !!currentSession.workerName &&
         u.name.trim().toLowerCase() === currentSession.workerName.trim().toLowerCase())
      ) || null
    : null;

  useEffect(() => {
    if (workerAssignedBranchId) setSessionBranchId(workerAssignedBranchId);
  }, [workerAssignedBranchId]);

  useEffect(() => {
    const exists = sessionWorkerName
      ? users.some(u => u.isActive !== false &&
          (u.name || '').trim().toLowerCase() === sessionWorkerName.trim().toLowerCase())
      : false;
    setIsNewEmployee(Boolean(sessionWorkerName && !exists));
  }, [sessionWorkerName, users]);

  const isBranchLocked = Boolean(workerAssignedBranchId);

  const allowedBranches = React.useMemo(() => {
    if (currentUser?.role === 'admin') return branches || [];
    const scopeUser = detectedWorker || currentUser;
    const ids = getAuthorizedWarehouseIds(scopeUser);
    return (branches || []).filter(b => ids.includes(b.id));
  }, [currentUser, detectedWorker, branches]);

  const [sessionBranchId, setSessionBranchId] = useState<string>(
    currentBranchId || ((allowedBranches || []).length > 0 ? allowedBranches[0].id : "")
  );

  // La caja abierta debe ser detectable aunque el selector de sucursal todavía
  // no haya terminado de hidratarse. Para el administrador mostramos sus cajas
  // abiertas; para un trabajador, solo su propio turno autorizado.
  const openSessionsForResume = React.useMemo(() => {
    const allowedIds = new Set((allowedBranches || []).map(b => b.id).filter(Boolean));
    return (activeCashSessions || [])
      .filter(s => {
        if (s.status !== 'open' || s.deletedAt) return false;
        // El administrador tiene alcance sobre toda la empresa; no depender de
        // allowedBranches evita ocultar una caja durante la hidratación inicial.
        if (currentUser?.role === 'admin') return true;
        if (allowedIds.size > 0 && !allowedIds.has(s.branchId)) return false;
        const uid = currentUser?.id || '';
        return !!uid && (s.userId === uid || s.workingEmployeeIds?.includes(uid));
      })
      .sort((a,b) => new Date(b.openedAt || 0).getTime() - new Date(a.openedAt || 0).getTime());
  }, [activeCashSessions, allowedBranches, currentUser?.id, currentUser?.role]);

  useEffect(() => {
    // Si la sucursal actual quedó vacía/stale mientras hidrata el POS,
    // seleccionar una sucursal válida o directamente la del turno abierto.
    const branchStillAllowed = !!sessionBranchId && (allowedBranches || []).some(b => b.id === sessionBranchId);
    if (branchStillAllowed) return;

    const preferred =
      currentBranchId ||
      openSessionsForResume[0]?.branchId ||
      allowedBranches?.[0]?.id ||
      '';
    if (preferred && preferred !== sessionBranchId) setSessionBranchId(preferred);
  }, [allowedBranches, currentBranchId, openSessionsForResume, sessionBranchId]);

  const [deductFromSalary, setDeductFromSalary] = useState(false);

  const [showCancelShiftModal, setShowCancelShiftModal] = useState(false);
  const [isCancellingShift, setIsCancellingShift] = useState(false);

  const handleCancelShift = async () => {
    if (!currentSession || isCancellingShift) return;

    // La sesión autenticada y el permiso cash.close se validan en el servidor.
    // La cancelación no solicita una segunda contraseña al trabajador.
    setIsCancellingShift(true);
    setPosError("");
    try {
      const sessionId = currentSession.id;
      const ok = await useStore.getState().cancelSession(sessionId, 'Cancelación de turno');
      if (!ok) {
        setPosError("No se pudo cancelar el turno. La operación no fue confirmada; el turno sigue abierto.");
        return;
      }

      setShowCancelShiftModal(false);
      setShowCashManagementModal(false);
      setShowDiscrepancyModal(false);
      setClosingBalances({});
      setFinalBalancesToClose([]);
      setCashManagementTab('movements');
      setDeductFromSalary(false);
      setShowOpenShiftModal(false);
      setJoiningSessionId(null);
      setJoiningSessionPassword("");
      setLastClosedSession(null);
      setActiveSessionId(null);
      clearCart();

      setPosSuccess("Turno cancelado correctamente. Regresando al selector de empleado.");
      setTimeout(() => setPosSuccess(""), 3500);
    } catch (err: any) {
      console.error("[POS] Error cancelando turno:", err);
      setPosError(err?.message || "No se pudo cancelar el turno. El turno permanece abierto.");
    } finally {
      setIsCancellingShift(false);
    }
  };

  const baseCurrency = getBaseCurrency();
  const productById = React.useMemo(() => new Map((products || []).map(product => [product.id, product])), [products]);
  const userById = React.useMemo(() => new Map((users || []).map(user => [user.id, user])), [users]);
  const currencyByCode = React.useMemo(() => new Map((currencies || []).map(currency => [currency.code, currency])), [currencies]);

  // Las liquidaciones de empleados se expresan siempre en CUP/MN, independientemente de la moneda base del POS.
  const formatSalaryCUP = (value: number) => `${Math.round(Number(value) || 0).toLocaleString('es-ES')} CUP`;
  // CUP/MN siempre visible en el arqueo físico.
  const cashDisplayCurrencies = React.useMemo(() => {
    const configured = [...(currencies || [])];
    if (!configured.some(c => c.code === 'CUP')) {
      configured.unshift({
        code: 'CUP',
        name: 'Peso Cubano',
        symbol: '$',
        rateToBase: 1,
        isBase: true
      } as any);
    }
    return configured;
  }, [currencies]);

  const expectedBalances = React.useMemo(
    () => calculateExpectedSessionBalances(currentSession, activeTransactions, currentBranchId, baseCurrency, currencies),
    [currentSession, activeTransactions, currentBranchId, baseCurrency, currencies]
  );

  // Desglose de liquidación del turno conectado a la configuración salarial global.
  const turnProductSalaryRows = React.useMemo(() => {
    if (!currentSession) return [];
    const rows = new Map<string, any>();
    activeTransactions.filter(tx => tx.branchId === currentBranchId && tx.status === 'completed' && !tx.deletedAt && !String(tx.notes || '').startsWith('AJUSTE_') && new Date(tx.date) >= new Date(currentSession.openedAt) && (!tx.sessionId || tx.sessionId === currentSession.id)).forEach(tx => {
      const sellers = tx.sellerEmployeeIds?.length ? tx.sellerEmployeeIds : [tx.userId];
      const splitFactor = Math.max(1, sellers.length);
      const saleTotal = Math.max(0, Number(tx.total) || 0);
      const totalItems = Math.max(1, (tx.items || []).reduce((sum, line) => sum + Math.max(0, Number((line as any).quantity) || 0), 0));
      (tx.items || []).forEach(item => {
        const raw = item as any;
        const rawProduct = raw.product ?? raw.productId;
        const product = typeof rawProduct === 'string' ? productById.get(rawProduct) : rawProduct;
        const productId = product?.id || raw.product_id || (typeof rawProduct === 'string' ? rawProduct : '');
        const quantity = Math.max(0, Number(raw.quantity) || 0);
        if (!productId || quantity <= 0) return;
        const productName = product?.name || raw.product_name || 'Producto vendido';
        const unitPrice = Number(raw.price ?? product?.price ?? raw.product_snapshot?.price ?? 0) || 0;
        const lineTotal = Math.max(0, unitPrice * quantity);
        const fixedCommission = Math.max(0, Number(product?.commissionValue ?? raw.product_snapshot?.commissionValue ?? raw.commissionValue ?? 0) || 0);
        sellers.forEach((sellerId: string) => {
          const employee = userById.get(sellerId);
          const salaryTotal = companyCompensation.mode === 'sales_percent'
            ? (saleTotal * companyCompensation.percentRate / 100 / splitFactor) * (saleTotal > 0 ? lineTotal / saleTotal : quantity / totalItems)
            : (fixedCommission * quantity) / splitFactor;
          const salaryPerUnit = salaryTotal / quantity;
          const key = sellerId + '::' + productId;
          const current = rows.get(key);
          if (current) {
            current.quantity += quantity;
            current.salaryTotal += salaryTotal;
            current.salaryPerUnit = current.quantity > 0 ? current.salaryTotal / current.quantity : 0;
          } else rows.set(key, { key, employeeName: employee?.name || tx.cashierName || 'Empleado', productName, quantity, salaryPerUnit, salaryTotal });
        });
      });
    });
    return Array.from(rows.values()).sort((x: any, y: any) => String(x.employeeName).localeCompare(String(y.employeeName)) || String(x.productName).localeCompare(String(y.productName)));
  }, [currentSession, activeTransactions, currentBranchId, productById, userById, companyCompensation]);

  const totalExpectedToDeliver = React.useMemo(() => {
    return expectedBalances.reduce((sum, line) => {
      const rate = line.currencyCode === baseCurrency.code
        ? 1
        : Number(line.exchangeRate || currencyByCode.get(line.currencyCode)?.rateToBase || 1);
      return sum + Number(line.amount || 0) * rate;
    }, 0);
  }, [expectedBalances, baseCurrency, currencyByCode]);


  const handleReturnItem = async () => {
    if (!returnConfirm) return;
    const { tx, item } = returnConfirm;

    try {
      const returnId = generateId();
      const prodId = typeof (item.product as any) === 'object' ? (item.product?.id || '') : (item.product || '');
      const returnData = {
        id: returnId,
        transactionId: tx.id,
        productId: prodId,
        quantity: item.quantity,
        reason: 'Devolución de cliente',
        date: new Date().toISOString(),
        status: 'pending' as const,
        type: 'refund' as const,
        notes: `Devolución desde historial de ventas. Ticket: ${tx.id}`
      };

      createReturn(returnData);
      await processReturn(returnId, 'complete');

      setPosSuccess("Producto devuelto y stock actualizado correctamente");
      setReturnConfirm(null);
      setTimeout(() => setPosSuccess(""), 3000);
    } catch (err) {
      console.error("Error processing return:", err);
      setPosError("Error al procesar la devolución");
      setTimeout(() => setPosError(""), 3000);
    }
  };

  const handleClose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (currentSession && !isClosingSession) {
      const finalBalances: Payment[] = Object.entries(closingBalances)
        .filter(([_, amount]) => (amount as number) > 0)
        .map(([key, amount]) => {
          const [code, method] = key.split('-');
          const currency = currencies.find(c => c.code === code)!;
          return {
            currencyCode: code as any,
            amount: amount as number,
            exchangeRate: getSafeRateToBase(code),
            method: method as any
          };
        });
      let hasDiscrepancy = false;
      expectedBalances.forEach(eb => {
        const actual = finalBalances.find(fb => fb.currencyCode === eb.currencyCode && fb.method === eb.method)?.amount || 0;
        if (Math.abs(actual - eb.amount) > 0.01) {
          hasDiscrepancy = true;
        }
      });
      finalBalances.forEach(fb => {
        const exp = expectedBalances.find(eb => fb.currencyCode === eb.currencyCode && fb.method === eb.method)?.amount || 0;
        if (Math.abs(fb.amount - exp) > 0.01) {
          hasDiscrepancy = true;
        }
      });

      if (hasDiscrepancy) {
        setFinalBalancesToClose(finalBalances);
        setShowDiscrepancyModal(true);
      } else {
        const ok = await processClose(finalBalances);
        if (ok) {
          setPosSuccess("Caja cerrada y confirmada correctamente.");
          setTimeout(() => setPosSuccess(""), 3000);
        }
      }
    }
  };

  const processClose = async (balances: Payment[], discrepancyDeduction?: number, sessionMeta?: Partial<CashRegisterSession>) => {
    if (!currentSession || isClosingSession) return false;

    setIsClosingSession(true);
    setPosError("");
    try {
      let finalClosingDate = new Date().toISOString();
      if (sessionClosingDate) {
        const parts = sessionClosingDate.split('-');
        if (parts.length === 3) {
          const d = new Date();
          d.setFullYear(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
          finalClosingDate = d.toISOString();
        }
      }

      const expectedCashBase = expectedBalances
        .filter(line => line.method === 'cash')
        .reduce((sum, line) => sum + (Number(line.amount) || 0) * (Number(line.exchangeRate) || getSafeRateToBase(line.currencyCode) || 1), 0);

      const sessionToClose: CashRegisterSession = {
        ...currentSession,
        status: 'closed' as const,
        closedAt: finalClosingDate,
        closingBalances: balances,
        workerName: sessionWorkerName || currentSession.workerName,
        closingDate: finalClosingDate,
        ...(sessionMeta || {}),
        expectedBalance: expectedCashBase
      };

      const confirmed = await closeSession(
        currentSession.id,
        balances,
        sessionWorkerName || currentSession.workerName,
        finalClosingDate,
        discrepancyDeduction,
        { ...(sessionMeta || {}), expectedBalance: expectedCashBase },
        companyCompensation
      );

      if (!confirmed) {
        setPosError("El cierre no fue confirmado por la base de datos. El turno permanece abierto y protegido.");
        return false;
      }

      setLastClosedSession(sessionToClose);
      void handlePrintClosureThermal(sessionToClose);
      setClosingBalances({});
      setSessionWorkerName("");
      setSessionPassword("");
      setActiveSessionId(null);
      setSessionClosingDate(new Date().toISOString().split('T')[0]);
      setShowCashManagementModal(false);
      setShowSalarySummary(true);
      setShowOpenShiftModal(false);
      return true;
    } catch (err: any) {
      console.error("[POS] Error confirmando cierre:", err);
      setPosError(err?.message || "No se pudo confirmar el cierre del turno.");
      return false;
    } finally {
      setIsClosingSession(false);
    }
  };

  const confirmClose = async () => {
    if (currentSession) {
      let totalDeduction = 0;
      if (deductFromSalary) {
        expectedBalances.forEach(eb => {
          const actual = finalBalancesToClose.find(fb => fb.currencyCode === eb.currencyCode && fb.method === eb.method)?.amount || 0;
          const diff = actual - eb.amount;
          if (diff < 0) {
            // Convert to base currency
            const currency = currencies.find(c => c.code === eb.currencyCode);
            totalDeduction += Math.abs(diff) * (currency?.rateToBase || 1);
          }
        });
      }

      // Build discrepancy details
      const discrepancyDetails: {
        currencyCode: string;
        method: 'cash' | 'transfer';
        expected: number;
        actual: number;
        difference: number;
      }[] = [];

      expectedBalances.forEach(eb => {
        const actual = finalBalancesToClose.find(fb => fb.currencyCode === eb.currencyCode && fb.method === eb.method)?.amount || 0;
        const diff = actual - eb.amount;
        if (Math.abs(diff) > 0.01) {
          discrepancyDetails.push({
            currencyCode: eb.currencyCode,
            method: eb.method as any,
            expected: eb.amount,
            actual,
            difference: diff
          });
        }
      });

      finalBalancesToClose.forEach(fb => {
        if (!expectedBalances.some(eb => eb.currencyCode === fb.currencyCode && eb.method === fb.method)) {
          discrepancyDetails.push({
            currencyCode: fb.currencyCode,
            method: fb.method as any,
            expected: 0,
            actual: fb.amount,
            difference: fb.amount
          });
        }
      });

      const matchingProductsAnalysis = discrepancyDetails.map(dd => {
        const matchedProducts = products
          .filter(p => Math.abs(p.price - Math.abs(dd.difference)) < 1)
          .slice(0, 3)
          .map(p => ({ id: p.id, name: p.name, price: p.price }));
        return {
          currencyCode: dd.currencyCode,
          difference: dd.difference,
          matchedProducts
        };
      }).filter(m => m.matchedProducts.length > 0);

      const sessionMeta: Partial<CashRegisterSession> = {
        isForcedClose: true,
        hasDiscrepancy: discrepancyDetails.length > 0,
        discrepancyDetails,
        discrepancyDeductionApplied: totalDeduction,
        deductedFromSalary: deductFromSalary,
        matchingProductsAnalysis,
        auditStatus: 'pending_review',
        notes: `Cierre forzado con descuadre. Deducción salarial: ${totalDeduction > 0 ? `${totalDeduction} CUP` : 'No aplicada'}.`
      };

      const ok = await processClose(finalBalancesToClose, totalDeduction, sessionMeta);
      if (!ok) return;
      setShowDiscrepancyModal(false);
      setDeductFromSalary(false);
      setFinalBalancesToClose([]);
      setPosSuccess("Caja cerrada. Se registraron los datos para la auditoría de descuadres en Reportes.");
      setTimeout(() => setPosSuccess(""), 3500);
    }
  };

  const handleAddMovement = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentSession) return;
    const amt = parseFloat(movementData.amount);
    if (isNaN(amt) || amt <= 0) return;

    addCashMovement(currentSession.id, {
      id: crypto.randomUUID(),
      sessionId: currentSession.id,
      branchId: currentSession.branchId || currentBranchId,
      workerName: currentSession.workerName || sessionWorkerName || currentUser?.name || 'Empleado',
      type: movementData.type,
      amount: amt,
      currencyCode: movementData.currencyCode,
      description: movementData.description,
      date: new Date().toISOString()
    });

    addNotification(`Movimiento de ${movementData.type === 'income' ? 'entrada' : 'salida'} registrado: ${formatMoney(amt, movementData.currencyCode)}`, 'success');
    setMovementData({ type: 'expense', amount: '', currencyCode: 'CUP', description: '' });
  };

  // Barcode scanner moved lower

  const {
    paymentLines,
    setPaymentLines,
    activePaymentLineId,
    setActivePaymentLineId,
    subtotalBase,
    taxBase,
    rawTotalBase,
    isCupBase,
    totalBase,
    totalPaidBase,
    balanceBase,
    remainingBase,
    changeBase,
    isPaid,
    getSafeRateToBase,
    toBaseAmount,
    roundBaseAmount,
    addPaymentLine,
    updatePaymentLine,
    removePaymentLine,
    autoFillRemaining,
    splitUsdPayment,
  } = usePOSPayments({ cart, currencies, baseCurrency, bankCards });

  const generateSerial = () => {
    const randomSN = `SN-${Math.floor(Math.random() * 100000000).toString().padStart(8, '0')}`;
    setConfigData({ ...configData, serialNumber: randomSN });
  };

  const {
    getProductStock,
    getCartQuantity,
    handleProductClick,
    handleCatalogOutOfStock,
    handleConfigSubmit,
  } = usePOSScanner({
    products,
    inventory,
    currentBranchId,
    currentSessionBranchId: currentSession?.branchId,
    cart,
    pendingOrders,
    addToCart,
    clearCart,
    removePendingOrder,
    selectedProduct,
    setSelectedProduct,
    configData,
    setConfigData,
    setShowConfigModal,
    showCameraScanner,
    setShowCameraScanner,
    setPosSuccess,
    setPosError,
  });

  const openCheckout = () => {
    if (!currentSession) {
      setPosError("No hay un turno de caja abierto en esta sucursal. Por favor, abre un turno para comenzar a cobrar.");
      setShowOpenShiftModal(true);
      return;
    }
    const newId = crypto.randomUUID();
    const defaultBank = bankCards.find(c => c.currency === baseCurrency.code) || bankCards[0];
    setPaymentLines([{ id: newId, code: baseCurrency.code, amount: totalBase, method: 'cash', bankCardId: defaultBank?.id }]);
    setActivePaymentLineId(newId);
    setShowCheckoutModal(true);
  };

  const {
    connectedPrinterName,
    setConnectedPrinterName,
    showPrinterSetupModal,
    setShowPrinterSetupModal,
    isConnectingPrinter,
    printerStatusMsg,
    handlePairBluetooth,
    handleConnectUsb,
    handleThermalPrint,
    handlePrintClosureThermal,
    handleWhatsAppReceipt,
    handleEmailReceipt,
  } = usePOSPrinter({
    currentSession,
    products,
    currencies,
    baseCurrency,
    branches,
    users,
    currentUser,
    salarySettlements,
    companyCompensation,
    receiptConfig,
    addNotification,
    setPosError,
    setPosSuccess,
  });

  const handleCheckout = async () => {
    if (isSubmittingCheckout) return;
    if (!currentSession) {
      setPosError('No existe un turno de caja activo para registrar esta venta.');
      setShowOpenShiftModal(true);
      return;
    }
    // Defensa en profundidad: una cuenta PALMYRA nunca puede vender usando un
    // turno o almacén que pertenezca a otra identidad/sucursal.
    if (currentUser?.role !== 'admin' && currentUser?.id) {
      const assignedBranchId = currentUser.branchId ||
        (getAuthorizedWarehouseIds(currentUser).length === 1 ? getAuthorizedWarehouseIds(currentUser)[0] : null);
      const ownsSession = currentSession.userId === currentUser.id ||
        currentSession.workingEmployeeIds?.includes(currentUser.id);
      const ownsBranch = !assignedBranchId || currentSession.branchId === assignedBranchId;
      if (!ownsSession || !ownsBranch) {
        setPosError('Tu cuenta PALMYRA solo puede vender en tu propio turno y almacén asignado.');
        setShowOpenShiftModal(true);
        return;
      }
    }
    if (!Number.isFinite(totalBase) || totalBase <= 0) {
      setPosError('El total de la venta no es válido.');
      return;
    }
    if (remainingBase > (isCupBase ? 0 : 0.01)) {
      setPosError(`Falta por cobrar ${formatMoney(remainingBase, baseCurrency.symbol)}.`);
      return;
    }
    const invalidTransfer = paymentLines.some(l =>
      l.method === 'transfer' &&
      (!l.bankCardId || !bankCards.some(c => c.id === l.bankCardId && (c.currency === l.code || (l.code === 'MN' && c.currency === 'CUP'))))
    );
    if (invalidTransfer) {
      setPosError('Seleccione una cuenta bancaria válida para cada pago por transferencia.');
      return;
    }
    setIsSubmittingCheckout(true);
    setPosError("");
    setPosSuccess("");
    try {
      const finalizedPayments = finalizeCheckoutPayments(paymentLines, currencies, baseCurrency);

    // Bloqueo estricto: Una venta NO puede crearse sin un turno abierto
    if (!currentSession) {
      setPosError("No existe un turno de caja activo para registrar esta venta. Por favor, abre un turno primero.");
      setShowOpenShiftModal(true);
      return;
    }

    const currentTransactions = useStore.getState().transactions.filter(t => !t.deletedAt);
    const activeSellerId = currentSession.userId || currentUser?.id || 'u1';
    const activeSellerName = currentSession.workerName || currentUser?.name || 'Empleado';
    const sellerUser = (users || []).find(u => u.id === activeSellerId) || currentUser;
    const effectiveBranchId = currentSession.branchId || sellerUser?.branchId || currentBranchId || (branches[0]?.id || '');
    const ticketNumber = buildTransactionTicketId(currentTransactions);
    const txId = crypto.randomUUID();

    const tx: import('../types').Transaction = {
      id: txId,
      remoteId: txId,
      ticketNumber,
      branchId: effectiveBranchId,
      userId: activeSellerId,
      sellerEmployeeIds: currentSession.workingEmployeeIds?.length ? currentSession.workingEmployeeIds : [activeSellerId],
      cashierName: activeSellerName,
      date: new Date().toISOString(),
      subtotal: subtotalBase,
      tax: taxBase,
      total: totalBase,
      items: cart,
      payments: finalizedPayments,
      status: 'completed',
      customerId: currentCustomerId,
      changeGiven: changeBase,
      changePayments: [],
      sessionId: currentSession.id
    };

    // La venta debe entrar al outbox DURABLE antes de cualquier operación
    // fiscal que pueda tardar o depender de la red. Así, si el navegador/dispositivo
    // se cierra mientras se reserva el NCF, el ticket no desaparece.
    // processTransaction volverá a encolar el mismo actionId y conservará el NCF
    // si finalmente se obtiene, sin crear una segunda operación.
    await waitForOfflineQueueReady();
    const durablePreNcf = { ...tx, offlinePending: true };
    await (await import("../services/offlineQueue")).enqueueOfflineItem(
      'transaction',
      durablePreNcf,
      tx.id
    );

    // Generate NCF if customer is selected or if config requires it.
    // El NCF es complementario al cobro. Nunca debe bloquear indefinidamente
    // una venta si la reserva fiscal está lenta o temporalmente no disponible.
    let nextNcf: string | undefined;
    try {
      nextNcf = await Promise.race([
        useStore.getState().getNextNCF('B01'),
        new Promise<string | undefined>(resolve => setTimeout(() => resolve(undefined), 7000))
      ]);
    } catch (ncfError: any) {
      // Fiscal numbering is supplemental to the sale. A temporary fiscal
      // configuration error must not cancel a valid checkout.
      console.warn('[POS] No se pudo reservar el NCF; la venta continuará sin NCF:', ncfError);
      addNotification(
        'No se pudo reservar el rango fiscal. La venta continuará sin NCF y quedará pendiente de configuración fiscal.',
        'warning',
        ncfError?.message || 'Error al reservar NCF.'
      );
    }
    if (nextNcf) {
      tx.ncf = nextNcf;
      tx.ncfType = 'B01';
    }

    // processTransaction ya protege la venta con el mismo outbox durable. No usamos
    // una Promise.race aquí porque podría liberar el botón mientras el cobro
    // real aún sigue en vuelo y permitir una segunda venta accidental.
    const saleConfirmed = await processTransaction(tx);
    if (!saleConfirmed) {
      setPosError('La venta no fue confirmada. Verifique el stock, turno y conexión antes de continuar.');
      setTimeout(() => setPosError(''), 5000);
      return;
    }

    // Register bank movements only after the sale is confirmed.
    // Aggregate multiple transfer lines hitting the same bank account into one
    // movement per account/sale, avoiding duplicate references and preserving
    // the actual amount in the bank card currency (transfers are forced to CUP).
    const transferByCard = aggregateTransferPayments(finalizedPayments);

    const itemDetails = cart.map(item => `${item.quantity}x ${item.product?.name || 'Producto'}`).join(', ');
    const bankSaveResults = await Promise.all(
      Array.from(transferByCard.entries()).map(([cardId, amount]) =>
        addBankTransaction({
          id: generateId('BTX'),
          cardId,
          type: 'payment_received',
          amount,
          date: tx.date,
          reference: tx.id,
          description: `Venta ${tx.id}: ${itemDetails.substring(0, 100)}${itemDetails.length > 100 ? '...' : ''}`,
          transactionId: tx.id
        })
      )
    );

    if (bankSaveResults.some(saved => !saved)) {
      addNotification('La venta quedó registrada, pero uno o más ingresos bancarios quedaron pendientes de sincronización.', 'warning');
    }

    // Close all checkout and mobile cart drawers cleanly
    const saleStillPending = getOfflineQueue().some(
      item => item.type === 'transaction' && item.actionId === tx.id && item.status !== 'conflict'
    );

    setShowCheckoutModal(false);
    setShowMobileCart(false);
    clearCart();
    if (saleStillPending) {
      setPosSuccess('Venta guardada localmente. Se sincronizará automáticamente cuando vuelva una conexión estable.');
      addNotification(
        'Venta guardada localmente',
        'info',
        'La venta está protegida en este dispositivo y se enviará automáticamente cuando PALMYRA recupere una conexión estable.'
      );
    } else {
      setPosSuccess('Venta registrada correctamente.');
    }
    setTimeout(() => setPosSuccess(""), saleStillPending ? 5000 : 3000);

    // Show receipt modal so cashier gets receipt details & print option
    setShowReceiptModal(tx);

      if (useStore.getState().receiptConfig.autoPrint) {
        handleThermalPrint(tx, { silent: true }).catch(console.error);
      }
    } catch (err: any) {
      console.error('[POS] Error al confirmar cobro:', err);
      const message = err?.message || 'No se pudo completar el cobro. La operación no se ha marcado como completada.';
      setPosError(message);
      setTimeout(() => setPosError(''), 8000);
    } finally {
      setIsSubmittingCheckout(false);
    }
  };

  const [sessionClosingDate, setSessionClosingDate] = useState(new Date().toISOString().split('T')[0]);

  const handleOpenSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isOpeningSession) return;

    setPosError("");
    setPosSuccess("");
    setIsOpeningSession(true);

    try {
      const rawVal = parseFloat(openingAmount);
      const val = isNaN(rawVal) || rawVal < 0 ? 0 : rawVal;

      if (!sessionBranchId) {
        setPosError("Debes seleccionar una sucursal");
        return;
      }

      const { users } = useStore.getState();
      const trimmedWorkerName = sessionWorkerName.trim();

      // Flujo obligatorio: seleccionar/buscar el empleado y después validar
      // su contraseña. Un trabajador normal solo puede seleccionar su propia
      // identidad; el administrador puede seleccionar cualquier empleado.
      if (!trimmedWorkerName) {
        setPosError("Debes buscar y seleccionar tu nombre antes de continuar.");
        return;
      }

      const workerToAssign =
        users.find(u =>
          u.isActive !== false &&
          (
            (u.name || '').trim().toLowerCase() === trimmedWorkerName.toLowerCase() ||
            u.id === sessionWorkerId
          )
        ) || null;

      if (!workerToAssign || workerToAssign.isActive === false) {
        setPosError("No se encontró un empleado activo con ese nombre. Actualiza el directorio y vuelve a seleccionar.");
        return;
      }

      // La cuenta que inició sesión identifica al usuario del sistema.
      // El administrador/propietario usa la misma contraseña de su cuenta PALMYRA;
      // los trabajadores mantienen su credencial operativa propia.
      // La sucursal queda limitada a las sucursales asignadas al trabajador seleccionado.
      const workerBranchIds = new Set(
        getAuthorizedWarehouseIds(workerToAssign)
      );
      const permittedBranchIds = currentUser?.role === 'admin'
        ? new Set((branches || []).map(b => b.id))
        : workerBranchIds;

      if (!sessionBranchId || !permittedBranchIds.has(sessionBranchId)) {
        setPosError("El trabajador seleccionado no tiene autorizada esta sucursal.");
        return;
      }

      const enteredPassword = (sessionPassword || '').trim();
      const { companyId } = await getActiveTenant();
      const skipPosPassword = localStorage.getItem(`palmyra:pos-passwords-disabled:${companyId}`) === 'true';
      if (!skipPosPassword) {

      if (!enteredPassword) {
        setPosError(
          currentUser?.role === 'admin' && workerToAssign.id === currentUser.id
            ? "Introduce tu contraseña de PALMYRA."
            : `Introduce la contraseña de ${workerToAssign.name || 'empleado'}.`
        );
        return;
      }

      // Online: Supabase es la autoridad. Después de una validación correcta
      // guardamos únicamente un verificador SHA-256 salado para poder volver a
      // abrir caja sin red. Nunca almacenamos la contraseña en el estado durable.
      // Offline: el acceso solo puede funcionar en un dispositivo que ya haya
      // validado esa credencial al menos una vez mientras tenía conexión.
      const { companyId } = await getActiveTenant();
      if (!navigator.onLine) {
        const validLocal = await verifyOfflinePosCredential(companyId, workerToAssign.id, enteredPassword);
        if (!validLocal) {
          setPosError(
            `No hay un verificador offline preparado para ${workerToAssign.name || 'empleado'}. Conecta este dispositivo y valida su clave POS una vez; PALMYRA guardará un verificador seguro para los próximos accesos sin red.`
          );
          return;
        }
      } else if (currentUser?.role === 'admin' && workerToAssign.id === currentUser.id) {
        try {
          const valid = await verifySaaSPosAccessPassword(companyId, workerToAssign.id, enteredPassword);
          if (!valid) {
            setPosError("Contraseña de la cuenta incorrecta. La contraseña del Administrador en POS es la misma que usas para entrar en PALMYRA.");
            return;
          }
          await rememberOfflinePosCredential(companyId, workerToAssign.id, enteredPassword).catch(() => {});
        } catch (error) {
          const validLocal = await verifyOfflinePosCredential(companyId, workerToAssign.id, enteredPassword);
          if (!validLocal) {
            console.error("[POS] No se pudo validar la contraseña del administrador:", error);
            setPosError("No se pudo validar la contraseña. Verifica la conexión y vuelve a intentarlo.");
            return;
          }
        }
      } else {
        try {
          const valid = await verifyEmployeePosAccessPassword(companyId, workerToAssign.id, enteredPassword);
          if (!valid) {
            setPosError(`Contraseña incorrecta para ${workerToAssign.name || 'empleado'}. Acceso denegado.`);
            return;
          }
          await rememberOfflinePosCredential(companyId, workerToAssign.id, enteredPassword).catch(() => {});
        } catch (error) {
          const validLocal = await verifyOfflinePosCredential(companyId, workerToAssign.id, enteredPassword);
          if (!validLocal) {
            console.error("[POS] No se pudo validar la contraseña del empleado:", error);
            setPosError("No se pudo validar la contraseña del empleado. Si la conexión está caída, este dispositivo aún no tiene un verificador offline para esa clave. Conecta el móvil y valida la clave una vez para sincronizarla de forma segura.");
            return;
          }
        }
      }

      } else {\n        console.info('[POS] El administrador habilitó acceso sin contraseña en este dispositivo.');
      }

      // Primero actualizamos los turnos de esta sucursal. Esto evita que un turno
      // recién creado en otra vista/terminal provoque un segundo intento falso.
      if (navigator.onLine) {
        try {
          await useStore.getState().refreshBranchOperationalData();
        } catch (refreshError) {
          console.warn('[POS] No se pudo refrescar caja antes de abrir:', refreshError);
        }
      }

      // Una caja abierta bloquea una segunda apertura. En lugar de dejar al
      // usuario frente a un error, mostramos inmediatamente la caja real para
      // reanudarla con contraseña.
      const branchOpenNow = (useStore.getState().cashSessions || []).find(s =>
        s.status === 'open' && !s.deletedAt && s.branchId === sessionBranchId
      );
      if (branchOpenNow) {
        const canResume =
          currentUser?.role === 'admin' ||
          branchOpenNow.userId === currentUser?.id ||
          branchOpenNow.workingEmployeeIds?.includes(currentUser?.id || '');
        if (canResume) {
          setJoiningSessionId(branchOpenNow.id);
          setJoiningSessionPassword("");
          setPosError("");
          setShowOpenShiftModal(false);
          return;
        }
        setPosError(
          "La caja ya tiene un turno abierto" +
          (branchOpenNow.workerName ? " (" + branchOpenNow.workerName + ")" : "") +
          ". Debes usar esa caja o pedir al administrador que cierre el turno."
        );
        return;
      }

      // Si ya existe un turno abierto para ese trabajador/sucursal, reutilizarlo.
      const existingSession = useStore.getState().getCurrentSession(sessionBranchId, workerToAssign.id);
      if (existingSession) {
        setActiveSessionId(existingSession.id);
        setCurrentBranch(existingSession.branchId);
        setSessionWorkerName(existingSession.workerName || workerToAssign.name || "");
        setSessionPassword("");
        setOpeningAmount("0");
        setShowOpenShiftModal(false);
        setPosSuccess(`Turno de ${existingSession.workerName || workerToAssign.name || 'Empleado'} ya estaba abierto. Continuando con ese turno.`);
        setTimeout(() => setPosSuccess(""), 3000);
        return;
      }

      const workerName = workerToAssign.name || trimmedWorkerName || currentUser?.name || 'Empleado';
      const workerId = workerToAssign.id || currentUser?.id || 'emp-1';

      const sessionToOpen: CashRegisterSession = {
        id: crypto.randomUUID(),
        branchId: sessionBranchId,
        openedAt: new Date().toISOString(),
        openingBalance: val,
        openingAmount: val,
        status: "open",
        userId: workerId,
        workerName,
        // La identidad operativa es exclusivamente el trabajador autenticado.
        workingEmployeeIds: [workerId]
      };

      setCurrentBranch(sessionBranchId);
      const opened = await openSession(sessionToOpen);

      if (!opened) {
        // Un timeout/race puede dejar la apertura aceptada en Supabase mientras
        // el primer intento no recibe la respuesta. Nunca debemos crear un
        // segundo turno: refrescamos y reutilizamos el turno existente.
        if (navigator.onLine) {
          try {
            await useStore.getState().refreshBranchOperationalData();
          } catch (refreshError) {
            console.warn('[POS] No se pudo recuperar el turno tras el rechazo:', refreshError);
          }

          const recovered = useStore.getState().getCurrentSession(sessionBranchId, workerId);
          if (recovered) {
            setActiveSessionId(recovered.id);
            setCurrentBranch(recovered.branchId);
            setOpeningAmount("0");
            setSessionWorkerName(recovered.workerName || workerName);
            setSessionPassword("");
            setShowOpenShiftModal(false);
            setPosSuccess("Turno de " + (recovered.workerName || workerName) + " ya estaba abierto. Continuando con ese turno.");
            setTimeout(() => setPosSuccess(""), 3000);
            return;
          }

          const branchOpen = (useStore.getState().cashSessions || []).find(s =>
            s.status === 'open' &&
            !s.deletedAt &&
            s.branchId === sessionBranchId
          );
          if (branchOpen) {
            const canResume =
              currentUser?.role === 'admin' ||
              branchOpen.userId === currentUser?.id ||
              branchOpen.workingEmployeeIds?.includes(currentUser?.id || '');
            if (canResume) {
              setJoiningSessionId(branchOpen.id);
              setJoiningSessionPassword("");
              setPosError("");
              setShowOpenShiftModal(false);
              return;
            }
            setPosError(
              "La caja ya tiene un turno abierto" +
              (branchOpen.workerName ? " (" + branchOpen.workerName + ")" : "") +
              ". Debes usar esa caja o pedir al administrador que cierre el turno."
            );
            return;
          }
        }

        setPosError("No se pudo abrir el turno. Verifica la conexión y vuelve a intentarlo. PALMYRA no creará un turno duplicado.");
        return;
      }

      // Confirmar que el turno realmente está visible para este terminal.
      // Si el servidor lo aceptó pero el caché quedó desfasado, recuperar el
      // snapshot operativo antes de mostrar el POS.
      let verifiedSession =
        useStore.getState().cashSessions.find(s =>
          s.status === 'open' &&
          !s.deletedAt &&
          s.branchId === sessionBranchId &&
          (s.userId === workerId || s.workingEmployeeIds?.includes(workerId))
        );

      if (!verifiedSession && navigator.onLine) {
        await useStore.getState().refreshBranchOperationalData();
        verifiedSession = useStore.getState().cashSessions.find(s =>
          s.status === 'open' &&
          !s.deletedAt &&
          s.branchId === sessionBranchId &&
          (s.userId === workerId || s.workingEmployeeIds?.includes(workerId))
        );
      }

      if (!verifiedSession) {
        // Si el servidor aceptó la operación pero aún no llegó el refresh,
        // no bloqueamos al POS: la sesión devuelta por openSession tiene el ID
        // oficial y es el registro que debemos activar localmente.
        verifiedSession = useStore.getState().cashSessions.find(
          s => s.id === sessionToOpen.id && s.status === 'open' && !s.deletedAt
        );
      }

      if (!verifiedSession) {
        setPosError("El turno fue procesado, pero esta terminal no pudo confirmar el estado del turno. Revisa la conexión y vuelve a abrir con la misma contraseña; no se creará otro turno.");
        return;
      }

      setActiveSessionId(verifiedSession.id);
      setOpeningAmount("0");
      setSessionWorkerName(verifiedSession.workerName || workerName);
      setSessionPassword("");
      setShowOpenShiftModal(false);
      setPosSuccess(`Turno abierto correctamente por ${verifiedSession.workerName || workerName}`);
      setTimeout(() => setPosSuccess(""), 3000);
    } catch (err: any) {
      console.error("[POS] Error inesperado al abrir turno:", err);
      setPosError(err?.message || "No se pudo abrir el turno. Verifica la conexión y vuelve a intentarlo.");
    } finally {
      setIsOpeningSession(false);
    }
  };

  const handleJoinExistingSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joiningSessionId) return;

    const targetSession = (activeCashSessions || []).find(s => s.id === joiningSessionId && s.status === 'open' && !s.deletedAt);
    if (!targetSession) {
      setPosError("Ese turno ya no está abierto. Actualiza la pantalla y selecciona otro trabajador.");
      return;
    }

    const targetUser =
      (users || []).find(u =>
        u.id === targetSession.userId ||
        (u.name || '').trim().toLowerCase() === (targetSession.workerName || '').trim().toLowerCase()
      ) ||
      (currentUser?.id === targetSession.userId ? currentUser : null);
    if (!targetUser) {
      setPosError("No se pudo identificar al trabajador dueño del turno.");
      return;
    }

    if (currentUser?.role !== 'admin') {
      const assignedBranchIds = getAuthorizedWarehouseIds(currentUser);
      const assignedBranchId = getWarehouseId(currentUser) ||
        (assignedBranchIds.length === 1 ? assignedBranchIds[0] : null);
      const ownIdentity = targetSession.userId === currentUser?.id ||
        targetSession.workingEmployeeIds?.includes(currentUser?.id || '');
      const ownBranch = !assignedBranchId || targetSession.branchId === assignedBranchId;
      if (!ownIdentity || !ownBranch) {
        setPosError('Una cuenta PALMYRA solo puede reanudar su propio turno en su almacén asignado.');
        return;
      }
    }

    const targetBranchIds = new Set(
      getAuthorizedWarehouseIds(targetUser)
    );

    if (targetBranchIds.size > 0 && !targetBranchIds.has(targetSession.branchId) && currentUser?.role !== 'admin') {
      setPosError("El trabajador del turno no tiene autorizada esa sucursal.");
      return;
    }

    const enteredPassword = (joiningSessionPassword || '').trim();

    let companyId: string;
    try {
      ({ companyId } = await getActiveTenant());
    } catch (tenantError) {
      // navigator.onLine puede seguir en true durante una caída real de red.
      // El alcance local ya validado identifica la misma empresa sin convertir
      // un fallo de transporte en un bloqueo del POS.
      const localScope = getPalmyraLocalScope();
      if (!localScope?.companyId) throw tenantError;
      companyId = localScope.companyId;
    }

    // La credencial que debe desbloquear el turno depende de quién está
    // reanudando:
    // - el administrador, si está retomando su propia caja, usa su contraseña PALMYRA;
    // - un trabajador que forma parte del turno usa su propia contraseña;
    // - el administrador que recupera una caja de un empleado sigue necesitando
    //   la credencial del empleado propietario del turno para no cambiar la
    //   atribución de las ventas.
    const isAdminOwnSession =
      currentUser?.role === 'admin' && targetSession.userId === currentUser.id;
    const isWorkerSharingSession =
      currentUser?.role !== 'admin' &&
      currentUser?.id &&
      targetSession.workingEmployeeIds?.includes(currentUser.id);
    const credentialUserId = isWorkerSharingSession
      ? currentUser!.id
      : targetSession.userId;
    const credentialUser = (users || []).find(u => u.id === credentialUserId) || targetUser;

    let authorized = false;

    if (!navigator.onLine) {
      // Primero usamos el permiso local generado cuando este mismo usuario
      // recibió el turno abierto mientras estaba conectado. Esto permite
      // "online -> descargar turno -> perder red -> reanudar" sin exigir una
      // segunda consulta a Supabase ni depender de que exista un verificador
      // de la contraseña del trabajador en este dispositivo.
      const resumeGrant = currentUser?.id
        ? verifyOfflinePosResumeGrant(companyId, currentUser.id, targetSession.id)
        : false;
      if (resumeGrant) {
        authorized = true;
      } else if (enteredPassword) {
        authorized = await verifyOfflinePosCredential(
          companyId,
          credentialUserId,
          enteredPassword
        );
      }

      if (!authorized) {
        setPosError(
          "Este turno no fue autorizado previamente para reanudación offline en este dispositivo. " +
          "Conéctate una vez mientras el turno esté abierto para descargar y habilitar su reanudación sin conexión."
        );
        return;
      }
    } else if (isAdminOwnSession) {
      if (!enteredPassword) {
        setPosError("Introduce la contraseña de PALMYRA para reanudar este turno.");
        return;
      }
      try {
        const valid = await verifySaaSPosAccessPassword(
          companyId,
          credentialUserId,
          enteredPassword
        );
        if (!valid) {
          setPosError("Contraseña de PALMYRA incorrecta. No se puede reanudar el turno.");
          return;
        }
        await rememberOfflinePosCredential(companyId, credentialUserId, enteredPassword).catch(() => {});
      } catch (error) {
        // navigator.onLine puede seguir en true durante una caída real de
        // conectividad. El verificador local permite reanudar sin red.
        console.warn("[POS] Validación remota del administrador no disponible al reanudar:", error);
        const localValid = await verifyOfflinePosCredential(
          companyId,
          credentialUserId,
          enteredPassword
        );
        if (!localValid) {
          setPosError("No se pudo validar tu contraseña. Conecta este dispositivo una vez con la contraseña correcta para habilitar la reanudación offline.");
          return;
        }
      }
    } else {
      if (!enteredPassword) {
        setPosError(
          "Introduce la contraseña de " +
          (credentialUser?.name || targetUser.name || 'empleado') +
          " para reanudar este turno."
        );
        return;
      }
      try {
        const valid = await verifyEmployeePosAccessPassword(
          companyId,
          credentialUserId,
          enteredPassword
        );
        if (!valid) {
          setPosError(
            "Contraseña incorrecta para " +
            (credentialUser?.name || targetUser.name || 'empleado') +
            ". Acceso denegado."
          );
          return;
        }
        await rememberOfflinePosCredential(companyId, credentialUserId, enteredPassword).catch(() => {});
      } catch (error) {
        console.warn("[POS] Validación remota del empleado no disponible al reanudar:", error);
        const localValid = await verifyOfflinePosCredential(
          companyId,
          credentialUserId,
          enteredPassword
        );
        if (!localValid) {
          setPosError(
            "No se pudo validar offline la contraseña de " +
            (credentialUser?.name || targetSession.workerName || 'empleado') +
            ". Conecta este dispositivo una vez para habilitar el acceso offline."
          );
          return;
        }
      }
    }

    // Reanudar no convierte la cuenta que inició sesión en el trabajador del turno.
    // La identidad operativa sigue siendo targetSession.userId.
    setActiveSessionId(targetSession.id);
    setSessionWorkerName(targetUser.name || targetSession.workerName || "");
    setSessionPassword("");
    setCurrentBranch(targetSession.branchId);
    setJoiningSessionId(null);
    setPosError("");
    setPosSuccess(`Turno de ${targetSession.workerName || 'Empleado'} reanudado correctamente.`);
    setTimeout(() => setPosSuccess(""), 3000);
  };

  const handleAddCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = generateId('CST');
    const saved = await addCustomer({ id, ...newCustomer });
    if (!saved) return;
    setCartCustomer(id);
    setShowAddCustomerModal(false);
    setNewCustomer({ name: '', phone: '', email: '', taxId: '' });
  };


  return (
    <div
      className="pos-page h-full flex flex-col min-h-0 relative text-[9px]" style={{ WebkitTextSizeAdjust: "100%", textSizeAdjust: "100%" }}
    >
      {/* Global High-Priority Toast Overlay */}
      {(posError || posSuccess) && (
        <div className="fixed top-2 sm:top-6 left-1/2 -translate-x-1/2 z-[200] w-[calc(100vw-1rem)] sm:w-full max-w-md min-w-0 px-0 sm:px-4 animate-in fade-in slide-in-from-top-4 duration-300">
          {posError && (
            <div className="bg-rose-600 text-white px-5 py-3.5 rounded-2xl shadow-2xl flex items-center justify-between gap-3 border border-rose-500">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <span className="text-xs font-black uppercase tracking-wide leading-tight">{posError}</span>
              </div>
              <button onClick={() => setPosError("")} className="p-1 hover:bg-white/10 rounded-lg text-white/80 hover:text-white shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {posSuccess && (
            <div className="bg-emerald-600 text-white px-5 py-3.5 rounded-2xl shadow-2xl flex items-center justify-between gap-3 border border-emerald-500">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-5 h-5 shrink-0" />
                <span className="text-xs font-black uppercase tracking-wide leading-tight">{posSuccess}</span>
              </div>
              <button onClick={() => setPosSuccess("")} className="p-1 hover:bg-white/10 rounded-lg text-white/80 hover:text-white shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}
      {!currentSession && (
        <Suspense fallback={null}>
          <POSStartupScreen {...{ activeCashSessions, allowedBranches, baseCurrency, branches, currencies, currentSession, currentUser, detectedWorker, employeePickerOpen, employeePickerRef, employeePickerSearch, handleJoinExistingSession, handleOpenSession, handlePrintClosureThermal, isBranchLocked, isOnline, isOpeningSession, isRefreshingOpenSessions, joiningSessionId, joiningSessionPassword, lastClosedSession, logout, navigate, openSessionForWorker, openSessionsForResume, openingAmount, posError, posSuccess, refreshOpenSessions, sessionBranchId, sessionPassword, sessionWorkerName, setEmployeePickerOpen, setEmployeePickerSearch, setJoiningSessionId, setJoiningSessionPassword, setOpeningAmount, setPosError, setPosSuccess, setSessionBranchId, setSessionPassword, setSessionWorkerId, setSessionWorkerName, setShowOpenSessionsModal, setShowOpenShiftModal, showOpenSessionsModal, showOpenShiftModal, users }} />
        </Suspense>
      )}

      {/* Checkout Modal - Compact & Linear Redesign */}
      {showCheckoutModal && (
        <Suspense
          fallback={
            <div className="pos-keyboard-overlay fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[80] flex items-center justify-center p-4">
              <div className="palmyra-mobile-modal keyboard-modal-surface bg-white dark:bg-slate-900 rounded-2xl p-5 shadow-2xl text-center text-[9px] font-bold text-slate-500">
                Cargando cobro…
              </div>
            </div>
          }
        >
          <CheckoutModal
            totalBase={totalBase}
            baseCurrency={baseCurrency}
            currencies={currencies}
            totalPaidBase={totalPaidBase}
            remainingBase={remainingBase}
            changeBase={changeBase}
            paymentLines={paymentLines}
            activePaymentLineId={activePaymentLineId}
            bankCards={bankCards}
            isSubmittingCheckout={isSubmittingCheckout}
            onClose={() => {
              setShowCheckoutModal(false);
              setPaymentLines([]);
              setActivePaymentLineId(null);
            }}
            onAddPaymentLine={addPaymentLine}
            onRemovePaymentLine={removePaymentLine}
            onUpdatePaymentLine={updatePaymentLine}
            onSetActivePaymentLine={setActivePaymentLineId}
            lockedPaymentMethod={paymentLines[0]?.method || 'cash'}
            onAutoFillRemaining={autoFillRemaining}
            onSplitUsdPayment={splitUsdPayment}
            onHandleCheckout={handleCheckout}
            onCopyFeedback={(message) => {
              setPosSuccess(message);
              setTimeout(() => setPosSuccess(""), 2000);
            }}
          />
        </Suspense>
      )}
      {/* Cash Management Modal */}
      {showCashManagementModal && currentSession && (
        <Suspense fallback={null}>
          <POSCashManagementModal {...{ activeTransactions, addNotification, bankCards, baseCurrency, cashDisplayCurrencies, cashManagementTab, closingBalances, companyCompensation, currencies, currentSession, currentUser, expectedBalances, formatSalaryCUP, handleAddMovement, handleClose, handlePrintClosureThermal, handleThermalPrint, isClosingSession, movementData, products, removeCashMovement, salesFilter, salesSubTab, sessionClosingDate, sessionWorkerName, setCashManagementTab, setClosingBalances, setMovementData, setSalesFilter, setSalesSubTab, setSessionClosingDate, setShowCashManagementModal, setShowReceiptModal, showCashManagementModal, turnProductSalaryRows, users }} />
        </Suspense>
      )}

      {/* Discrepancy Modal */}
      {showDiscrepancyModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="palmyra-mobile-modal bg-white rounded-2xl sm:rounded-[2rem] shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 border border-rose-100 flex flex-col max-h-[calc(100dvh-1rem)]">
            <div className="p-3 sm:p-6 text-center space-y-2.5 sm:space-y-4 shrink-0 border-b border-slate-100 bg-rose-50/30">
              <div className="w-16 h-16 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center mx-auto shadow-inner">
                <AlertCircle className="w-8 h-8" />
              </div>
              <div>
                <h3 className="text-lg font-black text-slate-900 uppercase tracking-tighter">Discrepancia Detectada</h3>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">Revisión del Descuadre</p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-3 sm:space-y-6">
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-3">Resumen de Descuadres</p>
                    <div className="space-y-2">
                      {expectedBalances.map(eb => {
                        const actual = finalBalancesToClose.find(fb => fb.currencyCode === eb.currencyCode && fb.method === eb.method)?.amount || 0;
                        const diff = actual - eb.amount;
                        if (Math.abs(diff) < 0.01) return null;
                        
                        return (
                          <div key={`${eb.currencyCode}-${eb.method}`} className="space-y-2 border-b border-slate-200 pb-2 last:border-0 last:pb-0">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold text-slate-600 uppercase">{eb.currencyCode} ({eb.method === 'cash' ? 'Efectivo' : 'Transf.'})</span>
                              <span className={cn(
                                "text-xs font-black",
                                diff > 0 ? "text-emerald-600" : "text-rose-600"
                              )}>
                                {diff > 0 ? 'SOBRANTE: ' : 'FALTANTE: '}{Math.abs(diff).toLocaleString('es-CU')}
                              </span>
                            </div>
                            

                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="p-4 bg-rose-50 rounded-2xl border border-rose-100 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-[10px] font-black text-rose-900 uppercase tracking-widest">¿Descontar faltante del salario?</p>
                        <p className="text-[8px] font-bold text-rose-500 uppercase">Se aplicará automáticamente a la liquidación</p>
                      </div>
                      <button 
                        type="button"
                        onClick={() => setDeductFromSalary(!deductFromSalary)}
                        className={cn(
                          "w-12 h-6 rounded-full transition-all relative border-2",
                          deductFromSalary ? "bg-rose-600 border-rose-600" : "bg-slate-200 border-slate-200"
                        )}
                      >
                        <div className={cn(
                          "w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-sm",
                          deductFromSalary ? "left-6" : "left-1"
                        )} />
                      </button>
                    </div>
                </div>
            </div>

            <div className="p-6 bg-slate-50 border-t border-slate-100 flex gap-3 shrink-0">
              <button 
                onClick={() => setShowDiscrepancyModal(false)}
                className="flex-1 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-50 transition-colors shadow-sm"
              >
                Volver a Revisar
              </button>
              <button 
                onClick={confirmClose}
                disabled={isClosingSession}
                className="flex-1 py-3 bg-rose-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-rose-700 transition-all shadow-lg shadow-rose-200 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isClosingSession ? "Confirmando..." : "Forzar Cierre"}
              </button>
            </div>
          </div>
        </div>
      )}

      <POSConfigProductModal
        open={showConfigModal}
        product={selectedProduct}
        configData={configData}
        setConfigData={setConfigData}
        generateSerial={generateSerial}
        inventory={inventory}
        branchId={currentSession?.branchId || currentBranchId}
        onSubmit={handleConfigSubmit}
        onClose={() => {
          setShowConfigModal(false);
          setConfigData({});
        }}
      />

      {/* POS Tablet & Desktop Professional Top Bar */}
      <header className="bg-slate-900 text-white px-3 sm:px-4 py-2 flex items-center justify-between gap-2 border-b border-slate-800 shrink-0 z-20">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="flex items-center gap-1.5 bg-slate-800/90 px-2.5 py-1 rounded-lg border border-slate-700/80">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="text-[8px] font-black uppercase tracking-[0.05em] text-slate-200 truncate max-w-[100px] sm:max-w-[140px]">
              {currentSession?.workerName || currentUser?.name || 'Caja Activa'}
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-1.5 text-slate-400 text-[8px] font-bold">
            <span>•</span>
            <span className="truncate max-w-[160px] text-slate-300 flex items-center gap-1.5">
              {branches.find(b => b.id === currentBranchId)?.name || branches[0]?.name || 'Sucursal General'}
              {isBranchLocked && (
                <span className="flex items-center gap-0.5 bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded text-[8px] border border-amber-500/30">
                  <Lock className="w-2.5 h-2.5" /> Bloqueado
                </span>
              )}
            </span>
          </div>

          {/* Exchange Rates Ticker */}
          <div className="hidden md:flex items-center gap-2 bg-indigo-950/60 border border-indigo-500/20 px-2.5 py-1 rounded-lg">
            {currencies.filter(c => !c.isBase).slice(0, 2).map(c => (
              <span key={c.code} className="text-[8px] font-black text-indigo-300">
                1 {c.code} = {c.rateToBase.toLocaleString('es-CU')} {baseCurrency.code}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Cierre de Caja Button - High Priority & Clearly Visible */}
          <button
            type="button"
            onClick={() => {
              setCashManagementTab('close');
              setShowCashManagementModal(true);
            }}
            className="px-2.5 sm:px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[8px] sm:text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 shadow-md shadow-rose-950/40 active:scale-95 border border-rose-500/40"
            title="Cerrar Caja y Finalizar Turno"
          >
            <Lock className="w-3.5 h-3.5 text-rose-200" />
            <span>Cerrar Caja</span>
          </button>

          {/* Cancelar Turno Button */}
          {currentSession && (
            <button
              type="button"
              onClick={() => setShowCancelShiftModal(true)}
              className="px-2 sm:px-2.5 py-1 bg-slate-100 hover:bg-rose-50 text-rose-600 rounded-lg text-[8px] sm:text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 border border-slate-200 active:scale-95"
              title="Anular Turno Completo"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="hidden xs:inline">Cancelar Turno</span>
            </button>
          )}

          {/* Printer Config (voluntary, never intrusive) */}
          <button
            type="button"
            onClick={() => setShowPrinterSetupModal(true)}
            className="p-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 transition-all active:scale-95"
            title="Configurar Impresora Térmica"
          >
            <Printer className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0 bg-slate-100 overflow-hidden relative">
        
        <POSCatalog
          baseCurrencySymbol={baseCurrency.symbol}
          currentUserRole={currentUser?.role}
          showMobileCart={showMobileCart}
          onSelectConfiguredProduct={handleProductClick}
          onOutOfStock={handleCatalogOutOfStock}
        />

        {/* Sidebar: Cart / Ticket (Side-by-side on Tablet md+ and Desktop, overlay on Mobile) */}
        {Boolean(currentSession) && (
          <aside className={cn(
            "w-full md:w-[310px] lg:w-[340px] xl:w-[360px] bg-secondary border-l border-base flex flex-col shrink-0 z-50 transition-all duration-300",
            showMobileCart ? "fixed inset-0 md:relative md:inset-auto" : "hidden md:flex"
          )}>
          {/* Sidebar Header */}
          <div className="h-12 border-b border-base flex items-center justify-between px-3.5 shrink-0 bg-subtle">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-xs">
                <Receipt className="w-3.5 h-3.5" />
              </div>
              <div>
                <h3 className="font-black text-[11px] uppercase tracking-wider text-primary leading-none">Ticket de Venta</h3>
                <p className="text-[8px] font-bold text-muted uppercase tracking-tight mt-0.5">{cart.reduce((s, i) => s + i.quantity, 0)} {cart.reduce((s, i) => s + i.quantity, 0) === 1 ? 'artículo' : 'artículos'}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={clearCart} className="p-1.5 text-muted hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-lg transition-all" title="Limpiar Ticket">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setShowMobileCart(false)} className="md:hidden p-1.5 text-muted hover:bg-subtle rounded-lg transition-all">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Customer Selector */}
          <div className="p-2.5 bg-secondary border-b border-base flex gap-1.5">
            <div className="flex-1 relative">
              <User className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted" />
              <select 
                value={currentCustomerId || ""}
                onChange={(e) => setCartCustomer(e.target.value || undefined)}
                className="w-full pl-7 pr-3 py-1.5 bg-subtle border border-base rounded-lg outline-none text-[9px] font-bold uppercase tracking-tight text-primary focus:ring-1 focus:ring-indigo-500 transition-all appearance-none"
              >
                <option value="">Consumidor Final</option>
                {customers.map(c => (<option key={c.id} value={c.id}>{c?.name || "Cliente"}</option>))}
              </select>
            </div>
            <button onClick={() => setShowAddCustomerModal(true)} className="p-1.5 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 rounded-lg border border-indigo-100 dark:border-indigo-900 hover:bg-indigo-100 transition-all" title="Registrar Cliente">
              <UserPlus className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Cart Items */}
          <div className="flex-1 overflow-y-auto p-2.5 custom-scrollbar space-y-2">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted py-12 space-y-3">
                <div className="w-12 h-12 bg-subtle rounded-full flex items-center justify-center">
                  <ShoppingCart className="w-6 h-6 text-muted" />
                </div>
                <div className="text-center">
                  <p className="text-[10px] font-black uppercase tracking-wider text-secondary mb-0.5">Ticket Vacío</p>
                  <p className="text-[8px] font-medium uppercase text-muted">Toca productos del inventario</p>
                </div>
              </div>
            ) : (
              cart.map(item => {
                const prodObj = typeof (item.product as any) === 'object' && item.product !== null ? item.product : (products.find(p => p.id === (item.product as any)) || null);
                const prodName = (prodObj?.name || (typeof (item.product as any) === 'string' ? (item.product as any) : 'Producto')) as string;
                const prodPrice = prodObj?.price ?? item.price ?? 0;
                const prodImg = prodObj?.image || '';
                const prodColor = prodObj?.color || '';
                const prodId = (prodObj?.id || (typeof (item.product as any) === 'string' ? (item.product as any) : '')) as string;
                const prodHasSerial = prodObj?.hasSerial ?? false;

                return (
                  <div key={item.id} className="p-1.5 sm:p-2 rounded-xl bg-subtle border border-base hover:bg-secondary transition-colors flex gap-2">
                    <div className="w-9 h-9 sm:w-10 sm:h-10 bg-secondary rounded-lg overflow-hidden shrink-0 border border-base">
                      {prodImg ? (
                        <img 
                          src={prodImg} 
                          className="w-full h-full object-cover" 
                          referrerPolicy="no-referrer" 
                          onError={(e) => {
                            e.currentTarget.onerror = null;
                            e.currentTarget.src = '';
                            e.currentTarget.style.display = 'none';
                          }}
                         loading="lazy" decoding="async" />
                      ) : (
                        <div className={cn("w-full h-full opacity-20 flex items-center justify-center font-bold text-[9px] text-muted", prodColor)}>
                          {(prodName || "PR").substring(0, 2).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="flex justify-between items-start gap-1">
                        <div className="min-w-0 flex-1">
                          <h4 className="text-[10px] font-bold text-primary leading-tight line-clamp-1">{prodName}</h4>
                          <p className="text-[8px] font-semibold text-muted">{formatMoney(prodPrice, baseCurrency.symbol)} / u.</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-[9px] sm:text-[10px] font-black text-primary font-mono">{formatMoney(prodPrice * item.quantity, baseCurrency.symbol)}</span>
                          <button
                            type="button"
                            onClick={() => updateCartQty(item.id, -item.quantity)}
                            className="p-0.5 text-muted hover:text-rose-500 rounded transition-colors cursor-pointer"
                            title="Eliminar producto"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-1 pt-0.5">
                        <div className="flex items-center bg-secondary rounded-md p-0.5 border border-base">
                          <button 
                            onClick={() => updateCartQty(item.id, -1)} 
                            className="p-0.5 sm:p-1 rounded hover:bg-subtle text-secondary hover:text-rose-500 transition-all active:scale-90 cursor-pointer"
                            title="Disminuir"
                          >
                            <Minus className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                          </button>
                          <span className="w-5 text-center text-[10px] font-black text-primary font-mono">{item.quantity}</span>
                          <button 
                            onClick={() => {
                              if (getCartQuantity(prodId, item.variantLabel) >= getProductStock(prodId, item.variantLabel)) {
                                setPosError("Stock insuficiente"); setTimeout(() => setPosError(""), 3000);
                              } else updateCartQty(item.id, 1);
                            }} 
                            disabled={prodHasSerial}
                            className="p-0.5 sm:p-1 rounded hover:bg-subtle text-secondary hover:text-indigo-600 transition-all disabled:opacity-20 active:scale-90 cursor-pointer"
                            title="Aumentar"
                          >
                            <Plus className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                          </button>
                        </div>
                        <div className="flex gap-1 flex-wrap justify-end">
                          {item.variantLabel && <span className="px-1 py-0.2 bg-subtle text-secondary text-[7px] font-black rounded uppercase border border-base">{item.variantLabel}</span>}
                          {item.serialNumber && <span className="px-1 py-0.2 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 text-[7px] font-black rounded border border-indigo-100 dark:border-indigo-900">SN: {item.serialNumber}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer Summary */}
          <div className="p-3 bg-secondary border-t border-base space-y-2.5">
            <div className="space-y-1">
              <div className="flex justify-between text-[9px] font-bold text-muted uppercase tracking-wider">
                <span>Subtotal</span>
                <span className="text-primary font-black">{formatMoney(subtotalBase, baseCurrency.symbol)}</span>
              </div>
              <div className="flex justify-between items-center pt-1 border-t border-base">
                <span className="text-[9px] font-black text-primary uppercase tracking-wider">Total</span>
                <span className="text-lg font-black text-indigo-600 dark:text-indigo-400 tracking-tight">{formatMoney(totalBase, baseCurrency.symbol)}</span>
              </div>
            </div>

            <button
              disabled={cart.length === 0}
              onClick={() => openCheckout()}
              className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black text-[10px] uppercase tracking-wider transition-all shadow-md shadow-indigo-600/20 disabled:opacity-20 active:scale-98 flex items-center justify-center gap-1.5"
            >
              <Receipt className="w-4 h-4" />
              Cobrar
            </button>
          </div>
        </aside>
      )}
      </div>

      {showReceiptModal && (
        <POSReceiptModal
          showReceiptModal={showReceiptModal}
          products={products}
          currencies={currencies}
          baseCurrency={baseCurrency}
          formatMoney={formatMoney}
          onClose={() => setShowReceiptModal(null)}
          onWhatsAppReceipt={handleWhatsAppReceipt}
          onThermalPrint={handleThermalPrint}
        />
      )}

      {returnConfirm && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-sm overflow-hidden animate-in zoom-in-95 border border-rose-100">
            <div className="p-8 text-center space-y-4">
              <div className="w-16 h-16 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center mx-auto mb-2 animate-bounce">
                <ArrowLeftRight className="w-8 h-8" />
              </div>
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest">¿Confirmar Devolución?</h3>
              <p className="text-[10px] font-bold text-slate-500 uppercase leading-relaxed">
                Estás a punto de devolver <span className="text-rose-600">{returnConfirm.item.quantity}x {typeof returnConfirm.item.product === "object" ? (returnConfirm.item.product?.name || "Producto") : (products.find(p => p.id === returnConfirm.item.product)?.name || returnConfirm.item.product || "Producto")}</span>. 
                Esto reintegrará el stock a la sucursal actual.
              </p>
              <div className="grid grid-cols-2 gap-3 pt-4">
                <button 
                  onClick={() => setReturnConfirm(null)}
                  className="py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                >
                  Cancelar
                </button>
                <button 
                  onClick={handleReturnItem}
                  className="py-3 bg-rose-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-rose-700 transition-all shadow-lg shadow-rose-200 active:scale-95"
                >
                  Confirmar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showSalarySummary && lastClosedSession && (
        <Suspense fallback={null}>
          <POSSalarySummaryModal {...{ activeTransactions, baseCurrency, companyCompensation, currentUser, formatSalaryCUP, handlePrintClosureThermal, lastClosedSession, navigate, products, salarySettlements, setShowSalarySummary, showSalarySummary, users }} />
        </Suspense>
      )}

      <POSAddCustomerModal
        open={showAddCustomerModal}
        value={newCustomer}
        setValue={setNewCustomer}
        onSubmit={handleAddCustomer}
        onClose={() => setShowAddCustomerModal(false)}
      />

      {/* Mobile Cart & Quick Checkout Bottom Bar: Visible ONLY on small mobile screens (< md) */}
      {Boolean(currentSession) && !showMobileCart && (
        isBottomBarMinimized ? (
          <button
            type="button"
            onClick={() => setIsBottomBarMinimized(false)}
            className="md:hidden fixed bottom-3 right-3 z-40 bg-slate-900 text-white p-2.5 rounded-2xl shadow-2xl border border-slate-700 flex items-center gap-2 active:scale-95 animate-in fade-in"
            title="Expandir barra de ticket"
          >
            <div className="relative shrink-0">
              <ShoppingCart className="w-4 h-4 text-indigo-400" />
              {cart.length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 bg-rose-500 text-white text-[8px] font-black w-3.5 h-3.5 rounded-full flex items-center justify-center border border-slate-900">
                  {cart.reduce((s, i) => s + i.quantity, 0)}
                </span>
              )}
            </div>
            <span className="text-[9px] font-black uppercase pr-1">
              {cart.length === 0 ? "Ticket" : formatMoney(totalBase, baseCurrency.symbol)}
            </span>
            <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
          </button>
        ) : (
          <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-900/98 text-white px-3 py-2 pb-[max(0.625rem,env(safe-area-inset-bottom,12px))] shadow-[0_-8px_30px_rgba(0,0,0,0.3)] border-t border-slate-800 flex items-center justify-between gap-2 animate-in slide-in-from-bottom-2">
            <div 
              onClick={() => setShowMobileCart(true)}
              className="flex items-center gap-2 cursor-pointer flex-1 min-w-0"
            >
              <div className="relative shrink-0">
                <div className="w-8 h-8 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-md shadow-indigo-950">
                  <ShoppingCart className="w-3.5 h-3.5" />
                </div>
                {cart.length > 0 && (
                  <span className="absolute -top-1 -right-1 bg-rose-500 text-white text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center border border-slate-900 animate-pulse">
                    {cart.reduce((s, i) => s + i.quantity, 0)}
                  </span>
                )}
              </div>
              <div className="min-w-0">
                <div className="text-[8px] font-black text-slate-400 uppercase tracking-widest leading-none mb-0.5 truncate">
                  {cart.length === 0 ? "Ticket" : "Total"}
                </div>
                <div className="text-xs font-black text-white truncate">
                  {cart.length === 0 ? "0 prod." : formatMoney(totalBase, baseCurrency.symbol)}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setShowMobileCart(true)}
                className="h-8 px-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1 active:scale-95 border border-slate-700 shadow-sm"
              >
                <Receipt className="w-3.5 h-3.5 text-indigo-400" />
                <span>Ticket</span>
              </button>
              <button
                type="button"
                disabled={cart.length === 0}
                onClick={() => openCheckout()}
                className="h-8 px-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-[9px] font-black uppercase tracking-wider transition-all shadow-lg shadow-indigo-950 active:scale-95 flex items-center gap-1 disabled:opacity-40 disabled:pointer-events-none disabled:shadow-none"
              >
                <Receipt className="w-3.5 h-3.5" />
                <span>Cobrar</span>
              </button>
              <button
                type="button"
                onClick={() => setIsBottomBarMinimized(true)}
                className="h-8 w-7 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-xl transition-colors flex items-center justify-center shrink-0 border border-slate-700"
                title="Minimizar barra"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )
      )}

      <POSClosurePrintArea
        session={lastClosedSession}
        transactions={activeTransactions}
        products={products}
        users={users}
        currentUser={currentUser}
        branches={branches}
        receiptConfig={receiptConfig}
        baseCurrency={baseCurrency}
        formatMoney={formatMoney}
        formatSalaryCUP={(value) =>
          `${Math.round(Number(value) || 0).toLocaleString("es-ES")} CUP`
        }
        companyCompensation={companyCompensation}
        salarySettlement={lastClosedSession ? salarySettlements.find(s => s.sessionId === lastClosedSession.id) : null}
      />

      {showPrinterSetupModal && (
        <POSPrinterSetupModal
          connectedPrinterName={connectedPrinterName}
          printerStatusMsg={printerStatusMsg}
          isConnectingPrinter={isConnectingPrinter}
          onClose={() => setShowPrinterSetupModal(false)}
          onPairBluetooth={handlePairBluetooth}
          onConnectUsb={handleConnectUsb}
          onPrinterConnectedChange={setConnectedPrinterName}
          printerWidth={(receiptConfig.printerWidth || '58mm') as '58mm' | '80mm'}
          onSuccess={(message) => {
            setPosSuccess(message);
            if (message) setTimeout(() => setPosSuccess(""), 2500);
          }}
          onError={(message) => {
            setPosError(message);
            if (message) setTimeout(() => setPosError(""), 3000);
          }}
        />
      )}

      <POSCancelShiftModal
        open={showCancelShiftModal}
        isCancelling={isCancellingShift}
        onCancel={handleCancelShift}
        onClose={() => {
          setShowCancelShiftModal(false);
        }}
      />

    </div>
  );
}