/**
 * Resumen puro de un lote de transferencias. El RPC aplica cada artículo por
 * separado; este módulo decide qué se confirmó, qué quedó pendiente y cómo
 * describirlo al usuario sin perder información.
 */
export type TransferBatchFailure = {
  operationId: string;
  productId: string;
  error: string;
  errorCode?: string;
};

export type TransferBatchSummary = {
  success: boolean;
  error?: string;
  errorCode?: string;
  data: {
    success: boolean;
    appliedOperationIds: string[];
    failedItems: TransferBatchFailure[];
  };
  appliedOperationIds: string[];
  failedItems: TransferBatchFailure[];
  partial: boolean;
};

export function summarizeTransferBatch(
  total: number,
  appliedOperationIds: string[],
  failedItems: TransferBatchFailure[]
): TransferBatchSummary {
  // Reintentos de un lote reenviado: la misma operación puede aparecer varias
  // veces entre aplicados y fallidos. Se desduplica por operation_id y una
  // operación aplicada NUNCA se reporta como fallida (evita reencolar y
  // volver a enviar artículos ya confirmados).
  const seen = new Set<string>();
  const applied: string[] = [];
  for (const id of appliedOperationIds || []) {
    const key = String(id || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    applied.push(key);
  }
  const failed: TransferBatchFailure[] = [];
  for (const item of failedItems || []) {
    const key = String(item?.operationId || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    failed.push(item);
  }

  if (failed.length === 0) {
    return {
      success: true,
      error: undefined,
      errorCode: undefined,
      data: { success: true, appliedOperationIds: applied, failedItems: [] },
      appliedOperationIds: applied,
      failedItems: [],
      partial: false
    };
  }

  const first = failed[0];
  const partial = applied.length > 0;
  return {
    success: false,
    error: partial
      ? `Se aplicaron ${applied.length} de ${total} artículos. ${first.error}`
      : first.error,
    errorCode: first.errorCode,
    data: { success: false, appliedOperationIds: applied, failedItems: failed },
    appliedOperationIds: applied,
    failedItems: failed,
    partial
  };
}
