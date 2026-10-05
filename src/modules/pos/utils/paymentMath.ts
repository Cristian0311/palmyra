import type { Currency } from '../../../types';

export const isCupLikeCurrency = (codeOrSymbol: string): boolean =>
  codeOrSymbol === 'CUP' || codeOrSymbol === 'MN' || codeOrSymbol === 'CUC' || codeOrSymbol === '₱';

export function getSafeRateToBase(code: string, baseCurrency: Currency, currencies: Currency[]): number {
  if (code === baseCurrency.code) return 1;
  const rate = Number(currencies.find((currency) => currency.code === code)?.rateToBase);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

export function toBaseAmount(
  amount: number,
  code: string,
  baseCurrency: Currency,
  currencies: Currency[]
): number {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value * getSafeRateToBase(code, baseCurrency, currencies);
}

export function roundBaseAmount(amount: number, isBaseCurrency: boolean): number {
  const value = Number(amount) || 0;
  return isBaseCurrency ? Math.round(value) : Math.round(value * 100) / 100;
}

export function formatMoney(amount: number, symbol: string): string {
  const decimals = isCupLikeCurrency(symbol) ? 0 : 2;
  const formatted = Number(amount || 0).toLocaleString('es-CU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  return symbol + ' ' + formatted;
}


export function createPaymentMath(baseCurrency: Currency, currencies: Currency[], isBaseCurrency: boolean) {
  return {
    getSafeRateToBase: (code: string) => getSafeRateToBase(code, baseCurrency, currencies),
    toBaseAmount: (amount: number, code: string) => toBaseAmount(amount, code, baseCurrency, currencies),
    roundBaseAmount: (amount: number) => roundBaseAmount(amount, isBaseCurrency)
  };
}
