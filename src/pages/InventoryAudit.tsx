import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ClipboardCheck, Plus, Search, Eye, X, CheckCircle2, AlertTriangle,
  RotateCcw, Lock, Unlock, ShieldCheck, Clock3, PackageCheck, RefreshCw
} from "lucide-react";
import { useStore } from "../store/useStore";
import { InventoryAudit } from "../types";
import { cn } from "../lib/utils";

type AuditItem = InventoryAudit["items"][number];

const reviewLabel: Record<string, string> = {
  counting: "Conteo en curso",
  recount_requested: "Requiere recuento",
  pending_approval: "Pendiente de aprobación",
  approved: "Aprobada y ajustada"
};

export default function InventoryAuditPage() {
  const {
    products, inventory, inventoryAudits, branches, currentBranchId, currentUser,
    createInventoryAudit, completeInventoryAudit, requestInventoryAuditRecount,
    approveInventoryAudit, addNotification
  } = useStore(useShallow(state => ({
    products: state.products,
    inventory: state.inventory,
    inventoryAudits: state.inventoryAudits,
    branches: state.branches,
    currentBranchId: state.currentBranchId,
    currentUser: state.currentUser,
    createInventoryAudit: state.createInventoryAudit,
    completeInventoryAudit: state.completeInventoryAudit,
    requestInventoryAuditRecount: state.requestInventoryAuditRecount,
    approveInventoryAudit: state.approveInventoryAudit,
    addNotification: state.addNotification
  })));

  const [showModal, setShowModal] = useState(false);
  const [step, setStep] = useState<"setup" | "count" | "review">("setup");
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);
  const [auditBranchId, setAuditBranchId] = useState(currentBranchId);
  const [mode, setMode] = useState<"physical" | "cycle_count">("cycle_count");
  const [blindCount, setBlindCount] = useState(true);
  const [notes, setNotes] = useState("");
  const [search, setSearch] = useState("");
  const [countDraft, setCountDraft] = useState<AuditItem[]>([]);
  const [isBusy, setIsBusy] = useState(false);

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

  const branchName = (id: string) => branches.find(b => b.id === id)?.name || "Sucursal";

  const buildLocalSnapshot = (branchId: string, blind: boolean): InventoryAudit => {
    const rows = inventory
      .filter(i => i.branchId === branchId)
      .sort((a, b) => {
        const an = products.find(p => p.id === a.productId)?.name || "";
        const bn = products.find(p => p.id === b.productId)?.name || "";
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
        productName: products.find(p => p.id === row.productId)?.name || "Producto",
        variantLabel: row.variantLabel || "",
        expected: Number(row.quantity || 0),
        counted: null,
        actual: null,
        difference: 0,
        systemAtSubmission: Number(row.quantity || 0),
        adjustmentDelta: 0,
        countCycle: 1
      })),
      notes
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

    setIsBusy(true);
    try {
      const audit = buildLocalSnapshot(auditBranchId, blindCount);
      const res = await createInventoryAudit(audit);
      if (!res.success) {
        addNotification(res.error || "No se pudo iniciar la auditoría.", "error");
        return;
      }

      const stored = useStore.getState().inventoryAudits.find(a => a.id === audit.id) || audit;
      setSelectedAuditId(stored.id);
      setCountDraft(stored.items);
      setStep("count");
      setShowModal(true);
    } finally {
      setIsBusy(false);
    }
  };

  const openAudit = (audit: InventoryAudit) => {
    setSelectedAuditId(audit.id);
    setAuditBranchId(audit.branchId);
    setNotes(audit.notes || "");
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
    const q = search.trim().toLowerCase();
    if (!q) return countDraft;
    return countDraft.filter(i =>
      i.productName.toLowerCase().includes(q) ||
      (i.variantLabel || "").toLowerCase().includes(q)
    );
  }, [countDraft, search]);

  const varianceSummary = useMemo(() => {
    const source = selectedAudit?.items || countDraft;
    let shortage = 0;
    let overage = 0;
    let changed = 0;
    let counted = 0;

    source.forEach(i => {
      const c = Number(i.counted);
      if (!Number.isFinite(c)) return;
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

  const submitCount = async () => {
    if (!selectedAuditId) return;
    const missing = countDraft.some(i => i.counted === null || i.counted === undefined);
    if (missing) {
      addNotification("Debes completar el conteo físico de todos los artículos antes de enviarlo a revisión.", "warning");
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
      addNotification("Auditoría aprobada y ajuste físico aplicado.", "success");
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
      setSearch("");
      setStep("count");
      addNotification("Recuento solicitado. El ajuste físico sigue sin aplicarse.", "info");
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
      const product = products.find(p => p.id === item.productId);
      return sum + Math.abs(Number(item.difference || 0)) * Number(product?.costPrice || 0);
    }, 0);
  }, [selectedAudit, products]);

  return (
    <div className="space-y-5 animate-in fade-in duration-300 pb-16">
      <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardCheck className="w-5 h-5 text-indigo-600" />
            <h1 data-palmi-content="inventory-audit" className="text-xl sm:text-2xl font-black text-primary uppercase tracking-tight">Auditoría de Stock</h1>
          </div>
          <p className="text-[9px] font-black text-muted uppercase tracking-[0.18em] mt-1">
            Conteo físico • Variación • Recuento • Aprobación • Ajuste controlado
          </p>
        </div>
        <button
          onClick={() => {
            setAuditBranchId(currentBranchId);
            setMode("cycle_count");
            setBlindCount(true);
            setNotes("");
            setSearch("");
            setStep("setup");
            setShowModal(true);
          }}
          className="w-full sm:w-auto px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20"
        >
          <Plus className="w-4 h-4" /> Nueva auditoría
        </button>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <div className="bg-secondary border border-base rounded-2xl p-3">
          <span className="text-[8px] font-black uppercase text-muted tracking-widest">Total auditorías</span>
          <p className="text-xl font-black text-primary mt-1">{inventoryAudits.length}</p>
        </div>
        <div className="bg-secondary border border-base rounded-2xl p-3">
          <span className="text-[8px] font-black uppercase text-muted tracking-widest">En conteo</span>
          <p className="text-xl font-black text-amber-600 mt-1">{inventoryAudits.filter(a => (a.reviewStatus || "counting") === "counting").length}</p>
        </div>
        <div className="bg-secondary border border-base rounded-2xl p-3">
          <span className="text-[8px] font-black uppercase text-muted tracking-widest">Pendientes revisión</span>
          <p className="text-xl font-black text-indigo-600 mt-1">{inventoryAudits.filter(a => a.reviewStatus === "pending_approval").length}</p>
        </div>
        <div className="bg-secondary border border-base rounded-2xl p-3">
          <span className="text-[8px] font-black uppercase text-muted tracking-widest">Aprobadas</span>
          <p className="text-xl font-black text-emerald-600 mt-1">{inventoryAudits.filter(a => a.reviewStatus === "approved" || a.status === "completed").length}</p>
        </div>
      </section>

      <section className="bg-secondary border border-base rounded-2xl overflow-hidden">
        <div className="p-3 border-b border-base flex items-center justify-between gap-2">
          <div>
            <h2 className="text-[10px] font-black uppercase tracking-widest text-primary">Historial y control</h2>
            <p className="text-[8px] text-muted font-bold mt-0.5">Cada auditoría conserva su conteo y las decisiones tomadas.</p>
          </div>
          <div className="flex items-center gap-1.5 text-[8px] font-black uppercase text-muted">
            <ShieldCheck className="w-3.5 h-3.5" /> Sin ajuste automático
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-subtle border-b border-base">
              <tr>
                <th className="px-4 py-3 text-[8px] font-black uppercase tracking-widest text-muted">Auditoría</th>
                <th className="px-4 py-3 text-[8px] font-black uppercase tracking-widest text-muted">Sucursal / Tipo</th>
                <th className="px-4 py-3 text-[8px] font-black uppercase tracking-widest text-muted">Líneas</th>
                <th className="px-4 py-3 text-[8px] font-black uppercase tracking-widest text-muted">Variación</th>
                <th className="px-4 py-3 text-[8px] font-black uppercase tracking-widest text-muted">Estado</th>
                <th className="px-4 py-3 text-right text-[8px] font-black uppercase tracking-widest text-muted">Abrir</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base">
              {inventoryAudits.map(audit => {
                const differences = audit.items.filter(i => Number(i.difference || 0) !== 0).length;
                const review = audit.reviewStatus || (audit.status === "completed" ? "approved" : "counting");
                return (
                  <tr key={audit.id} className="hover:bg-subtle/50">
                    <td className="px-4 py-3">
                      <div className="text-[9px] font-black text-primary font-mono">{audit.id.slice(0, 12)}…</div>
                      <div className="text-[8px] text-muted font-bold mt-0.5">{new Date(audit.date).toLocaleString("es-CU")}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-[9px] font-black text-primary uppercase">{branchName(audit.branchId)}</div>
                      <span className="text-[7px] uppercase font-black text-muted">{audit.mode === "physical" ? "Inventario físico" : "Conteo cíclico"}{audit.blindCount ? " • Ciego" : ""}</span>
                    </td>
                    <td className="px-4 py-3 text-[10px] font-black text-primary">{audit.items.length}</td>
                    <td className="px-4 py-3">
                      {differences === 0 ? (
                        <span className="inline-flex items-center gap-1 text-[8px] font-black uppercase text-emerald-600"><CheckCircle2 className="w-3 h-3" /> Sin variación</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[8px] font-black uppercase text-rose-600"><AlertTriangle className="w-3 h-3" /> {differences} líneas</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        "inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[7px] font-black uppercase border",
                        review === "approved" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                        review === "pending_approval" ? "bg-indigo-50 text-indigo-700 border-indigo-200" :
                        review === "recount_requested" ? "bg-amber-50 text-amber-700 border-amber-200" :
                        "bg-slate-100 text-slate-600 border-slate-200"
                      )}>
                        {reviewLabel[review] || "En curso"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => openAudit(audit)} className="p-2 rounded-lg bg-subtle hover:bg-indigo-50 text-muted hover:text-indigo-600">
                        <Eye className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {inventoryAudits.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-14 text-center text-muted text-[9px] font-black uppercase tracking-widest">No hay auditorías registradas.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showModal && (
        <div className="fixed inset-0 z-[90] bg-slate-950/70 backdrop-blur-sm p-2 sm:p-4 flex items-center justify-center">
          <div className="w-full max-w-5xl max-h-[95vh] bg-secondary border border-base rounded-3xl shadow-2xl overflow-hidden flex flex-col">
            <div className="px-4 sm:px-5 py-3.5 border-b border-base flex items-center justify-between bg-subtle">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="px-2 py-1 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 text-[8px] font-black uppercase">{selectedAudit ? selectedAudit.id.slice(0, 12) : "Nueva auditoría"}</span>
                  {selectedAudit && (
                    <span className="px-2 py-1 rounded-lg bg-white border border-base text-[8px] font-black uppercase text-primary">
                      {reviewLabel[selectedAudit.reviewStatus || "counting"] || "En curso"}
                    </span>
                  )}
                </div>
                <h2 className="text-sm sm:text-base font-black uppercase tracking-tight text-primary mt-1">
                  {step === "setup" ? "Preparar conteo" : step === "count" ? "Conteo físico" : "Revisión del ajuste"}
                </h2>
                <p className="text-[8px] font-bold text-muted uppercase mt-0.5">{branchName(auditBranchId)}</p>
              </div>
              <button onClick={() => setShowModal(false)} className="p-2 rounded-xl hover:bg-white text-muted"><X className="w-5 h-5" /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 sm:p-5">
              {step === "setup" && (
                <div className="max-w-2xl mx-auto space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-4 rounded-2xl border border-base bg-subtle">
                      <div className="flex items-center gap-2 mb-2"><PackageCheck className="w-4 h-4 text-indigo-600" /><span className="text-[9px] font-black uppercase text-primary">Sucursal</span></div>
                      <select value={auditBranchId} onChange={e => setAuditBranchId(e.target.value)} className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-base text-[10px] font-black uppercase text-primary">
                        {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </div>
                    <div className="p-4 rounded-2xl border border-base bg-subtle">
                      <div className="flex items-center gap-2 mb-2"><RefreshCw className="w-4 h-4 text-indigo-600" /><span className="text-[9px] font-black uppercase text-primary">Tipo de conteo</span></div>
                      <select value={mode} onChange={e => setMode(e.target.value as any)} className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-base text-[10px] font-black uppercase text-primary">
                        <option value="cycle_count">Conteo cíclico</option>
                        <option value="physical">Inventario físico</option>
                      </select>
                    </div>
                  </div>

                  <button onClick={() => setBlindCount(v => !v)} className={cn("w-full p-4 rounded-2xl border text-left transition-all", blindCount ? "border-indigo-200 bg-indigo-50/70" : "border-base bg-subtle")}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[9px] font-black uppercase text-primary">Conteo ciego</p>
                        <p className="text-[8px] font-bold text-muted mt-0.5">El operador no ve la cantidad esperada durante el conteo.</p>
                      </div>
                      <span className={cn("w-10 h-6 rounded-full p-1 flex items-center", blindCount ? "bg-indigo-600 justify-end" : "bg-slate-300 justify-start")}><span className="w-4 h-4 rounded-full bg-white shadow-sm" /></span>
                    </div>
                  </button>

                  <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Objetivo, sector, responsable o notas del conteo..." className="w-full px-3 py-2.5 rounded-2xl bg-secondary border border-base text-xs text-primary outline-none resize-none" />

                  <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900">
                    <p className="text-[8px] font-black uppercase tracking-wider">Cómo funciona</p>
                    <p className="text-[9px] font-bold leading-relaxed mt-1">1. Se toma un snapshot del stock. 2. Se cuentan físicamente las unidades. 3. Se envía el resultado a revisión. 4. Solo al aprobar se publica el ajuste.</p>
                  </div>

                  <button disabled={isBusy} onClick={beginNewAudit} className="w-full py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-black uppercase tracking-widest disabled:opacity-50">
                    {isBusy ? "Preparando..." : "Iniciar conteo y tomar snapshot"}
                  </button>
                </div>
              )}

              {step === "count" && selectedAudit && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div className="p-3 rounded-2xl bg-subtle border border-base"><span className="text-[7px] font-black uppercase text-muted">Líneas</span><p className="text-lg font-black text-primary mt-0.5">{countDraft.length}</p></div>
                    <div className="p-3 rounded-2xl bg-subtle border border-base"><span className="text-[7px] font-black uppercase text-muted">Contadas</span><p className="text-lg font-black text-primary mt-0.5">{varianceSummary.counted}</p></div>
                    <div className="p-3 rounded-2xl bg-subtle border border-base"><span className="text-[7px] font-black uppercase text-muted">Variaciones</span><p className={cn("text-lg font-black mt-0.5", varianceSummary.changed ? "text-rose-600" : "text-emerald-600")}>{varianceSummary.changed}</p></div>
                    <div className="p-3 rounded-2xl bg-subtle border border-base"><span className="text-[7px] font-black uppercase text-muted">Recuento</span><p className="text-lg font-black text-indigo-600 mt-0.5">{selectedAudit.recountCount || 0}</p></div>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2">
                    <div className="flex-1 relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar producto o variante..." className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-subtle border border-base text-xs font-bold text-primary outline-none" />
                    </div>
                    <div className="px-3 py-2.5 rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-100 text-[8px] font-black uppercase flex items-center gap-1.5">
                      {selectedAudit.blindCount ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                      {selectedAudit.blindCount ? "Conteo ciego" : "Conteo con referencia"}
                    </div>
                  </div>

                  <div className="border border-base rounded-2xl overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-subtle border-b border-base">
                        <tr>
                          <th className="px-3 py-2.5 text-left text-[8px] font-black uppercase tracking-widest text-muted">Producto</th>
                          <th className="px-3 py-2.5 text-center text-[8px] font-black uppercase tracking-widest text-muted">Esperado</th>
                          <th className="px-3 py-2.5 text-center text-[8px] font-black uppercase tracking-widest text-muted">Físico</th>
                          <th className="px-3 py-2.5 text-right text-[8px] font-black uppercase tracking-widest text-muted">Variación</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-base">
                        {filteredDraft.map((item) => {
                          const idx = countDraft.findIndex(x => x.productId === item.productId && (x.variantLabel || "") === (item.variantLabel || ""));
                          const diff = item.counted == null ? 0 : Number(item.counted) - Number(item.expected || 0);
                          return (
                            <tr key={item.productId + "::" + (item.variantLabel || "")}>
                              <td className="px-3 py-3">
                                <div className="text-[9px] font-black uppercase text-primary">{item.productName}</div>
                                {item.variantLabel && <div className="text-[8px] text-muted font-bold mt-0.5">{item.variantLabel}</div>}
                              </td>
                              <td className="px-3 py-3 text-center">
                                <span className={cn("text-[10px] font-black font-mono", selectedAudit.blindCount ? "text-transparent bg-slate-200 rounded px-2" : "text-muted")}>
                                  {selectedAudit.blindCount ? "000" : item.expected}
                                </span>
                              </td>
                              <td className="px-3 py-3 text-center">
                                <div className="inline-flex items-center gap-1">
                                  <button onClick={() => updateCount(idx, Math.max(0, Number(item.counted || 0) - 1))} className="w-7 h-7 rounded-lg bg-subtle border border-base text-primary font-black">−</button>
                                  <input value={item.counted ?? ""} onChange={e => updateCount(idx, Number(e.target.value))} type="number" min={0} className="w-16 py-1.5 rounded-lg bg-secondary border border-base text-center text-xs font-black text-primary outline-none" />
                                  <button onClick={() => updateCount(idx, Number(item.counted || 0) + 1)} className="w-7 h-7 rounded-lg bg-subtle border border-base text-primary font-black">+</button>
                                </div>
                              </td>
                              <td className="px-3 py-3 text-right">
                                {item.counted == null ? (
                                  <span className="text-[8px] font-black uppercase text-muted">Pendiente</span>
                                ) : (
                                  <span className={cn("text-[10px] font-black font-mono", diff === 0 ? "text-slate-400" : diff > 0 ? "text-emerald-600" : "text-rose-600")}>
                                    {diff > 0 ? "+" : ""}{diff}
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Notas del conteo o explicación inicial..." className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-base text-xs text-primary outline-none resize-none" />
                </div>
              )}

              {step === "review" && selectedAudit && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
                    <div className="p-3 rounded-2xl bg-subtle border border-base"><span className="text-[7px] font-black uppercase text-muted">Faltante</span><p className="text-xl font-black text-rose-600 mt-0.5">-{varianceSummary.shortage}</p><span className="text-[7px] font-bold text-muted uppercase">unidades</span></div>
                    <div className="p-3 rounded-2xl bg-subtle border border-base"><span className="text-[7px] font-black uppercase text-muted">Sobrante</span><p className="text-xl font-black text-emerald-600 mt-0.5">+{varianceSummary.overage}</p><span className="text-[7px] font-bold text-muted uppercase">unidades</span></div>
                    <div className="p-3 rounded-2xl bg-subtle border border-base"><span className="text-[7px] font-black uppercase text-muted">Líneas con variación</span><p className="text-xl font-black text-indigo-600 mt-0.5">{varianceSummary.changed}</p></div>
                    <div className="p-3 rounded-2xl bg-subtle border border-base"><span className="text-[7px] font-black uppercase text-muted">Valor de diferencia</span><p className="text-lg font-black text-primary mt-0.5">CUP {totalValue.toLocaleString("es-CU")}</p></div>
                  </div>

                  {selectedCurrentSystemChanges > 0 && selectedAudit.reviewStatus === "pending_approval" && (
                    <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 flex items-start gap-2.5">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[8px] font-black uppercase text-amber-900">El stock cambió después del conteo</p>
                        <p className="text-[9px] font-bold text-amber-800 mt-0.5">Hay {selectedCurrentSystemChanges} líneas modificadas desde que el conteo fue enviado. El sistema bloqueará el ajuste hasta realizar un nuevo recuento.</p>
                      </div>
                    </div>
                  )}

                  <div className="p-3.5 rounded-2xl bg-indigo-50 border border-indigo-100">
                    <div className="flex items-center gap-2 text-indigo-800"><ShieldCheck className="w-4 h-4" /><p className="text-[9px] font-black uppercase">Regla de control</p></div>
                    <p className="text-[9px] font-bold text-indigo-900 mt-1 leading-relaxed">El valor “Esperado” es el snapshot del inicio. El ajuste final se calcula contra el stock vigente al aprobar. Si el stock cambió después del envío del conteo, la aprobación se rechaza y se solicita recuento.</p>
                  </div>

                  <div className="border border-base rounded-2xl overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-subtle border-b border-base">
                        <tr>
                          <th className="px-3 py-2.5 text-left text-[8px] font-black uppercase tracking-widest text-muted">Producto</th>
                          <th className="px-3 py-2.5 text-right text-[8px] font-black uppercase tracking-widest text-muted">Snapshot</th>
                          <th className="px-3 py-2.5 text-right text-[8px] font-black uppercase tracking-widest text-muted">Contado</th>
                          <th className="px-3 py-2.5 text-right text-[8px] font-black uppercase tracking-widest text-muted">Variación</th>
                          <th className="px-3 py-2.5 text-right text-[8px] font-black uppercase tracking-widest text-muted">Sistema actual</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-base">
                        {selectedAudit.items.filter(i => Number(i.difference || 0) !== 0 || i.counted != null).map(item => {
                          const current = inventory.find(i => i.productId === item.productId && i.branchId === selectedAudit.branchId && (i.variantLabel || "") === (item.variantLabel || ""))?.quantity ?? 0;
                          return (
                            <tr key={item.productId + "::" + (item.variantLabel || "")}>
                              <td className="px-3 py-2.5"><div className="text-[9px] font-black uppercase text-primary">{item.productName}</div><div className="text-[7px] text-muted font-bold">{item.variantLabel || "Base"}</div></td>
                              <td className="px-3 py-2.5 text-right font-mono text-[9px] text-muted">{item.expected}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-[9px] font-black text-primary">{item.counted ?? "-"}</td>
                              <td className={cn("px-3 py-2.5 text-right font-mono text-[9px] font-black", Number(item.difference || 0) < 0 ? "text-rose-600" : Number(item.difference || 0) > 0 ? "text-emerald-600" : "text-slate-400")}>{Number(item.difference || 0) > 0 ? "+" : ""}{item.difference}</td>
                              <td className={cn("px-3 py-2.5 text-right font-mono text-[9px] font-black", Number(current) !== Number(item.systemAtSubmission ?? item.expected) ? "text-amber-600" : "text-primary")}>{current}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Conclusión de la revisión, motivo de la diferencia o decisión del supervisor..." className="w-full px-3 py-2.5 rounded-xl bg-secondary border border-base text-xs text-primary outline-none resize-none" />
                </div>
              )}
            </div>

            <div className="px-4 sm:px-5 py-3 border-t border-base bg-subtle flex flex-col sm:flex-row gap-2">
              {step === "count" && selectedAudit && (
                <>
                  <button onClick={() => setShowModal(false)} className="sm:w-auto px-4 py-2.5 rounded-xl bg-secondary border border-base text-[9px] font-black uppercase text-primary">Guardar y salir</button>
                  <button disabled={isBusy} onClick={submitCount} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-[9px] font-black uppercase tracking-wider flex items-center justify-center gap-2 disabled:opacity-50"><Lock className="w-3.5 h-3.5" />{isBusy ? "Enviando..." : "Enviar conteo a revisión"}</button>
                </>
              )}
              {step === "review" && selectedAudit && (
                <>
                  <button onClick={() => setShowModal(false)} className="sm:w-auto px-4 py-2.5 rounded-xl bg-secondary border border-base text-[9px] font-black uppercase text-primary">Cerrar</button>
                  {selectedAudit.reviewStatus === "pending_approval" && (
                    <>
                      <button disabled={isBusy} onClick={requestRecount} className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-[9px] font-black uppercase flex items-center justify-center gap-2 disabled:opacity-50"><RotateCcw className="w-3.5 h-3.5" />Solicitar recuento</button>
                      <button disabled={isBusy} onClick={approve} className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-[9px] font-black uppercase flex items-center justify-center gap-2 disabled:opacity-50"><CheckCircle2 className="w-3.5 h-3.5" />Aprobar y ajustar stock</button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
