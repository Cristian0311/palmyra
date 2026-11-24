import { createPortal } from "react-dom";
import { CalendarDays, EyeOff, Printer, Trash2, TrendingUp, X } from "lucide-react";
import { ticketDisplay } from "../../lib/documentCodes";
import type { Product, Transaction, User } from "../../types";

type Props = {
  transaction: Transaction | null;
  products: Product[];
  users: User[];
  branches: { id: string; name: string }[];
  getProductName: (product: unknown) => string;
  formatMoney: (amount: number, code?: string) => string;
  onClose: () => void;
  onPrintShiftTicket: (sessionId: string) => void;
  onVoidTransaction: (transaction: Transaction) => void | Promise<void>;
  onHideTransaction: (transaction: Transaction) => void | Promise<void>;
  onEditDate: (transaction: Transaction) => void;
};

export function ReportsTransactionDetailModal({
  transaction,
  products,
  users,
  branches,
  getProductName,
  formatMoney,
  onClose,
  onPrintShiftTicket,
  onVoidTransaction,
  onHideTransaction,
  onEditDate,
}: Props) {
  if (!transaction) return null;

  const getItemTotal = (item: Transaction["items"][number]) => {
    const storedTotal = item.total;
    if (typeof storedTotal === "number" && Number.isFinite(storedTotal)) {
      return storedTotal;
    }
    return (Number(item.quantity) || 0) * (Number(item.price) || 0);
  };
  const detailTotal = (transaction.items || []).reduce(
    (sum, item) => sum + getItemTotal(item),
    0
  );
  const detailDifference = Number(transaction.total) - detailTotal;
  const hasDetailMismatch = Math.abs(detailDifference) > 0.01;

  return createPortal((
    <div className="fixed inset-0 z-[99] flex items-center justify-center overflow-hidden bg-slate-950/70 p-2 backdrop-blur-sm sm:p-4">
      <div className="bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 border border-base my-auto text-primary">
        <div className="bg-rose-600 p-5 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-white/10 rounded-2xl backdrop-blur-md">
              <TrendingUp className="w-6 h-6 text-white" />
            </div>
            <div>
              <span className="text-[9px] font-black uppercase tracking-widest text-rose-200 block">
                Comprobante de Venta POS
              </span>
              <h3 className="max-w-[13rem] truncate text-base font-black uppercase tracking-tight text-white sm:max-w-[18rem]" title={`Ticket ${ticketDisplay(transaction.ticketNumber, transaction.id)}`}>
                Ticket {ticketDisplay(transaction.ticketNumber, transaction.id)}
              </h3>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-xl transition-all text-white/80 hover:text-white cursor-pointer"
            aria-label="Cerrar detalle"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
          <div className="grid grid-cols-2 gap-3 text-left">
            <div className="bg-subtle p-3 rounded-xl border border-base">
              <span className="text-[8px] font-black text-muted uppercase tracking-wider block mb-0.5">
                Cajero / Vendedor
              </span>
              <p
                className="truncate text-xs font-black uppercase text-primary"
                title={transaction.cashierName || users.find((user) => user.id === transaction.userId)?.name || "Vendedor"}
              >
                {transaction.cashierName ||
                  users.find((user) => user.id === transaction.userId)?.name ||
                  "Vendedor"}
              </p>
            </div>
            <div className="bg-subtle p-3 rounded-xl border border-base">
              <span className="text-[8px] font-black text-muted uppercase tracking-wider block mb-0.5">
                Sucursal / Fecha
              </span>
              <p className="text-xs font-black text-primary uppercase">
                {branches.find((branch) => branch.id === transaction.branchId)
                  ?.name || "Sucursal"}
              </p>
              <p className="text-[9px] font-bold text-muted">
                {new Date(transaction.date).toLocaleString("es-CU", { timeZone: 'America/Havana', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>

          <div className="border border-base rounded-2xl overflow-hidden">
            <div className="bg-subtle px-3.5 py-2 border-b border-base flex items-center justify-between">
              <span className="text-[9px] font-black text-muted uppercase tracking-wider">
                Productos del Ticket
              </span>
              <span className="text-[9px] font-black text-rose-600 bg-rose-50 dark:bg-rose-950/40 px-2 py-0.5 rounded-md border border-rose-100 dark:border-rose-900">
                {(transaction.items || []).reduce(
                  (sum, item) => sum + item.quantity,
                  0
                )}{" "}
                unidades
              </span>
            </div>

            <div className="divide-y divide-base max-h-56 overflow-y-auto">
              {(transaction.items || []).map((item, index) => {
                const productObject =
                  typeof item.product === "object" ? item.product : null;
                const product =
                  productObject ||
                  products.find(
                    (candidate) =>
                      candidate.id === (item.product as unknown as string)
                  );
                const name =
                  product?.name || getProductName(item.product);
                const price = item.price ?? product?.price ?? 0;
                const totalItem = getItemTotal(item);

                return (
                  <div
                    key={index}
                    className="p-3 flex items-center justify-between hover:bg-subtle/50 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-black uppercase text-primary" title={name}>
                        {name}
                      </p>
                      {item.variantLabel && (
                        <p className="text-[9px] font-bold text-muted uppercase">
                          Variante: {item.variantLabel}
                        </p>
                      )}
                      <p className="text-[9px] font-medium text-muted">
                        {item.quantity} x {formatMoney(price)}
                      </p>
                    </div>
                    <span className="ml-2 shrink-0 text-xs font-black text-primary">
                      {formatMoney(totalItem)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-subtle p-3 rounded-xl border border-base space-y-1">
            <span className="text-[8px] font-black text-muted uppercase tracking-wider block mb-1">
              Desglose de Pago
            </span>
            {(transaction.payments || []).map((payment, index) => (
              <div
                key={index}
                className="flex justify-between text-[9px] font-bold"
              >
                <span className="text-muted uppercase">
                  {payment.method === "cash" ? "Efectivo" : "Transferencia"} (
                  {payment.currencyCode}):
                </span>
                <span className="text-primary font-mono">
                  {formatMoney(payment.amount, payment.currencyCode)}
                </span>
              </div>
            ))}
            {(!transaction.payments || transaction.payments.length === 0) && (
              <div className="flex justify-between text-[9px] font-bold">
                <span className="text-muted">Total Venta:</span>
                <span className="text-primary font-mono">
                  {formatMoney(transaction.total)}
                </span>
              </div>
            )}
          </div>

          <div className="bg-subtle p-3 rounded-xl border border-base space-y-1">
            <div className="flex items-center justify-between gap-3 text-[10px] font-bold">
              <span className="text-muted uppercase">Suma del detalle</span>
              <span className="text-primary font-mono">{formatMoney(detailTotal)}</span>
            </div>
            {hasDetailMismatch && (
              <div
                role="alert"
                className="mt-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 text-[10px] text-amber-900 dark:text-amber-200"
              >
                <p className="font-black uppercase tracking-wide">Revisar diferencia de importes</p>
                <p className="mt-1">
                  {detailDifference > 0
                    ? "El total facturado supera la suma del detalle por " + formatMoney(detailDifference) + "."
                    : "La suma del detalle supera el total facturado por " + formatMoney(Math.abs(detailDifference)) + "."}
                  {" "}Se muestran los importes guardados; no se ajustan automáticamente los datos históricos.
                </p>
              </div>
            )}
          </div>

          <div className="p-4 bg-rose-50/50 dark:bg-rose-950/30 rounded-2xl border border-rose-100 dark:border-rose-900/40 flex items-center justify-between">
            <div>
              <span className="text-[8px] font-black uppercase tracking-widest text-rose-600 dark:text-rose-400 block">
                Total Facturado
              </span>
              <span className="text-xs font-bold text-muted">
                {(transaction.items || []).length} producto{(transaction.items || []).length === 1 ? "" : "s"} diferente{(transaction.items || []).length === 1 ? "" : "s"}
              </span>
            </div>
            <span className="text-lg font-black text-rose-700 dark:text-rose-300">
              {formatMoney(transaction.total)}
            </span>
          </div>

        </div>

        <div className="space-y-2 border-t border-base bg-secondary p-4">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  if (transaction.sessionId) onPrintShiftTicket(transaction.sessionId);
                }}
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-3 font-black uppercase tracking-wider text-white shadow-md transition-all hover:bg-rose-700"
                style={{ fontSize: 11 }}
              >
                <Printer className="h-4 w-4" aria-hidden="true" /> Imprimir
              </button>
              <button
                type="button"
                onClick={() => onEditDate(transaction)}
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 font-black uppercase tracking-wider text-amber-700 transition-all hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300"
                style={{ fontSize: 11 }}
                title="Cambiar la fecha de esta venta y del turno asociado"
              >
                <CalendarDays className="h-4 w-4" aria-hidden="true" /> Editar fecha
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void onHideTransaction(transaction)}
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-amber-200 bg-secondary px-3 font-black uppercase tracking-wider text-amber-700 transition-colors hover:bg-amber-50 dark:border-amber-900/60 dark:text-amber-300 dark:hover:bg-amber-950/30"
                style={{ fontSize: 11 }}
                title="Quitar esta venta de la lista de reportes sin borrarla ni tocar el inventario"
              >
                <EyeOff className="h-4 w-4" aria-hidden="true" /> Ocultar venta
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-base bg-subtle px-3 font-black uppercase tracking-wider text-primary transition-colors hover:bg-slate-200 dark:hover:bg-slate-800"
                style={{ fontSize: 11 }}
              >
                Cerrar
              </button>
            </div>
            <button
              type="button"
              onClick={() => void onVoidTransaction(transaction)}
              className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-3 font-black uppercase tracking-wider text-white shadow-md transition-all hover:bg-rose-700"
              style={{ fontSize: 11 }}
              title="Eliminar la venta, sus registros y devolver los productos al almacén de origen"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" /> Eliminar venta
            </button>
            <p className="text-center text-[11px] font-semibold leading-snug text-muted">
              Eliminar devuelve los productos vendidos a su almacén y quita la venta de los reportes. Ocultar solo la esconde.
            </p>
        </div>
      </div>
    </div>
  ), document.body);
}
