import { getOfflineQueue, removeFromOfflineQueue } from '../offlineQueue';

export function removeFromOfflineQueueByAction(type: string, actionId: string): void {
  const queued = getOfflineQueue().find((item) => item.type === type && item.actionId === actionId);
  if (queued) removeFromOfflineQueue(queued.id);
}

export function removeFromOfflineQueueByTransactionId(transactionId: string): void {
  const queued = getOfflineQueue().find((item) => item.type === 'transaction' && item.actionId === transactionId);
  if (queued) removeFromOfflineQueue(queued.id);
}
