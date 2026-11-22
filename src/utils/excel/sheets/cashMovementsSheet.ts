import type { ExcelExportData } from "../types";

export function generateCashMovementsSheet(data: ExcelExportData): any[][] {
  const { cashSessions = [], branches = [], currencies = [], baseCurrency } = data;
  const baseCode = baseCurrency?.code || 'CUP';
  const branchById = new Map(branches.map(branch => [branch.id, branch]));
  const rateByCode = new Map<string, number>(currencies.map(currency => [currency.code, Number(currency.rateToBase) || 1]));

  const rows: any[][] = [
    [
      'ID Movimiento',
      'Fecha y Hora',
      'Turno',
      'Sucursal / Almacén',
      'Cajero Responsable',
      'Tipo de Operación',
      'Concepto / Descripción',
      'Importe Original',
      'Moneda',
      `Equivalente Base (${baseCode})`,
      'Estado del Turno',
    ],
  ];

  for (const session of cashSessions) {
    const branchName = branchById.get(session.branchId)?.name || 'Sucursal';
    const workerName = session.workerName || 'Cajero';
    const turnLabel = session.turnNumber ? `#${session.turnNumber}` : session.id;

    for (const movement of session.movements || []) {
      const date = movement.date ? new Date(movement.date) : null;
      const amount = Number(movement.amount) || 0;
      const rate = rateByCode.get(movement.currencyCode) || 1;
      const equivalent = amount * rate;

      rows.push([
        movement.id,
        date && !Number.isNaN(date.getTime()) ? date : null,
        turnLabel,
        branchName,
        movement.workerName || workerName,
        movement.type === 'income' ? 'INGRESO (ENTRADA)' : 'EGRESO (GASTO)',
        movement.description || (movement.category ? `Movimiento de ${movement.category}` : 'Sin descripción'),
        Number(amount.toFixed(2)),
        movement.currencyCode || baseCode,
        Number(equivalent.toFixed(2)),
        session.status === 'cancelled' ? 'Turno Cancelado' : session.status === 'closed' ? 'Turno Cerrado' : 'Turno Abierto',
      ]);
    }
  }

  return rows;
}
