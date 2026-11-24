import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Equal,
  Eye,
  Filter,
  Loader2,
  Lock,
  PackageCheck,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { useStore } from "../store/useStore";
import type { InventoryAudit } from "../types";
import { cn } from "../lib/utils";
import { documentCode } from "../lib/documentCodes";
import PlanFeatureGate from "../components/PlanFeatureGate";
import OperationsSurface from "../components/OperationsSurface";
import { InfoTooltip } from "../components/InfoTooltip";

type AuditItem = InventoryAudit["items"][number];
type AuditFilter = "all" | "counting" | "pending_approval" | "recount_requested" | "approved";

const reviewLabel: Record<string, string> = {
  counting: "Conteo en curso",
  recount_requested: "Requiere recuento",
  pending_approval: "Pendiente de aprobación",
  approved: "Aprobada y ajustada",
};

const auditCode = (id: string) => documentCode("AUD", id);

const reviewOf = (audit: InventoryAudit): Exclude<AuditFilter, "all"> =>
  (audit.reviewStatus || (audit.status === "completed" ? "approved" : "counting")) as Exclude<AuditFilter, "all">;

const shortDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("es-CU", { dateStyle: "short", timeStyle: "short" });
};

const fmtNum = (value: number) => (Number(value) || 0).toLocaleString("es-CU", { maximumFractionDigits: 0 });
const fmtMoney = (value: number, currency: string) =>
  `${(Number(value) || 0).toLocaleString("es-CU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

const countedValue = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
}

type AuditStats = {
  total: number;
  counted: number;
  changed: number;
  shortage: number;
  overage: number;
  value: number;
  accuracy: number;
};

export default function InventoryAuditPage() {
  const {
    products, inventory, inventoryAudits, branches, currentBranchId, currentUser, getBaseCurrency,
    createInventoryAudit, completeInventoryAudit, requestInventoryAuditRecount,
    approveInventoryAudit, deleteInventoryAudit, addNotification,
  } = useStore(useShallow(state => ({
    products: state.products,
    inventory: state.inventory,
    inventoryAudits: state.inventoryAudits,
    branches: state.branches,
    currentBranchId: state.currentBranchId,
    currentUser: state.currentUser,
    getBaseCurrency: state.getBaseCurrency,
    createInventoryAudit: state.createInventoryAudit,
    completeInventoryAudit: state.completeInventoryAudit,
    requestInventoryAuditRecount: state.requestInventoryAuditRecount,
    approveInventoryAudit: state.approveInventoryAudit,
    deleteInventoryAudit: state.deleteInventoryAudit,
    addNotification: state.addNotification,
  })));

  const baseCurrency = getBaseCurrency();
  const [showModal, setShowModal] = useState(false);
  const [step, setStep] = useState<"setup" | "count" | "review">("setup");
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);
  const [auditBranchId, setAuditBranchId] = useState(currentBranchId);
  const [mode, setMode] = useState<"physical" | "cycle_count">("cycle_count");
  const [notes, setNotes] = useState("");
  const [countSearch, setCountSearch] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  const [onlyDifferences, setOnlyDifferences] = useState(true);
  const [historyFilter, setHistoryFilter] = useState<AuditFilter>("all");
  const [historySearch, setHistorySearch] = useState("");
  const [historyBranch, setHistoryBranch] = useState("all");
  const [countDraft, setCountDraft] = useState<AuditItem[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<InventoryAudit | null>(null);

  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const branchName = (id: string) => branches.find(b => b.id === id)?.name || "Sucursal";

  const activeAudit = useMemo(
    () => inventoryAudits.find(a =>
      a.status === "pending" &&
      a.branchId === auditBranchId &&
      (a.reviewStatus || "counting") !== "approved"
    ),
    [inventoryAudits, auditBranchId]
  );

  const selectedAudit = useMemo(
    () => inventoryAudits.find(a => a.id === selectedAuditId) || null,
    [inventoryAudits, selectedAuditId]
  );

  const statsOf = (audit: InventoryAudit): AuditStats => {
    let counted = 0;
    let shortage = 0;
    let overage = 0;
    let changed = 0;
    let value = 0;
    for (const item of audit.items) {
      const c = countedValue(item.counted);
      if (c === null) continue;
      counted += 1;
      const diff = c - Number(item.expected || 0);
      if (diff !== 0) {
        changed += 1;
        value += Math.abs(diff) * Number(productById.get(item.productId)?.costPrice || 0);
      }
      if (diff < 0) shortage += Math.abs(diff);
      if (diff > 0) overage += diff;
    }
    return {
      total: audit.items.length,
      counted,
      changed,
      shortage,
      overage,
      value,
      accuracy: counted ? Math.round(((counted - changed) / counted) * 100) : 0,
    };
  };

  const approvedAudits = inventoryAudits.filter(a => reviewOf(a) === "approved");
  const overallAccuracy = useMemo(() => {
    let counted = 0;
    let matched = 0;
    for (const audit of approvedAudits) {
      for (const item of audit.items) {
        const c = countedValue(item.counted);
        if (c === null) continue;
        counted += 1;
        if (c === Number(item.expected || 0)) matched += 1;
      }
    }
    return counted ? Math.round((matched / counted) * 100) : null;
  }, [approvedAudits]);

  const historyCounts = {
    all: inventoryAudits.length,
    counting: inventoryAudits.filter(a => reviewOf(a) === "counting").length,
    pending_approval: inventoryAudits.filter(a => reviewOf(a) === "pending_approval").length,
    recount_requested: inventoryAudits.filter(a => reviewOf(a) === "recount_requested").length,
    approved: approvedAudits.length,
  };

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    return inventoryAudits
      .filter(audit => {
        if (historyFilter !== "all" && reviewOf(audit) !== historyFilter) return false;
        if (historyBranch !== "all" && audit.branchId !== historyBranch) return false;
        if (!q) return true;
        return (
          audit.id.toLowerCase().includes(q) ||
          auditCode(audit.id).toLowerCase().includes(q) ||
          branchName(audit.branchId).toLowerCase().includes(q) ||
          (audit.notes || "").toLowerCase().includes(q) ||
          audit.items.some(item => item.productName.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }, [inventoryAudits, historyFilter, historyBranch, historySearch, branches]);

  const buildLocalSnapshot = (branchId: string, blind: boolean): InventoryAudit => {
    const rows = inventory
      .filter(i => i.branchId === branchId)
      .sort((a, b) => {
        const an = productById.get(a.productId)?.name || "";
        const bn = productById.get(b.productId)?.name || "";
        return an.localeCompare(bn) || (a.variantLabel || "").localeCompare(b.variantLabel || "");
      });

    return {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      branchId,
      userId: currentUser?.id || "system",
      status: "pending",
      mode,
      blindCount: blind,
      snapshotAt: new Date().toISOString(),
      reviewStatus: "counting",
      countedBy: currentUser?.id || "system",
      items: rows.map(row => ({
        productId: row.productId,
        productName: productById.get(row.productId)?.name || "Producto",
        variantLabel: row.variantLabel || "",
        expected: Number(row.quantity || 0),
        counted: null,
        actual: null,
        difference: 0,
        systemAtSubmission: Number(row.quantity || 0),
        adjustmentDelta: 0,
        countCycle: 1,
      })),
      notes,
    };
  };

  const beginNewAudit = async () => {
    if (!auditBranchId) {
      addNotification("Selecciona una sucursal para iniciar el conteo.", "warning");
      return;
    }
    if (activeAudit) {
      addNotification("Ya existe una auditoría abierta para esta sucursal.", "warning");
      return;
    }
    if (!inventory.some(i => i.branchId === auditBranchId)) {
      addNotification("La sucursal no tiene líneas de inventario para auditar.", "warning");
      return;
    }

    setIsBusy(true);
    try {
      const audit = buildLocalSnapshot(auditBranchId, false);
      const res = await createInventoryAudit(audit);
      if (!res.success) {
        addNotification(res.error || "No se pudo iniciar la auditoría.", "error");
        return;
      }

      const stored = useStore.getState().inventoryAudits.find(a => a.id === audit.id) || audit;
      setSelectedAuditId(stored.id);
      setCountDraft(stored.items);
      setCountSearch("");
      setOnlyPending(false);
      setStep("count");
      setShowModal(true);
      addNotification(`Snapshot tomado: ${stored.items.length} líneas para contar.`, "success");
    } finally {
      setIsBusy(false);
    }
  };

  const openAudit = (audit: InventoryAudit) => {
    setSelectedAuditId(audit.id);
    setAuditBranchId(audit.branchId);
    setNotes(audit.notes || "");
    setCountSearch("");
    setOnlyPending(false);
    setOnlyDifferences(true);
    if (audit.reviewStatus === "pending_approval") {
      setStep("review");
    } else if (audit.status === "completed") {
      setStep("review");
    } else {
      setCountDraft(audit.items);
      setStep("count");
    }
    setShowModal(true);
  };

  const filteredDraft = useMemo(() => {
    const q = countSearch.trim().toLowerCase();
    return countDraft.filter(item => {
      if (onlyPending && item.counted != null) return false;
      if (!q) return true;
      return item.productName.toLowerCase().includes(q) || (item.variantLabel || "").toLowerCase().includes(q);
    });
  }, [countDraft, countSearch, onlyPending]);

  const varianceSummary = useMemo(() => {
    const source = selectedAudit?.items || countDraft;
    let shortage = 0;
    let overage = 0;
    let changed = 0;
    let counted = 0;

    source.forEach(i => {
      const c = countedValue(i.counted);
      if (c === null) return;
      counted += 1;
      const diff = c - Number(i.expected || 0);
      if (diff < 0) shortage += Math.abs(diff);
      if (diff > 0) overage += diff;
      if (diff !== 0) changed += 1;
    });

    return { shortage, overage, changed, counted, total: source.length };
  }, [selectedAudit, countDraft]);

  const updateCount = (indexInDraft: number, value: number) => {
    const safe = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    setCountDraft(items => items.map((item, idx) => idx === indexInDraft
      ? { ...item, counted: safe, actual: safe, difference: safe - Number(item.expected || 0) }
      : item
    ));
  };

  const setCountInput = (indexInDraft: number, raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      setCountDraft(items => items.map((item, idx) => idx === indexInDraft
        ? { ...item, counted: null, actual: null, difference: 0 }
        : item
      ));
      return;
    }
    updateCount(indexInDraft, Number(trimmed));
  };

  const completeRemainingWithExpected = () => {
    const remaining = countDraft.filter(item => item.counted == null).length;
    if (!remaining) {
      addNotification("Todas las líneas ya tienen una cantidad contada.", "info");
      return;
    }
    setCountDraft(items => items.map(item => item.counted == null
      ? { ...item, counted: Number(item.expected || 0), actual: Number(item.expected || 0), difference: 0, systemAtSubmission: Number(item.expected || 0) }
      : item
    ));
    addNotification(`${remaining} línea(s) marcadas con el stock esperado. Aún no se ha enviado el conteo.`, "info");
  };

  const submitCount = async () => {
    if (!selectedAuditId) return;
    const missing = countDraft.filter(i => i.counted === null || i.counted === undefined).length;
    if (missing) {
      addNotification(`Faltan ${missing} línea(s) por contar. Usa «Completar con esperado» si coincide con el sistema.`, "warning");
      return;
    }

    setIsBusy(true);
    try {
      const res = await completeInventoryAudit(selectedAuditId, countDraft, notes || "Conteo físico de inventario");
      if (!res.success) {
        addNotification(res.error || "No se pudo enviar el conteo a revisión.", "error");
        return;
      }
      setStep("review");
      const updated = useStore.getState().inventoryAudits.find(a => a.id === selectedAuditId);
      if (updated) setCountDraft(updated.items);
      addNotification("Conteo guardado. El stock aún NO ha sido ajustado; queda pendiente de revisión.", "success");
    } finally {
      setIsBusy(false);
    }
  };

  const approve = async () => {
    if (!selectedAuditId) return;
    setIsBusy(true);
    try {
      const res = await approveInventoryAudit(selectedAuditId, notes || "Aprobación de ajuste de inventario");
      if (!res.success) {
        addNotification(res.error || "No se pudo aprobar el ajuste. Puede ser necesario un nuevo conteo.", "error");
        return;
      }
      addNotification(
        res.pending
          ? "Auditoría aprobada localmente; el ajuste se sincronizará al reconectar."
          : "Auditoría aprobada y ajuste físico aplicado.",
        res.pending ? "info" : "success"
      );
      setShowModal(false);
    } finally {
      setIsBusy(false);
    }
  };

  const requestRecount = async () => {
    if (!selectedAuditId) return;
    setIsBusy(true);
    try {
      const res = await requestInventoryAuditRecount(selectedAuditId, notes || "Recuento solicitado por revisión");
      if (!res.success) {
        addNotification(res.error || "No se pudo solicitar el recuento.", "error");
        return;
      }
      const updated = useStore.getState().inventoryAudits.find(a => a.id === selectedAuditId);
      setCountDraft(updated?.items || countDraft);
      setCountSearch("");
      setOnlyPending(true);
      setStep("count");
      addNotification("Recuento solicitado. El ajuste físico sigue sin aplicarse.", "info");
    } finally {
      setIsBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setIsBusy(true);
    try {
      const res = await deleteInventoryAudit(pendingDelete.id);
      if (!res.success) {
        addNotification(res.error || "No se pudo eliminar la auditoría.", "error");
        return;
      }
      if (selectedAuditId === pendingDelete.id) {
        setShowModal(false);
        setSelectedAuditId(null);
      }
      addNotification(
        res.pending ? "Auditoría eliminada; se confirmará al reconectar." : "Auditoría eliminada.",
        res.pending ? "info" : "success"
      );
      setPendingDelete(null);
    } finally {
      setIsBusy(false);
    }
  };

  const selectedCurrentSystemChanges = useMemo(() => {
    if (!selectedAudit || selectedAudit.reviewStatus !== "pending_approval") return 0;
    let changed = 0;
    for (const item of selectedAudit.items) {
      const current = inventory.find(i =>
        i.productId === item.productId &&
        i.branchId === selectedAudit.branchId &&
        (i.variantLabel || "") === (item.variantLabel || "")
      )?.quantity ?? 0;
      if (Number(current) !== Number(item.systemAtSubmission ?? item.expected ?? 0)) changed += 1;
    }
    return changed;
  }, [selectedAudit, inventory]);

  const totalValue = useMemo(() => {
    const audit = selectedAudit;
    if (!audit) return 0;
    return audit.items.reduce((sum, item) => {
      const product = productById.get(item.productId);
      return sum + Math.abs(Number(item.difference || 0)) * Number(product?.costPrice || 0);
    }, 0);
  }, [selectedAudit, productById]);

  const reviewItems = useMemo(() => {
    if (!selectedAudit) return [];
    const items = selectedAudit.items.filter(i => i.counted != null);
    return onlyDifferences ? items.filter(i => Number(i.difference || 0) !== 0) : items;
  }, [selectedAudit, onlyDifferences]);

  const printAuditReport = (audit: InventoryAudit) => {
    const stats = statsOf(audit);
    const review = reviewOf(audit);
    const rows = audit.items
      .filter(item => Number(item.difference || 0) !== 0 || item.counted == null)
      .map(item => {
        const counted = countedValue(item.counted);
        const diff = counted === null ? 0 : counted - Number(item.expected || 0);
        const value = counted === null ? 0 : Math.abs(diff) * Number(productById.get(item.productId)?.costPrice || 0);
        return `<tr>
          <td>${escapeHtml(item.productName)}${item.variantLabel ? `<div class="muted">${escapeHtml(item.variantLabel)}</div>` : ""}</td>
          <td class="num">${fmtNum(Number(item.expected || 0))}</td>
          <td class="num">${counted === null ? "Pendiente" : fmtNum(counted)}</td>
          <td class="num ${diff === 0 ? "" : diff > 0 ? "pos" : "neg"}">${counted === null ? "—" : `${diff > 0 ? "+" : ""}${fmtNum(diff)}`}</td>
          <td class="num">${value ? fmtMoney(value, baseCurrency.code) : "—"}</td>
        </tr>`;
      })
      .join("");

    const doc = `<!doctype html><html lang="es"><head><meta charset="utf-8" />
      <title>Informe ${escapeHtml(auditCode(audit.id))}</title>
      <style>
        @page { size: A4; margin: 16mm; }
        * { box-sizing: border-box; }
        body { font-family: "Segoe UI", Arial, sans-serif; color: #1e1b2e; margin: 0; padding: 16px 20px; }
        @media print { body { padding: 0; } .toolbar { display: none; } }
        .toolbar { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 0 14px; }
        .toolbar button { border: 0; background: #6535C5; color: #fff; font-weight: 700; padding: 9px 16px; border-radius: 8px; cursor: pointer; }
        h1 { font-size: 20px; margin: 0; letter-spacing: .04em; }
        .muted { color: #6b6880; font-size: 10px; }
        .head { display: flex; justify-content: space-between; border-bottom: 3px solid #6535C5; padding-bottom: 10px; }
        .brand { font-weight: 800; color: #6535C5; letter-spacing: .18em; font-size: 12px; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 14px 0; }
        .card { border: 1px solid #e5e1f0; border-radius: 8px; padding: 8px 10px; }
        .card .label { font-size: 8px; text-transform: uppercase; letter-spacing: .1em; color: #6b6880; font-weight: 700; }
        .card .value { font-size: 16px; font-weight: 800; margin-top: 2px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 10px; }
        th { background: #f5f2fb; text-align: left; text-transform: uppercase; font-size: 8px; letter-spacing: .08em; color: #6b6880; padding: 6px; border-bottom: 1px solid #e5e1f0; }
        td { padding: 6px; border-bottom: 1px solid #f0edf7; }
        .num { text-align: right; font-variant-numeric: tabular-nums; }
        .pos { color: #047857; font-weight: 700; }
        .neg { color: #b91c1c; font-weight: 700; }
        .notes { margin-top: 14px; border: 1px solid #e5e1f0; border-radius: 8px; padding: 10px; font-size: 10px; }
        .sign { display: flex; gap: 30px; margin-top: 40px; }
        .sign div { flex: 1; border-top: 1px solid #1e1b2e; padding-top: 6px; font-size: 9px; text-align: center; color: #6b6880; }
        footer { margin-top: 18px; font-size: 8px; color: #6b6880; text-align: center; }
      </style></head><body>
      <div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button></div>
      <div class="head">
        <div><div class="brand">PALMYRA</div><h1>Informe de auditoría de inventario</h1>
          <div class="muted">${escapeHtml(auditCode(audit.id))} · ${escapeHtml(shortDate(audit.date))}</div></div>
        <div style="text-align:right;font-size:10px">
          <div><b>Sucursal:</b> ${escapeHtml(branchName(audit.branchId))}</div>
          <div><b>Tipo:</b> ${audit.mode === "physical" ? "Inventario físico" : "Conteo cíclico"}</div>
          <div><b>Estado:</b> ${escapeHtml(reviewLabel[review] || review)}</div>
        </div>
      </div>
      <div class="grid">
        <div class="card"><div class="label">Líneas</div><div class="value">${stats.total}</div></div>
        <div class="card"><div class="label">Contadas</div><div class="value">${stats.counted}</div></div>
        <div class="card"><div class="label">Exactitud</div><div class="value">${stats.accuracy}%</div></div>
        <div class="card"><div class="label">Valor diferencia</div><div class="value" style="font-size:13px">${fmtMoney(stats.value, baseCurrency.code)}</div></div>
      </div>
      <div class="muted">Faltante: ${fmtNum(stats.shortage)} · Sobrante: ${fmtNum(stats.overage)} · Líneas con variación: ${stats.changed}</div>
      <table>
        <thead><tr><th>Producto</th><th class="num">Snapshot</th><th class="num">Contado</th><th class="num">Variación</th><th class="num">Valor</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" style="text-align:center;color:#047857">Sin diferencias registradas</td></tr>`}</tbody>
      </table>
      ${audit.notes ? `<div class="notes"><b>Notas:</b> ${escapeHtml(audit.notes)}</div>` : ""}
      <div class="sign"><div>Auditor / conteo</div><div>Supervisor / aprobación</div></div>
      <footer>Generado por Palmyra · ${escapeHtml(new Date().toLocaleString("es-CU"))} · Documento de control interno</footer>
      <script>window.addEventListener('load', function () { window.print(); });</script>
      </body></html>`;

    const win = window.open("", "_blank", "width=1024,height=900");
    if (!win) {
      addNotification("Permite ventanas emergentes para imprimir el informe.", "warning");
      return;
    }
    win.document.open();
    win.document.write(doc);
    win.document.close();
  };

  const countedPct = countDraft.length ? Math.round((varianceSummary.counted / countDraft.length) * 100) : 0;

  return (
    <PlanFeatureGate feature="inventory_audit" title="Auditoría de inventario" description="El conteo y ajuste formal de inventario requiere un plan con funciones de control avanzado." highlights={[
      "Conteo físico por almacén y responsable",
      "Recuento y aprobación con diferencias controladas",
      "Ajuste de stock con trazabilidad completa"
    ]}>
      <OperationsSurface className="flex flex-col gap-4 -mx-3 -mt-3 px-3 pb-10 pt-3 sm:-mx-4 sm:-mt-4 sm:px-4 sm:pt-4 lg:-mx-6 lg:-mt-6 lg:px-6">
        <header className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
          <div>
            <div className="flex items-center gap-2">
              <ClipboardCheck size={20} className="text-violet-600 dark:text-violet-300" />
              <h1 data-palmi-content="inventory-audit" className="text-xl sm:text-2xl font-black tracking-tight text-primary">Auditoría de stock</h1>
              <InfoTooltip
                text="Toma un snapshot del inventario, cuenta físicamente, revisa variaciones y aprueba el ajuste. El stock no cambia hasta la aprobación del supervisor."
                position="bottom"
              />
            </div>
            <p className="mt-1 text-sm text-muted">Conteo físico, recuento y ajuste controlado con historial completo.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setAuditBranchId(currentBranchId);
              setMode("cycle_count");
              setNotes("");
              setStep("setup");
              setShowModal(true);
            }}
            className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-4 text-sm font-bold text-white transition-colors hover:bg-violet-700 sm:w-auto"
          >
            <Plus size={15} /> Nueva auditoría
          </button>
        </header>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="min-w-0 rounded-2xl border border-base bg-secondary p-3 sm:p-4 shadow-2xs">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-violet-700 text-white shadow-sm" aria-hidden="true">
                <ClipboardCheck size={16} />
              </span>
              <span className="block min-w-0 font-black uppercase text-muted text-[10px] leading-tight tracking-[0.06em] break-words">Auditorías totales</span>
            </div>
            <div className="mt-2.5 flex items-baseline gap-1.5">
              <span className="text-lg sm:text-xl font-black tabular-nums leading-none text-primary">{inventoryAudits.length}</span>
              <span className="font-bold text-muted text-[10px]">registradas</span>
            </div>
            <span className="mt-1 block text-[11px] font-semibold text-muted break-words">{historyCounts.approved} aprobadas con ajuste aplicado</span>
          </div>

          <div className="min-w-0 rounded-2xl border border-base bg-secondary p-3 sm:p-4 shadow-2xs">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm" aria-hidden="true">
                <Clock3 size={16} />
              </span>
              <span className="block min-w-0 font-black uppercase text-muted text-[10px] leading-tight tracking-[0.06em] break-words">En conteo</span>
            </div>
            <div className="mt-2.5 flex items-baseline gap-1.5">
              <span className="text-lg sm:text-xl font-black tabular-nums leading-none text-amber-600 dark:text-amber-400">{historyCounts.counting}</span>
              <span className="font-bold text-muted text-[10px]">abiertas</span>
            </div>
            <span className="mt-1 block text-[11px] font-semibold text-muted break-words">
              {historyCounts.recount_requested ? `${historyCounts.recount_requested} con recuento solicitado` : "Sin recuentos pendientes"}
            </span>
          </div>

          <div className="min-w-0 rounded-2xl border border-base bg-secondary p-3 sm:p-4 shadow-2xs">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-700 text-white shadow-sm" aria-hidden="true">
                <ShieldCheck size={16} />
              </span>
              <span className="block min-w-0 font-black uppercase text-muted text-[10px] leading-tight tracking-[0.06em] break-words">Pendientes revisión</span>
            </div>
            <div className="mt-2.5 flex items-baseline gap-1.5">
              <span className="text-lg sm:text-xl font-black tabular-nums leading-none text-sky-600 dark:text-sky-400">{historyCounts.pending_approval}</span>
              <span className="font-bold text-muted text-[10px]">por aprobar</span>
            </div>
            <span className="mt-1 block text-[11px] font-semibold text-muted break-words">El stock espera aprobación del supervisor</span>
          </div>

          <div className="min-w-0 rounded-2xl border border-base bg-secondary p-3 sm:p-4 shadow-2xs">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow-sm" aria-hidden="true">
                <CheckCircle2 size={16} />
              </span>
              <span className="block min-w-0 font-black uppercase text-muted text-[10px] leading-tight tracking-[0.06em] break-words">Exactitud histórica</span>
            </div>
            <div className="mt-2.5 flex items-baseline gap-1.5">
              <span className="text-lg sm:text-xl font-black tabular-nums leading-none text-emerald-600 dark:text-emerald-400">{overallAccuracy == null ? "—" : `${overallAccuracy}%`}</span>
              <span className="font-bold text-muted text-[10px]">líneas exactas</span>
            </div>
            <span className="mt-1 block text-[11px] font-semibold text-muted break-words">Medida sobre auditorías aprobadas</span>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm">
          <div className="flex flex-col gap-2 border-b border-base p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-black text-primary">Historial y control</h2>
                <p className="text-xs font-semibold text-muted">Cada auditoría conserva su conteo, variaciones y decisiones.</p>
              </div>
              <span className="flex items-center gap-1.5 rounded-lg border border-base px-2.5 py-1.5 text-[11px] font-black uppercase tracking-wide text-muted">
                <ShieldCheck size={13} /> Sin ajuste automático
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {([
                ["all", "Todas"],
                ["counting", "En conteo"],
                ["pending_approval", "Revisión"],
                ["recount_requested", "Recuento"],
                ["approved", "Aprobadas"],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setHistoryFilter(key)}
                  className={cn(
                    "flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 text-sm font-bold transition-colors",
                    historyFilter === key
                      ? "border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300"
                      : "border-base bg-secondary text-secondary hover:bg-subtle hover:text-primary"
                  )}
                >
                  {label}
                  <span className="text-[11px] font-black text-muted">{historyCounts[key]}</span>
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  type="search"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Buscar por código, sucursal, producto o nota…"
                  className="w-full rounded-xl border border-base bg-secondary py-2 pl-9 pr-3 text-sm font-semibold text-primary outline-none placeholder:font-medium placeholder:text-muted focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20"
                />
              </div>
              <label className="flex items-center gap-1.5 rounded-xl border border-base bg-secondary px-2.5 py-1.5">
                <Filter size={13} className="text-muted" />
                <select
                  value={historyBranch}
                  onChange={(e) => setHistoryBranch(e.target.value)}
                  className="bg-transparent text-sm font-bold text-primary outline-none"
                  aria-label="Filtrar por sucursal"
                >
                  <option value="all">Todas las sucursales</option>
                  {branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </label>
            </div>
          </div>

          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[760px] text-left text-sm [&_td]:px-3 [&_td]:py-3 [&_th]:px-3 [&_th]:py-2.5">
              <thead className="border-b border-base bg-subtle text-[11px] font-black uppercase tracking-wider text-muted">
                <tr>
                  <th>Auditoría</th>
                  <th>Sucursal / Tipo</th>
                  <th>Avance</th>
                  <th>Variación</th>
                  <th className="text-right">Valor diferencia</th>
                  <th>Estado</th>
                  <th className="text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="[&>tr+tr]:border-t [&>tr+tr]:border-base">
                {filteredHistory.map(audit => {
                  const stats = statsOf(audit);
                  const review = reviewOf(audit);
                  const pct = stats.total ? Math.round((stats.counted / stats.total) * 100) : 0;
                  return (
                    <tr key={audit.id} className="align-top transition-colors hover:bg-subtle/60">
                      <td>
                        <div className="break-words font-mono text-xs font-black text-primary">{auditCode(audit.id)}</div>
                        <div className="mt-0.5 break-words text-[11px] font-semibold text-muted">{shortDate(audit.date)}</div>
                      </td>
                      <td>
                        <div className="font-bold text-primary">{branchName(audit.branchId)}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] font-semibold text-muted">
                          <span>{audit.mode === "physical" ? "Inventario físico" : "Conteo cíclico"}</span>
                          <span className="rounded bg-subtle px-1.5 py-0.5 font-bold text-secondary">
                            Con referencia
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-subtle">
                            <div
                              className={cn("h-full rounded-full", pct === 100 ? "bg-emerald-500" : "bg-violet-500")}
                              style={{ width: `${Math.max(4, pct)}%` }}
                            />
                          </div>
                          <span className="text-xs font-black tabular-nums text-primary">{stats.counted}/{stats.total}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] font-semibold text-muted">{pct}% contado · Exactitud {stats.accuracy}%</div>
                      </td>
                      <td>
                        {stats.changed === 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 size={12} /> Sin variación
                          </span>
                        ) : (
                          <div className="space-y-0.5 text-xs font-bold">
                            <span className="flex items-center gap-1 text-red-600 dark:text-red-400"><TrendingDown size={12} /> −{fmtNum(stats.shortage)}</span>
                            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><TrendingUp size={12} /> +{fmtNum(stats.overage)}</span>
                            <span className="text-[11px] font-semibold text-muted">{stats.changed} línea(s) con diferencia</span>
                          </div>
                        )}
                      </td>
                      <td className="text-right">
                        <span className={cn("break-words text-xs font-black tabular-nums", stats.value > 0 ? "text-primary" : "text-muted")}>
                          {fmtMoney(stats.value, baseCurrency.code)}
                        </span>
                      </td>
                      <td>
                        <span className={cn(
                          "inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-black uppercase tracking-wide",
                          review === "approved" && "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
                          review === "pending_approval" && "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
                          review === "recount_requested" && "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
                          review === "counting" && "bg-subtle text-secondary",
                        )}>
                          {review === "approved" && <CheckCircle2 size={11} />}
                          {review === "pending_approval" && <ShieldCheck size={11} />}
                          {review === "recount_requested" && <RotateCcw size={11} />}
                          {review === "counting" && <Clock3 size={11} />}
                          {reviewLabel[review] || "En curso"}
                        </span>
                      </td>
                      <td className="text-right">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => openAudit(audit)}
                            className="flex min-h-[34px] items-center gap-1 rounded-lg border border-base px-2.5 text-xs font-bold text-secondary transition-colors hover:bg-subtle hover:text-primary"
                          >
                            <Eye size={12} /> {review === "counting" ? "Continuar" : "Abrir"}
                          </button>
                          <button
                            type="button"
                            disabled={review === "approved"}
                            onClick={() => setPendingDelete(audit)}
                            title={review === "approved" ? "Las auditorías aprobadas conservan el ajuste de stock" : "Eliminar auditoría"}
                            className="flex min-h-[34px] items-center gap-1 rounded-lg border border-base px-2.5 text-xs font-bold text-muted transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-rose-950/40"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filteredHistory.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <div className="flex flex-col items-center gap-2 py-14 text-center">
                        <ClipboardCheck size={28} className="text-muted" aria-hidden="true" />
                        <p className="text-base font-black text-primary">Sin auditorías en esta vista</p>
                        <p className="max-w-sm text-sm text-muted">
                          {historySearch || historyFilter !== "all" || historyBranch !== "all"
                            ? "Ajusta la búsqueda o los filtros."
                            : "Inicia una nueva auditoría para tomar el primer snapshot del stock."}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Movil/tablet: las mismas auditorías en tarjetas, sin tabla de 760px. */}
          <ul className="divide-y divide-base lg:hidden">
            {filteredHistory.map(audit => {
              const stats = statsOf(audit);
              const review = reviewOf(audit);
              const pct = stats.total ? Math.round((stats.counted / stats.total) * 100) : 0;
              return (
                <li key={audit.id} className="space-y-2 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words font-mono text-xs font-black text-primary">{auditCode(audit.id)}</p>
                      <p className="mt-0.5 text-[11px] font-semibold text-muted">{shortDate(audit.date)}</p>
                    </div>
                    <span className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 text-[10px] font-black uppercase tracking-wide",
                      review === "approved" && "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
                      review === "pending_approval" && "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
                      review === "recount_requested" && "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
                      review === "counting" && "bg-subtle text-secondary",
                    )}>
                      {review === "approved" && <CheckCircle2 size={11} />}
                      {review === "pending_approval" && <ShieldCheck size={11} />}
                      {review === "recount_requested" && <RotateCcw size={11} />}
                      {review === "counting" && <Clock3 size={11} />}
                      {reviewLabel[review] || "En curso"}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-muted">
                    <span className="flex items-center gap-1 font-bold text-primary"><Building2 size={12} /> {branchName(audit.branchId)}</span>
                    <span className="rounded bg-subtle px-1.5 py-0.5 font-bold text-secondary">{audit.mode === "physical" ? "Inventario físico" : "Conteo cíclico"}</span>
                  </div>

                  <div className="rounded-xl border border-base bg-subtle px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2 text-[11px] font-bold text-secondary">
                      <span>Avance del conteo</span>
                      <span className="tabular-nums text-primary">{stats.counted}/{stats.total} · {pct}%</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div className={cn("h-full rounded-full", pct === 100 ? "bg-emerald-500" : "bg-violet-500")} style={{ width: `${Math.max(4, pct)}%` }} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-bold">
                      {stats.changed === 0 ? (
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={11} /> Sin variación</span>
                      ) : (
                        <>
                          <span className="flex items-center gap-1 text-red-600 dark:text-red-400"><TrendingDown size={11} /> −{fmtNum(stats.shortage)}</span>
                          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><TrendingUp size={11} /> +{fmtNum(stats.overage)}</span>
                          <span className="text-muted">{stats.changed} línea(s) con diferencia</span>
                        </>
                      )}
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] font-semibold text-muted">
                      <span>Valor diferencia</span>
                      <span className={cn("font-black tabular-nums", stats.value > 0 ? "text-primary" : "text-muted")}>{fmtMoney(stats.value, baseCurrency.code)}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => openAudit(audit)}
                      className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-lg border border-base text-xs font-bold text-secondary transition-colors hover:bg-subtle hover:text-primary"
                    >
                      <Eye size={13} /> {review === "counting" ? "Continuar conteo" : "Abrir auditoría"}
                    </button>
                    <button
                      type="button"
                      disabled={review === "approved"}
                      onClick={() => setPendingDelete(audit)}
                      aria-label={`Eliminar auditoría ${auditCode(audit.id)}`}
                      title={review === "approved" ? "Las auditorías aprobadas conservan el ajuste de stock" : "Eliminar auditoría"}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-base text-muted transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-rose-950/40"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              );
            })}
            {filteredHistory.length === 0 && (
              <li className="px-6 py-12 text-center">
                <ClipboardCheck size={28} className="mx-auto text-muted" aria-hidden="true" />
                <p className="mt-2 text-sm font-black text-primary">Sin auditorías en esta vista</p>
                <p className="mt-1 text-[11px] font-semibold text-muted">
                  {historySearch || historyFilter !== "all" || historyBranch !== "all"
                    ? "Ajusta la búsqueda o los filtros."
                    : "Inicia una nueva auditoría para tomar el primer snapshot del stock."}
                </p>
              </li>
            )}
          </ul>
        </section>

        {showModal && (
          <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/70 backdrop-blur-sm sm:items-center sm:p-4">
            <div className="flex max-h-[94dvh] w-full max-w-5xl flex-col overflow-hidden rounded-t-3xl border border-base bg-secondary shadow-2xl sm:rounded-3xl">
              <div className="flex items-center justify-between gap-3 border-b border-base bg-subtle px-4 py-3 sm:px-5">
                <div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-lg border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-black uppercase text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300">
                      {selectedAudit ? auditCode(selectedAudit.id) : "Nueva auditoría"}
                    </span>
                    {selectedAudit && (
                      <span className="rounded-lg border border-base bg-secondary px-2 py-0.5 text-[10px] font-black uppercase text-secondary">
                        {reviewLabel[selectedAudit.reviewStatus || "counting"] || "En curso"}
                      </span>
                    )}
                  </div>
                  <h2 className="mt-1 text-base font-black text-primary sm:text-lg">
                    {step === "setup" ? "Preparar conteo" : step === "count" ? "Conteo físico" : "Revisión del ajuste"}
                  </h2>
                  <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{branchName(auditBranchId)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="hidden items-center gap-1 sm:flex">
                    {([
                      ["setup", "1"],
                      ["count", "2"],
                      ["review", "3"],
                    ] as const).map(([key, n]) => (
                      <span
                        key={key}
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-full text-xs font-black",
                          step === key ? "bg-violet-600 text-white" : "border border-base bg-secondary text-muted"
                        )}
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="flex h-9 w-9 items-center justify-center rounded-xl border border-base text-muted transition-colors hover:bg-secondary hover:text-primary"
                    aria-label="Cerrar"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 sm:p-5">
                {step === "setup" && (
                  <div className="mx-auto max-w-2xl space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl border border-base bg-subtle p-3.5">
                        <div className="mb-1.5 flex items-center gap-2"><PackageCheck size={15} className="text-violet-600 dark:text-violet-300" /><span className="text-xs font-black uppercase tracking-wide text-primary">Sucursal</span></div>
                        <select value={auditBranchId} onChange={e => setAuditBranchId(e.target.value)} className="w-full rounded-xl border border-base bg-secondary px-3 py-2.5 text-sm font-bold text-primary outline-none focus:border-violet-400">
                          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                        {activeAudit && (
                          <p className="mt-1.5 text-[11px] font-bold text-amber-600 dark:text-amber-400">Esta sucursal ya tiene una auditoría abierta.</p>
                        )}
                      </div>
                      <div className="rounded-2xl border border-base bg-subtle p-3.5">
                        <div className="mb-1.5 flex items-center gap-2"><RefreshCw size={15} className="text-violet-600 dark:text-violet-300" /><span className="text-xs font-black uppercase tracking-wide text-primary">Tipo de conteo</span></div>
                        <select value={mode} onChange={e => setMode(e.target.value as "physical" | "cycle_count")} className="w-full rounded-xl border border-base bg-secondary px-3 py-2.5 text-sm font-bold text-primary outline-none focus:border-violet-400">
                          <option value="cycle_count">Conteo cíclico</option>
                          <option value="physical">Inventario físico</option>
                        </select>
                        <p className="mt-1.5 text-[11px] font-semibold text-muted">El cíclico audita una sección; el físico recorre todo el almacén.</p>
                      </div>
                    </div>

                    <textarea
                      value={notes}
                      onChange={e => setNotes(e.target.value)}
                      rows={2}
                      placeholder="Objetivo, sector, responsable o notas del conteo…"
                      className="w-full resize-none rounded-2xl border border-base bg-secondary px-3 py-2.5 text-sm font-medium text-primary outline-none placeholder:text-muted focus:border-violet-400"
                    />

                    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3.5 text-amber-900 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-200">
                      <p className="text-[11px] font-black uppercase tracking-wider">Cómo funciona</p>
                      <p className="mt-1 text-xs font-semibold leading-relaxed">1. Snapshot del stock actual. 2. Conteo físico de cada línea. 3. Envío a revisión con variaciones. 4. Solo al aprobar se publica el ajuste y se actualiza el inventario.</p>
                    </div>

                    <button
                      type="button"
                      disabled={isBusy || Boolean(activeAudit)}
                      onClick={beginNewAudit}
                      className={cn(
                        "flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl text-sm font-bold text-white transition-colors",
                        isBusy || activeAudit ? "cursor-not-allowed bg-subtle text-muted" : "bg-violet-600 hover:bg-violet-700"
                      )}
                    >
                      {isBusy && <Loader2 size={15} className="animate-spin" />}
                      {isBusy ? "Preparando snapshot…" : "Iniciar conteo y tomar snapshot"}
                    </button>
                  </div>
                )}

                {step === "count" && selectedAudit && (
                  <div className="space-y-3">
                    <div className="rounded-2xl border border-base bg-subtle p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-black uppercase tracking-wide text-secondary">Avance del conteo</span>
                        <span className="text-sm font-black tabular-nums text-primary">{varianceSummary.counted}/{varianceSummary.total} · {countedPct}%</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                        <div className={cn("h-full rounded-full transition-all", countedPct === 100 ? "bg-emerald-500" : "bg-violet-500")} style={{ width: `${Math.max(2, countedPct)}%` }} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-bold text-muted">
                        <span className="flex items-center gap-1 text-red-600 dark:text-red-400"><TrendingDown size={11} /> Faltante {varianceSummary.shortage}</span>
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><TrendingUp size={11} /> Sobrante {varianceSummary.overage}</span>
                        <span>{varianceSummary.changed} con variación</span>
                        <span>Recuento #{selectedAudit.recountCount || 0}</span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <div className="relative flex-1">
                        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                        <input
                          value={countSearch}
                          onChange={e => setCountSearch(e.target.value)}
                          placeholder="Buscar producto o variante…"
                          className="w-full rounded-xl border border-base bg-secondary py-2.5 pl-9 pr-3 text-sm font-semibold text-primary outline-none placeholder:text-muted focus:border-violet-400"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setOnlyPending(v => !v)}
                        className={cn(
                          "flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-bold transition-colors",
                          onlyPending ? "border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300" : "border-base bg-secondary text-secondary hover:bg-subtle"
                        )}
                      >
                        Solo pendientes
                      </button>
                      <button
                        type="button"
                        onClick={completeRemainingWithExpected}
                        title="Marca todas las líneas sin contar con el stock esperado. Útil cuando el sistema coincide con la realidad."
                        className="flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl border border-base bg-secondary px-3 text-sm font-bold text-secondary transition-colors hover:bg-subtle hover:text-primary"
                      >
                        <Equal size={14} /> Completar con esperado
                      </button>
                      <span className="flex min-h-[42px] items-center gap-1.5 rounded-xl border border-base bg-secondary px-3 text-[11px] font-black uppercase text-secondary">
                        <Unlock size={13} />
                        Referencia visible
                      </span>
                    </div>

                    <div className="overflow-hidden rounded-2xl border border-base">
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[720px] text-sm [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_th]:py-2">
                          <thead className="border-b border-base bg-subtle text-left text-[11px] font-black uppercase tracking-wider text-muted">
                            <tr>
                              <th>Producto</th>
                              <th className="text-center">Esperado</th>
                              <th className="text-center">Físico</th>
                              <th className="text-right">Variación</th>
                            </tr>
                          </thead>
                          <tbody className="[&>tr+tr]:border-t [&>tr+tr]:border-base">
                            {filteredDraft.map(item => {
                              const idx = countDraft.findIndex(x => x.productId === item.productId && (x.variantLabel || "") === (item.variantLabel || ""));
                              const diff = item.counted == null ? 0 : Number(item.counted) - Number(item.expected || 0);
                              return (
                                <tr key={item.productId + "::" + (item.variantLabel || "")} className={cn(item.counted == null ? "" : "bg-secondary")}>
                                  <td>
                                    <div className="font-bold text-primary">{item.productName}</div>
                                    <div className="text-[11px] font-semibold text-muted">{item.variantLabel || "Base"}</div>
                                  </td>
                                  <td className="text-center">
                                    <span className="text-sm font-black tabular-nums text-muted">
                                      {item.expected}
                                    </span>
                                  </td>
                                  <td className="text-center">
                                    <div className="inline-flex items-center gap-1">
                                      <button
                                        type="button"
                                        onClick={() => updateCount(idx, Math.max(0, Number(item.counted || 0) - 1))}
                                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-base bg-subtle text-sm font-black text-primary transition-colors hover:bg-secondary"
                                        aria-label="Restar unidad"
                                      >
                                        −
                                      </button>
                                      <input
                                        value={item.counted ?? ""}
                                        onChange={e => setCountInput(idx, e.target.value)}
                                        type="number"
                                        min={0}
                                        inputMode="numeric"
                                        placeholder="—"
                                        aria-label={`Cantidad física de ${item.productName}`}
                                        className="w-16 rounded-lg border border-base bg-secondary py-1.5 text-center text-sm font-black tabular-nums text-primary outline-none placeholder:text-muted focus:border-violet-400"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => updateCount(idx, Number(item.counted || 0) + 1)}
                                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-base bg-subtle text-sm font-black text-primary transition-colors hover:bg-secondary"
                                        aria-label="Sumar unidad"
                                      >
                                        +
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => updateCount(idx, Number(item.expected || 0))}
                                        className="ml-1 flex h-8 items-center rounded-lg border border-base px-2 text-[10px] font-black uppercase text-muted transition-colors hover:bg-subtle hover:text-primary"
                                        title="Usar la cantidad del sistema"
                                      >
                                        = esperado
                                      </button>
                                    </div>
                                  </td>
                                  <td className="text-right">
                                    {item.counted == null ? (
                                      <span className="text-[11px] font-black uppercase text-muted">Pendiente</span>
                                    ) : (
                                      <span className={cn("text-sm font-black tabular-nums", diff === 0 ? "text-muted" : diff > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                                        {diff > 0 ? "+" : ""}{diff}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                            {filteredDraft.length === 0 && (
                              <tr>
                                <td colSpan={4} className="py-10 text-center">
                                  <p className="text-sm font-black text-primary">{onlyPending ? "No quedan líneas pendientes" : "Sin resultados"}</p>
                                  <p className="mt-1 text-xs font-semibold text-muted">{onlyPending ? "Todas las líneas ya tienen cantidad contada." : "Cambia el término de búsqueda."}</p>
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <textarea
                      value={notes}
                      onChange={e => setNotes(e.target.value)}
                      rows={2}
                      placeholder="Notas del conteo o explicación de diferencias…"
                      className="w-full resize-none rounded-xl border border-base bg-secondary px-3 py-2.5 text-sm font-medium text-primary outline-none placeholder:text-muted focus:border-violet-400"
                    />
                  </div>
                )}

                {step === "review" && selectedAudit && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
                      <div className="rounded-2xl border border-base bg-subtle p-3">
                        <span className="text-[10px] font-black uppercase tracking-wider text-muted">Faltante</span>
                        <p className="mt-0.5 text-xl font-black text-red-600 tabular-nums dark:text-red-400">−{fmtNum(varianceSummary.shortage)}</p>
                        <span className="text-[10px] font-bold uppercase text-muted">unidades</span>
                      </div>
                      <div className="rounded-2xl border border-base bg-subtle p-3">
                        <span className="text-[10px] font-black uppercase tracking-wider text-muted">Sobrante</span>
                        <p className="mt-0.5 text-xl font-black text-emerald-600 tabular-nums dark:text-emerald-400">+{fmtNum(varianceSummary.overage)}</p>
                        <span className="text-[10px] font-bold uppercase text-muted">unidades</span>
                      </div>
                      <div className="rounded-2xl border border-base bg-subtle p-3">
                        <span className="text-[10px] font-black uppercase tracking-wider text-muted">Líneas con variación</span>
                        <p className="mt-0.5 text-xl font-black text-primary tabular-nums">{varianceSummary.changed}</p>
                        <span className="text-[10px] font-bold uppercase text-muted">de {varianceSummary.total}</span>
                      </div>
                      <div className="rounded-2xl border border-base bg-subtle p-3">
                        <span className="text-[10px] font-black uppercase tracking-wider text-muted">Exactitud</span>
                        <p className="mt-0.5 text-xl font-black text-sky-600 tabular-nums dark:text-sky-400">
                          {varianceSummary.counted ? Math.round(((varianceSummary.counted - varianceSummary.changed) / varianceSummary.counted) * 100) : 0}%
                        </p>
                        <span className="text-[10px] font-bold uppercase text-muted">del conteo</span>
                      </div>
                      <div className="min-w-0 rounded-2xl border border-base bg-subtle p-3">
                        <span className="text-[10px] font-black uppercase tracking-wider text-muted">Valor de diferencia</span>
                        <p className="mt-0.5 break-words text-base font-black text-primary tabular-nums">{fmtMoney(totalValue, baseCurrency.code)}</p>
                        <span className="text-[10px] font-bold uppercase text-muted">a costo</span>
                      </div>
                    </div>

                    {selectedCurrentSystemChanges > 0 && selectedAudit.reviewStatus === "pending_approval" && (
                      <div className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 p-3.5 dark:border-amber-900/50 dark:bg-amber-500/10">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        <div>
                          <p className="text-xs font-black uppercase text-amber-900 dark:text-amber-200">El stock cambió después del conteo</p>
                          <p className="mt-0.5 text-xs font-semibold text-amber-800 dark:text-amber-300">Hay {selectedCurrentSystemChanges} línea(s) modificadas desde el envío. Solicita un recuento para aprobar con datos vigentes.</p>
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-base bg-subtle px-3 py-2">
                      <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wide text-secondary">
                        <ShieldCheck size={13} /> Ajuste pendiente de aprobación
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setOnlyDifferences(true)}
                          className={cn("min-h-[32px] rounded-lg border px-2.5 text-xs font-bold transition-colors", onlyDifferences ? "border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300" : "border-base bg-secondary text-secondary hover:bg-subtle")}
                        >
                          Solo diferencias
                        </button>
                        <button
                          type="button"
                          onClick={() => setOnlyDifferences(false)}
                          className={cn("min-h-[32px] rounded-lg border px-2.5 text-xs font-bold transition-colors", !onlyDifferences ? "border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300" : "border-base bg-secondary text-secondary hover:bg-subtle")}
                        >
                          Todas las contadas
                        </button>
                        <button
                          type="button"
                          onClick={() => printAuditReport(selectedAudit)}
                          className="flex min-h-[32px] items-center gap-1 rounded-lg border border-base bg-secondary px-2.5 text-xs font-bold text-secondary transition-colors hover:bg-subtle hover:text-primary"
                        >
                          <Printer size={12} /> Imprimir informe
                        </button>
                      </div>
                    </div>

                    <div className="overflow-hidden rounded-2xl border border-base">
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[600px] text-sm [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_th]:py-2">
                          <thead className="border-b border-base bg-subtle text-[11px] font-black uppercase tracking-wider text-muted">
                            <tr>
                              <th>Producto</th>
                              <th className="text-right">Snapshot</th>
                              <th className="text-right">Contado</th>
                              <th className="text-right">Variación</th>
                              <th className="text-right">Valor</th>
                              <th className="text-right">Sistema actual</th>
                            </tr>
                          </thead>
                          <tbody className="[&>tr+tr]:border-t [&>tr+tr]:border-base">
                            {reviewItems.map(item => {
                              const current = inventory.find(i => i.productId === item.productId && i.branchId === selectedAudit.branchId && (i.variantLabel || "") === (item.variantLabel || ""))?.quantity ?? 0;
                              const diff = Number(item.difference || 0);
                              const value = Math.abs(diff) * Number(productById.get(item.productId)?.costPrice || 0);
                              return (
                                <tr key={item.productId + "::" + (item.variantLabel || "")}>
                                  <td>
                                    <div className="font-bold text-primary">{item.productName}</div>
                                    <div className="text-[11px] font-semibold text-muted">{item.variantLabel || "Base"}</div>
                                  </td>
                                  <td className="text-right font-mono text-sm text-muted tabular-nums">{item.expected}</td>
                                  <td className="text-right font-mono text-sm font-black text-primary tabular-nums">{item.counted ?? "—"}</td>
                                  <td className={cn("text-right font-mono text-sm font-black tabular-nums", diff < 0 ? "text-red-600 dark:text-red-400" : diff > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted")}>
                                    {diff > 0 ? "+" : ""}{diff}
                                  </td>
                                  <td className="text-right font-mono text-xs font-bold text-secondary tabular-nums">{value ? fmtMoney(value, baseCurrency.code) : "—"}</td>
                                  <td className={cn("text-right font-mono text-sm font-black tabular-nums", Number(current) !== Number(item.systemAtSubmission ?? item.expected) ? "text-amber-600 dark:text-amber-400" : "text-primary")}>
                                    {current}
                                  </td>
                                </tr>
                              );
                            })}
                            {reviewItems.length === 0 && (
                              <tr>
                                <td colSpan={6} className="py-10 text-center">
                                  <p className="flex items-center justify-center gap-1.5 text-sm font-black text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={15} /> Sin diferencias</p>
                                  <p className="mt-1 text-xs font-semibold text-muted">El conteo coincide con el sistema. Puedes aprobar o revisar todas las líneas contadas.</p>
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-base bg-subtle p-3.5">
                      <div className="flex items-center gap-2 text-primary"><ShieldCheck size={15} className="text-violet-600 dark:text-violet-300" /><p className="text-xs font-black uppercase tracking-wide">Regla de control</p></div>
                      <p className="mt-1 text-xs font-semibold leading-relaxed text-secondary">El «Snapshot» es el stock al iniciar. El ajuste final se calcula contra el stock vigente al aprobar. Si el stock cambió después del envío, la aprobación se rechaza y se solicita recuento.</p>
                    </div>

                    <textarea
                      value={notes}
                      onChange={e => setNotes(e.target.value)}
                      rows={2}
                      placeholder="Conclusión de la revisión, motivo de la diferencia o decisión del supervisor…"
                      className="w-full resize-none rounded-xl border border-base bg-secondary px-3 py-2.5 text-sm font-medium text-primary outline-none placeholder:text-muted focus:border-violet-400"
                    />
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2 border-t border-base bg-subtle px-4 py-3 sm:flex-row sm:px-5">
                {step === "count" && selectedAudit && (
                  <>
                    <button type="button" onClick={() => setShowModal(false)} className="min-h-[42px] rounded-xl border border-base bg-secondary px-4 text-sm font-bold text-secondary transition-colors hover:bg-subtle hover:text-primary">
                      Guardar y salir
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={submitCount}
                      className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-bold text-white transition-colors", isBusy ? "bg-subtle text-muted" : "bg-violet-600 hover:bg-violet-700")}
                    >
                      {isBusy ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                      {isBusy ? "Enviando…" : "Enviar conteo a revisión"}
                    </button>
                  </>
                )}
                {step === "review" && selectedAudit && (
                  <>
                    <button type="button" onClick={() => setShowModal(false)} className="min-h-[42px] rounded-xl border border-base bg-secondary px-4 text-sm font-bold text-secondary transition-colors hover:bg-subtle hover:text-primary">
                      Cerrar
                    </button>
                    {selectedAudit.reviewStatus === "pending_approval" && (
                      <>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={requestRecount}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-4 text-sm font-bold text-white transition-colors hover:bg-amber-600 disabled:opacity-60"
                        >
                          <RotateCcw size={14} /> Solicitar recuento
                        </button>
                        <button
                          type="button"
                          disabled={isBusy || selectedCurrentSystemChanges > 0}
                          onClick={approve}
                          title={selectedCurrentSystemChanges > 0 ? "El stock cambió después del conteo: solicita un recuento" : undefined}
                          className={cn(
                            "flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-bold text-white transition-colors",
                            isBusy || selectedCurrentSystemChanges > 0 ? "cursor-not-allowed bg-subtle text-muted" : "bg-emerald-600 hover:bg-emerald-700"
                          )}
                        >
                          <CheckCircle2 size={14} /> Aprobar y ajustar stock
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      {pendingDelete && (
        <div className="fixed inset-0 z-[120] flex items-end justify-center bg-slate-950/70 p-3 backdrop-blur-sm sm:items-center">
          <div className="w-full max-w-md rounded-t-3xl border border-base bg-secondary p-4 shadow-2xl sm:rounded-3xl sm:p-5">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400">
                <Trash2 size={18} />
              </span>
              <div className="min-w-0">
                <p className="text-base font-black text-primary">Eliminar auditoría</p>
                <p className="mt-1 break-words text-sm font-semibold text-muted">
                  Se borrará {auditCode(pendingDelete.id)} y su conteo. El stock no cambia porque todavía no se aprobó ningún ajuste.
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="min-h-[44px] flex-1 rounded-xl border border-base bg-secondary px-4 text-sm font-bold text-secondary transition-colors hover:bg-subtle hover:text-primary"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={confirmDelete}
                className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-4 text-sm font-bold text-white transition-colors hover:bg-rose-700 disabled:opacity-60"
              >
                {isBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {isBusy ? "Eliminando…" : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}
      </OperationsSurface>
    </PlanFeatureGate>
  );
}
