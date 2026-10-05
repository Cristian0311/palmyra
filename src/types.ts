export interface Currency {
  code: 'CUP' | 'USD' | 'EUR' | 'MN';
  name: string;
  symbol: string;
  rateToBase: number; // Exchange rate relative to base currency (e.g., 1 USD = 320 CUP)
  isBase?: boolean;
}

export interface Warehouse {
  id: string;
  name: string;
  address?: string;
  phone?: string;
  isMain?: boolean;
  isActive?: boolean;
}

/** @deprecated Use Warehouse. Kept temporarily for runtime compatibility. */
export interface Branch extends Warehouse {}

export interface Category {
  id: string;
  name: string;
  department: string; // e.g., 'Electrodomésticos', 'Ferretería', 'Ropa', 'Calzado'
  description?: string;
  color?: string;
  image?: string;
}

export interface Product {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  costPrice: number; // Precio de compra
  price: number; // Precio de venta
  margin: number; // Ganancia
  categoryId: string;
  color: string; // Tailwind class para UI
  
  // Commission settings
  commissionValue: number; // Cup fijo de comisión por producto
  commissionType?: 'percentage' | 'fixed';

  // Enterprise fields
  unit?: string; // 'unidad', 'kg', 'm', 'par', etc.
  status?: 'active' | 'discontinued' | 'draft';
  minStockAlert?: number; // Override for specific product
  
  // Advanced tracking
  hasSerial?: boolean; // Tracking individual units
  isKit?: boolean; // Is it a bundle of other products?
  kitComponents?: { productId: string; quantity: number }[];
  kitItems?: any[];
  
  // Dynamic attributes
  warrantyDays?: number;
  deviceColor?: string;
  
  // Ropa / Calzado
  availableSizes?: string[];
  availableColors?: string[];
  nextSerial?: number; // Para autogenerar series
  image?: string; // Base64 or URL
}

export interface InventoryLevel {
  id?: string;
  productId: string;
  /** Canonical warehouse scope. */
  warehouseId?: string;
  /** @deprecated Use warehouseId. */
  branchId: string;
  variantLabel?: string; // e.g., 'Talla 42', 'M', 'Rojo'
  quantity: number;
  minQuantity: number;
}

export interface CartItem {
  id: string; // ID único para la fila del carrito
  product: Product;
  quantity: number;
  price: number; // Precio al que se vendió
  total: number; // Subtotal (quantity * price)
  serialNumber?: string; // Si hasSerial es true
  warrantyCode?: string;
  selectedSize?: string;
  selectedColor?: string;
  variantLabel?: string; // Unificado para tracking
}

export interface Payment {
  currencyCode: 'CUP' | 'USD' | 'EUR' | 'MN';
  amount: number; // Monto pagado en esa moneda
  exchangeRate: number; // Tasa de cambio al momento de la venta
  method: 'cash' | 'transfer';
  bankCardId?: string;
}

export interface StoreConfig {
  storeName: string;
  address: string;
  phone: string;
  receiptNotes?: string;
  latitude?: number;
  longitude?: number;
  darkMode?: boolean;
  manualOfflineSync?: boolean;
}


export interface Transaction {
  id: string;
  /** Canonical warehouse scope. */
  warehouseId?: string;
  /** @deprecated Use warehouseId. */
  branchId: string;
  userId: string; // The user who processed the transaction
  sellerEmployeeIds?: string[]; // IDs of employees involved in the sale for commission splitting
  cashierName?: string; // Explicit name of the cashier/seller for the shift
  date: string;
  subtotal?: number; // In base currency (CUP)
  tax?: number; // In base currency
  discount?: number;
  total: number; // In base currency
  payments: Payment[]; // Pagos múltiples combinados
  items: CartItem[];
  status: 'completed' | 'refunded' | 'partial_refund';
  customerId?: string;
  ncf?: string; // Numero de Comprobante Fiscal
  ncfType?: string; // e.g., 'B01', 'B02'
  changeGiven?: number; // In base currency
  changePayments?: Payment[]; // Multicurrency change details
  sessionId?: string; // ID of the cash session/turno in which the transaction was created
  notes?: string;
  paymentMethod?: string;
  deletedAt?: string;
  deletedBy?: string;
  deleteReason?: string;
  /** Local marker: sale exists on this terminal and still requires durable/offline confirmation. */
  offlinePending?: boolean;
}

