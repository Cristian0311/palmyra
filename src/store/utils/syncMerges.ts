import { normalizeSemanticText } from "../../utils/textUtils";

export function mergeById<T extends { id: string }>(
  remote: T[] | undefined,
  local: T[],
  protectedIds: Set<string | number> = new Set()
): T[] {
  const localMap = new Map(local.map((item) => [item.id, item]));
  const map = new Map((remote || []).map((item) => [item.id, item]));

  for (const [id, item] of localMap) {
    if (!map.has(id) || protectedIds.has(id)) {
      map.set(id, item);
    }
  }

  return Array.from(map.values());
}

export function mergeUnique<T extends Record<string, any>>(
  remote: T[] | undefined,
  local: T[],
  options?: {
    offlineIds?: Set<string | number>;
    semanticDedupe?: boolean;
    idKey?: string;
    semanticKeys?: string[];
  }
): T[] {
  const idKey = options?.idKey || "id";
  const semanticKeys =
    options?.semanticKeys || (options?.semanticDedupe ? ["name"] : []);

  const map = new Map<string | number, T>();
  const semanticMap = new Map<string, string | number>();

  const getSemanticKey = (item: T): string | null => {
    if (semanticKeys.length === 0) return null;
    const values = semanticKeys
      .map((key) => normalizeSemanticText(String(item[key] || "")))
      .filter(Boolean);

    return values.length > 0 ? values.join("::") : null;
  };

  local.forEach((item) => {
    const semanticKey = getSemanticKey(item);
    if (semanticKey) semanticMap.set(semanticKey, item[idKey]);
    map.set(item[idKey], item);
  });

  (remote || []).forEach((item) => {
    const semanticKey = getSemanticKey(item);
    if (semanticKey) {
      const existingId = semanticMap.get(semanticKey);
      if (existingId && existingId !== item[idKey]) {
        map.delete(existingId);
      }
      semanticMap.set(semanticKey, item[idKey]);
    }

    // A local closed session must not be reopened by a stale cloud snapshot.
    if (item.status === "open") {
      const localItem = map.get(item[idKey]);
      if (localItem && localItem.status === "closed") {
        map.set(item[idKey], {
          ...item,
          status: "closed",
          closedAt:
            localItem.closedAt || item.closed_at || new Date().toISOString(),
          closingDate: localItem.closingDate || localItem.closedAt,
          closingBalances: localItem.closingBalances || [],
        });
        return;
      }
    }

    map.set(item[idKey], item);
  });

  return Array.from(map.values());
}
