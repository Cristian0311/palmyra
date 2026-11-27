export type OfflineActionType =
  | 'transaction' | 'void_transaction' | 'return_complete' | 'transfer'
  | 'supplier_receive' | 'transfer_bulk' | 'transfer_receive' | 'transfer_cancel' | 'audit_complete' | 'cash_session'
  | 'inventory' | 'inventory_adjustment' | 'inventory_reconcile'
  | 'customer' | 'customer_delete' | 'product_delete' | 'return'
  | 'bank_transaction' | 'branch' | 'product' | 'category' | 'receipt_config'
  | 'store_config' | 'catalog_config' | 'salary_settlement' | 'user' | 'currency'
  | 'warranty' | 'time_shift' | 'quote' | 'bank_internal_transfer'
  | 'bank_internal_transfer_delete' | 'bank_transaction_delete' | 'bank_card_delete'
  | 'bank_card' | 'bank_card_balance' | 'currency_rate' | 'supplier' | 'supplier_order'
  | 'inventory_audit' | 'audit_start' | 'audit_recount' | 'audit_approve' | 'audit_delete'
  | 'cash_movement' | 'cash_movement_delete' | 'employee_create' | 'employee_update' | 'employee_status' | 'employee_delete' | 'invitation_revoke' | 'team_compensation_settings' | 'team_role_upsert'
  | 'branch_delete' | 'category_delete' | 'supplier_delete' | 'user_delete' | 'quote_delete';

export interface OfflineQueueItem {
  id: string;
  actionId: string;
  type: OfflineActionType;
  data: any;
  timestamp: string;
  retryCount: number;
  status?: 'pending' | 'processing' | 'failed' | 'conflict';
  lastError?: string;
  /** Earliest automatic retry time after a transient sync failure. */
  nextRetryAt?: number;
  deviceId?: string;
  /** Schema version of this queued operation, so app upgrades can still replay it. */
  schemaVersion?: number;
  /** Monotonic per-device order; never derived from the local clock. */
  deviceSequence?: number;
  /** Original enqueue time, kept even if the item is later updated. */
  queuedAt?: string;
  /**
   * Clave idempotente explícita de la operación (`tipo:actionId`). Se persiste
   * junto a la operación para que un reintento tras un cierre abrupto use
   * exactamente la misma clave aunque cambie el id de la fila.
   */
  idempotencyKey?: string;
  /**
   * Marca de una operación que quedó "en vuelo" al cerrarse la aplicación.
   * Solo aporta diagnóstico y respeta el backoff de `nextRetryAt`.
   */
  interruptedAt?: string;
  /**
   * Causa legible del último intento fallido, en español y sin códigos crudos.
   * Contrato (ver src/services/offline/syncContract.ts): cadena no vacía.
   */
  failureReason?: string;
  /** Código canónico del rechazo del servidor ('invalid_warehouse', …) o ''. */
  failureCode?: string;
  /** Marca temporal ISO del último intento fallido. */
  failureAt?: string;
  /** 'permanent' = conflicto definitivo visible; 'transient' = se reintenta. */
  failureKind?: 'permanent' | 'transient';
}
