/**
 * La fecha de negocio (`businessDate`, `YYYY-MM-DD`) la elige el cajero al
 * arquear la caja y Supabase guarda solo el instante de creación. Al fusionar
 * un snapshot remoto hay que conservar la elegida en el equipo o la venta
 * volvería a agruparse en el día de creación tras un pull/refresco.
 */
export function keepLocalBusinessDate<T extends Record<string, any>>(
  remoteItem: T | undefined,
  localItem: T | undefined
): T | undefined {
  if (!remoteItem || !localItem) return remoteItem;
  if (remoteItem.businessDate || !localItem.businessDate) return remoteItem;
  return { ...remoteItem, businessDate: localItem.businessDate };
}

export function replaceRemoteRecords<T extends Record<string, any>>(
  remoteData: T[] | undefined,
  localData: T[],
  pendingIds: Set<string>,
  idKey = 'id'
): T[] {
  if (!Array.isArray(remoteData)) return localData;

  const localById = new Map<string, T>();
  for (const item of localData) {
    const id = item?.[idKey];
    if (id != null) localById.set(String(id), item);
  }

  const byId = new Map<string, T>();
  for (const item of remoteData) {
    const id = item?.[idKey];
    if (id != null) byId.set(String(id), item);
  }

  // El remoto es la autoridad del resto de campos; la fecha de negocio es
  // local y se conserva mientras Supabase no la devuelva.
  for (const [id, remoteItem] of byId) {
    const preserved = keepLocalBusinessDate(remoteItem, localById.get(id));
    if (preserved && preserved !== remoteItem) byId.set(id, preserved);
  }

  for (const item of localData) {
    const id = item?.[idKey];
    if (id != null && pendingIds.has(String(id)) && !byId.has(String(id))) {
      byId.set(String(id), item);
    }
  }

  return Array.from(byId.values());
}
