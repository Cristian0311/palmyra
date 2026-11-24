/**
 * Respaldo y restauración del almacén local de PALMYRA.
 *
 * Punto de entrada único: respaldo lógico cifrado (universal), retención 7+4,
 * fichas en IndexedDB y la nota sobre el respaldo binario opcional.
 */
export {
  BACKUP_CIPHER,
  BACKUP_DEFAULT_ITERATIONS,
  BACKUP_ENVELOPE_VERSION,
  BACKUP_KDF,
  BACKUP_MAX_ITERATIONS,
  BACKUP_MIN_ITERATIONS,
  BACKUP_MIN_PASSPHRASE_LENGTH,
  BACKUP_PAYLOAD_FORMAT,
  BackupError,
  canonicalJson,
  decryptBackupEnvelope,
  encryptBackupPayload,
  fromBase64,
  fromUtf8,
  normalizeBackupPassphrase,
  parseBackupEnvelope,
  randomBytes,
  sha256Hex,
  toBase64,
  utf8,
  type BackupEnvelope,
  type BackupErrorCode
} from "./format";
export {
  applyBackupSnapshot,
  readBackupSnapshot,
  type ApplySnapshotReport,
  type BackupSnapshot
} from "./snapshot";
export {
  createBackup,
  createBackupResult,
  inspectBackup,
  restoreBackup,
  type BackupResult,
  type BackupSummary,
  type CreateBackupOptions,
  type RestoreBackupOptions,
  type RestoreReport
} from "./backup";
export {
  BACKUP_DAILY_LIMIT,
  BACKUP_WEEKLY_LIMIT,
  pruneBackups,
  type BackupRetentionEntry,
  type BackupRetentionOptions,
  type BackupRetentionPlan
} from "./retention";
export {
  BACKUP_META_DB,
  BACKUP_META_STORE,
  createBackupMetaStore,
  deleteBackupMeta,
  getBackupMetaStore,
  listBackups,
  newBackupId,
  pruneBackupMetadata,
  sanitizeBackupEntry,
  saveBackupMeta,
  setBackupMetaStore,
  type BackupEntry,
  type BackupMetaStore,
  type BackupMetaStoreOptions
} from "./meta";
export {
  BINARY_BACKUP_FORMAT,
  BINARY_BACKUP_KIND,

  BINARY_BACKUP_VERSION,
  BINARY_SNAPSHOT_MAX_BYTES,
  binaryBackupCapability,
  createBinarySnapshot,
  isSqliteFile,
  readBinaryBackup,
  restoreBinarySnapshot,
  snapshotToBackupBytes,
  tryCreateBinaryBackup,
  validateBinaryRestore,
  type BinaryBackupCapability,
  type BinaryBackupResult,
  type BinaryBackupSummary,
  type BinaryRestoreOptions,
  type BinaryRestoreResult,
  type BinaryRestoreSuccess,
  type BinaryRestoreValidation,
  type BinarySnapshotData,
  type BinarySnapshotFailure,
  type BinarySnapshotOptions,
  type BinarySnapshotResult,
  type ReadBinaryBackupOptions,
  type ReadBinaryBackupResult,
  type SnapshotToBackupOptions
} from "./binary";
export {
  CLOUD_BACKUP_BUCKET,
  CLOUD_BACKUP_INTERVAL_MS,
  CLOUD_BACKUP_MANIFEST_SUFFIX,
  CLOUD_BACKUP_MANIFEST_VERSION,
  CLOUD_BACKUP_MAX_ATTEMPTS,
  CLOUD_BACKUP_MAX_BYTES,
  CLOUD_BACKUP_MIN_KEPT,
  CLOUD_BACKUP_RETENTION,
  CLOUD_BACKUP_SNAPSHOT_SUFFIX,
  CLOUD_BACKUP_STATE_KEY,
  cloudBackupPrefix,
  cloudBackupStateKey,
  cloudManifestPath,
  cloudSnapshotPath,
  createCloudBackupManager,
  createSupabaseCloudTransport,
  normalizeCloudDay,
  normalizeCloudSegment,
  parseCloudManifest,
  readCloudBackupState,
  type CloudBackupDay,
  type CloudBackupManager,
  type CloudBackupManagerDeps,
  type CloudBackupManifest,
  type CloudBackupOutcome,
  type CloudBackupSkipReason,
  type CloudBackupState,
  type CloudBackupStateStorage,
  type CloudRestoreFailure,
  type CloudRestoreInput,
  type CloudRestoreOutcome,
  type CloudSnapshot,
  type CloudStorageEntry,
  type CloudStorageTransport
} from "./cloud";
