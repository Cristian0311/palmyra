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
  if (failedItems.length === 0) {
    return {
      success: true,
      error: undefined,
      errorCode: undefined,
      data: { success: true, appliedOperationIds, failedItems: [] },
      appliedOperationIds,
      failedItems: [],
      partial: false
    };
  }

  const first = failedItems[0];
  const partial = appliedOperationIds.length > 0;
  return {
    success: false,
    error: partial
      ? `Se aplicaron ${appliedOperationIds.length} de ${total} artículos. ${first.error}`
      : first.error,
    errorCode: first.errorCode,
    data: { success: false, appliedOperationIds, failedItems },
    appliedOperationIds,
    failedItems,
    partial
  };
}
