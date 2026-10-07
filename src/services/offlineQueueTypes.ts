export type OfflineActionType =
  | 'transaction' | 'void_transaction' | 'return_complete' | 'transfer'
  | 'supplier_receive' | 'transfer_bulk' | 'audit_complete' | 'cash_session'
  | 'inventory' | 'inventory_adjustment' | 'inventory_reconcile'
  | 'customer' | 'customer_delete' | 'product_delete' | 'return'
  | 'bank_transaction' | 'branch' | 'product' | 'category' | 'receipt_config'
  | 'store_config' | 'catalog_config' | 'salary_settlement' | 'user' | 'currency'
  | 'warranty' | 'time_shift' | 'quote' | 'bank_internal_transfer'
  | 'bank_internal_transfer_delete' | 'bank_transaction_delete' | 'bank_card_delete'
  | 'bank_card' | 'bank_card_balance' | 'currency_rate' | 'supplier' | 'supplier_order'
  | 'inventory_audit' | 'audit_start' | 'audit_recount' | 'audit_approve'
  | 'cash_movement' | 'cash_movement_delete'
  | 'branch_delete' | 'category_delete' | 'supplier_delete' | 'user_delete';

export interface OfflineQueueItem {
  id: string;
  actionId: string;
  type: OfflineActionType;
  data: any;
  timestamp: string;
  retryCount: number;
  status?: 'pending' | 'processing' | 'failed' | 'conflict';
  lastError?: string;
  deviceId?: string;
}
