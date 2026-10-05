export interface AIDiagnosticReport {
  executiveSummary: string;
  healthScore: number;
  topInsights: string[];
  cashAlerts: string[];
  inventoryAdvice: string[];
  strategicActions: string[];
  structuredAuditRows: Array<[string, string, string, string, string, string]>;
}

export interface ExcelExportData {
  businessName?: string;
  transactions: import('../../types').Transaction[];
  cashSessions: import('../../types').CashRegisterSession[];
  salarySettlements: import('../../types').SalarySettlement[];
  products: import('../../types').Product[];
  categories: import('../../types').Category[];
  currencies: import('../../types').Currency[];
  branches: import('../../types').Branch[];
  users: import('../../types').User[];
  customers: import('../../types').Customer[];
  bankTransactions: import('../../types').BankTransaction[];
  bankCards: import('../../types').BankCard[];
  inventory?: import('../../types').InventoryLevel[];
  transfers?: import('../../types').InventoryTransfer[];
  returns?: any[];
  warranties?: any[];
  baseCurrency: import('../../types').Currency;
  dateFilterLabel?: string;
  aiDiagnostic?: AIDiagnosticReport | null;
}
