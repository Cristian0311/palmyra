export * from "./contract";
export * from "./schema";
export { createMemoryDriver } from "./memoryDriver";
export { createIndexedDbDriver, type IndexedDbDriverOptions } from "./indexedDbDriver";
export {
  createIpcSqliteAdapter,
  type IpcSqliteAdapter,
  type IpcSqliteAdapterOptions
} from "./sqlite/ipcAdapter";
export {
  DESKTOP_DB_FILE_PATH,
  createDesktopSqliteDriver,
  createLocalDbDriverForRuntime,
  desktopDbAvailable,
  type DesktopSqliteDriverOptions
} from "./desktop";
export {
  applyLegacyImport,
  importLegacyState,
  type ImportMeta,
  type ImportReport,
  type LegacyImportResult
} from "./importLegacy";
export {
  applyVerifiedImport,
  formatVerificationReport,
  verifyImportedState,
  type ImportSource,
  type ImportTableStatus,
  type ImportVerificationReport
} from "./importVerify";
export {
  createLegacyShadowWriter,
  shadowRowHash,
  type LegacyShadowOptions,
  type LegacyShadowReport,
  type LegacyShadowWriter
} from "./legacyShadow";
export {
  createMemoryShadowIndexStore,
  createShadowIndexStore,
  type ShadowIndexData,
  type ShadowIndexStore,
  type ShadowRowStamp
} from "./shadowIndex";
export { getRuntimeDriver } from "./runtimeDriver";
export {
  SALE_VOID_ID_PREFIX,
  SALE_VOID_REASONS,
  SALE_VOID_TABLE,
  SaleVoidError,
  assertSaleNotVoided,
  effectiveSaleStatus,
  isSaleVoided,
  recordSaleVoid,
  saleVoidId,
  type EffectiveSaleStatus,
  type RecordSaleVoidInput,
  type RecordSaleVoidResult,
  type SaleVoidErrorCode,
  type SaleVoidReasonCode,
  type SaleVoidRow,
  type SaleVoidSale,
  type SaleVoidSaleRef,
  type SaleVoidSkipReason
} from "./saleLifecycle";
export {
  createRepositories,
  getOpenCashSessions,
  listProducts,
  listRecentSales,
  listStockBalances,
  transactionFromRowWithChildren,
  cashSessionFromRowWithChildren,
  productFromRow,
  inventoryFromRow,
  customerFromRow,
  supplierFromRow,
  branchFromRow,
  transactionFromRow,
  cashSessionFromRow,
  cashMovementFromRow,
  storeConfigFromRow,
  rowToEntityFields,
  toCamelColumn,
  type RepositoryOptions,
  type RepositoryContext,
  type LocalRepositories,
  type ProductRepository,
  type InventoryRepository,
  type CustomerRepository,
  type SupplierRepository,
  type SaleRepository,
  type CashSessionRepository,
  type WarehouseRepository,
  type StoreConfigRepository,
  type HotReadOptions,
  type StockBalanceReadOptions
} from "./repositories";
export {
  compareLocalDbWithLegacy,
  requestLocalDbRollback,
  isLocalDbRollbackRequested,
  clearLocalDbRollback,
  localDbRollbackStorageKey,
  LOCAL_DB_ROLLBACK_KEY,
  LOCAL_DB_ROLLBACK_EVENT,
  type ParityReport,
  type ParityTableStatus,
  type ParityTotals,
  type CompareLocalDbWithLegacyOptions,
  type LocalDbRollbackRecord,
  type RollbackOptions,
  type RollbackStorage
} from "./parity";
export {
  LEGACY_JSON_RETENTION_DAYS,
  LEGACY_BACKUP_PREFIX,
  LEGACY_BACKUP_MAX_BYTES,
  pruneLegacyBackups,
  writeLegacyBackup,
  type RetentionStorage,
  type PruneLegacyBackupsOptions,
  type WriteLegacyBackupOptions,
  type WriteLegacyBackupResult
} from "./jsonRetention";
export {
  getLocalDbSourceMode,
  isLocalDbSource,
  isLocalDbSourceForced,
  type LocalDbSourceMode,
  type LocalDbSourceEnv
} from "./cutover";
export {
  initLocalDbSource,
  hydrateFromLocalDb,
  LOCAL_DB_SOURCE_EVENT,
  type LocalDbSnapshot,
  type HydrateFromLocalDbOptions,
  type LocalDbSourceDiagnostics,
  type InitLocalDbSourceOptions,
  type HydratableStore,
  type HydratableState
} from "./bootHydration";
