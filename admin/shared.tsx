import type { ReactNode } from "react";
import { BarChart3, Sparkles } from "lucide-react";

export function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-CU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function statusLabel(status?: string | null) {
  const map: Record<string, string> = {
    active: "Activa",
    suspended: "Suspendida",
    setup: "Configuración",
    pending_payment: "Pago pendiente",
    trialing: "Prueba",
    cancelled: "Cancelada",
  };
  return map[status || ""] || status || "Sin estado";
}

export function isToday(value?: string | null) {
  if (!value) return false;
  const d = new Date(value);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export function Button({
  children,
  variant = "secondary",
  onClick,
  disabled,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`admin-btn admin-btn--${variant} ${className}`}
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
    normalized === "active" ? "green" :
    normalized === "suspended" ? "red" :
    normalized === "pending_payment" ? "amber" :
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
