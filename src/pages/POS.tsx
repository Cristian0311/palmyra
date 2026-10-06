import React, { lazy, Suspense, useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { Search, Wifi, WifiOff, RefreshCw, Plus, Minus, CreditCard, Receipt, Trash2, ShoppingCart, ShieldCheck, DollarSign, Banknote, QrCode, ArrowLeftRight, UserPlus, X, Lock, Unlock, Camera, AlertCircle, TrendingUp, Wallet, MessageSquare, Mail, HelpCircle, Calculator, ArrowRight, Package, User, RotateCcw, Printer, Bluetooth, Usb, Smartphone, Send, Copy, Check, CheckCircle, Share2, Store, ChevronDown, ChevronUp, Filter } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn, generateId } from "../lib/utils";
import { useStore } from "../store/useStore";
import { Product, Payment, Transaction, CashRegisterSession } from "../types";
import { InfoTooltip } from "../components/InfoTooltip";
import { waitForOfflineQueueReady } from "../services/offlineQueue";
import { getActiveTenant } from "../services/tenant";
import { usePOSOfflineStatus } from "../modules/pos/hooks/usePOSOfflineStatus";
import { POSCatalog } from "../components/POSCatalog";
import { formatMoney } from "../modules/pos/utils/paymentMath";
import { verifySaaSPosAccessPassword } from "../services/saas";
import { usePOSPayments } from "../modules/pos/hooks/usePOSPayments";
import { usePOSScanner } from "../modules/pos/hooks/usePOSScanner";
import { usePOSPrinter } from "../modules/pos/hooks/usePOSPrinter";
import { POSConfigProductModal } from "../components/pos/POSConfigProductModal";
import { POSAddCustomerModal } from "../components/pos/POSAddCustomerModal";
import { POSCancelShiftModal } from "../components/pos/POSCancelShiftModal";
import { POSClosurePrintArea } from "../components/pos/POSClosurePrintArea";
import { getAuthorizedWarehouseIds, getWarehouseId } from "../modules/warehouse/warehouseScope";
import { pullOpenCashSessionsFromSupabase } from "../services/supabaseSync";
import { calculateExpectedSessionBalances } from "../modules/pos/utils/cashMath";
import { aggregateTransferPayments, buildTransactionTicketId, finalizeCheckoutPayments } from '../modules/pos/utils/checkoutUtils';
const CheckoutModal = lazy(() => import("../components/pos/CheckoutModal"));

const POSReceiptModal = lazy(() => import("../components/POSReceiptModal"));
const POSPrinterSetupModal = lazy(() => import("../components/POSPrinterSetupModal"));

const EMPTY_TRANSACTIONS: Transaction[] = [];
const EMPTY_CASH_SESSIONS: CashRegisterSession[] = [];

export default function POS() {
  const [showCashManagementModal, setShowCashManagementModal] = useState(false);
  const [lastClosedSession, setLastClosedSession] = useState<CashRegisterSession | null>(null);
  const [showOpenShiftModal, setShowOpenShiftModal] = useState(false);
  const [joiningSessionId, setJoiningSessionId] = useState<string | null>(null);

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
  // La reanudación de una caja persistida siempre es explícita. El ID de
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

        // Recuperación específica de cajas: no depende del almacén seleccionado.
        // Se ejecuta solo cuando este terminal todavía no conoce ninguna caja
        // abierta, evitando una descarga pesada en cada entrada al POS.
        const localHasOpenCash = useStore.getState().cashSessions.some(
          s => s.status === 'open' && !s.deletedAt
        );
        if (!localHasOpenCash) {
          const remoteCash = await pullOpenCashSessionsFromSupabase();
          if (remoteCash.success && remoteCash.cashSessions.length) {
            useStore.setState(state => {
              const map = new Map((state.cashSessions || []).map(s => [s.id, s]));
              for (const session of remoteCash.cashSessions) map.set(session.id, session);
              return { cashSessions: Array.from(map.values()) };
            });
          }
        }
      } catch (error) {
        console.warn('[POS] No se pudo refrescar el estado operativo al entrar:', error);
      }
    };
    void run();
  }, [currentUser?.id, fallbackSessionBranchId]);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [showSalarySummary, setShowSalarySummary] = useState(false);
  const [isSubmittingCheckout, setIsSubmittingCheckout] = useState(false);
  const [salesFilter, setSalesFilter] = useState<'all' | 'usd' | 'transfer' | 'cash_cup' | 'mixed'>('all');
  const [salesSubTab, setSalesSubTab] = useState<'tickets' | 'products'>('tickets');

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
  const [cancelShiftPassword, setCancelShiftPassword] = useState("");
  const [isCancellingShift, setIsCancellingShift] = useState(false);

  const handleCancelShift = async () => {
    if (!currentSession || isCancellingShift) return;

    const worker = users.find(u =>
      u.id === currentSession.userId ||
      (u.name && currentSession.workerName && u.name.toLowerCase() === currentSession.workerName.toLowerCase())
    );

    const isAdminAuthorized =
      currentUser?.role === 'admin' &&
      !!currentUser.password &&
      cancelShiftPassword === currentUser.password;

    const isWorkerAuthorized =
      currentUser?.role !== 'admin' &&
      !!worker?.password &&
      cancelShiftPassword === worker.password &&
      worker.isActive !== false;

    if (!isAdminAuthorized && !isWorkerAuthorized) {
      setPosError(
        currentUser?.role === 'admin'
          ? "Contraseña de administrador incorrecta."
          : `Debes ingresar la contraseña del trabajador del turno (${worker?.name || 'trabajador'}).`
      );
      setTimeout(() => setPosError(""), 3000);
      return;
    }

    setIsCancellingShift(true);
    setPosError("");
    try {
      const sessionId = currentSession.id;
      const ok = await useStore.getState().cancelSession(sessionId);
      if (!ok) {
        setPosError("No se pudo cancelar el turno. La operación no fue confirmada; el turno sigue abierto.");
        return;
      }

      setShowCancelShiftModal(false);
      setCancelShiftPassword("");
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

      setPosSuccess(
        isOnline
          ? "Turno cancelado correctamente. Regresando al selector de empleado."
          : "Turno cancelado localmente. La cancelación quedó guardada y se sincronizará al recuperar la conexión."
      );
      setTimeout(() => setPosSuccess(""), 3500);
    } catch (err: any) {
      console.error("[POS] Error cancelando turno:", err);
      setPosError(err?.message || "No se pudo cancelar el turno. El turno permanece abierto.");
    } finally {
      setIsCancellingShift(false);
    }
  };

;

;

