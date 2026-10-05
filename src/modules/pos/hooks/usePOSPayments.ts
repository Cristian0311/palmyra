import { useState } from 'react';
import type { CartItem, Currency, BankCard } from '../../types';
import { createPaymentMath, isCupLikeCurrency } from './utils/paymentMath';

export type POSPaymentLine = {
  id: string;
  code: string;
  amount: number;
  method: 'cash' | 'transfer';
  bankCardId?: string;
};

type UsePOSPaymentsArgs = {
  cart: CartItem[];
  currencies: Currency[];
  baseCurrency: Currency;
  bankCards: BankCard[];
};

export function usePOSPayments({ cart, currencies, baseCurrency, bankCards }: UsePOSPaymentsArgs) {
  const subtotalBase = cart.reduce((sum, item) => {
    const price = typeof (item.product as any) === 'object' && item.product !== null ? (item.product.price ?? item.price ?? 0) : (item.price ?? 0);
    return sum + (price * item.quantity);
  }, 0);
  const taxBase = 0; // Configurable tax if needed
  const rawTotalBase = subtotalBase + taxBase;
  const isCupBase = baseCurrency.code === 'CUP' || baseCurrency.code === 'MN';
  const totalBase = isCupBase ? Math.round(rawTotalBase) : Math.round(rawTotalBase * 100) / 100;

  // Todos los importes del checkout se convierten a la moneda base con una
  // tasa válida. La moneda base siempre vale 1, incluso si la configuración
  // remota llega momentáneamente sin rateToBase.
  const { getSafeRateToBase, toBaseAmount, roundBaseAmount } = createPaymentMath(baseCurrency, currencies, isCupBase);

  const totalPaidBase = roundBaseAmount(paymentLines.reduce(
    (sum, line) => sum + toBaseAmount(line.amount, line.code),
    0
  ));

  const balanceBase = roundBaseAmount(totalBase - totalPaidBase);
  const remainingBase = Math.max(0, balanceBase);
  const changeBase = Math.max(0, -balanceBase);
  const isPaid = remainingBase <= (isCupBase ? 0 : 0.01) && totalBase > 0;
  const { getSafeRateToBase, toBaseAmount, roundBaseAmount } = createPaymentMath(baseCurrency, currencies, isCupBase);
  const [paymentLines, setPaymentLines] = useState<POSPaymentLine[]>([]);
  const [activePaymentLineId, setActivePaymentLineId] = useState<string | null>(null);

  const addPaymentLine = () => {
    const newId = crypto.randomUUID();
    const curr = currencies.find(c => c.code === baseCurrency.code);
    let fillAmount = 0;
    if (remainingBase > 0) {
      const rawAmount = remainingBase / (curr?.rateToBase || 1);
      fillAmount = curr?.code === 'CUP' ? Math.round(rawAmount) : Math.round(rawAmount * 100) / 100;
    }
    const defaultBank = bankCards.find(c => c.currency === baseCurrency.code) || bankCards[0];
    setPaymentLines(prev => [...prev, { id: newId, code: baseCurrency.code, amount: fillAmount, method: 'cash', bankCardId: defaultBank?.id }]);
    setActivePaymentLineId(newId);
  };

  const updatePaymentLine = (id: string, field: keyof PaymentLine, value: any) => {
    setPaymentLines(prev => {
      let nextLines = prev.map(p => {
        if (p.id !== id) return p;
        const updated = { ...p, [field]: value };

        // Handle currency conversion when code changes
        if (field === 'code' && value !== p.code) {
          const oldCurrency = currencies.find(c => c.code === p.code);
          const newCurrency = currencies.find(c => c.code === value);
          if (oldCurrency && newCurrency) {
            const amountInBase = p.amount * oldCurrency.rateToBase;
            const convertedAmount = amountInBase / newCurrency.rateToBase;
            // If new currency is CUP-like, round to integer, otherwise keep 2 decimals
            updated.amount = isCupLikeCurrency(value) ? Math.round(convertedAmount) : Math.round(convertedAmount * 100) / 100;
          }
        }

        // If amount is directly edited and it's CUP, round to integer
        if (field === 'amount' && isCupLikeCurrency(updated.code)) {
          updated.amount = Math.round(updated.amount);
        }

        if (field === 'method' && value === 'transfer') {
          // If transfer is selected, force CUP if not already
          if (updated.code !== 'CUP') {
            const oldCurrency = currencies.find(c => c.code === updated.code);
            const cupCurrency = currencies.find(c => c.code === 'CUP');
            if (oldCurrency && cupCurrency) {
              const amountInBase = updated.amount * oldCurrency.rateToBase;
              updated.amount = Math.round(amountInBase / cupCurrency.rateToBase);
            }
            updated.code = 'CUP';
          }
          
          if (!updated.bankCardId) {
            const matchingCard = bankCards.find(c => c.currency === updated.code) || bankCards[0];
            if (matchingCard) {
              updated.bankCardId = matchingCard.id;
            }
          }
        }

        // Ensure that if it's CUP, it's ALWAYS an integer regardless of the field being changed
        if (isCupLikeCurrency(updated.code)) {
          updated.amount = Math.round(updated.amount);
        }

        if (field === 'code' && updated.method === 'transfer') {
          const matchingCard = bankCards.find(c => c.currency === value) || bankCards[0];
          if (matchingCard) {
            updated.bankCardId = matchingCard.id;
          }
        }
        return updated;
      });
      return nextLines;
    });
  };

  const removePaymentLine = (id: string) => {
    setPaymentLines(prev => {
      const filtered = prev.filter(p => p.id !== id);
      if (activePaymentLineId === id && filtered.length > 0) {
        setActivePaymentLineId(filtered[0].id);
      }
      return filtered;
    });
  };

  const autoFillRemaining = (id: string) => {
    const line = paymentLines.find(p => p.id === id);
    if (!line) return;
    const currency = currencies.find(c => c.code === line.code);
    if (!currency || !Number.isFinite(currency.rateToBase) || currency.rateToBase <= 0) return;

    // Completa exactamente lo que falta. No se suma al importe existente,
    // porque eso podía duplicar el importe al volver a pulsar "Total a cobrar".
    const paidByOtherLines = paymentLines.reduce((sum, p) => {
      if (p.id === id) return sum;
      return sum + toBaseAmount(p.amount, p.code);
    }, 0);
    const missingBase = Math.max(0, roundBaseAmount(totalBase - paidByOtherLines));
    const amountNeededInCurrency = missingBase / getSafeRateToBase(line.code);
    const roundedAmount = (line.code === 'CUP' || line.code === 'MN' || line.code === 'CUC')
      ? Math.round(amountNeededInCurrency)
      : Math.round(amountNeededInCurrency * 100) / 100;

    updatePaymentLine(id, 'amount', roundedAmount);
  };

  const splitUsdPayment = (id: string) => {
    const line = paymentLines.find(p => p.id === id);
    if (!line || line.code !== 'USD') return;
    
    const usdCurrency = currencies.find(c => c.code === 'USD');
    const cupCurrency = currencies.find(c => c.code === 'CUP');
    if (!usdCurrency || !cupCurrency) return;

    // Take the integer part of the CURRENT amount in this line
    const integerPart = Math.floor(line.amount);
    
    // Calculate base currency covered by OTHER lines
    const coveredByOthers = paymentLines.reduce((sum, p) => {
      if (p.id === id) return sum;
      const curr = currencies.find(c => c.code === p.code);
      return sum + (p.amount * (curr?.rateToBase || 0));
    }, 0);

    // Calculate base currency covered by the integer USD part
    const coveredByUsdInteger = integerPart * usdCurrency.rateToBase;
    
    // The exact remainder needed in base currency to reach totalBase
    const remainderBase = totalBase - (coveredByOthers + coveredByUsdInteger);
    
    // Convert to CUP and round to integer
    const remainderCup = Math.max(0, Math.round(remainderBase / cupCurrency.rateToBase));

    // 1. Update current line to integer USD
    updatePaymentLine(id, 'amount', integerPart);

    // 2. Add or Update CUP line
    // Search for any existing CUP cash line that is NOT the current line
    const existingCupLine = paymentLines.find(p => (p.code === 'CUP' || p.code === 'MN') && p.method === 'cash' && p.id !== id);
    
    if (existingCupLine) {
      updatePaymentLine(existingCupLine.id, 'amount', existingCupLine.amount + remainderCup);
      setActivePaymentLineId(existingCupLine.id);
    } else if (remainderCup > 0) {
      const newId = crypto.randomUUID();
      const defaultCupBank = bankCards.find(c => c.currency === 'CUP') || bankCards[0];
      setPaymentLines(prev => [...prev, { 
        id: newId, 
        code: 'CUP', 
        amount: remainderCup, 
        method: 'cash', 
        bankCardId: defaultCupBank?.id 
      }]);
      setActivePaymentLineId(newId);
    }
  };
  return {
    paymentLines,
    setPaymentLines,
    activePaymentLineId,
    setActivePaymentLineId,
    subtotalBase,
    taxBase,
    rawTotalBase,
    isCupBase,
    totalBase,
    totalPaidBase,
    balanceBase,
    remainingBase,
    changeBase,
    isPaid,
    getSafeRateToBase,
    toBaseAmount,
    roundBaseAmount,
    addPaymentLine,
    updatePaymentLine,
    removePaymentLine,
    autoFillRemaining,
    splitUsdPayment,
  };
}
