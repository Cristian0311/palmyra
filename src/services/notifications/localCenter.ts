/**
 * Centro de notificaciones local (offline-first).
 *
 * La nube produce avisos de tasas, resumen diario y pruebas; los eventos
 * operativos de este dispositivo (stock bajo, fin de turno, actualización
 * disponible) no llegan a la tabla `notifications`. Este módulo los recolecta
 * desde el almacén local y los persiste como un feed ligero en localStorage,
 * de modo que el centro muestre avisos reales también sin conexión.
 *
 * - Dedupe por clave: un mismo evento solo genera un aviso.
 * - El feed se recorta a un máximo para no crecer sin límite.
 * - Nunca lanza: si localStorage falla, el aviso simplemente no persiste.
 */

import { isLowStockQuantity } from "../../modules/inventory/utils/lowStock";
import { publishOsAlert } from "../../lib/osAlert";
import {
  UPDATE_AVAILABLE_STORAGE_KEY,
  UPDATE_VERSION_STORAGE_KEY,
} from "../../hooks/useUpdateSignal";

export type LocalCenterKind = "low_stock" | "shift_closed" | "update_available" | "offline_error";

export interface LocalCenterNotice {
  id: string;
  kind: LocalCenterKind;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface LocalCenterNoticeInput {
  kind: LocalCenterKind;
  title: string;
  body: string;
  /** Clave de dedupe: si ya se emitió, no se repite el aviso. */
  dedupeKey?: string;
}

const FEED_KEY = "palmyra:local-notice-feed";
const DEDUPE_KEY = "palmyra:local-notice-dedupe";
const FEED_MAX = 40;

function safeRead<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Sin cuota o sin permisos: el feed solo vive en memoria del llamador.
  }
}

export function listLocalNotices(): LocalCenterNotice[] {
  return safeRead<LocalCenterNotice[]>(FEED_KEY, []);
}

export function unreadLocalCount(): number {
  return listLocalNotices().filter((notice) => !notice.read_at).length;
}

/** Persiste un aviso local; devuelve null si la clave de dedupe ya se emitió. */
export function pushLocalNotice(input: LocalCenterNoticeInput): LocalCenterNotice | null {
  if (input.dedupeKey) {
    const seen = safeRead<Record<string, number>>(DEDUPE_KEY, {});
    if (seen[input.dedupeKey]) return null;
    seen[input.dedupeKey] = Date.now();
    safeWrite(DEDUPE_KEY, seen);
  }
  const notice: LocalCenterNotice = {
    id: crypto.randomUUID(),
    kind: input.kind,
    title: input.title,
    body: input.body,
    created_at: new Date().toISOString(),
    read_at: null,
  };
  safeWrite(FEED_KEY, [notice, ...listLocalNotices()].slice(0, FEED_MAX));
  // El aviso también sale al sistema (bandeja de Android / centro de actividades
  // de Windows). La tag es el tipo, así un caso nuevo reemplaza al anterior en vez
  // de acumularse. Si falta permiso, el aviso sigue viviendo solo en la campana.
  void publishOsAlert({ title: notice.title, body: notice.body, tag: input.kind, url: "/notifications" }).catch(() => {});
  return notice;
}

export function markLocalNoticeRead(id: string): void {
  safeWrite(FEED_KEY, listLocalNotices().map((notice) =>
    notice.id === id ? { ...notice, read_at: notice.read_at || new Date().toISOString() } : notice
  ));
}

export function markAllLocalNoticesRead(): void {
  const now = new Date().toISOString();
  safeWrite(FEED_KEY, listLocalNotices().map((notice) =>
    notice.read_at ? notice : { ...notice, read_at: now }
  ));
}

/** Estado mínimo del store que necesita el colector. */
export interface OperationalStoreSnapshot {
  inventory?: ReadonlyArray<{
    productId: string;
    branchId: string;
    quantity?: number | null;
    minQuantity?: number | null;
    variantLabel?: string | null;
  }>;
  products?: ReadonlyArray<{
    id: string;
    name: string;
    sku?: string | null;
    minStockAlert?: number | null;
  }>;
  currentBranchId?: string | null;
  cashSessions?: ReadonlyArray<{
    id: string;
    branchId?: string;
    openedAt?: string | null;
    closedAt?: string | null;
    workerName?: string | null;
  }>;
  branches?: ReadonlyArray<{ id: string; name?: string | null }>;
}

