import { Printer, Trash2, TrendingUp, X } from "lucide-react";
import { cn } from "../../lib/utils";
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
}: Props) {
  if (!transaction) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
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
              <h3 className="text-base font-black text-white uppercase tracking-tight">
                Ticket #{transaction.id}
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
              <p className="text-xs font-black text-primary uppercase">
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
                {new Date(transaction.date).toLocaleString("es-CU")}
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
                const totalItem = (item.quantity || 0) * price;

                return (
                  <div
                    key={index}
                    className="p-3 flex items-center justify-between hover:bg-subtle/50 transition-colors"
                  >
                    <div>
                      <p className="text-xs font-black text-primary uppercase">
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
                    <span className="text-xs font-black text-primary">
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

          <div className="p-4 bg-rose-50/50 dark:bg-rose-950/30 rounded-2xl border border-rose-100 dark:border-rose-900/40 flex items-center justify-between">
            <div>
              <span className="text-[8px] font-black uppercase tracking-widest text-rose-600 dark:text-rose-400 block">
                Total Facturado
              </span>
              <span className="text-xs font-bold text-muted">
                {(transaction.items || []).length} productos diferentes
              </span>
            </div>
            <span className="text-lg font-black text-rose-700 dark:text-rose-300">
              {formatMoney(transaction.total)}
            </span>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={() => {
                if (transaction.sessionId) {
                  onPrintShiftTicket(transaction.sessionId);
                }
              }}
              className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer shadow-md"
            >
              <Printer className="w-4 h-4" />
              Imprimir
            </button>
            <button
              onClick={() => void onVoidTransaction(transaction)}
              className={cn(
                "px-3 py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-xl text-xs font-black uppercase tracking-wider transition-all cursor-pointer border border-rose-200"
              )}
              title="Anular este Ticket"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2.5 bg-subtle hover:bg-slate-200 dark:hover:bg-slate-800 text-primary rounded-xl text-xs font-black uppercase tracking-wider transition-all cursor-pointer border border-base"
            >
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
