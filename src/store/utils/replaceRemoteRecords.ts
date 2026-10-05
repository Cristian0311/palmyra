export function replaceRemoteRecords<T extends Record<string, any>>(
  remoteData: T[] | undefined,
  localData: T[],
  pendingIds: Set<string>,
  idKey = 'id'
): T[] {
  // An authoritative successful pull must be allowed to clear local records that
  // no longer exist in Supabase. Only operations still present in the durable
  // offline outbox survive the replacement.
  if (!Array.isArray(remoteData)) return localData;

  const byId = new Map<string, T>();
  for (const item of remoteData) {
    const id = item?.[idKey];
    if (id != null) byId.set(String(id), item);
  }

  for (const item of localData) {
    const id = item?.[idKey];
    if (id != null && pendingIds.has(String(id)) && !byId.has(String(id))) {
      byId.set(String(id), item);
    }
  }

  return Array.from(byId.values());
}