function branchName(snapshot: OperationalStoreSnapshot, branchId?: string): string {
  return snapshot.branches?.find((branch) => branch.id === branchId)?.name || "esta sucursal";
}

/**
 * Recolecta los eventos operativos pendientes como avisos locales.
 * Es idempotente: el dedupe evita repetir avisos ya persistidos.
 */
export function collectOperationalLocalNotices(snapshot: OperationalStoreSnapshot): LocalCenterNotice[] {
  const created: LocalCenterNotice[] = [];
  const products = snapshot.products || [];
  const inventory = snapshot.inventory || [];
  const currentBranchId = snapshot.currentBranchId || null;
  const now = Date.now();

  // 1) Stock bajo: misma regla única del inventario (umbral por producto).
  const stockByProduct = new Map<string, number>();
  for (const row of inventory) {
    if (currentBranchId && row.branchId !== currentBranchId) continue;
    stockByProduct.set(row.productId, (stockByProduct.get(row.productId) || 0) + (Number(row.quantity) || 0));
  }
  const lowProducts = products
    .map((product) => ({ product, stock: stockByProduct.get(product.id) || 0 }))
    .filter(({ product, stock }) => isLowStockQuantity(stock, product));
  if (lowProducts.length > 0) {
    const names = lowProducts.slice(0, 8).map(({ product, stock }) => `${product.name} (${stock})`);
    const extra = lowProducts.length - names.length;
    const notice = pushLocalNotice({
      kind: "low_stock",
      title: `Stock bajo: ${lowProducts.length} producto${lowProducts.length === 1 ? "" : "s"}`,
      body: names.join("\n") + (extra > 0 ? `\n…y ${extra} más.` : "") + "\nRevisa el inventario para reponer.",
      dedupeKey: `low-stock:${currentBranchId || "all"}:${lowProducts.length}`,
    });
    if (notice) created.push(notice);
  }

  // 2) Fin de turno: cierres de las últimas 48 h sin aviso previo.
  const sessions = snapshot.cashSessions || [];
  const shiftWindow = 48 * 60 * 60 * 1000;
  for (const session of sessions) {
    const closedAt = session.closedAt ? new Date(session.closedAt).getTime() : 0;
    if (!closedAt || Number.isNaN(closedAt) || now - closedAt > shiftWindow) continue;
    const notice = pushLocalNotice({
      kind: "shift_closed",
      title: "Turno cerrado",
      body: `Cierre de caja en ${branchName(snapshot, session.branchId)} a las ${new Date(closedAt).toLocaleTimeString("es-CU", { hour: "2-digit", minute: "2-digit" })}${session.workerName ? ` · ${session.workerName}` : ""}.`,
      dedupeKey: `shift-closed:${session.id}`,
    });
    if (notice) created.push(notice);
  }

  // 3) Actualización disponible: marca persistente que publica useUpdateSignal.
  try {
    const updateMarked = localStorage.getItem(UPDATE_AVAILABLE_STORAGE_KEY) === "1";
    if (updateMarked) {
      const version = (localStorage.getItem(UPDATE_VERSION_STORAGE_KEY) || "").trim();
      const notice = pushLocalNotice({
        kind: "update_available",
        title: "Actualización disponible",
        body: version
          ? `La versión ${version} ya está lista. Aplícala desde el aviso de actualización para seguir operando con la última versión.`
          : "Hay una nueva versión de PALMYRA lista para aplicar.",
        dedupeKey: `update-available:${version || "pending"}`,
      });
      if (notice) created.push(notice);
    }
  } catch {
    // Sin acceso a localStorage no hay marca que leer.
  }

  return created;
}

/**
 * Puente de eventos: vuelve a recolectar cuando llega la señal de
 * actualización o cuando otra pestaña modifica el feed. Devuelve el cleanup.
 */
export function installLocalNoticeBridge(onNewNotices: () => void): () => void {
  const handleUpdate = () => onNewNotices();
  const handleStorage = (event: StorageEvent) => {
    if (event.key === FEED_KEY || event.key === UPDATE_AVAILABLE_STORAGE_KEY) onNewNotices();
  };
  window.addEventListener("palmyra:update-available", handleUpdate);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener("palmyra:update-available", handleUpdate);
    window.removeEventListener("storage", handleStorage);
  };
}
