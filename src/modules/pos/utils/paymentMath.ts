import type { Currency } from '../../../types';

export const isCupLikeCurrency = (code: string): boolean =>
  code === 'CUP' || code === 'MN' || code === 'CUC' || code === '₱';

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

export function formatMoney(amount: number, currencyCode: string): string {
  const decimals = isCupLikeCurrency(currencyCode) ? 0 : 2;
  const formatted = Number(amount || 0).toLocaleString('es-CU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  return currencyCode + ' ' + formatted;
}
