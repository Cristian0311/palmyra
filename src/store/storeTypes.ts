import {
  Branch, Category, Product, InventoryLevel, CartItem, Transaction, ReturnItem, Currency, Customer,
  CashRegisterSession, User, PendingOrder, SalarySettlement, InventoryTransfer, Warranty, CashMovement,
  Supplier, SupplierOrder, InventoryAudit, FiscalConfig, DemandForecast, BankCard, BankTransaction
} from '../types';
import type { SyncResult } from '../services/supabaseSync';

export interface AppState {
  // Auth
  users: User[];
  currentUser: User | null;
  login: (email: string, pass: string) => Promise<boolean>;
  logout: () => void;
  clearAllData: () => Promise<void>;
  clearReportsHistory: () => Promise<void>;
  resetSelectedData: (sections: import('../services/supabaseSync/mutations').ResetSection[]) => Promise<{ success: boolean; failed: string[] }>;
  exportData: () => string;
  importData: (jsonData: string) => Promise<{ success: boolean; error?: string }>;
  addUser: (user: User) => void;
  registerEmployee: (name: string, password: string) => User;
  updateUser: (id: string, user: Partial<User>) => void;
  deleteUser: (id: string) => void;

  // Configuración
  currencies: Currency[];
  updateCurrencyRate: (code: string, newRate: number) => void;
  getBaseCurrency: () => Currency;
  storeConfig: import('../types').StoreConfig;
  updateStoreConfig: (config: import('../types').StoreConfig) => void;

  // Sucursales
  branches: Branch[];
  currentBranchId: string;
  setCurrentBranch: (id: string) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  addBranch: (branch: Branch) => void;
  updateBranch: (id: string, branch: Partial<Branch>) => void;
  deleteBranch: (id: string) => void;
  
  // Catálogo
  categories: Category[];
  addCategory: (category: Category) => void;
  updateCategory: (id: string, category: Partial<Category>) => void;
  deleteCategory: (id: string) => void;
  products: Product[];
  inventory: InventoryLevel[];
  addProduct: (product: Product, initialQuantity?: number, branchId?: string, variantLabel?: string, initialVariantQuantities?: { [key: string]: number }) => void;
  updateProduct: (id: string, product: Partial<Product>) => void;
  deleteProduct: (id: string) => void;
  batchDeleteProducts: (ids: string[]) => void;
  batchUpdateProducts: (ids: string[], updates: Partial<Product>) => void;
  transferInventory: (productId: string, fromBranchId: string, toBranchId: string, quantity: number, variantLabel?: string, transactionId?: string) => Promise<{ success: boolean; error?: string } | boolean>;
  transferInventoryBatch: (productId: string, fromBranchId: string, toBranchId: string, variants: { variantLabel: string; quantity: number }[], transactionId?: string, batchId?: string) => Promise<{ success: boolean; error?: string }>;
  reconcileProductStock: (productId: string, corrections: { branchId: string; variantLabel?: string; quantity: number; minQuantity?: number }[]) => Promise<{ success: boolean; error?: string }>;
  repairOrphanedInventoryLevels: () => Promise<{ repaired: number; message: string }>;
  adjustInventory: (productId: string, branchId: string, delta: number, variantLabel?: string, minQuantity?: number) => void;
  setInventoryQuantity: (productId: string, branchId: string, quantity: number, variantLabel?: string, minQuantity?: number) => void;
  transferProductsBulk: (fromBranchId: string, toBranchId: string, items: { productId: string; quantity: number; variant?: string }[]) => Promise<{ success: boolean; error?: string }>;
  
  // Carrito POS
  cart: CartItem[];
  currentCustomerId?: string;
  addToCart: (product: Product, serialNumber?: string, attributes?: { size?: string, color?: string, variantLabel?: string }, quantity?: number) => void;
  updateCartQty: (cartItemId: string, delta: number) => void;
  updateCartSerial: (cartItemId: string, serialNumber: string) => void;
  setCartCustomer: (customerId?: string) => void;
  clearCart: () => void;

  // Transacciones y Devoluciones
  transactions: Transaction[];
  timeShifts: import("../types").TimeShift[];
  addTimeShift: (shift: import("../types").TimeShift) => void;
  updateTimeShift: (id: string, updates: Partial<import("../types").TimeShift>) => void;
  quotes: import("../types").Quote[];
  addQuote: (quote: import("../types").Quote) => void;
  updateQuote: (id: string, updates: Partial<import("../types").Quote>) => void;
  returns: ReturnItem[];
  processTransaction: (transaction: Transaction) => Promise<boolean>;
  updateTransaction: (id: string, updates: Partial<Transaction>) => void;
  deleteTransaction: (id: string, reason?: string) => void;
  createReturn: (returnItem: ReturnItem) => void;
  updateReturn: (id: string, returnItem: Partial<ReturnItem>) => void;
  processReturn: (id: string, action: 'complete' | 'reject') => void;

  // Clientes
  customers: Customer[];
  addCustomer: (customer: Customer) => Promise<boolean>;
  updateCustomer: (id: string, customer: Partial<Customer>) => Promise<boolean>;
  deleteCustomer: (id: string) => void;

