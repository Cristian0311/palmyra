import { type ReactNode, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Search, Sparkles, X } from "lucide-react";

export function fmtDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-CU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function fmtDay(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-CU", { dateStyle: "medium" }).format(new Date(value));
}

export function fmtMoney(value?: number | null, currency = "USD") {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `${Number(value).toLocaleString("es-CU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

const STATUS_LABELS: Record<string, string> = {
  active: "Activa", suspended: "Suspendida", setup: "Configuración", pending_payment: "Pago pendiente",
  trialing: "Prueba", cancelled: "Cancelada", pending: "Pendiente", approved: "Aprobada",
  rejected: "Rechazada", open: "Abierta", in_progress: "En atención", resolved: "Resuelta",
  closed: "Cerrada", paid: "Pagada", void: "Anulada", past_due: "En gracia", expired: "Vencida",
  free: "Gratis", starter: "Starter", growth: "Growth", pro: "Pro", invited: "Invitado",
};

export function statusLabel(status?: string | null) {
  return STATUS_LABELS[String(status || "").toLowerCase()] || status || "Sin estado";
}

export function statusTone(status?: string | null): "green" | "amber" | "red" | "violet" | "slate" {
  const s = String(status || "").toLowerCase();
  if (["active", "paid", "approved", "resolved"].includes(s)) return "green";
  if (["suspended", "rejected"].includes(s)) return "red";
  if (["pending_payment", "pending", "open", "past_due", "in_progress", "expired"].includes(s)) return "amber";
  if (["setup", "invited", "trialing"].includes(s)) return "violet";
  return "slate";
}

const BADGE_TONES: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30",
  amber: "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30",
  red: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-500/30",
  violet: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/30",
  slate: "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-500/30",
};

export function Badge({ status, label }: { status?: string | null; label?: string }) {
  const tone = statusTone(status);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-wide ${BADGE_TONES[tone]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label || statusLabel(status)}
    </span>
  );
}

export function methodLabel(method?: string | null) {
  const map: Record<string, string> = {
    cup_cash: "Efectivo CUP", cup_bank_transfer: "Transferencia CUP", usd_cash: "Efectivo USD",
    manual_cash: "Efectivo (manual)", bank_transfer: "Transferencia", card: "Tarjeta",
    online: "En línea", paypal_abroad: "PayPal (exterior)",
  };
  return map[method || ""] || method || "Pago manual";
}

export function auditLabel(action?: string | null) {
  const map: Record<string, string> = {
    "plan_request.created": "Solicitud de plan creada",
    "plan_request.approved": "Solicitud aprobada",
    "plan_request.rejected": "Solicitud rechazada",
    "plan_request.cancelled": "Solicitud cancelada",
    "company.status_changed": "Estado de empresa cambiado",
    "company.plan_assigned": "Plan asignado manualmente",
    "subscription.created": "Suscripción creada",
    "subscription.updated": "Suscripción actualizada",
    "support.status_changed": "Estado de soporte cambiado",
  };
  return map[action || ""] || action || "Acción";
}

export function SectionCard({
  title, subtitle, icon, action, children, className = "",
}: { title: string; subtitle?: string; icon?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-3xl border border-base bg-secondary p-4 sm:p-5 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          {icon ? <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-subtle text-violet-600">{icon}</span> : null}
          <div>
            <h2 className="text-sm font-black text-primary">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[11px] leading-5 text-muted">{subtitle}</p> : null}
          </div>
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const KPI_TONES: Record<string, string> = {
  violet: "from-violet-500/10 to-transparent text-violet-600",
  green: "from-emerald-500/10 to-transparent text-emerald-600",
  amber: "from-amber-500/10 to-transparent text-amber-600",
  slate: "from-slate-500/10 to-transparent text-slate-500",
  red: "from-rose-500/10 to-transparent text-rose-600",
};

export function Kpi({ label, value, detail, icon, tone = "violet" }: {
  label: string; value: string | number; detail?: string; icon: ReactNode; tone?: keyof typeof KPI_TONES;
}) {
  return (
    <article className={`rounded-2xl border border-base bg-gradient-to-br ${KPI_TONES[tone]} bg-secondary p-3.5`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-black uppercase tracking-[.14em] text-muted">{label}</span>
        <span className="opacity-80">{icon}</span>
      </div>
      <p className="mt-2 text-xl font-black leading-tight text-primary sm:text-2xl">{value}</p>
      {detail ? <p className="mt-1 text-[10px] font-bold leading-4 text-muted">{detail}</p> : null}
    </article>
  );
}

export function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-base bg-primary/60 p-6 text-center">
      <Sparkles className="mx-auto h-5 w-5 text-violet-400" />
      <p className="mt-2 text-xs font-black text-primary">{title}</p>
      <p className="mt-1 text-[11px] leading-5 text-muted">{description}</p>
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="flex h-10 w-full min-w-0 items-center gap-2 rounded-xl border border-base bg-primary px-3">
      <Search className="h-4 w-4 shrink-0 text-muted" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent text-xs font-bold text-primary outline-none placeholder:text-muted/70" />
      {value ? <button type="button" onClick={() => onChange("")} aria-label="Limpiar búsqueda" className="text-muted hover:text-primary"><X className="h-3.5 w-3.5" /></button> : null}
    </label>
  );
}

export function FilterTabs<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto pb-1">
      {options.map(([option, label]) => (
        <button key={option} type="button" onClick={() => onChange(option)}
          className={`h-8 shrink-0 rounded-lg px-2.5 text-[10px] font-black transition ${value === option ? "bg-violet-600 text-white shadow-sm" : "bg-subtle text-muted hover:text-primary"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (page: number) => void }) {
  if (pages <= 1) return <p className="text-[10px] font-bold text-muted">{total} registro(s)</p>;
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-[10px] font-bold text-muted">Página {page} de {pages} · {total} registro(s)</p>
      <div className="flex gap-1.5">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-base disabled:opacity-40" aria-label="Página anterior"><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-base disabled:opacity-40" aria-label="Página siguiente"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

export function Modal({ title, description, onClose, children, footer, wide = false }: {
  title: string; description?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = previous; };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center bg-[#1B1030]/55 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={title} className={`flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-base bg-secondary shadow-2xl sm:rounded-3xl ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`}>
        <header className="flex items-start justify-between gap-3 border-b border-base px-4 py-3.5 sm:px-5">
          <div>
            <h2 className="text-sm font-black text-primary">{title}</h2>
            {description ? <p className="mt-0.5 text-[11px] leading-5 text-muted">{description}</p> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-base text-muted"><X className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer ? <footer className="flex flex-wrap justify-end gap-2 border-t border-base px-4 py-3 sm:px-5">{footer}</footer> : null}
      </section>
    </div>
  );
}

export function ConfirmDialog({ title, body, confirmLabel, tone = "primary", busy, onConfirm, onCancel }: {
  title: string; body: ReactNode; confirmLabel: string; tone?: "primary" | "danger"; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={() => { if (!busy) onCancel(); }} footer={
      <>
        <button type="button" disabled={busy} onClick={onCancel} className="h-10 rounded-xl border border-base px-4 text-xs font-black text-primary disabled:opacity-50">Cancelar</button>
        <button type="button" disabled={busy} onClick={onConfirm} className={`h-10 rounded-xl px-4 text-xs font-black text-white disabled:opacity-50 ${tone === "danger" ? "bg-rose-600" : "bg-violet-600"}`}>{busy ? "Procesando…" : confirmLabel}</button>
      </>
    }>
      <div className="text-xs leading-6 text-muted">{body}</div>
    </Modal>
  );
}

export function useDebounced<T>(value: T, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function pageSlice<T>(items: T[], page: number, size: number) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const safePage = Math.min(Math.max(1, page), pages);
  return { slice: items.slice((safePage - 1) * size, safePage * size), pages, page: safePage, total: items.length };
}
