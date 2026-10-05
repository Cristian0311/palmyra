import { cn } from '../../lib/utils';
import type { Currency } from '../../types';

interface MultiCurrencyTotalProps {
  amount: number;
  currencies: Currency[];
  className?: string;
}

export default function MultiCurrencyTotal({ amount, currencies, className = '' }: MultiCurrencyTotalProps) {
  return (
    <div className={`flex flex-col gap-0.5 mt-1 ${className}`}>
      {currencies.map(c => {
        const converted = c.isBase ? amount : amount / (c.rateToBase || 1);
        const hasDecimals = converted % 1 !== 0;
        return (
          <div key={c.code} className={cn("flex justify-between items-center text-[10px]", c.isBase ? "font-black text-primary" : "font-bold text-muted")}>
            <span>{c.symbol} {converted.toLocaleString('es-CU', { minimumFractionDigits: hasDecimals ? 2 : 0, maximumFractionDigits: 2 })}</span>
            <span className="text-[8px] uppercase">{c.code}</span>
          </div>
        );
      })}
    </div>
  );
}