  // Caja
  cashSessions: CashRegisterSession[];
  openSession: (session: CashRegisterSession) => Promise<boolean>;
  closeSession: (sessionId: string, closingBalances: import('../types').Payment[], workerName?: string, closingDate?: string, discrepancyDeduction?: number, sessionMeta?: Partial<CashRegisterSession>) => Promise<boolean>;
  updateCashSession: (id: string, updates: Partial<CashRegisterSession>) => void;
  cancelSession: (sessionId: string, reason?: string) => Promise<boolean>;
  updateCashSessionDateCascade: (sessionId: string, newDateYMD: string) => Promise<boolean>;
  joinOpenSession: (sessionId: string, userId: string, workerName?: string) => void;
  getCurrentSession: (branchId: string, userId: string) => CashRegisterSession | undefined;
  addInformationalSoldProductToSession: (sessionId: string, itemData: {
    productId: string;
    productName: string;
    quantity: number;
    price: number;
    userId?: string;
    workerName?: string;
    paymentMethod?: 'cash' | 'transfer';
    currencyCode?: string;
    variantLabel?: string;
  }, affectStock?: boolean, isDeduction?: boolean) => Promise<{ success: boolean; transactionId?: string }>;
  subtractInformationalProductFromSession: (sessionId: string, itemData: {
    productId: string;
    productName: string;
    quantity: number;
    price: number;
    userId?: string;
    workerName?: string;
    paymentMethod?: 'cash' | 'transfer';
    currencyCode?: string;
    variantLabel?: string;
  }, affectStock?: boolean) => Promise<{ success: boolean; transactionId?: string }>;
  forceCloseSessionFromReports: (sessionId: string, closingBalances?: import('../types').Payment[], closingDate?: string, notes?: string) => Promise<{ success: boolean }>;

  // Garantías
  warranties: import('../types').Warranty[];
  addWarranty: (warranty: import('../types').Warranty) => void;
  updateWarranty: (id: string, warranty: Partial<import('../types').Warranty>) => void;

  // Liquidaciones de Salario
  salarySettlements: SalarySettlement[];
  addSalarySettlement: (settlement: SalarySettlement) => void;
  updateSalarySettlement: (id: string, settlement: Partial<SalarySettlement>) => void;
  addCashMovement: (sessionId: string, movement: CashMovement) => Promise<boolean | void>;
  removeCashMovement: (sessionId: string, movementId: string) => Promise<boolean | void>;
  transfers: InventoryTransfer[];
  addTransfer: (transfer: InventoryTransfer) => void;

  // Pedidos QR
  pendingOrders: PendingOrder[];
  createPendingOrder: (order: PendingOrder) => void;
  removePendingOrder: (id: string) => void;

  // Enterprise Modules
  suppliers: Supplier[];
  addSupplier: (supplier: Supplier) => void;
  updateSupplier: (id: string, supplier: Partial<Supplier>) => void;
  deleteSupplier: (id: string) => void;
  
  supplierOrders: SupplierOrder[];
  createSupplierOrder: (order: SupplierOrder) => void;
  updateSupplierOrder: (id: string, order: Partial<SupplierOrder>) => void;
  
  inventoryAudits: InventoryAudit[];
  createInventoryAudit: (audit: InventoryAudit) => Promise<{ success: boolean; error?: string }>;
  completeInventoryAudit: (id: string, items: any[], notes?: string) => Promise<{ success: boolean; error?: string }>;
  requestInventoryAuditRecount: (id: string, notes?: string) => Promise<{ success: boolean; error?: string }>;
  approveInventoryAudit: (id: string, notes?: string) => Promise<{ success: boolean; error?: string }>;
  
  fiscalConfigs: FiscalConfig[];
  updateFiscalConfig: (id: string, config: Partial<FiscalConfig>) => void;
  getNextNCF: (type: string) => Promise<string | undefined>;

  demandForecasts: DemandForecast[];
  updateForecasts: (forecasts: DemandForecast[]) => void;

  receiptConfig: import('../types').ReceiptConfig;
  updateReceiptConfig: (config: Partial<import('../types').ReceiptConfig>) => void;

  lastTurnNumber: number;

  // Banks Module
  bankCards: import('../types').BankCard[];
  addBankCard: (card: import('../types').BankCard) => void;
  updateBankCard: (id: string, card: Partial<import('../types').BankCard>) => void;
  deleteBankCard: (id: string) => Promise<boolean>;
  
  bankTransactions: import('../types').BankTransaction[];
  addBankTransaction: (transaction: import('../types').BankTransaction) => Promise<boolean>;
  deleteBankTransaction: (id: string) => Promise<boolean>;
  reconcileBankBalances: () => Promise<{ removedDuplicates: number; totalSales?: number; totalMovements?: number; message: string }>;

  // Supabase Sync
  isSyncing: boolean;
  lastSyncTime: string | null;
  syncResult: SyncResult | null;
  syncWithSupabase: () => Promise<SyncResult>;
  bootstrapPosFromSupabase: () => Promise<boolean>;
  refreshBranchInventory: () => Promise<boolean>;
  refreshBranchOperationalData: (options?: { sessionId?: string; transactionLimit?: number; transferLimit?: number }) => Promise<boolean>;
  refreshGlobalCatalogData: () => Promise<boolean>;
  seedDemoProducts: () => void;
  restoreTransactionsFromBackup: () => void;

  isInitialized: boolean;
  
  // Notificaciones Globales
  notifications: { id: string; message: string; type: 'success' | 'error' | 'warning' | 'info'; details?: string }[];
  addNotification: (message: string, type?: 'success' | 'error' | 'warning' | 'info', details?: string) => void;
  removeNotification: (id: string) => void;
}
