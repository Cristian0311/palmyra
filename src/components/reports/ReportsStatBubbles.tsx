import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

export type ReportsStatTone = "violet" | "red" | "emerald" | "amber" | "blue" | "slate";

export type ReportsStat = {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tone?: ReportsStatTone;
  /** Overrides the value line style, e.g. to wrap a long name instead of truncating it. */
  valueClassName?: string;
};

/** Un acento único por tarjeta: color del borde izquierdo y tinte del ícono. */
const TONE: Record<ReportsStatTone, { border: string; icon: string }> = {
  violet: { border: "border-l-[var(--primary)]", icon: "bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-[var(--primary)]" },
  red: { border: "border-l-[var(--danger)]", icon: "bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)]" },
  emerald: { border: "border-l-[var(--success)]", icon: "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]" },
  amber: { border: "border-l-[var(--warning)]", icon: "bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--warning)]" },
  blue: { border: "border-l-[var(--info)]", icon: "bg-[color-mix(in_srgb,var(--info)_12%,transparent)] text-[var(--info)]" },
  slate: { border: "border-l-[var(--border-accent)]", icon: "bg-[var(--bg-subtle)] text-[var(--text-muted)]" },
};

/** One KPI bubble style for every Reports tab, so the section keeps a single visual line. */
export function ReportsStatBubbles({ items }: { items: ReportsStat[] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      {items.map(({ label, value, hint, icon: Icon, tone = "violet", valueClassName }) => (
        <div key={label} className={cn("border-l-[3px] rounded-[var(--radius-2xl)] border border-base bg-secondary p-3 shadow-[var(--shadow-md)]", TONE[tone].border)}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="line-clamp-2 text-[11px] font-black uppercase leading-tight tracking-widest text-muted" title={label}>
                {label}
              </p>
              <p className={cn("mt-1 text-lg font-black leading-tight text-primary sm:text-xl", valueClassName ?? "truncate")} title={value}>
                {value}
              </p>
            </div>
            <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", TONE[tone].icon)}>
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          {hint ? (
            <p className="mt-1.5 line-clamp-2 text-[11px] font-bold leading-tight text-muted" title={hint}>
              {hint}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