export interface ReturnItem {
  id: string;
  transactionId: string;
  productId: string;
  quantity: number;
  reason: string; // 'defective', 'wrong_size', 'changed_mind'
  date: string;
  status: 'pending' | 'approved' | 'rejected' | 'completed';
  type: 'refund' | 'warranty_exchange';
  notes?: string;
  variantLabel?: string;
  branchId?: string;
  replacementProductId?: string;
  replacementQuantity?: number;
  processedBy?: string;
  // Physical return and monetary refund are separate control events.
  refundStatus?: 'not_required' | 'pending' | 'approved' | 'paid' | 'rejected';
  refundAmount?: number;
  refundCurrencyCode?: string;
  refundMethod?: 'cash' | 'transfer' | 'store_credit';
  refundBankCardId?: string;
  refundTransactionId?: string;
  receivedAt?: string;
  refundedAt?: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  taxId?: string; // RNC or Cédula
}

export interface CashRegisterSession {
  id: string;
  /** Persisted global sequential cash-turn number assigned by Supabase. */
  turnNumber?: number;
  /** Canonical warehouse scope. */
  warehouseId?: string;
  /** @deprecated Use warehouseId. */
  branchId: string;
  openedAt: string;
  closedAt?: string;
  openingBalance: number;
  openingAmount?: number;
  closingBalances?: Payment[];
  expectedBalance?: number;
  status: 'open' | 'closed' | 'cancelled';
  userId: string; // The user who opened it
  workerName?: string; // Custom name for the shift (e.g., worker name)
  workingEmployeeIds?: string[]; // IDs of employees working this session
  movements?: CashMovement[];
  closingDate?: string;
  notes?: string;
  isForcedClose?: boolean;
  forcedCloseReason?: string;
  discrepancyNote?: string;
  hasDiscrepancy?: boolean;
  discrepancyDetails?: {
    currencyCode: string;
    method: 'cash' | 'transfer';
    expected: number;
    actual: number;
    difference: number;
  }[];
  discrepancyDeductionApplied?: number;
  deductedFromSalary?: boolean;
  aiDiagnostic?: {
    analysis: string;
    suggestions: string[];
  };
  matchingProductsAnalysis?: {
    currencyCode: string;
    difference: number;
    matchedProducts: { id: string; name: string; price: number }[];
  }[];
  auditStatus?: 'pending_review' | 'reviewed' | 'resolved';
  auditNotes?: string;
  deletedAt?: string;
  deletedBy?: string;
  deleteReason?: string;
}

export interface CashMovement {
  id: string;
  type: 'income' | 'expense';
  amount: number;
  currencyCode: string;
  description: string;
  date: string;
  sessionId?: string;
  branchId?: string;
  workerName?: string;
  category?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'employee';
  password?: string;
  /** Canonical warehouse assignment. */
  warehouseId?: string;
  baseSalary: number; // Salario base o CUP fijo por día
  salesGoal?: number;
  commissionRate?: number;
  phone?: string;
  branchId?: string; // Sucursal asignada
  supervisorId?: string; // Supervisor (empleado principal)
  allowedBranches?: string[]; // @deprecated Alias de allowedWarehouseIds
  allowedWarehouseIds?: string[]; // Almacenes donde el usuario puede operar
  permissions?: string[];
  isActive?: boolean;
}


export interface PendingOrder {
  id: string; // e.g. QR code
  items: CartItem[];
  createdAt: string;
  status: 'pending' | 'completed';
}

export interface Warranty {
  id: string;
  productId: string;
  productName: string;
  transactionId: string;
  customerId?: string;
  customerName?: string;
  purchaseDate: string;
  expiryDate: string;
  serialNumber?: string;
  status: 'active' | 'expired' | 'claimed' | 'refunded' | 'exchanged';
}

export interface SalarySettlement {
  id: string;
  userId: string;
  userName: string;
  sessionId: string;
  baseSalary: number;
  salesGoal?: number;
  commissions: number;
  discrepancyDeduction?: number;
  total: number;
  date: string;
  status: 'pending' | 'paid' | 'cancelled' | 'waiting';
}

