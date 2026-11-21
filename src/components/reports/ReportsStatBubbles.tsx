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

const TONE: Record<ReportsStatTone, string> = {
  violet: "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  red: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300",
  emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  slate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

/** One KPI bubble style for every Reports tab, so the section keeps a single visual line. */
export function ReportsStatBubbles({ items }: { items: ReportsStat[] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      {items.map(({ label, value, hint, icon: Icon, tone = "violet", valueClassName }) => (
        <div key={label} className="rounded-2xl border border-base bg-secondary p-3 shadow-xs">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="line-clamp-2 text-[11px] font-black uppercase leading-tight tracking-widest text-muted" title={label}>
                {label}
              </p>
              <p className={cn("mt-1 text-lg font-black leading-tight text-primary sm:text-xl", valueClassName ?? "truncate")} title={value}>
                {value}
              </p>
            </div>
            <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", TONE[tone])}>
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
