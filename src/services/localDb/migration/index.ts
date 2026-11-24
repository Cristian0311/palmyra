/**
 * Migración guiada del JSON legado al almacén local normalizado.
 *
 * Punto de entrada único para el panel de migración: análisis de solo lectura,
 * gate del respaldo obligatorio, ejecución verificada y marca de rollback.
 */
export {
  GUIDED_ROLLBACK_REASON,
  analyzeLegacyMigration,
  clearGuidedMigrationState,
  clearRollback,
  createBackupProof,
  createEmptyGuidedMigrationState,
  formatGuidedMigrationReport,
  guidedMigrationStorageKey,
  isRollbackRequested,
  readGuidedMigrationState,
  requestRollback,
  runGuidedMigration,
  saveGuidedMigrationState,
  type BackupProof,
  type BackupProofCheck,
  type BackupProofInput,
  type GuidedMigrationAnalysis,
  type GuidedMigrationResult,
  type GuidedMigrationResultSummary,
  type GuidedMigrationState,
  type GuidedMigrationStep,
  type GuidedMigrationStorage,
  type GuidedRollbackOptions,
  type GuidedStateOptions,
  type RunGuidedMigrationOptions
} from "./guided";
