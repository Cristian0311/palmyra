import type { CashRegisterSession, Currency, Product, ReceiptConfig, Transaction, User } from "../../types";

type Props = {
  session: CashRegisterSession | null;
  transactions: Transaction[];
  products: Product[];
  users: User[];
  currentUser: User | null;
  branches: { id: string; name: string }[];
  receiptConfig: ReceiptConfig;
  baseCurrency: Currency;
  formatMoney: (amount: number, symbol?: string) => string;
  formatSalaryCUP: (value: number) => string;
};

export function POSClosurePrintArea({
  session,
  transactions,
  products,
  users,
  currentUser,
  branches,
  receiptConfig,
  baseCurrency,
  formatMoney,
  formatSalaryCUP,
}: Props) {
  if (!session) return null;

  const sessionTransactions = transactions.filter(
    (transaction) =>
      transaction.sessionId === session.id && !transaction.deletedAt
  );

  const soldMap: Record<string, { name: string; qty: number; total: number }> = {};
  sessionTransactions.forEach((transaction) => {
    (transaction.items || []).forEach((item) => {
      const name =
        typeof item.product === "string"
          ? item.product
          : item.product?.name || "Producto";

      if (!soldMap[name]) {
        soldMap[name] = { name, qty: 0, total: 0 };
      }

      const price =
        typeof item.product === "object" ? item.product?.price || 0 : 0;
      soldMap[name].qty += item.quantity;
      soldMap[name].total += price * item.quantity;
    });
  });

  const soldList = Object.values(soldMap);
  const totalSales = sessionTransactions.reduce(
    (sum, transaction) => sum + transaction.total,
    0
  );

  const commissions = sessionTransactions.reduce(
    (sum, transaction) =>
      sum +
      (transaction.items || []).reduce((itemSum, item) => {
        const productId =
          typeof item.product === "string"
            ? item.product
            : item.product?.id;
        const product = products.find((candidate) => candidate.id === productId);
        return itemSum + (product?.commissionValue || 0) * item.quantity;
      }, 0),
    0
  );

  const employee =
    users.find(
      (user) =>
        user.id === session.userId || user.name === session.workerName
    ) ||
    users.find(
      (user) =>
        user.name?.toLowerCase() === session.workerName?.toLowerCase()
    ) ||
    users.find((user) => user.role === "employee") ||
    currentUser;

  const baseSalary = employee?.baseSalary || 0;
  const totalSalary = baseSalary + commissions;

  return (
    <div
      id="print-closure-area"
      className="hidden font-mono text-[11px] leading-tight text-black bg-white p-2"
    >
      <div className="space-y-1">
        <div className="text-center font-black text-sm uppercase">
          {receiptConfig.businessName || "PALMYRA POS"}
        </div>
        {receiptConfig.showAddress && receiptConfig.businessAddress && (
          <div className="text-center text-[9px]">
            {receiptConfig.businessAddress}
          </div>
        )}
        {receiptConfig.showPhone && receiptConfig.businessPhone && (
          <div className="text-center text-[9px]">
            {receiptConfig.businessPhone}
          </div>
        )}
        <div className="border-t border-dashed border-black my-2" />
        <div className="text-center font-black uppercase text-xs">
          CIERRE DE CAJA / LIQUIDACIÓN
        </div>

        <div className="flex justify-between text-[10px]">
          <span>TURNO:</span>
          <span className="font-bold">{session.id}</span>
        </div>
        <div className="flex justify-between text-[10px]">
          <span>FECHA:</span>
          <span>
            {new Date(
              session.closingDate || session.closedAt || new Date()
            ).toLocaleString()}
          </span>
        </div>
        <div className="flex justify-between text-[10px]">
          <span>EMPLEADO:</span>
          <span className="font-bold uppercase">
            {session.workerName || "EMPLEADO"}
          </span>
        </div>
        <div className="flex justify-between text-[10px]">
          <span>SUCURSAL:</span>
          <span>
            {branches.find((branch) => branch.id === session.branchId)?.name ||
              "Central"}
          </span>
        </div>

        <div className="border-t border-dashed border-black my-2" />
        <div className="font-bold text-[10px] uppercase">
          PRODUCTOS VENDIDOS ({soldList.reduce((sum, item) => sum + item.qty, 0)}):
        </div>

        {soldList.length === 0 ? (
          <div className="text-[10px] italic">
            Sin ventas registradas en el turno
          </div>
        ) : (
          soldList.map((item, index) => (
            <div key={index} className="flex justify-between text-[10px]">
              <span className="truncate max-w-[170px]">
                {item.qty}x {item.name || "Producto"}
              </span>
              <span className="font-bold">
                {formatMoney(item.total, baseCurrency.symbol)}
              </span>
            </div>
          ))
        )}

        <div className="border-t border-dashed border-black my-2" />
        <div className="flex justify-between font-black text-xs">
          <span>VENTA TOTAL:</span>
          <span>{formatMoney(totalSales, baseCurrency.symbol)}</span>
        </div>

        <div className="border-t border-dashed border-black my-2" />
        <div className="font-bold text-[10px] uppercase">
          ARQUEO DE FONDOS:
        </div>
        <div className="flex justify-between text-[10px]">
          <span>Fondo Inicial:</span>
          <span>
            {formatMoney(session.openingBalance, baseCurrency.symbol)}
          </span>
        </div>

        <div className="border-t border-dashed border-black my-2" />
        <div className="font-bold text-[10px] uppercase">
          LIQUIDACIÓN DE SALARIO:
        </div>
        <div className="flex justify-between text-[10px]">
          <span>Salario Base:</span>
          <span>{formatMoney(baseSalary, baseCurrency.symbol)}</span>
        </div>
        <div className="flex justify-between text-[10px]">
          <span>Comisiones Productos:</span>
          <span>+{formatMoney(commissions, baseCurrency.symbol)}</span>
        </div>
        <div className="flex justify-between font-black text-xs pt-1 border-t border-dotted border-black">
          <span>SALARIO A PAGAR:</span>
          <span>{formatSalaryCUP(totalSalary)}</span>
        </div>

        <div className="border-t border-dashed border-black my-4" />
        <div className="pt-6 text-center text-[9px] border-t border-black">
          Firma del Empleado
        </div>
        <div className="pt-6 text-center text-[9px] border-t border-black">
          Firma Supervisor / Administrador
        </div>
      </div>
    </div>
  );
}
