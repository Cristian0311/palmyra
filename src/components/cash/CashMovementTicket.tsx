import React from "react";
import { Wallet } from "lucide-react";
import { cn } from "../../lib/utils";
import type { CashMovement } from "../../types";

type Props = {
  movement: CashMovement;
  workerName?: string;
  formatMoney: (amount: number, currencyCode?: string) => string;
  compact?: boolean;
};

export function CashMovementTicket({ movement, workerName, formatMoney, compact = false }: Props) {
  const isIncome = movement.type === "income";
  const ticketId = `MOV-${String(movement.id).slice(0, 8).toUpperCase()}`;

  return (
    <div className={cn(
      "bg-white rounded-xl border border-slate-200 shadow-sm",
      compact ? "p-2.5" : "p-3"
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-[9px] font-black text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-100">
              {ticketId}
            </span>
            <span className={cn(
              "text-[8px] font-black uppercase rounded-full px-1.5 py-0.5",
              isIncome ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
            )}>
              {isIncome ? "Ingreso" : "Egreso / gasto"}
            </span>
          </div>
          <p className="mt-1 text-[8px] font-bold text-slate-500">
            {new Date(movement.date).toLocaleString("es-CU")}
          </p>
        </div>

        <span className={cn(
          "shrink-0 font-mono text-xs font-black",
          isIncome ? "text-emerald-600" : "text-rose-600"
        )}>
          {isIncome ? "+" : "-"}{formatMoney(Math.abs(Number(movement.amount || 0)), movement.currencyCode)}
        </span>
      </div>

      <div className="mt-2 rounded-lg bg-slate-50 border border-slate-100 px-2.5 py-2">
        <p className="text-[8px] font-black uppercase tracking-wider text-slate-400">Concepto</p>
        <p className="text-[10px] font-bold text-slate-700 break-words">
          {movement.description || "Sin concepto registrado"}
        </p>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[8px] font-bold text-slate-400">
        <span>{movement.workerName || workerName || "Empleado"}</span>
        <span className="flex items-center gap-1"><Wallet className="w-3 h-3" /> Comprobante de movimiento</span>
      </div>
    </div>
  );
}
