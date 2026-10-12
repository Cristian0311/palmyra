type ModalProps = Record<string, any>;

export default function ReportsPrintableSession(props: ModalProps) {
  const { String, formatMoney, getProductName, printBranch, printPayrollItem, printSession, products, sessionTurnMap, transactions, users } = props;
  return (
    <>
      {printSession && (
        <div id="print-closure-area" className="hidden">
          {(() => {
            const sessionTx = transactions.filter(t =>
              t.branchId === printSession.branchId &&
              t.sessionId === printSession.id &&
              t.status === 'completed' &&
              !t.deletedAt &&
              !String(t.notes || '').startsWith('AJUSTE_')
            );
            const totalSales = sessionTx.reduce((sum, tx) => sum + Math.max(0, Number(tx.total) || 0), 0);
            const totalItems = sessionTx.reduce((sum, tx) => sum + (tx.items || []).reduce((s, i) => s + (i.quantity || 0), 0), 0);
            const workerName = printSession.workerName || users.find(u => u.id === printSession.userId)?.name || 'Vendedor';
            const sequentialTurn = sessionTurnMap.get(printSession.id) || printSession.id;

            return (
              <>
                <div className="text-center mb-3">
                  <h1 className="text-base font-black uppercase tracking-wider">PALMYRA</h1>
                  <p className="text-[10px] uppercase font-bold">{printBranch?.name || 'Sucursal Principal'}</p>
                  <p className="text-[9px] mt-1 font-bold">COMPROBANTE DE CIERRE DE TURNO</p>
                  <div className="border-b-2 border-black my-2"></div>
                </div>

                <div className="text-[10px] space-y-1 mb-2 font-mono">
                  <div className="flex justify-between">
                    <span>FECHA CIERRE:</span>
                    <span className="font-bold">{new Date(printSession.closingDate || printSession.closedAt || printSession.openedAt).toLocaleDateString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>HORA CIERRE:</span>
                    <span className="font-bold">{new Date(printSession.closingDate || printSession.closedAt || printSession.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>TURNO:</span>
                    <span className="font-bold">{sequentialTurn}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>TRABAJADOR:</span>
                    <span className="font-bold">{workerName}</span>
                  </div>
                </div>

                <div className="border-b border-black border-dashed my-2"></div>
                <div className="text-[9px] font-black uppercase mb-1">DETALLE DE PRODUCTOS VENDIDOS</div>
                <div className="text-[9px] space-y-1 font-mono">
                  {(() => {
                    const grouped: {[key: string]: {name: string, quantity: number, total: number}} = {};
                    sessionTx.forEach(tx => {
                      (tx.items || []).forEach(item => {
                        const prodObj = typeof item.product === 'object' ? item.product : products.find(p => p.id === (item.product as unknown as string));
                        const name = prodObj?.name || getProductName(item.product);
                        if (!grouped[name]) grouped[name] = { name, quantity: 0, total: 0 };
                        grouped[name].quantity += (item.quantity || 0);
                        const price = Number((item as any)?.price ?? prodObj?.price ?? 0);
                        grouped[name].total += Math.max(0, price) * Math.max(0, Number(item.quantity) || 0);
                      });
                    });

                    return Object.values(grouped).map((item, idx) => (
                      <div key={idx} className="flex justify-between">
                        <span>{item.quantity}x {item.name.slice(0, 18)}</span>
                        <span>{formatMoney(item.total)}</span>
                      </div>
                    ));
                  })()}
                </div>

                <div className="border-b border-black border-dashed my-2"></div>
                <div className="text-[10px] font-mono space-y-1">
                  <div className="flex justify-between font-bold">
                    <span>TOTAL VENTAS:</span>
                    <span>{formatMoney(totalSales)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>ITEMS VENDIDOS:</span>
                    <span>{totalItems}</span>
                  </div>
                </div>

                {printPayrollItem && (
                  <>
                    <div className="border-b-2 border-black my-2"></div>
                    <div className="text-[9px] font-black uppercase mb-1">LIQUIDACIÓN DE SALARIO</div>
                    <div className="text-[10px] font-mono space-y-1">
                      <div className="flex justify-between">
                        <span>Salario Base:</span>
                        <span>{formatMoney(printPayrollItem.baseSalary)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Comisiones Productos:</span>
                        <span>+{formatMoney(printPayrollItem.commissions)}</span>
                      </div>
                      <div className="flex justify-between font-black text-xs border-t border-black pt-1">
                        <span>TOTAL SALARIO:</span>
                        <span>{formatMoney(printPayrollItem.totalSalary)}</span>
                      </div>
                      <div className="flex justify-between text-[9px] mt-0.5">
                        <span>Estado:</span>
                        <span className="font-bold uppercase">{printPayrollItem.status === 'paid' ? 'PAGADO' : 'PENDIENTE'}</span>
                      </div>
                    </div>
                  </>
                )}
              </>
            );
          })()}

          <div className="mt-8 pt-6 border-t border-black border-dashed text-center text-[9px]">
            <p className="mb-6">Firma del Trabajador: ______________________</p>
            <p>Firma del Supervisor: ______________________</p>
            <p className="mt-4 font-mono text-[8px]">PALMYRA SISTEMA DE PUNTO DE VENTA</p>
          </div>
        </div>
      )}
    </>
  );
}
