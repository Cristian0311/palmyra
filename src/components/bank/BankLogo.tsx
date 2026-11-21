import React from 'react';
import { cn } from '../../lib/utils';

type BankLogoProps = {
  bank?: string;
  /** Tamaño del wordmark. Admite px o unidades de contenedor (cqw). */
  fontSize?: number | string;
  subtitle?: boolean;
  subtitleFontSize?: number | string;
  tone?: 'light' | 'dark';
  className?: string;
};

/**
 * Wordmark tipográfico por banco. Se dibuja como texto (no como logotipo
 * inventado) porque las marcas reales no están disponibles como SVG y un
 * símbolo genérico confunde al cajero al identificar la cuenta.
 */
const WORDMARKS: Record<string, { short: string; full: string }> = {
  BPA: { short: 'BPA', full: 'BANCO POPULAR DE AHORRO' },
  BANDEC: { short: 'BANDEC', full: 'BANCO DE CRÉDITO Y COMERCIO' },
  'Banco Metropolitano': { short: 'BANMET', full: 'BANCO METROPOLITANO' },
  EnZona: { short: 'ENZONA', full: 'BILLETERA · PASARELA XETID' },
};

export function getBankWordmark(bank?: string) {
  return WORDMARKS[bank || ''] || WORDMARKS.BPA;
}

export default function BankLogo({
  bank,
  fontSize = 16,
  subtitle = false,
  subtitleFontSize = 8,
  tone = 'dark',
  className,
}: BankLogoProps) {
  const mark = getBankWordmark(bank);
  const light = tone === 'light';

  return (
    <span className={cn('inline-flex min-w-0 flex-col', className)}>
      <span
        className={cn('block truncate font-black uppercase leading-none', light ? 'text-white' : 'text-primary')}
        style={{ fontSize, letterSpacing: '0.09em' }}
      >
        {mark.short}
      </span>
      {subtitle && (
        <span
          className={cn('mt-[0.4em] block truncate font-bold uppercase leading-none', light ? 'text-white/65' : 'text-muted')}
          style={{ fontSize: subtitleFontSize, letterSpacing: '0.14em' }}
        >
          {mark.full}
        </span>
      )}
    </span>
  );
}
