import { useEffect, type ReactNode } from "react";
import { BarChart3, Sparkles, X } from "lucide-react";

export function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-CU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatDay(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-CU", { dateStyle: "medium" }).format(new Date(value));
}

export function formatMoney(value?: number | null, currency = "USD") {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `${Number(value).toLocaleString("es-CU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function statusLabel(status?: string | null) {
  const map: Record<string, string> = {
    active: "Activa",
    suspended: "Suspendida",
    setup: "Configuración",
    pending_payment: "Pago pendiente",
    trialing: "Prueba",
    cancelled: "Cancelada",
    pending: "Pendiente",
    approved: "Aprobada",
    rejected: "Rechazada",
    open: "Abierta",
    in_progress: "En atención",
    resolved: "Resuelta",
    closed: "Cerrada",
    paid: "Pagada",
    void: "Anulada",
    past_due: "En gracia",
    expired: "Vencida",
    free: "Gratis",
    starter: "Starter",
    growth: "Growth",
    pro: "Pro",
  };
  return map[status || ""] || status || "Sin estado";
}

export function methodLabel(method?: string | null) {
  const map: Record<string, string> = {
    cup_cash: "Efectivo CUP",
    cup_bank_transfer: "Transferencia CUP",
    usd_cash: "Efectivo USD",
    manual_cash: "Efectivo (manual)",
    bank_transfer: "Transferencia",
    card: "Tarjeta",
    online: "En línea",
    paypal_abroad: "PayPal (exterior)",
  };
  return map[method || ""] || method || "Pago manual";
}

export function isToday(value?: string | null) {
  if (!value) return false;
  const d = new Date(value);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export function daysUntil(value?: string | null) {
  if (!value) return null;
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return null;
  return Math.ceil((target - Date.now()) / 86400000);
}

export const FEATURE_LABELS: Record<string, string> = {
  pos: "Punto de venta",
  cash: "Caja",
  inventory: "Inventario",
  offline: "Modo offline",
  basic_reports: "Reportes básicos",
  cloud_backup: "Respaldo en la nube",
  custom_roles: "Roles personalizados",
  transfers: "Transferencias",
  purchases: "Compras",
  inventory_audit: "Auditoría de inventario",
  advanced_reports: "Reportes avanzados",
  banking: "Bancos",
  multi_warehouse: "Multi-almacén",
  advanced_analytics: "Analítica avanzada",
  customers_suppliers: "Clientes y proveedores",
  visual_style: "Estilo visual",
  excel_exports: "Exportar a Excel",
  ai_dashboard: "Dashboard IA",
  warranty_returns: "Devoluciones y garantías",
  abc_analysis: "Análisis ABC",
  labels: "Etiquetas",
  payroll: "Nómina",
};

export const ACTION_LABELS: Record<string, string> = {
  "plan_request.created": "Solicitud creada",
  "plan_request.approved": "Plan aprobado",
  "plan_request.rejected": "Solicitud rechazada",
  "plan_request.cancelled": "Solicitud cancelada",
  "company.status_changed": "Cambio de estado",
  "company.plan_assigned": "Plan asignado manualmente",
  "company.profile_updated": "Datos de la empresa",
  "company.note_updated": "Nota interna",
  "company.subscription_dates_updated": "Fechas de suscripción",
  "subscription.created": "Suscripción creada",
  "subscription.updated": "Suscripción actualizada",
  "support.status_changed": "Soporte actualizado",
};

export const DETAIL_LABELS: Record<string, string> = {
  from: "antes",
  to: "después",
  plan_code: "plan",
  plan_id: "plan",
  months: "meses",
  billing_months: "meses",
  quoted_amount: "cotizado",
  note: "nota",
  subject: "asunto",
  status: "estado",
  trial_ends_at: "fin de prueba",
  current_period_end: "vence",
  grace_ends_at: "fin de gracia",
  name: "nombre",
  slug: "identificador",
  currency: "moneda",
  length: "caracteres",
  active: "activa",
  period_end: "vence",
  from_plan: "plan anterior",
  to_plan: "plan nuevo",
  from_status: "estado anterior",
  to_status: "estado nuevo",
};

export function auditDetailText(detail?: Record<string, unknown> | null) {
  if (!detail) return "";
  return Object.entries(detail)
    .filter(([, value]) => value != null && value !== "" && typeof value !== "object")
    .slice(0, 6)
    .map(([key, value]) => `${DETAIL_LABELS[key] || key}: ${String(value)}`)
    .join(" · ");
}

export function downloadCsv(filename: string, rows: Array<Array<string | number | boolean | null | undefined>>) {
  if (!rows.length) return;
  const escape = (cell: string | number | boolean | null | undefined) => {
    const value = cell == null ? "" : String(cell);
    return /[",\r\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  const body = rows.map((row) => row.map(escape).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${body}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function LoadingBlock({ label = "Cargando…" }: { label?: string }) {
  return (
    <div className="admin-loading" role="status" aria-live="polite">
      <span className="admin-loading__bar" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Button({
  children,
  variant = "secondary",
  onClick,
  disabled,
  className = "",
  type = "button",
  ariaLabel,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
  ariaLabel?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`admin-btn admin-btn--${variant} ${className}`}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

export function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "violet",
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof BarChart3;
  tone?: "violet" | "green" | "amber" | "slate";
}) {
  return (
    <article className={`admin-stat admin-stat--${tone}`}>
      <div className="admin-stat__top">
        <span>{label}</span>
        <span className="admin-icon-box"><Icon size={15} strokeWidth={2.2} /></span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export function StatusBadge({ status }: { status?: string | null }) {
  const normalized = String(status || "").toLowerCase();
  const tone =
    normalized === "active" || normalized === "paid" || normalized === "approved" || normalized === "resolved" ? "green" :
    normalized === "suspended" || normalized === "rejected" ? "red" :
    normalized === "pending_payment" || normalized === "pending" || normalized === "open" || normalized === "past_due" || normalized === "in_progress" ? "amber" :
    "slate";
  return <span className={`admin-status admin-status--${tone}`}><span />{statusLabel(status)}</span>;
}

export function EmptyPanel({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="admin-empty">
      <div className="admin-empty__icon"><Sparkles size={18} /></div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function FileTextIcon(){return <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M6 2h9l3 3v17H6V2Zm8 1.5V6h3.5L14 3.5ZM8 8h8V6.5H8V8Zm0 4h8v-1.5H8V12Zm0 4h6v-1.5H8V16Z"/></svg>}

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`admin-modal ${wide ? "admin-modal--wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="admin-modal__head">
          <div>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button type="button" className="admin-modal__close" onClick={onClose} aria-label="Cerrar">
            <X size={16} />
          </button>
        </header>
        <div className="admin-modal__body">{children}</div>
        {footer ? <footer className="admin-modal__foot">{footer}</footer> : null}
      </section>
    </div>
  );
}
