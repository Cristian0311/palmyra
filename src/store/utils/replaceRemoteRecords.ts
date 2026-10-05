export function replaceRemoteRecords<T extends Record<string, any>>(
  remoteData: T[] | undefined,
  localData: T[],
  pendingIds: Set<string>,
  idKey = 'id'
): T[] {
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
