export type PwaStorageHealth = {
  supported: boolean;
  indexedDbAvailable: boolean;
  usageBytes: number;
  quotaBytes: number;
  usageRatio: number;
  persisted: boolean;
  persistentRequestSupported: boolean;
  warning: boolean;
};

export async function inspectPwaStorageHealth(): Promise<PwaStorageHealth> {
  const indexedDbAvailable = typeof indexedDB !== 'undefined';
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;

  let usageBytes = 0;
  let quotaBytes = 0;
  if (storage?.estimate) {
    try {
      const estimate = await storage.estimate();
      usageBytes = Number(estimate.usage || 0);
      quotaBytes = Number(estimate.quota || 0);
    } catch {}
  }

  let persisted = false;
  if (storage?.persisted) {
    try { persisted = await storage.persisted(); } catch {}
  }

  const persistentRequestSupported = Boolean(storage?.persist);
  const usageRatio = quotaBytes > 0 ? usageBytes / quotaBytes : 0;

  return {
    supported: Boolean(storage),
    indexedDbAvailable,
    usageBytes,
    quotaBytes,
    usageRatio,
    persisted,
    persistentRequestSupported,
    warning: !indexedDbAvailable || (quotaBytes > 0 && usageRatio >= 0.8),
  };
}

export async function protectPwaStorage(): Promise<PwaStorageHealth> {
  const health = await inspectPwaStorageHealth();

  // Requesting persistent storage is best-effort. The browser decides whether
  // it is granted; PALMYRA never blocks POS startup waiting for this.
  if (health.supported && health.persistentRequestSupported && !health.persisted) {
    try {
      await navigator.storage.persist?.();
    } catch {}
  }

  return inspectPwaStorageHealth();
}

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return Math.max(0, Math.round(bytes)) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2) + ' ' + units[index];
}