;

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

  // Liquidación por producto del turno actual.
  const turnProductSalaryRows = React.useMemo(() => {
    if (!currentSession) return [];
    const rows = new Map();

    activeTransactions
      .filter(tx =>
        tx.branchId === currentBranchId &&
        tx.status === 'completed' &&
        !tx.deletedAt &&
        new Date(tx.date) >= new Date(currentSession.openedAt) &&
        (!tx.sessionId || tx.sessionId === currentSession.id)
      )
      .forEach(tx => {
        const sellers = tx.sellerEmployeeIds?.length ? tx.sellerEmployeeIds : [tx.userId];
        const splitFactor = Math.max(1, sellers.length);

        (tx.items || []).forEach(item => {
          const rawItem = item as any;
          const rawProduct = rawItem.product ?? rawItem.productId;
          const product = typeof rawProduct === 'string'
            ? productById.get(rawProduct)
            : rawProduct;

          const productId = product?.id || rawItem.product_id || (typeof rawProduct === 'string' ? rawProduct : '');
          if (!productId) return;

          const productName = product?.name || rawItem.product_name || (typeof rawProduct === 'string' ? rawProduct : 'Producto vendido');
          const quantity = Number(rawItem.quantity || 0);
          if (!Number.isFinite(quantity) || quantity <= 0) return;

          // commissionValue es el salario/comisión FIJO en CUP por unidad.
          // No usar rawItem.price/product.price para calcular el salario fijo.
          const commissionValue = Number(
            product?.commissionValue ??
            rawItem.product_snapshot?.commissionValue ??
            rawItem.commissionValue ??
            0
          ) || 0;
          const salaryPerUnit = commissionValue / splitFactor;

          sellers.forEach((sellerId: string) => {
            const employee = userById.get(sellerId);
            const key = sellerId + '::' + productId;
            const existing = rows.get(key);

            if (existing) {
              existing.quantity += quantity;
              existing.salaryTotal += salaryPerUnit * quantity;
              existing.salaryPerUnit = existing.quantity > 0 ? existing.salaryTotal / existing.quantity : 0;
            } else {
              rows.set(key, {
                key,
                employeeName: employee?.name || tx.cashierName || 'Empleado',
                productName,
                quantity,
                salaryPerUnit,
                salaryTotal: salaryPerUnit * quantity
              });
            }
          });
        });
      });

    return Array.from(rows.values()).sort((a, b) =>
      String(a.employeeName).localeCompare(String(b.employeeName)) ||
      String(a.productName).localeCompare(String(b.productName))
    );
  }, [currentSession, activeTransactions, currentBranchId, productById, userById]);

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
        { ...(sessionMeta || {}), expectedBalance: expectedCashBase }
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
    setPaymentLines([
      {
        id: newId,
        code: baseCurrency.code,
        amount: totalBase,
        method: 'cash',
        bankCardId: defaultBank?.id
      }
    ]);
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
    const txId = buildTransactionTicketId(currentTransactions);

    const tx: import('../types').Transaction = {
      id: txId,
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
    const nextNcf = await Promise.race([
      useStore.getState().getNextNCF('B01'),
      new Promise<string | undefined>(resolve => setTimeout(() => resolve(undefined), 7000))
    ]);
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
    setShowCheckoutModal(false);
    setShowMobileCart(false);
    clearCart();
    setPosSuccess(`Venta ${tx.id} registrada correctamente.`);
    setTimeout(() => setPosSuccess(""), 3000);

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

      if (!enteredPassword) {
        setPosError(
          currentUser?.role === 'admin' && workerToAssign.id === currentUser.id
            ? "Introduce tu contraseña de PALMYRA."
            : `Introduce la contraseña de ${workerToAssign.name || 'empleado'}.`
        );
        return;
      }

      // El administrador/propietario usa la misma contraseña de su cuenta PALMYRA.
      // La validación ocurre en servidor contra Supabase Auth y la contraseña nunca
      // se guarda en el estado persistido del POS.
      if (currentUser?.role === 'admin' && workerToAssign.id === currentUser.id) {
        const { companyId } = await getActiveTenant();
        const valid = await verifySaaSPosAccessPassword(companyId, workerToAssign.id, enteredPassword);
        if (!valid) {
          setPosError("Contraseña de la cuenta incorrecta. La contraseña del Administrador en POS es la misma que usas para entrar en PALMYRA.");
          return;
        }
      } else {
        // Compatibilidad con la credencial operativa existente de empleados.
        const requiredPassword = (workerToAssign.password || '').trim();
        if (!requiredPassword) {
          setPosError(`El empleado ${workerToAssign.name || 'empleado'} no tiene contraseña operativa asignada.`);
          return;
        }
        if (enteredPassword !== requiredPassword) {
          setPosError(`Contraseña incorrecta para ${workerToAssign.name || 'empleado'}. Acceso denegado.`);
          return;
        }
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
    if (!enteredPassword) {
      setPosError("Introduce la contraseña para reanudar este turno.");
      return;
    }

    // El Administrador entra al POS con la misma contraseña de su cuenta PALMYRA.
    // Los empleados mantienen su contraseña operativa.
    if (currentUser?.role === 'admin' && targetSession.userId === currentUser.id) {
      try {
        const { companyId } = await getActiveTenant();
        const valid = await verifySaaSPosAccessPassword(companyId, currentUser.id, enteredPassword);
        if (!valid) {
          setPosError("Contraseña de PALMYRA incorrecta. No se puede reanudar el turno.");
          return;
        }
      } catch (error) {
        console.error("[POS] No se pudo validar la contraseña del administrador al reanudar:", error);
        setPosError("No se pudo validar tu contraseña. Verifica la conexión y vuelve a intentarlo.");
        return;
      }
    } else {
      const requiredPassword = (targetUser.password || '').trim();
      if (!requiredPassword) {
        setPosError(`El empleado ${targetUser.name || 'empleado'} no tiene contraseña asignada. El administrador debe asignarle una.`);
        return;
      }
      if (enteredPassword !== requiredPassword) {
        setPosError(`Contraseña incorrecta para ${targetUser.name || 'empleado'}. Acceso denegado.`);
        return;
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
      className="h-full flex flex-col min-h-0 relative"
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
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-2 sm:p-3 overflow-y-auto space-y-2">
          {!joiningSessionId && openSessionsForResume.length > 0 && (
            <div className="w-full max-w-[min(92vw,20rem)] rounded-2xl border border-emerald-200 bg-white shadow-xl p-2.5 sm:p-3 text-left animate-in fade-in zoom-in-95">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <p className="text-[8px] font-black uppercase tracking-[0.14em] text-emerald-700">Caja abierta</p>
                  <p className="text-[9px] font-bold text-slate-500 leading-tight">Hay un turno guardado y disponible para reanudar.</p>
                </div>
                <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
              </div>
              <div className="space-y-1.5 max-h-28 overflow-y-auto custom-scrollbar pr-0.5">
                {openSessionsForResume.map(session => (
                  <div key={session.id} className="flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-100 px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[8.5px] font-black text-emerald-900 truncate">
                        Turno {session.turnNumber || "—"} · {session.workerName || "Administrador"}
                      </p>
                      <p className="text-[7px] font-bold text-emerald-700/80 truncate">
                        {branches.find(b => b.id === session.branchId)?.name || "Almacén principal"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setJoiningSessionId(session.id);
                        setJoiningSessionPassword("");
                        setPosError("");
                      }}
                      className="shrink-0 rounded-lg bg-emerald-600 px-2.5 py-1.25 text-[7px] font-black uppercase tracking-tight text-white shadow-sm hover:bg-emerald-700"
                    >
                      Reanudar
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {joiningSessionId ? (
            /* Modal Formulario de Ingreso a Turno Abierto Existente */
            <div className="bg-white dark:bg-slate-900 p-3 sm:p-4 rounded-2xl shadow-2xl text-center max-w-[20rem] w-full animate-in zoom-in-95 border border-white/20">
              <div className="w-9 h-9 bg-amber-50 dark:bg-amber-950/40 rounded-xl flex items-center justify-center mx-auto mb-2">
                <Lock className="w-4 h-4 text-amber-600" />
              </div>
              <h3 className="text-sm font-black text-slate-900 dark:text-slate-100 uppercase tracking-tight leading-none mb-1">
                Reanudar Turno Abierto
              </h3>
              <p className="text-[7px] font-bold text-slate-400 uppercase tracking-wider mb-2.5">
                Turno de {(activeCashSessions || []).find(s => s.id === joiningSessionId)?.workerName || 'Empleado'}
              </p>

              {posError && (
                <div className="mb-2 p-2.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs font-bold text-left flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                  <span className="text-[11px] leading-tight">{posError}</span>
                </div>
              )}

              <form onSubmit={handleJoinExistingSession} className="space-y-2">
                <div className="text-left">
                  <label className="block text-[7px] font-black text-slate-400 uppercase tracking-wider mb-1">
                    Contraseña para reanudar el turno
                  </label>
                  <input
                    type="password"
                    required
                    value={joiningSessionPassword}
                    onChange={e => {
                      setJoiningSessionPassword(e.target.value);
                      setPosError("");
                    }}
                    placeholder="Ingresa la contraseña"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-100 dark:bg-slate-800 dark:border-slate-700 rounded-lg text-[10px] font-bold text-slate-900 dark:text-slate-100 outline-none focus:ring-2 focus:ring-rose-500"
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
                    className="py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-[10px] uppercase tracking-wider transition-all"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="py-2 bg-rose-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-[8px] uppercase tracking-tight transition-all shadow-sm"
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

                  {/* Botones de impresión y acciones */}
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-2 gap-2">
                      <button                        type="button"
                        onClick={() => handlePrintClosureThermal(lastClosedSession)}
                        className="py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-black text-[8px] uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 active:scale-95"
                      >
                        <Printer className="w-3 h-3 text-slate-500" />
                        Ticket 58mm
                      </button>
                      
                    </div>

                    <button
                      type="button"
                      onClick={() => setShowOpenShiftModal(true)}
                      className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black text-[9px] uppercase tracking-widest transition-all shadow-lg shadow-indigo-100 active:scale-95 flex items-center justify-center gap-2"
                    >
                      <DollarSign className="w-3.5 h-3.5" />
                      Abrir Nuevo Turno / Caja
                    </button>

                    {currentUser?.role === 'admin' ? (
                      <button 
                        type="button"
                        onClick={() => navigate('/')}
                        className="w-full py-2 bg-slate-100 text-slate-600 rounded-xl font-black text-[8px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                      >
                        Volver al Menú Principal
                      </button>
                    ) : (
                      <button 
                        type="button"
                        onClick={() => logout()}
                        className="w-full py-2 bg-slate-100 text-slate-600 rounded-xl font-black text-[8px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                      >
                        Cerrar Sesión del Empleado
                      </button>
                    )}
                  </div>
                </div>

              ) : (
                /* Modal Formulario de Apertura de Caja */
                <div className="palmyra-mobile-modal palmyra-open-cash-modal p-1.5 sm:p-2 rounded-2xl shadow-2xl text-center w-full max-w-[min(92vw,20rem)] max-h-[calc(100dvh-0.5rem)] overflow-y-auto animate-in zoom-in-95 my-auto">
                  <div className="flex items-center justify-center gap-1.5 mb-1">
                    <div className="w-6 h-6 sm:w-7 sm:h-7 bg-violet-50 rounded-lg flex items-center justify-center shrink-0">
                      <DollarSign className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-violet-600" />
                    </div>
                    <div className="min-w-0 text-left">
                      <h3 className="text-xs sm:text-sm font-black text-slate-900 uppercase tracking-tight leading-none">Apertura de Caja</h3>
                      <p className="text-[6px] font-bold text-slate-400 uppercase tracking-wider mt-0.5">Fondo Inicial</p>
                    </div>
                  </div>

                  
                  {/* Inline Modal Alert */}
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
                  )}

              <form onSubmit={handleOpenSession} className="space-y-2">
                    <div className="text-left space-y-2">
                      {!false && (
                      <div>
                        <label className="block text-[7px] font-black text-slate-400 uppercase tracking-widest mb-1">
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
                                placeholder="Toca para seleccionar o buscar empleado"
                                className="w-full pl-9 pr-10 py-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-bold text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
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
                              <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden">
                                <div className="max-h-[30vh] overflow-y-auto custom-scrollbar p-1">
                                  {(users || [])
                                    .filter(u => u.isActive !== false)
                                    .filter(u => {
                                      const q = employeePickerSearch.trim().toLowerCase();
                                      return !q || (u.name || '').toLowerCase().includes(q);
                                    })
                                    .map(u => {
                                      const isSelected = sessionWorkerName === (u.name || '');
                                      const isSelectedEmployee = false;
                                      const open = openSessionForWorker(u.id);
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
                                            if (u.branchId) setSessionBranchId(u.branchId);
                                            
                                            else if ((u.allowedBranches || []).length === 1) setSessionBranchId(u.allowedBranches![0]);
                                            setPosError('');
                                          }}
                                          className={cn(
                                            "w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left transition-colors",
                                            isSelected ? "bg-rose-100 text-rose-900" : "hover:bg-slate-50 text-slate-900"
                                          )}
                                        >
                                          <div className="min-w-0">
                                            <span className="block text-[10px] sm:text-[11px] font-black uppercase tracking-tight leading-tight whitespace-normal break-words">
                                              {u.name || 'Trabajador'}
                                            </span>
                                            <span className={cn(
                                              "block text-[7px] font-black uppercase tracking-wider mt-0.5",
                                              u.role === 'admin' ? "text-rose-700" : "text-slate-400"
                                            )}>
                                              {u.role === 'admin' ? "ADMINISTRADOR" : "EMPLEADO"}
                                            </span>
                                          </div>
                                          <span className={cn(
                                            "shrink-0 px-1.5 py-0.5 rounded-md border text-[7px] font-black uppercase tracking-wider",
                                            open ? "bg-emerald-100 border-emerald-300 text-emerald-700" : "bg-slate-100 border-slate-200 text-slate-400"
                                          )}>
                                            {open ? "ABIERTO" : "DISPONIBLE"}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  {!(users || []).some(u => {
                                    const q = employeePickerSearch.trim().toLowerCase();
                                    return u.isActive !== false && (!q || (u.name || '').toLowerCase().includes(q));
                                  }) && (
                                    <div className="px-3 py-4 text-center text-[9px] font-bold text-slate-400 uppercase">
                                      No se encontraron empleados.
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pt-0.5 text-[7px] font-black uppercase tracking-wider">
                            <span className="inline-flex items-center gap-1 text-rose-700">
                              <span className="w-2 h-2 rounded-full bg-indigo-600" />
                              EMPLEADO
                            </span>
                            <span className="inline-flex items-center gap-1 text-rose-700">
                              <span className="w-2 h-2 rounded-full bg-rose-500" />
                              EMPLEADO PALMYRA
                            </span>
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <span className="w-2 h-2 rounded-full bg-emerald-500" />
                              TURNO ABIERTO
                            </span>
                          </div>
                        </div>
                      </div>
                      )}

                      <div>
                        <label className="block text-[7px] font-black text-slate-400 uppercase tracking-widest mb-1">
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
                            <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest">
                              Sucursal / Almacén a Operar
                            </label>
                            {isBranchLocked && (
                              <span className="flex items-center gap-1 text-[8px] font-black text-amber-700 uppercase bg-amber-100 px-1.5 py-0.5 rounded border border-amber-300">
                                <Lock className="w-2.5 h-2.5" /> Bloqueado
                              </span>
                            )}
                          </div>
                          <select 
                            value={sessionBranchId}
                            disabled={isBranchLocked}
                            onChange={(e) => setSessionBranchId(e.target.value)}
                            className={cn(
                              "w-full px-4 py-3 border rounded-xl text-xs font-bold text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 transition-all appearance-none",
                              isBranchLocked ? "bg-amber-50/70 border-amber-200 cursor-not-allowed text-amber-900 font-black" : "bg-slate-50 border-slate-100"
                            )}
                          >
                            {allowedBranches.map(b => (
                              <option key={b.id} value={b.id}>{b.name}</option>
                            ))}
                          </select>
                          {isBranchLocked && (
                            <p className="text-[8px] font-bold text-amber-700 mt-1 uppercase">
                              El vendedor tiene un almacén fijo asignado y no puede vender desde otro almacén.
                            </p>
                          )}
                        </div>
                        
                        <div className="text-left">
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest">
                              Fondo Inicial ({baseCurrency.symbol} CUP)
                            </label>
                            <span className="text-[7px] font-bold text-slate-400 uppercase">0 permitido</span>
                          </div>
                          <div className="relative">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                              <span className="text-slate-400 font-bold text-[9px]">{baseCurrency.symbol}</span>
                            </div>
                            <input 
                              type="number" 
                              min="0"
                              step="0.01"
                              value={openingAmount}
                              onFocus={(e) => e.target.select()}
                              onChange={e => setOpeningAmount(e.target.value)}
                              className="w-full pl-10 pr-3 py-2 bg-slate-50 border border-slate-100 rounded-lg text-sm font-black text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                              placeholder="0.00"
                            />
                          </div>
                        </div>

                        <div className="space-y-1.5 pt-1">
                          <button 
                            type="submit"
                            disabled={isOpeningSession}
                            className="w-full py-2 bg-violet-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-violet-700 transition-all shadow-lg shadow-violet-600/20 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            {isOpeningSession ? "Abriendo Caja..." : "Abrir Caja y Comenzar"}
                          </button>

                          {lastClosedSession && (
                            <button
                              type="button"
                              onClick={() => setShowOpenShiftModal(false)}
                              className="w-full py-2 bg-slate-100 text-slate-600 rounded-xl font-black text-[9px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                            >
                              Ver Resumen de Turno Anterior
                            </button>
                          )}

                          {currentUser?.role === 'admin' ? (
                            <button 
                              type="button"
                              onClick={() => navigate('/')}
                              className="w-full py-2.5 bg-slate-100 text-slate-600 rounded-xl font-black text-[9px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                            >
                              Volver al Menú
                            </button>
                          ) : (
                            <button 
                              type="button"
                              onClick={() => logout()}
                              className="w-full py-2.5 bg-slate-100 text-slate-600 rounded-xl font-black text-[9px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
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
                            className="w-full py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-[9px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                          >
                            Volver al Menú
                          </button>
                        ) : (
                          <button 
                            type="button"
                            onClick={() => logout()}
                            className="w-full py-3 bg-slate-100 text-slate-600 rounded-xl font-black text-[9px] uppercase tracking-widest hover:bg-slate-200 transition-all active:scale-95"
                          >
                            Cerrar Sesión
                          </button>
                        )}
                      </div>
                    )}
                  </form>
                </div>
              )}

              {/* Turnos Abiertos en Curso (Evita duplicidad y permite reanudar con contraseña) */}
              {(() => {
                // Las cuentas PALMYRA no deben ver ni poder escoger turnos de terceros.
                if (false) return null;
                const otherOpenSessions = (activeCashSessions || []).filter(s => s.status === 'open');
                if (otherOpenSessions.length === 0) return null;
                return (
                  <div className="bg-white dark:bg-slate-900 p-2.5 sm:p-3 rounded-2xl shadow-lg border border-slate-100 dark:border-slate-800 text-left max-w-sm w-full mt-1 shrink-0">
                    <span className="text-[7px] font-black uppercase text-indigo-600 tracking-tight flex items-center gap-1 mb-1.5">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin-slow text-indigo-500" />
                      Turnos Abiertos Actualmente
                    </span>
                    <div className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar">
                      {otherOpenSessions.map(s => (
                        <div key={s.id} className="p-2 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-[9px] font-black text-slate-900 dark:text-slate-100 uppercase tracking-tight block whitespace-normal break-words leading-tight">
                              {s.workerName || 'Empleado'}
                            </span>
                            <span className="text-[6px] font-bold text-slate-400 uppercase tracking-tight block whitespace-normal break-words leading-tight">
                              {branches.find(b => b.id === s.branchId)?.name || 'Sucursal'} • ID: {s.id.slice(0, 6)}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setJoiningSessionId(s.id);
                              setJoiningSessionPassword("");
                              setPosError("");
                            }}
                            className="px-2 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400 font-black text-[7px] uppercase tracking-tight rounded-lg transition-all active:scale-95 cursor-pointer shrink-0"
                          >
                            Reanudar
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* Checkout Modal - Compact & Linear Redesign */}
      {showCheckoutModal && (
        <Suspense
          fallback={
            <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[80] flex items-center justify-center p-4">
              <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 shadow-2xl text-center text-xs font-bold text-slate-500">
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
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="palmyra-mobile-modal bg-white rounded-2xl sm:rounded-[2rem] shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95 border border-white/20 flex flex-col max-h-[calc(100dvh-1rem)]">
            <div className="p-4 border-b border-slate-50 flex items-center justify-between bg-slate-900 text-white shrink-0">
              <div className="flex items-center gap-2">
                <Receipt className="w-4 h-4 text-indigo-400" />
                <h3 className="text-xs font-black uppercase tracking-widest">Caja y Ventas del Turno</h3>
              </div>
              <button 
                onClick={() => setShowCashManagementModal(false)}
                className="p-1.5 hover:bg-white/10 rounded-full transition-colors text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            
            <div className="flex border-b border-slate-100 bg-slate-50/50 shrink-0">
              <button
                onClick={() => setCashManagementTab('movements')}
                className={cn(
                  "flex-1 py-2.5 text-[9px] font-black uppercase tracking-widest transition-colors",
                  cashManagementTab === 'movements' ? "text-indigo-600 border-b-2 border-indigo-600 bg-white" : "text-slate-400 hover:text-slate-600"
                )}
              >
                Movimientos
              </button>
              <button
                onClick={() => setCashManagementTab('sales')}
                className={cn(
                  "flex-1 py-2.5 text-[9px] font-black uppercase tracking-widest transition-colors",
                  cashManagementTab === 'sales' ? "text-indigo-600 border-b-2 border-indigo-600 bg-white" : "text-slate-400 hover:text-slate-600"
                )}
              >
                Ventas del Turno
              </button>
              <button
                onClick={() => setCashManagementTab('close')}
                className={cn(
                  "flex-1 py-2.5 text-[9px] font-black uppercase tracking-widest transition-colors",
                  cashManagementTab === 'close' ? "text-indigo-600 border-b-2 border-indigo-600 bg-white" : "text-slate-400 hover:text-slate-600"
                )}
              >
                Arqueo y Cierre
              </button>
            </div>

            <div className="p-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
              {cashManagementTab === 'movements' ? (
                <div className="space-y-6">
                  <form onSubmit={handleAddMovement} className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Tipo</label>
                        <select 
                          value={movementData.type}
                          onChange={e => setMovementData({...movementData, type: e.target.value as any})}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black uppercase outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          <option value="expense">Egreso (Gasto)</option>
                          <option value="income">Ingreso (Entrada)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Moneda</label>
                        <select 
                          value={movementData.currencyCode}
                          onChange={e => setMovementData({...movementData, currencyCode: e.target.value})}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black uppercase outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          {currencies.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Monto</label>
                        <input 
                          type="number" 
                          step="0.01" 
                          required
                          value={movementData.amount}
                          onFocus={(e) => e.target.select()}
                          onChange={e => setMovementData({...movementData, amount: e.target.value})}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Descripción</label>
                        <input 
                          type="text" 
                          required
                          value={movementData.description}
                          onChange={e => setMovementData({...movementData, description: e.target.value})}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="Ej: Pago de almuerzo"
                        />
                      </div>
                    </div>
                    <button type="submit" className="w-full py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-100">
                      Registrar Movimiento
                    </button>
                  </form>

                  <div className="space-y-2">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Historial de Turno</h4>
                    {currentSession?.movements && currentSession.movements.length > 0 ? (
                      currentSession.movements.map(m => (
                        <div key={m.id} className="flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl shadow-sm hover:border-slate-200 transition-all group">
                          <div className="flex items-center gap-3">
                            <div className={cn(
                              "w-8 h-8 rounded-lg flex items-center justify-center",
                              m.type === 'income' ? "bg-emerald-100 text-emerald-600" : "bg-rose-100 text-rose-600"
                            )}>
                              {m.type === 'income' ? <TrendingUp className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                            </div>
                            <div>
                              <p className="text-[10px] font-black text-slate-900 uppercase tracking-tight">{m.description}</p>
                              <p className="text-[8px] font-bold text-slate-400 uppercase">{new Date(m.date).toLocaleTimeString()}</p>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-3">
                            <p className={cn(
                              "text-[11px] font-black",
                              m.type === 'income' ? "text-emerald-600" : "text-rose-600"
                            )}>
                              {m.type === 'income' ? '+' : '-'}{m.amount.toLocaleString('es-CU', { minimumFractionDigits: 2 })} {m.currencyCode}
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                if (window.confirm(`¿Estás seguro de que deseas eliminar este movimiento: "${m.description}"?`)) {
                                  removeCashMovement(currentSession.id, m.id);
                                  addNotification("Movimiento de caja eliminado", 'info');
                                }
                              }}
                              className="p-1 text-slate-400 hover:text-rose-600 rounded-full hover:bg-rose-50 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                              title="Eliminar movimiento"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-slate-400 text-center py-4 font-bold">No hay movimientos registrados</p>
                    )}
                  </div>
                </div>              ) : cashManagementTab === 'sales' ? (
                <div className="space-y-4">
                  {(() => {
                    const sessionTx = activeTransactions.filter(t => 
                      t.sessionId === currentSession?.id && !t.deletedAt
                    );

                    // Categorize payment types
                    let cashCupSum = 0;
                    let cashUsdSum = 0;
                    let transferCupSum = 0;
                    let otherSum = 0;

                    sessionTx.forEach(tx => {
                      (tx.payments || []).forEach(p => {
                        if (p.currencyCode === 'USD' && p.method === 'cash') {
                          cashUsdSum += p.amount;
                        } else if (p.currencyCode === baseCurrency.code && p.method === 'cash') {
                          cashCupSum += p.amount;
                        } else if (p.method === 'transfer') {
                          transferCupSum += (p.amount * (p.exchangeRate || 1));
                        } else {
                          otherSum += (p.amount * (p.exchangeRate || 1));
                        }
                      });
                    });

                    const totalSalesAmount = sessionTx.reduce((sum, tx) => sum + (tx.total || 0), 0);

                    // Helper to determine payment category for a transaction
                    const getTxPaymentCategory = (tx: Transaction): 'usd' | 'transfer' | 'cash_cup' | 'mixed' => {
                      const payments = tx.payments || [];
                      if (payments.length === 0) return 'cash_cup';
                      const hasUsd = payments.some(p => p.currencyCode === 'USD');
                      const hasTransfer = payments.some(p => p.method === 'transfer');
                      const hasCashCup = payments.some(p => p.currencyCode === baseCurrency.code && p.method === 'cash');

                      if (payments.length === 1) {
                        if (hasUsd) return 'usd';
                        if (hasTransfer) return 'transfer';
                        if (hasCashCup) return 'cash_cup';
                      }

                      // Multiple payments
                      const uniqueTypes = new Set(payments.map(p => `${p.currencyCode}-${p.method}`));
                      if (uniqueTypes.size === 1) {
                        if (hasUsd) return 'usd';
                        if (hasTransfer) return 'transfer';
                        return 'cash_cup';
                      }
                      return 'mixed';
                    };

                    const filteredTx = sessionTx.filter(tx => {
                      if (salesFilter === 'all') return true;
                      const cat = getTxPaymentCategory(tx);
                      return cat === salesFilter;
                    });

                    // Product Aggregation with Payment context breakdown
                    type ProdBreakdown = {
                      name: string;
                      quantity: number;
                      unitPrice: number;
                      total: number;
                      usdQty: number;
                      usdTotal: number;
                      transferQty: number;
                      transferTotal: number;
                      cashCupQty: number;
                      cashCupTotal: number;
                      mixedQty: number;
                      mixedTotal: number;
                    };

                    const productAgg: Record<string, ProdBreakdown> = {};
                    sessionTx.forEach(tx => {
                      const cat = getTxPaymentCategory(tx);
                      (tx.items || []).forEach(item => {
                        const prodObj = typeof item.product === 'object' ? item.product : products.find(p => p.id === (item.product as unknown as string));
                        const name = prodObj?.name || (typeof item.product === 'string' ? item.product : 'Producto');
                        const price = prodObj?.price || 0;
                        const variantStr = item.variantLabel ? ` (${item.variantLabel})` : '';
                        const fullName = `${name}${variantStr}`;

                        if (!productAgg[fullName]) {
                          productAgg[fullName] = { 
                            name: fullName, 
                            quantity: 0, 
                            unitPrice: price, 
                            total: 0,
                            usdQty: 0,
                            usdTotal: 0,
                            transferQty: 0,
                            transferTotal: 0,
                            cashCupQty: 0,
                            cashCupTotal: 0,
                            mixedQty: 0,
                            mixedTotal: 0
                          };
                        }
                        productAgg[fullName].quantity += item.quantity;
                        productAgg[fullName].total += (price * item.quantity);

                        if (cat === 'usd') {
                          productAgg[fullName].usdQty += item.quantity;
                          productAgg[fullName].usdTotal += (price * item.quantity);
                        } else if (cat === 'transfer') {
                          productAgg[fullName].transferQty += item.quantity;
                          productAgg[fullName].transferTotal += (price * item.quantity);
                        } else if (cat === 'cash_cup') {
                          productAgg[fullName].cashCupQty += item.quantity;
                          productAgg[fullName].cashCupTotal += (price * item.quantity);
                        } else {
                          productAgg[fullName].mixedQty += item.quantity;
                          productAgg[fullName].mixedTotal += (price * item.quantity);
                        }
                      });
                    });

                    const consolidatedList = Object.values(productAgg);

                    return (
                      <div className="space-y-4">
                        {/* Financial Cards Grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          <div className="bg-emerald-50/80 border border-emerald-100 rounded-xl p-2.5 flex flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-emerald-700 mb-1">
                              <span className="text-[8px] font-black uppercase tracking-wider">Efectivo CUP</span>
                              <Banknote className="w-3.5 h-3.5" />
                            </div>
                            <span className="text-xs font-black text-emerald-900 truncate">
                              {formatMoney(cashCupSum, baseCurrency.symbol)}
                            </span>
                          </div>

                          <div className="bg-amber-50/80 border border-amber-100 rounded-xl p-2.5 flex flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-amber-700 mb-1">
                              <span className="text-[8px] font-black uppercase tracking-wider">Efectivo USD</span>
                              <DollarSign className="w-3.5 h-3.5" />
                            </div>
                            <div>
                              <span className="text-xs font-black text-amber-900 block truncate">
                                ${cashUsdSum.toFixed(2)} USD
                              </span>
                              <span className="text-[8px] font-bold text-amber-600 block">
                                {formatMoney(cashUsdSum * (currencies.find(c => c.code === 'USD')?.rateToBase || 1), baseCurrency.symbol)} eq.
                              </span>
                            </div>
                          </div>

                          <div className="bg-blue-50/80 border border-blue-100 rounded-xl p-2.5 flex flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-blue-700 mb-1">
                              <span className="text-[8px] font-black uppercase tracking-wider">Transferencia</span>
                              <CreditCard className="w-3.5 h-3.5" />
                            </div>
                            <span className="text-xs font-black text-blue-900 truncate">
                              {formatMoney(transferCupSum, baseCurrency.symbol)}
                            </span>
                          </div>

                          <div className="bg-indigo-50/80 border border-indigo-100 rounded-xl p-2.5 flex flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-indigo-700 mb-1">
                              <span className="text-[8px] font-black uppercase tracking-wider">Total Ventas</span>
                              <Package className="w-3.5 h-3.5" />
                            </div>
                            <div>
                              <span className="text-xs font-black text-indigo-900 block truncate">
                                {formatMoney(totalSalesAmount, baseCurrency.symbol)}
                              </span>
                              <span className="text-[8px] font-bold text-indigo-600 block">
                                {sessionTx.length} {sessionTx.length === 1 ? 'ticket' : 'tickets'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Subtabs & Filters */}
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pt-1 border-t border-slate-100">
                          {/* Subtabs */}
                          <div className="flex bg-slate-100 p-0.5 rounded-xl text-[9px] font-black uppercase">
                            <button
                              onClick={() => setSalesSubTab('tickets')}
                              className={cn(
                                "px-3 py-1.5 rounded-lg transition-all flex items-center gap-1",
                                salesSubTab === 'tickets' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-800"
                              )}
                            >
                              <Receipt className="w-3 h-3" />
                              Tickets ({sessionTx.length})
                            </button>
                            <button
                              onClick={() => setSalesSubTab('products')}
                              className={cn(
                                "px-3 py-1.5 rounded-lg transition-all flex items-center gap-1",
                                salesSubTab === 'products' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-800"
                              )}
                            >
                              <Package className="w-3 h-3" />
                              Productos ({consolidatedList.reduce((s, p) => s + p.quantity, 0)} u.)
                            </button>
                          </div>

                          {/* Filter by Payment Method */}
                          {salesSubTab === 'tickets' && (
                            <div className="flex items-center gap-1 overflow-x-auto max-w-full pb-0.5">
                              <button
                                onClick={() => setSalesFilter('all')}
                                className={cn(
                                  "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider whitespace-nowrap transition-all",
                                  salesFilter === 'all' ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                                )}
                              >
                                Todos
                              </button>
                              <button
                                onClick={() => setSalesFilter('usd')}
                                className={cn(
                                  "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-0.5",
                                  salesFilter === 'usd' ? "bg-amber-600 text-white" : "bg-amber-50 text-amber-700 hover:bg-amber-100"
                                )}
                              >
                                💵 USD
                              </button>
                              <button
                                onClick={() => setSalesFilter('transfer')}
                                className={cn(
                                  "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-0.5",
                                  salesFilter === 'transfer' ? "bg-blue-600 text-white" : "bg-blue-50 text-blue-700 hover:bg-blue-100"
                                )}
                              >
                                💳 Transferencia
                              </button>
                              <button
                                onClick={() => setSalesFilter('cash_cup')}
                                className={cn(
                                  "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-0.5",
                                  salesFilter === 'cash_cup' ? "bg-emerald-600 text-white" : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                                )}
                              >
                                💵 Efectivo CUP
                              </button>
                              <button
                                onClick={() => setSalesFilter('mixed')}
                                className={cn(
                                  "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-0.5",
                                  salesFilter === 'mixed' ? "bg-purple-600 text-white" : "bg-purple-50 text-purple-700 hover:bg-purple-100"
                                )}
                              >
                                🔄 Mixto
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Content: Tickets view vs Products view */}
                        {salesSubTab === 'tickets' ? (
                          <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar pr-1">
                            {filteredTx.length > 0 ? (
                              filteredTx.map((tx) => {
                                const customer = useStore.getState().customers.find(c => c.id === tx.customerId);
                                const cat = getTxPaymentCategory(tx);
                                return (
                                  <div key={tx.id} className="p-3 bg-white rounded-xl border border-slate-200/80 shadow-sm space-y-2">
                                    <div className="flex items-start justify-between gap-2">
                                      <div>
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                          <span className="font-mono text-[10px] font-black text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100">
                                            {tx.id}
                                          </span>
                                          <span className="text-[9px] font-bold text-slate-400">
                                            {new Date(tx.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                          </span>
                                          <span className="text-[9px] font-bold text-slate-600">
                                            • {customer?.name || 'Consumidor Final'}
                                          </span>
                                        </div>
                                      </div>

                                      <div className="flex items-center gap-2 shrink-0">
                                        <span className="text-xs font-black text-slate-900 dark:text-white">
                                          {formatMoney(tx.total, baseCurrency.symbol)}
                                        </span>
                                        <div className="flex items-center gap-1">
                                          <button
                                            onClick={() => setShowReceiptModal(tx)}
                                            className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-lg transition-colors cursor-pointer"
                                            title="Ver Comprobante Flotante"
                                          >
                                            <Receipt className="w-3.5 h-3.5" />
                                          </button>
                                          <button
                                            onClick={() => handleThermalPrint(tx)}
                                            className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-lg transition-colors cursor-pointer"
                                            title="Imprimir Ticket Térmico"
                                          >
                                            <Printer className="w-3.5 h-3.5" />
                                          </button>
                                          <button
                                            onClick={() => {
                                              if (window.confirm(`¿Estás seguro de eliminar el ticket ${tx.id}? Esto devolverá los productos al inventario.`)) {
                                                useStore.getState().deleteTransaction(tx.id);
                                                addNotification(`Ticket ${tx.id} eliminado y stock restaurado.`, 'info');
                                              }
                                            }}
                                            className="p-1 text-slate-300 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                                            title="Anular Venta"
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        </div>
                                      </div>
                                    </div>

                                    {/* Products list in this ticket - Compact & Contained */}
                                    <div className="bg-slate-50 dark:bg-slate-800/40 rounded-lg p-2 space-y-1 text-[9px] max-h-24 sm:max-h-28 overflow-y-auto custom-scrollbar">
                                      {tx.items.map((item, idx) => (
                                        <div key={idx} className="flex justify-between items-center text-slate-700 font-bold">
                                          <span className="truncate pr-2">
                                            {item.quantity}x {typeof (item.product as any) === "object" ? ((item.product as any)?.name || "Producto") : (products.find(p => p.id === (item.product as any))?.name || (item.product as any) || "Producto")}
                                            {item.variantLabel ? ` (${item.variantLabel})` : ''}
                                          </span>
                                          <span className="font-mono shrink-0">
                                            {formatMoney((typeof (item.product as any) === "object" ? ((item.product as any)?.price || 0) : (products.find(p => p.id === (item.product as any))?.price || item.price || 0)) * item.quantity, baseCurrency.symbol)}
                                          </span>
                                        </div>
                                      ))}
                                    </div>

                                    {/* Payment Method Badges & Breakdown */}
                                    <div className="flex items-center justify-between gap-2 flex-wrap pt-1 border-t border-slate-100 text-[8px] font-black">
                                      <div className="flex items-center gap-1 flex-wrap">
                                        {cat === 'usd' && (
                                          <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                                            💵 100% Pagado en USD
                                          </span>
                                        )}
                                        {cat === 'transfer' && (
                                          <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                                            💳 Pagado por Transferencia
                                          </span>
                                        )}
                                        {cat === 'cash_cup' && (
                                          <span className="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                                            💵 Pagado en Efectivo CUP
                                          </span>
                                        )}
                                        {cat === 'mixed' && (
                                          <span className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                                            🔄 Pago Mixto / Multi-moneda
                                          </span>
                                        )}

                                        {/* Individual lines */}
                                        {(tx.payments || []).map((p, pIdx) => {
                                          const card = p.bankCardId ? bankCards.find(c => c.id === p.bankCardId) : null;
                                          const sym = currencies.find(c => c.code === p.currencyCode)?.symbol || '';
                                          return (
                                            <span key={pIdx} className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded border border-slate-200 font-mono">
                                              {p.method === 'transfer' ? 'Transf' : 'Efec'} {formatMoney(p.amount, sym)} {card ? `(${card.bank})` : ''}
                                            </span>
                                          );
                                        })}
                                      </div>

                                      {tx.changeGiven && tx.changeGiven > 0 ? (
                                        <span className="text-emerald-600 font-bold">
                                          Vuelto: {formatMoney(tx.changeGiven, baseCurrency.symbol)}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              })
                            ) : (
                              <div className="text-center py-8 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                                <Receipt className="w-6 h-6 text-slate-300 mx-auto mb-1.5" />
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                                  No hay ventas con este filtro
                                </p>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar pr-1">
                            {consolidatedList.length > 0 ? (
                              consolidatedList.map((prod, idx) => (
                                <div key={idx} className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm space-y-1.5">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                      <span className="w-7 h-7 bg-indigo-100 text-indigo-700 rounded-lg flex items-center justify-center font-black text-xs shrink-0">
                                        {prod.quantity}x
                                      </span>
                                      <div className="min-w-0">
                                        <span className="font-black text-slate-900 text-xs uppercase block truncate">{prod?.name || "Producto"}</span>
                                        <span className="text-[9px] font-bold text-slate-400 block">
                                          Precio unitario: {formatMoney(prod.unitPrice, baseCurrency.symbol)}
                                        </span>
                                      </div>
                                    </div>
                                    <span className="font-black text-indigo-600 text-xs shrink-0 ml-2">
                                      {formatMoney(prod.total, baseCurrency.symbol)}
                                    </span>
                                  </div>

                                  {/* Payment method breakdown for this product */}
                                  <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-slate-100 text-[8px] font-bold">
                                    <span className="text-slate-400 uppercase tracking-widest text-[7px] font-black">Pagado en:</span>
                                    {prod.usdQty > 0 && (
                                      <span className="bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded">
                                        💵 USD: {prod.usdQty} u. ({formatMoney(prod.usdTotal, baseCurrency.symbol)})
                                      </span>
                                    )}
                                    {prod.transferQty > 0 && (
                                      <span className="bg-blue-50 text-blue-800 border border-blue-200 px-1.5 py-0.5 rounded">
                                        💳 Transf: {prod.transferQty} u. ({formatMoney(prod.transferTotal, baseCurrency.symbol)})
                                      </span>
                                    )}
                                    {prod.cashCupQty > 0 && (
                                      <span className="bg-emerald-50 text-emerald-800 border border-emerald-200 px-1.5 py-0.5 rounded">
                                        💵 CUP: {prod.cashCupQty} u. ({formatMoney(prod.cashCupTotal, baseCurrency.symbol)})
                                      </span>
                                    )}
                                    {prod.mixedQty > 0 && (
                                      <span className="bg-purple-50 text-purple-800 border border-purple-200 px-1.5 py-0.5 rounded">
                                        🔄 Mixto: {prod.mixedQty} u. ({formatMoney(prod.mixedTotal, baseCurrency.symbol)})
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ))
                            ) : (
                              <div className="text-center py-8 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                                <Package className="w-6 h-6 text-slate-300 mx-auto mb-1.5" />
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                                  No hay productos vendidos en este turno
                                </p>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Buttons to Print Full Shift Summary */}
                        <div className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row gap-2">
                          <button
                            type="button"
                            onClick={() => handlePrintClosureThermal(currentSession)}
                            className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-md shadow-indigo-100 active:scale-95 flex items-center justify-center gap-2"
                          >
                            <Printer className="w-4 h-4" />
                            Imprimir Resumen de Cierre
                          </button>
                          
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="bg-indigo-50 rounded-2xl p-4 flex justify-between items-center border border-indigo-100">
                    <div>
                      <p className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Fondo Inicial</p>
                      <p className="text-lg font-black text-indigo-900">{(currentSession?.openingBalance || 0).toLocaleString('es-CU', { minimumFractionDigits: 2 })} {baseCurrency.code}</p>
                    </div>
                    <button 
                      onClick={() => {
                        const autoBalances: {[key: string]: number} = {};
                        expectedBalances.forEach(eb => {
                          autoBalances[`${eb.currencyCode}-${eb.method}`] = eb.amount;
                        });
                        setClosingBalances(autoBalances);
                      }}
                      className="text-[9px] font-black uppercase text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-xl transition-all shadow-md shadow-indigo-100 active:scale-95"
                    >
                      Cuadre Perfecto
                    </button>
                  </div>

                  <form onSubmit={handleClose} className="space-y-5">
                    {/* Fecha de Cierre Arriba */}
                    <div className="space-y-3">
                      <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-200">
                        <label className="block text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                          Fecha de Cierre del Turno
                        </label>
                        <input 
                          type="date"
                          required
                          value={sessionClosingDate}
                          onChange={(e) => setSessionClosingDate(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-black text-slate-800 outline-none focus:ring-2 focus:ring-indigo-500 shadow-sm"
                        />
                      </div>

                      {/* Empleado del Turno (Sin volver a pedir el nombre) */}
                      <div className="bg-indigo-50/60 p-3 rounded-xl border border-indigo-100 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <User className="w-4 h-4 text-indigo-600" />
                          <span className="text-[9px] font-black text-indigo-900 uppercase tracking-wider">Empleado Asignado:</span>
                        </div>
                        <span className="text-xs font-black text-indigo-950 uppercase tracking-tight">
                          {currentSession?.workerName || sessionWorkerName || currentUser?.name || 'Empleado'}
                        </span>
                      </div>

                      {/* Salary Calculation Card */}
                      {(() => {
                        const sessionUser = users.find(u => u.id === currentSession?.userId || (u.name && currentSession?.workerName && u.name.toLowerCase() === currentSession.workerName.toLowerCase())) || currentUser;
                        if (!sessionUser) return null;
                        
                        const sessionTx = activeTransactions.filter(t => 
                          t.sessionId === currentSession?.id && !t.deletedAt
                        );
                        const totalSales = sessionTx.reduce((sum, tx) => sum + (tx.total || 0), 0);
                        
                        const productCommissions = sessionTx.reduce((sum, tx) => {
                          return sum + (tx.items || []).reduce((itemSum, item) => {
                            const prodId = typeof item.product === 'string' ? item.product : item.product?.id;
                            const prodObj = products.find(p => p.id === prodId);
                            const commVal = prodObj?.commissionValue || 0;
                            return itemSum + (commVal * (item.quantity || 0));
                          }, 0);
                        }, 0);

                        // La liquidación por producto es exclusivamente la comisión fija
                        // configurada en CUP por unidad. No se mezcla con el precio de venta
                        // ni con una comisión porcentual del total vendido.
                        const totalCommissions = productCommissions;
                        const totalSalary = (sessionUser.baseSalary || 0) + totalCommissions;
                        
                        return (
                          <div className="bg-amber-50 p-4 rounded-2xl border border-amber-200 space-y-2 shadow-sm animate-in fade-in slide-in-from-top-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <DollarSign className="w-4 h-4 text-amber-600" />
                                <span className="text-[10px] font-black text-amber-900 uppercase tracking-widest">Liquidación del Turno</span>
                              </div>
                              <span className="text-xs font-black text-amber-900 uppercase">
                                {sessionUser?.name || "Empleado"}
                              </span>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-amber-100">
                              <div>
                                <p className="text-[8px] font-bold text-amber-600 uppercase tracking-tighter">Salario Base</p>
                                <p className="text-sm font-black text-amber-900">{formatSalaryCUP(sessionUser.baseSalary || 0)}</p>
                              </div>
                              <div>
                                <p className="text-[8px] font-bold text-amber-600 uppercase tracking-tighter">Comisiones por productos</p>
                                <p className="text-sm font-black text-emerald-700">+{formatSalaryCUP(totalCommissions)}</p>
                                {productCommissions > 0 && (
                                  <p className="text-[7px] text-emerald-600 font-bold mt-0.5">({formatSalaryCUP(productCommissions)} por productos)</p>
                                )}
                              </div>
                            </div>
                            
                            <div className="pt-2 border-t border-amber-100 flex justify-between items-center">
                              <span className="text-[9px] font-black text-amber-900 uppercase">Total a Entregar</span>
                              <span className="text-lg font-black text-amber-600">{formatSalaryCUP(totalSalary)}</span>
                            </div>
                            <div className="pt-3 border-t border-amber-100 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[9px] font-black text-amber-900 uppercase tracking-widest">Productos cobrados y salario por producto</span>
                                <span className="text-[8px] font-black text-amber-700 uppercase whitespace-nowrap">{turnProductSalaryRows.reduce((sum, row) => sum + row.quantity, 0)} uds</span>
                              </div>
                              {turnProductSalaryRows.length > 0 ? (
                                <div className="overflow-x-auto rounded-xl border border-amber-100 bg-white">
                                  <table className="w-full min-w-[560px] text-left">
                                    <thead><tr className="bg-amber-50 border-b border-amber-100">
                                      <th className="px-3 py-2 text-[7px] font-black text-amber-700 uppercase">Empleado</th>
                                      <th className="px-3 py-2 text-[7px] font-black text-amber-700 uppercase">Producto</th>
                                      <th className="px-3 py-2 text-[7px] font-black text-amber-700 uppercase text-right">Cantidad</th>
                                      <th className="px-3 py-2 text-[7px] font-black text-amber-700 uppercase text-right">Salario / unidad</th>
                                      <th className="px-3 py-2 text-[7px] font-black text-amber-700 uppercase text-right">Salario total</th>
                                    </tr></thead>
                                    <tbody className="divide-y divide-amber-50">
                                      {turnProductSalaryRows.map(row => (
                                        <tr key={row.key}>
                                          <td className="px-3 py-2 text-[8px] font-black text-slate-700 uppercase break-words">{row.employeeName}</td>
                                          <td className="px-3 py-2 text-[8px] font-black text-slate-900 uppercase break-words">{row.productName}</td>
                                          <td className="px-3 py-2 text-[8px] font-black text-slate-800 text-right">{row.quantity}</td>
                                          <td className="px-3 py-2 text-[8px] font-black text-indigo-700 text-right">{formatSalaryCUP(row.salaryPerUnit)}</td>
                                          <td className="px-3 py-2 text-[8px] font-black text-indigo-900 text-right">{formatSalaryCUP(row.salaryTotal)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ) : (
                                <div className="bg-white rounded-xl border border-amber-100 px-3 py-4 text-center">
                                  <p className="text-[7px] font-black text-slate-400 uppercase tracking-wider">No hay productos cobrados en este turno</p>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    <div className="space-y-3">
                      <h4 className="text-[10px] font-black text-slate-900 uppercase tracking-widest border-b border-slate-100 pb-2">Arqueo de Efectivo Físico</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-emerald-50 p-3 rounded-xl border-2 border-emerald-200 focus-within:ring-2 focus-within:ring-emerald-500 transition-all shadow-sm">
                          <label className="block text-[9px] font-black text-emerald-700 uppercase tracking-widest mb-1">Efectivo CUP / MN</label>
                          <p className="text-[7px] font-bold text-emerald-500 uppercase mb-1">Conteo físico de efectivo</p>
                          <input type="number" min="0" step="0.01" value={closingBalances['CUP-cash'] || ''} onFocus={(e) => e.target.select()} onChange={(e) => setClosingBalances({ ...closingBalances, ['CUP-cash']: parseFloat(e.target.value) || 0 })} className="w-full bg-transparent border-none focus:ring-0 outline-none font-black text-emerald-900 text-sm p-0" placeholder="0.00" />
                        </div>
                        {cashDisplayCurrencies.filter(c => c.code !== 'CUP').map(c => (
                          <div key={c.code} className="bg-slate-50 p-3 rounded-xl border border-slate-100 focus-within:ring-2 focus-within:ring-emerald-500 transition-all">
                            <label className="block text-[8px] font-black text-emerald-600 uppercase tracking-widest mb-1">Efectivo {c.code}</label>
                            <input type="number" min="0" step="0.01" value={closingBalances[c.code + '-cash'] || ''} onFocus={(e) => e.target.select()} onChange={(e) => setClosingBalances({ ...closingBalances, [c.code + '-cash']: parseFloat(e.target.value) || 0 })} className="w-full bg-transparent border-none focus:ring-0 outline-none font-black text-slate-900 text-sm p-0" placeholder="0.00" />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h4 className="text-[10px] font-black text-slate-900 uppercase tracking-widest border-b border-slate-100 pb-2">Transferencias</h4>
                      <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                        <label className="block text-[8px] font-black text-blue-600 uppercase tracking-widest mb-1">Transf. CUP</label>
                        <input 
                          type="number" 
                          min="0" step="0.01"
                          value={closingBalances['CUP-transfer'] || ''}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => setClosingBalances({ ...closingBalances, 'CUP-transfer': parseFloat(e.target.value) || 0 })}
                          className="w-full bg-transparent border-none focus:ring-0 outline-none font-black text-slate-900 text-sm p-0"
                          placeholder="0.00"
                        />
                      </div>
                    </div>

                    <div className="pt-2">
                      <button 
                        type="submit"
                        disabled={isClosingSession}
                        className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 transition-all shadow-xl shadow-slate-200 active:scale-95 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {isClosingSession ? <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin" /> : <ShieldCheck className="w-4 h-4 text-emerald-400" />}
                        {isClosingSession ? "Confirmando Cierre..." : "Cerrar Turno y Finalizar"}
                      </button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          </div>
        </div>
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
                                {diff > 0 ? 'SOBRANTE: +' : 'FALTANTE: '}{diff.toLocaleString('es-CU')}
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
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-200 truncate max-w-[110px] sm:max-w-[150px]">
              {currentSession?.workerName || currentUser?.name || 'Caja Activa'}
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-1.5 text-slate-400 text-[10px] font-bold">
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
              <span key={c.code} className="text-[9px] font-black text-indigo-300">
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
            className="px-2.5 sm:px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[9px] sm:text-[10px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 shadow-md shadow-rose-950/40 active:scale-95 border border-rose-500/40"
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
              className="px-2 sm:px-2.5 py-1 bg-slate-100 hover:bg-rose-50 text-rose-600 rounded-lg text-[9px] sm:text-[10px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 border border-slate-200 active:scale-95"
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
                          <span className="text-[10px] sm:text-[11px] font-black text-primary font-mono">{formatMoney(prodPrice * item.quantity, baseCurrency.symbol)}</span>
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
                <span className="text-[11px] font-black text-primary uppercase tracking-wider">Total</span>
                <span className="text-xl font-black text-indigo-600 dark:text-indigo-400 tracking-tight">{formatMoney(totalBase, baseCurrency.symbol)}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-1.5">
              <button 
                disabled={cart.length === 0}
                onClick={() => {
                  if (!currentSession) {
                    setPosError("Debes abrir un turno de caja antes de cobrar.");
                    setShowOpenShiftModal(true);
                    return;
                  }
                  const lineId = crypto.randomUUID();
                  setPaymentLines([{ id: lineId, code: baseCurrency.code, amount: totalBase, method: 'cash' }]);
                  setActivePaymentLineId(lineId);
                  setShowCheckoutModal(true);
                }}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-black text-[11px] uppercase tracking-wider transition-all shadow-md shadow-indigo-600/20 disabled:opacity-20 active:scale-98 flex items-center justify-center gap-2"
              >
                <Banknote className="w-4 h-4 text-emerald-300" />
                Cobrar Efectivo
              </button>
              
              <div className="grid grid-cols-2 gap-1.5">
                <button 
                  disabled={cart.length === 0}
                  onClick={() => {
                    if (!currentSession) {
                      setPosError("Debes abrir un turno de caja antes de cobrar.");
                      setShowOpenShiftModal(true);
                      return;
                    }
                    const lineId = crypto.randomUUID();
                    setPaymentLines([{ id: lineId, code: baseCurrency.code, amount: totalBase, method: 'transfer' }]);
                    setActivePaymentLineId(lineId);
                    setShowCheckoutModal(true);
                  }}
                  className="py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-[9px] uppercase tracking-wider transition-all shadow-xs disabled:opacity-20 active:scale-98 flex items-center justify-center gap-1.5"
                >
                  <CreditCard className="w-3.5 h-3.5" />
                  Transferir
                </button>
                <button 
                  disabled={cart.length === 0}
                  onClick={() => openCheckout()}
                  className="py-2 bg-indigo-700 hover:bg-indigo-800 text-white rounded-xl font-black text-[9px] uppercase tracking-wider transition-all shadow-xs disabled:opacity-20 active:scale-98 flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Cobro Mixto
                </button>
              </div>
            </div>
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
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[95] flex items-center justify-center p-2 sm:p-4 overflow-hidden animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-md max-h-[94vh] sm:max-h-[90vh] flex flex-col overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            {/* Header: Compact & Sticky */}
            <div className="p-3.5 sm:p-4 text-center border-b border-slate-100 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 shrink-0">
              <div className="w-10 h-10 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-1 border border-emerald-100 dark:border-emerald-900/50 shadow-xs">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div className="flex items-center justify-center gap-1.5 flex-wrap">
                <span className="bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 text-[9px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-indigo-100 dark:border-indigo-900">
                  {lastClosedSession.id}
                </span>
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">
                  {lastClosedSession.workerName || 'Empleado'}
                </span>
              </div>
              <h3 className="text-base sm:text-lg font-black text-slate-900 dark:text-white uppercase tracking-tight mt-0.5">
                Turno Cerrado con Éxito
              </h3>
              <p className="text-[8px] sm:text-[9px] font-medium text-slate-400 uppercase tracking-wider">
                {new Date(lastClosedSession.closingDate || lastClosedSession.closedAt || new Date()).toLocaleString()}
              </p>
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-3.5 sm:p-5 space-y-3 text-left">
              {(() => {
                const sessionTransactions = activeTransactions.filter(t => 
                  t.branchId === lastClosedSession.branchId && 
                  t.sessionId === lastClosedSession.id
                );

                const employee = users.find(u => u.id === lastClosedSession.userId || u.name === lastClosedSession.workerName) || users.find(u => u.name?.toLowerCase() === lastClosedSession.workerName?.toLowerCase()) || users.find(u => u.role === 'employee') || currentUser;
                const isIndependent = false;

                const commissions = isIndependent ? 0 : sessionTransactions.reduce((sum, tx) => {
                  return sum + (tx.items || []).reduce((s, item) => {
                    const prodId = typeof item.product === 'string' ? item.product : item.product?.id;
                    const prod = products.find(p => p.id === prodId);
                    if (!prod) return s;
                    const commValue = prod.commissionValue || 0;
                    return s + (commValue * item.quantity);
                  }, 0);
                }, 0);

                const baseSalary = employee?.baseSalary || 0;
                const settlement = salarySettlements.find(s => s.sessionId === lastClosedSession.id);
                const deduction = settlement?.discrepancyDeduction || 0;
                const totalSalary = (baseSalary + commissions) - deduction;
                
                const totalSales = sessionTransactions.reduce((sum, tx) => sum + (tx.total || 0), 0);
                const totalItems = sessionTransactions.reduce((sum, tx) => sum + (tx.items || []).reduce((s, i) => s + (i.quantity || 0), 0), 0);

                // Group products for display
                const groupedProducts: { [name: string]: number } = {};                sessionTransactions.forEach(tx => {
                  tx.items.forEach(item => {
                    const name = typeof item.product === 'string' ? item.product : item.product?.name;
                    if (name) groupedProducts[name] = (groupedProducts[name] || 0) + item.quantity;
                  });
                });

                return (
                  <div className="space-y-3">
                    {/* Resumen de Productos */}
                    <div className="bg-slate-50 dark:bg-slate-800/40 rounded-xl sm:rounded-2xl p-3 border border-slate-100 dark:border-slate-800">
                      <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 flex justify-between">
                        <span>Resumen de Venta</span>
                        <span className="text-indigo-600 dark:text-indigo-400">{totalItems} {totalItems === 1 ? 'unidad' : 'unidades'}</span>
                      </p>
                      <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
                        {Object.entries(groupedProducts).map(([name, qty]) => (
                          <div key={name} className="flex justify-between items-center text-[10px] sm:text-[11px] py-0.5 border-b border-slate-100 dark:border-slate-800/50 last:border-0">
                            <span className="font-semibold text-slate-700 dark:text-slate-300 truncate max-w-[200px] sm:max-w-[240px]">{name}</span>
                            <span className="font-mono font-black text-slate-900 dark:text-white bg-white dark:bg-slate-700 px-1.5 py-0.2 rounded border border-slate-200 dark:border-slate-600 shrink-0">x{qty}</span>
                          </div>
                        ))}
                        {Object.keys(groupedProducts).length === 0 && (
                          <p className="text-[10px] text-slate-400 italic py-1">No se registraron ventas en este turno.</p>
                        )}
                      </div>
                    </div>

                    {/* Liquidación de Salario */}
                    <div className="bg-white dark:bg-slate-900 rounded-xl sm:rounded-2xl p-3 border border-indigo-100 dark:border-indigo-900/50 space-y-2 shadow-2xs">
                      <div className="text-[9px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-widest border-b border-indigo-50 dark:border-indigo-950 pb-1.5 flex justify-between">
                        <span>Liquidación de Salario</span>
                        <span className="text-slate-400 font-bold">{lastClosedSession.workerName}</span>
                      </div>
                      
                      <div className="space-y-1 text-xs">
                        <div className="flex justify-between items-center">
                          <span className="font-semibold text-slate-500 dark:text-slate-400 text-[10px] uppercase">Salario Base</span>
                          <span className="font-mono font-bold text-slate-900 dark:text-slate-100">{formatMoney(baseSalary, baseCurrency.symbol)}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="font-semibold text-slate-500 dark:text-slate-400 text-[10px] uppercase">Comisiones</span>
                          <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">+{formatMoney(commissions, baseCurrency.symbol)}</span>
                        </div>
                        
                        {deduction > 0 && (
                          <div className="flex justify-between items-center p-1.5 bg-rose-50 dark:bg-rose-950/30 rounded-lg border border-rose-100 dark:border-rose-900/50">
                            <span className="font-bold text-rose-600 dark:text-rose-400 text-[9px] uppercase">Descuento Descuadre</span>
                            <span className="font-mono font-black text-rose-600 dark:text-rose-400">-{formatMoney(deduction, baseCurrency.symbol)}</span>
                          </div>
                        )}
                      </div>

                      <div className="pt-2 border-t border-slate-100 dark:border-slate-800 border-dashed flex justify-between items-center">
                        <div>
                          <span className="text-[9px] font-black text-slate-900 dark:text-white uppercase tracking-wider block">Neto a Recibir</span>
                          <span className="text-[7px] font-bold text-slate-400 uppercase">Liquidación Total Turno</span>
                        </div>
                        <span className="text-lg sm:text-xl font-black text-indigo-600 dark:text-indigo-400 font-mono tracking-tight">
                          {formatSalaryCUP(totalSalary)}
                        </span>
                      </div>
                    </div>

                    {/* Totales de Turno */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded-xl p-2.5 border border-emerald-100 dark:border-emerald-900/50">
                        <p className="text-[8px] font-black text-emerald-800 dark:text-emerald-400 uppercase tracking-tight">Total Vendido</p>
                        <p className="text-xs sm:text-sm font-black text-emerald-700 dark:text-emerald-300 font-mono">{formatMoney(totalSales, baseCurrency.symbol)}</p>
                      </div>
                      <div className="bg-slate-900 dark:bg-slate-800 rounded-xl p-2.5 text-white">
                        <p className="text-[8px] font-black text-slate-400 uppercase tracking-tight">Ventas Turno</p>
                        <p className="text-xs sm:text-sm font-black font-mono">{sessionTransactions.length} Tickets</p>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Action Footer - Sticky and Compact */}
            <div className="p-2.5 sm:p-3 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 space-y-1.5 shrink-0">
              <div className="grid grid-cols-2 gap-1.5">
                <button 
                  onClick={() => handlePrintClosureThermal(lastClosedSession)}
                  className="py-2.5 px-2 bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white text-white rounded-xl font-black text-[9px] sm:text-[10px] uppercase tracking-wider transition-all shadow-xs active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer"
                  title="Imprimir ticket en la impresora configurada"
                >
                  <Printer className="w-3.5 h-3.5 shrink-0" />
                  <span>Imprimir Ticket</span>
                </button>

                
              </div>

              <button 
                onClick={() => {
                  setShowSalarySummary(false);
                  navigate('/');
                }}
                className="w-full py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-xl font-black text-[10px] sm:text-xs uppercase tracking-wider hover:bg-slate-100 dark:hover:bg-slate-750 transition-all active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
              >
                <span>Finalizar e Ir al Menú</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
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
                onClick={openCheckout}
                className="h-8 px-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-lg shadow-emerald-950 active:scale-95 flex items-center gap-1 disabled:opacity-40 disabled:pointer-events-none disabled:shadow-none"
              >
                <Banknote className="w-3.5 h-3.5" />
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
        password={cancelShiftPassword}
        setPassword={setCancelShiftPassword}
        isCancelling={isCancellingShift}
        onCancel={handleCancelShift}
        onClose={() => {
          setShowCancelShiftModal(false);
          setCancelShiftPassword("");
        }}
      />

    </div>
  );
}