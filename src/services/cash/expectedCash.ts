import type { CashRegisterSession, Currency, Transaction } from '../../types';
import {
  calculateExpectedCashBaseTotal,
  calculateExpectedSessionBalances,
  hasRealDifference,
  round6,
} from '../../modules/pos/utils/cashMath';

export { hasRealDifference, round6 } from '../../modules/pos/utils/cashMath';

export type ExpectedBalance = {
  currencyCode: string;
  method: 'cash' | 'transfer';
  amount: number;
};

export type ExpectedDiscrepancyDetail = {
  currencyCode: string;
  method: 'cash' | 'transfer';
  expected: number;
  actual: number;
  difference: number;
};

/**
 * Esperado por moneda y medio de pago de un turno. Delega en la fuente única
 * de verdad (modules/pos/utils/cashMath) para que el arqueo del POS, el cierre
 * y Reportes vean exactamente los mismos números.
 */
export function calculateExpectedBalances(
  session: CashRegisterSession,
  transactions: Transaction[],
  baseCurrency: Currency
): ExpectedBalance[] {
  return calculateExpectedSessionBalances(session, transactions, session.branchId, baseCurrency, [])
    .map(row => ({
      currencyCode: String(row.currencyCode),
      method: row.method as 'cash' | 'transfer',
      amount: round6(Number(row.amount)),
    }));
}

/**
 * Esperado en efectivo convertido a moneda base: fondo + pagos cash − vuelto +
 * movimientos de ingreso/egreso, excluyendo ventas borradas, no completadas y
 * AJUSTE_*. Mismo cálculo que usa el arqueo del POS y que se envía al RPC de
 * cierre; cualquier divergencia entre ambos la rechaza el servidor con
 * cash_difference_mismatch.
 */
export function calculateExpectedCashBase(
  session: CashRegisterSession,
  transactions: Transaction[],
  currencies: Currency[]
): number {
  const baseCurrency =
    currencies.find(currency => currency.isBase) ??
    currencies[0] ??
    ({ code: 'CUP', name: 'Peso cubano', symbol: '$', rateToBase: 1, isBase: true } as Currency);
  return calculateExpectedCashBaseTotal(session, transactions, baseCurrency, currencies);
}

/**
 * Tasa con la que se valora un faltante/sobrante histórico: la registrada en
 * closingBalances al cerrar la caja; si no existe, la tasa vigente de la
 * moneda; si no, 1. La deducción salarial del POS y Reportes usan la misma.
 */
export function resolveCloseRate(
  currencyCode: string,
  closingBalances: { currencyCode: string; exchangeRate?: number }[] | undefined,
  currencies: Currency[],
): number {
  const recorded = Number(
    (closingBalances || []).find(
      balance => balance.currencyCode === currencyCode && Number(balance.exchangeRate) > 0,
    )?.exchangeRate,
  );
  if (Number.isFinite(recorded) && recorded > 0) return recorded;
  const rate = Number(currencies.find(currency => currency.code === currencyCode)?.rateToBase);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

/**
 * Descuadres por moneda/medio comparando lo declarado con el esperado. Toda
 * diferencia real cuenta (0.00 solo si es exactamente cero), y las diferencias
 * se redondean igual que el esperado para que POS y Reportes coincidan.
 */
export function buildDiscrepancyDetails(
  expected: { currencyCode: string; method: string; amount: number }[],
  closingBalances: { currencyCode: string; method: string; amount: number }[] | undefined,
): ExpectedDiscrepancyDetail[] {
  const declared = closingBalances || [];
  const details: ExpectedDiscrepancyDetail[] = [];

  expected.forEach(row => {
    const actual = Number(
      declared.find(balance => balance.currencyCode === row.currencyCode && balance.method === row.method)?.amount,
    ) || 0;
    const difference = round6(actual - Number(row.amount));
    if (hasRealDifference(difference)) {
      details.push({
        currencyCode: row.currencyCode,
        method: row.method as 'cash' | 'transfer',
        expected: round6(Number(row.amount)),
        actual,
        difference,
      });
    }
  });

  declared.forEach(balance => {
    if (Number(balance.amount) <= 0) return;
    const alreadyExpected = expected.some(
      row => row.currencyCode === balance.currencyCode && row.method === balance.method,
    );
    if (!alreadyExpected) {
      details.push({
        currencyCode: balance.currencyCode,
        method: balance.method as 'cash' | 'transfer',
        expected: 0,
        actual: Number(balance.amount),
        difference: round6(Number(balance.amount)),
      });
    }
  });

  return details;
}

/** Faltante total en moneda base valorado con la tasa del cierre (deducción salarial). */
export function shortageBaseAtClose(
  details: { currencyCode: string; difference: number }[],
  closingBalances: { currencyCode: string; exchangeRate?: number }[] | undefined,
  currencies: Currency[],
): number {
  return round6(
    details.reduce(
      (sum, detail) =>
        detail.difference < 0
          ? sum + Math.abs(detail.difference) * resolveCloseRate(detail.currencyCode, closingBalances, currencies)
          : sum,
      0,
    ),
  );
}

/**
 * Turno donde registrar el egreso de un reembolso en efectivo fuera de turno:
 * el turno abierto de la caja o, si no lo hay, el turno aún abierto de la
 * venta original. undefined si no hay ningún turno abierto (solo se avisa).
 */
export function resolveRefundTargetSession<
  T extends { id: string; status: string; deletedAt?: string | null },
>(openCashSession: T | undefined, ticketSessionId: string | undefined, cashSessions: T[] | undefined): T | undefined {
  if (openCashSession) return openCashSession;
  if (!ticketSessionId) return undefined;
  return (cashSessions || []).find(
    session => session.id === ticketSessionId && session.status === 'open' && !session.deletedAt,
  );
}

/**
 * Idempotencia del egreso de reembolso: ya está registrado si existe un
 * movimiento con el mismo id (el RPC palmyra_record_cash_movement es
 * idempotente por movement_id) o con categoría devolucion y la misma
 * referencia de la devolución.
 */
export function hasRefundMovement(
  targetSession: { movements?: { id: string; category?: string; description?: string }[] } | undefined,
  movementId: string,
  returnCode: string,
): boolean {
  return (targetSession?.movements || []).some(
    movement =>
      movement.id === movementId ||
      (movement.category === 'devolucion' && (movement.description || '').includes(returnCode)),
  );
}