export interface InventoryTransfer {
  id: string;
  productId: string;
  productName: string;
  /** Canonical warehouse scope. */
  fromWarehouseId?: string;
  toWarehouseId?: string;
  /** @deprecated Use fromWarehouseId/toWarehouseId. */
  fromBranchId: string;
  fromBranchName: string;
  toBranchId: string;
  toBranchName: string;
  variantLabel?: string;
  quantity: number;
  variants?: { variantLabel: string; quantity: number }[]; // For grouped transfers
  date: string;
  userId: string;
  transactionId?: string;
  batchId?: string; // For grouping multiple products in a single operation
  status: 'completed' | 'cancelled' | 'pending';
  operationId?: string;
}

export interface Supplier {
  id: string;
  name: string;
  phone: string;
  address?: string;
  email?: string;
  rating?: number;
  products?: { productId: string; purchasePrice?: number }[];
  typeOfMerchandise?: string; // Mantener por compatibilidad si es necesario
}

export interface SupplierOrder {
  id: string;
  supplierId: string;
  date: string;
  expectedDeliveryDate?: string; // Fecha en que se espera recibir
  items: {
    productId: string;
    productName: string;
    variantLabel?: string;
    quantity: number;
    cost: number;
  }[];
  total: number;
  status: 'pending' | 'received' | 'cancelled';
  branchId: string;
  transportDetails?: string;
  transportCost?: number;
}

export interface BankCard {
  id: string;
  name?: string; // e.g. "Tarjeta Banreservas Principal"
  bank?: string;
  bankName?: string;
  cardHolder?: string;
  accountNumber?: string;
  phone?: string; // Teléfono asociado para confirmación (Transfermóvil)
  lastFour?: string;
  lastFourDigits?: string;
  balance: number;
  currency: string;
  color?: string;
  isActive: boolean;
}

export interface BankTransaction {
  id: string;
  cardId: string;
  type: 'deposit' | 'withdrawal' | 'payment_received' | 'supplier_payment';
  amount: number;
  date: string;
  reference?: string;
  description: string;
  transactionId?: string; // id of the original transaction if payment_received
}

export interface InventoryAudit {
  id: string;
  date: string;
  branchId: string;
  userId: string;
  status: 'pending' | 'completed';
  mode?: 'physical' | 'cycle_count';
  blindCount?: boolean;
  snapshotAt?: string;
  submittedAt?: string;
  reviewStatus?: 'counting' | 'recount_requested' | 'pending_approval' | 'approved';
  countedBy?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  recountCount?: number;
  adjustmentPostedAt?: string;
  items: {
    productId: string;
    productName: string;
    variantLabel?: string;
    expected: number;
    counted?: number | null;
    actual?: number | null;
    difference: number;
    adjustmentDelta?: number;
    systemAtSubmission?: number;
    countCycle?: number;
  }[];
  notes?: string;
}

export interface FiscalConfig {
  id: string;
  type: string; // 'B01', 'B02', etc.
  name: string;
  prefix: string;
  current: number;
  limit: number;
  active: boolean;
}

export interface DemandForecast {
  productId: string;
  productName: string;
  predictedSales: number;
  confidence: number;
  nextMonth: string;
}

export interface ReceiptConfig {
  showLogo: boolean;
  showAddress: boolean;
  showPhone: boolean;
  showFooter: boolean;
  footerText: string;
  businessName: string;
  businessAddress: string;
  businessPhone: string;
  printerWidth?: '58mm' | '80mm';
  openDrawer?: boolean;
  useWebSerial?: boolean;
  autoPrint?: boolean;
  printerIp?: string;
}

export interface Quote {
  id: string;
  branchId: string;
  userId: string;
  customerId?: string;
  date: string;
  subtotal: number;
  tax: number;
  total: number;
  items: CartItem[];
  status: 'pending' | 'converted' | 'expired';
  notes?: string;
}

export interface TimeShift {
  id: string;
  userId: string;
  clockIn: string;
  clockOut?: string;
  notes?: string;
}

export interface SyncTask {
  id: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE' | 'RPC';
  table: string;
  data: any;
  timestamp: string;
  status: 'pending' | 'error';
  retryCount: number;
}

