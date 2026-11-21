import type { InventoryAudit } from '../../types';

// Auditorías borradas localmente cuya eliminación remota aún no se confirmó.
// Evita que un refresco/realtime vuelva a insertarlas en la lista.
const pendingDeletions = new Set<string>();

export function markAuditPendingDeletion(id: string) {
  if (id) pendingDeletions.add(id);
}

export function clearAuditPendingDeletion(id: string) {
  pendingDeletions.delete(id);
}

// El servidor guarda auditorías a nivel de producto, sin variantes. Un refresco
// remoto no debe borrar los conteos por variante ni una aprobación hecha
// offline que todavía no llegó a la nube.
export function mergeInventoryAudits(
  local: InventoryAudit[] = [],
  remote: InventoryAudit[] = []
): InventoryAudit[] {
  const byId = new Map<string, InventoryAudit>();
  for (const audit of remote) {
    if (pendingDeletions.has(audit.id)) continue;
    byId.set(audit.id, audit);
  }

  for (const current of local) {
    if (pendingDeletions.has(current.id)) continue;
    const incoming = byId.get(current.id);
    if (!incoming) {
      byId.set(current.id, current);
      continue;
    }

    const localHasVariants = (current.items || []).some(item => Boolean(item.variantLabel));
    const remoteHasVariants = (incoming.items || []).some(item => Boolean(item.variantLabel));
    const keepLocalApproval = current.reviewStatus === 'approved' && incoming.reviewStatus !== 'approved';

    byId.set(current.id, {
      ...incoming,
      ...(keepLocalApproval
        ? {
            status: current.status,
            reviewStatus: current.reviewStatus,
            reviewedBy: current.reviewedBy,
            reviewedAt: current.reviewedAt,
            adjustmentPostedAt: current.adjustmentPostedAt
          }
        : {}),
      items: localHasVariants && !remoteHasVariants ? current.items : incoming.items,
      recountCount: Math.max(current.recountCount || 0, incoming.recountCount || 0),
      notes: incoming.notes || current.notes,
      blindCount: incoming.blindCount || current.blindCount,
      snapshotAt: incoming.snapshotAt || current.snapshotAt
    });
  }

  return Array.from(byId.values()).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
