import { useShallow } from 'zustand/react/shallow';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import OperationsSurface from '../components/OperationsSurface';
import { selectBankTransactions, validateBankTransfer } from '../utils/operationsUi';
import { useStore } from '../store/useStore';
import { generateId, cn } from '../lib/utils';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowLeftRight,
  ArrowUpRight,
  Banknote,
  CheckCircle2,
  Copy,
  CreditCard,
  List,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Snowflake,
  Trash2,
  Wallet,
  Wrench,
  X,
} from 'lucide-react';
import { BankCard, BankTransaction, Transaction } from '../types';
import { InfoTooltip } from '../components/InfoTooltip';
import PlanFeatureGate from '../components/PlanFeatureGate';
import BankLogo, { getBankWordmark } from '../components/bank/BankLogo';
import { enqueueOfflineItem, getOfflineQueue, removeFromOfflineQueue } from '../services/offlineQueue';
import { callBankInternalTransferRPC } from '../services/supabaseSync';
import { findSessionEmployeeUser } from '../services/employeeCompensation';
import { buildSessionTurnMap } from '../modules/reports/useReportsSessions';
import type { BankRefreshResult } from '../store/actions/bankActions';

const CARD_TYPE_OPTIONS = ['MN', 'MLC', 'Clásica USD'] as const;
type BankCardType = typeof CARD_TYPE_OPTIONS[number];

const cardTypeCurrency = (type: string): string =>
  type === 'Clásica USD' ? 'USD' : type === 'MLC' ? 'MLC' : 'CUP';

/** Legacy cards stored Débito/Crédito/Clásica CUP; map them to the new taxonomy. */
function normalizeCardType(card: Pick<BankCard, 'cardType' | 'currency' | 'bank'>): BankCardType {
  const raw = (card.cardType || '').trim();
  if (raw === 'MLC') return 'MLC';
  if (raw === 'Clásica USD' || raw === 'USD') return 'Clásica USD';
  if (raw === 'MN' || raw === 'Clásica CUP') {
    return card.currency === 'MLC' ? 'MLC' : card.currency === 'USD' ? 'Clásica USD' : 'MN';
  }
  return card.currency === 'MLC' ? 'MLC' : card.currency === 'USD' ? 'Clásica USD' : 'MN';
}

type BankTheme = {
  gradient: string;
  accentText: string;
  isWallet?: boolean;
};

const BANK_THEMES: Record<string, BankTheme> = {
  BPA: {
    gradient: 'linear-gradient(135deg, #3B1B6B 0%, #6D28D9 52%, #2E1065 100%)',
    accentText: 'text-violet-600 dark:text-violet-300',
  },
  BANDEC: {
    gradient: 'linear-gradient(135deg, #0B3D91 0%, #1D4ED8 52%, #0B1E4D 100%)',
    accentText: 'text-blue-600 dark:text-blue-300',
  },
  'Banco Metropolitano': {
    gradient: 'linear-gradient(135deg, #064E3B 0%, #10B981 52%, #022C22 100%)',
    accentText: 'text-emerald-600 dark:text-emerald-400',
  },
  EnZona: {
    gradient: 'linear-gradient(135deg, #7C2D12 0%, #EA580C 52%, #431407 100%)',
    accentText: 'text-orange-600 dark:text-orange-400',
    isWallet: true,
  },
};

const DEFAULT_BANK_THEME = BANK_THEMES.BPA;

function getBankTheme(bank?: string): BankTheme {
  return BANK_THEMES[bank || ''] || DEFAULT_BANK_THEME;
}

function onlyDigits(raw: string) {
  return (raw || '').replace(/\D/g, '');
}

function formatCardNumber(raw: string) {
  const digits = onlyDigits(raw).slice(0, 16);
  const groups = digits.match(/.{1,4}/g) || [];
  return groups.join(' ');
}

function maskCardNumber(raw: string) {
  const digits = onlyDigits(raw);
  if (digits.length < 4) return '••••  ••••  ••••  ••••';
  return `••••  ••••  ••••  ${digits.slice(-4)}`;
}

function lastFourOf(card: BankCard) {
  return (card.lastFour || onlyDigits(card.accountNumber || '').slice(-4) || '····').slice(-4);
}

function money(value: number) {
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  return safe.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function CardChip() {
  return (
    <span
      className="relative block shrink-0 overflow-hidden"
      style={{
        width: 'clamp(28px, 11cqw, 42px)',
        height: 'clamp(20px, 7.9cqw, 30px)',
        borderRadius: 5,
        background: 'linear-gradient(135deg, #F5D48A 0%, #E6C173 45%, #B8860B 100%)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.35), 0 1px 2px rgba(0,0,0,.35)',
      }}
    >
      <svg viewBox="0 0 38 28" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <g stroke="#7A5B10" strokeOpacity="0.55" strokeWidth="1.1" fill="none">
          <path d="M0 9h38M0 19h38M13 0v28M25 0v28" />
          <rect x="13" y="9" width="12" height="10" rx="2" />
        </g>
      </svg>
    </span>
  );
}

function ContactlessSymbol({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="shrink-0"
      aria-hidden="true"
    >
      <path d="M6 9a8 8 0 0 1 0 6" opacity="0.55" />
      <path d="M9.5 6.5a12 12 0 0 1 0 11" opacity="0.75" />
      <path d="M13 4a16 16 0 0 1 0 16" />
    </svg>
  );
}

/** Cara de tarjeta ISO ID-1 (85.6 × 53.98 mm → ratio 1.586). */
function CardFace({ card, theme }: { card: BankCard; theme: BankTheme }) {
  const isWallet = Boolean(theme.isWallet);
  const digits = onlyDigits(card.accountNumber || '');
  const masked = digits.length >= 4 ? maskCardNumber(digits) : `••••  ••••  ••••  ${lastFourOf(card)}`;
  const holder = (card.cardHolder || card.name || 'TITULAR').toUpperCase();
  const expiry = card.expiryDate?.trim() || 'MM/AA';
  const rawType = normalizeCardType(card);
  const cardType = isWallet ? 'Monedero' : rawType;
  const mark = getBankWordmark(card.bank);

  return (
    <div
      className="relative aspect-[1.586] w-full overflow-hidden rounded-2xl"
      style={{
        containerType: 'inline-size',
        backgroundImage: theme.gradient,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.18)',
      }}
    >
      {/* Patrón tenue de arcos/olas */}
      <svg
        viewBox="0 0 340 214"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ opacity: 0.09 }}
        aria-hidden="true"
      >
        <g fill="none" stroke="#FFFFFF" strokeWidth="1.3">
          <circle cx="302" cy="196" r="58" />
          <circle cx="302" cy="196" r="90" />
          <circle cx="302" cy="196" r="122" />
          <path d="M-12 168C62 128 132 206 218 158S322 108 356 138" />
          <path d="M-12 190C72 150 142 228 228 180S332 130 366 160" />
        </g>
      </svg>

      {/* Brillo especular diagonal */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(115deg, rgba(255,255,255,0) 32%, rgba(255,255,255,.11) 45%, rgba(255,255,255,.03) 57%, rgba(255,255,255,0) 68%)',
        }}
        aria-hidden="true"
      />

      {/* Banda magnética (solo plástico) */}
      {!isWallet && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0"
          style={{ height: '9%', background: 'linear-gradient(90deg, #07070B 0%, #23232C 35%, #0A0A10 100%)' }}
          aria-hidden="true"
        />
      )}

      <div
        className="relative flex h-full flex-col"
        style={{ padding: isWallet ? '5.5% 5.5% 5%' : '3.2% 5.5% 4.4%' }}
      >
        {!isWallet && <div aria-hidden="true" style={{ height: '9%' }} />}

        {/* Fila superior: wordmark + sin contacto */}
        <div className="flex items-start justify-between gap-2">
          <BankLogo
            bank={card.bank}
            tone="light"
            fontSize="clamp(12px, 5.2cqw, 18px)"
            subtitle
            subtitleFontSize="clamp(7px, 2.7cqw, 9.5px)"
            className="min-w-0"
          />
          {!isWallet && <ContactlessSymbol size={15} />}
          {isWallet && (
            <span
              className="rounded-full border border-white/30 bg-white/15 px-2 py-0.5 font-black uppercase text-white"
              style={{ fontSize: 'clamp(6.5px, 2.4cqw, 9px)', letterSpacing: '0.12em' }}
            >
              Xetid
            </span>
          )}
        </div>

        {/* Fila media: chip (plástico) | badges */}
        {!isWallet ? (
          <div className="flex items-start justify-between gap-2" style={{ marginTop: '4%' }}>
            <CardChip />
            <div className="flex flex-wrap items-start justify-end gap-1">
              <span
                className="rounded-md border border-white/25 bg-white/15 px-1.5 py-0.5 font-black uppercase text-white"
                style={{ fontSize: 'clamp(7px, 2.8cqw, 10px)', letterSpacing: '0.1em' }}
              >
                {card.currency}
              </span>
              <span
                className="whitespace-nowrap rounded-md border border-white/25 bg-white/15 px-1.5 py-0.5 font-black uppercase text-white"
                style={{ fontSize: 'clamp(7px, 2.8cqw, 10px)', letterSpacing: '0.1em' }}
              >
                {cardType}
              </span>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: '5%' }}>
            <span
              className="block font-black uppercase text-white/70"
              style={{ fontSize: 'clamp(6.5px, 2.5cqw, 8px)', letterSpacing: '0.18em' }}
            >
              Saldo disponible
            </span>
            <span className="mt-1 flex items-baseline gap-1.5 text-white">
              <span
                className="font-black tabular-nums leading-none"
                style={{ fontSize: 'clamp(17px, 8.4cqw, 28px)', letterSpacing: '-0.01em' }}
              >
                {money(Number(card.balance) || 0)}
              </span>
              <span className="font-bold" style={{ fontSize: 'clamp(8px, 3cqw, 11px)' }}>
                {card.currency}
              </span>
            </span>
          </div>
        )}

        {/* Número enmascarado (solo plástico) */}
        {!isWallet && (
          <div className="mt-auto flex items-end justify-between gap-2">
            <span
              className="truncate font-bold tabular-nums text-white"
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 'clamp(11px, 5.1cqw, 17px)',
                letterSpacing: '0.06em',
                textShadow: '0 1px 2px rgba(0,0,0,.35)',
              }}
            >
              {masked}
            </span>
            <span
              className="shrink-0 font-black uppercase text-white/70"
              style={{ fontSize: 'clamp(6.5px, 2.4cqw, 9px)', letterSpacing: '0.22em' }}
            >
              Red
            </span>
          </div>
        )}

        {isWallet && (
          <div className="mt-auto">
            <span
              className="inline-block max-w-full truncate rounded-full border border-white/30 bg-black/20 px-2 py-0.5 font-black uppercase text-white"
              style={{ fontSize: 'clamp(6.5px, 2.4cqw, 9px)', letterSpacing: '0.14em' }}
            >
              {mark.full}
            </span>
          </div>
        )}

        {/* Titular + vencimiento / teléfono */}
        <div className="mt-[2.5%] flex items-end justify-between gap-2">
          <span className="min-w-0">
            <span
              className="block font-bold uppercase text-white/60"
              style={{ fontSize: 'clamp(6px, 2.3cqw, 8px)', letterSpacing: '0.18em' }}
            >
              Titular
            </span>
            <span
              className="mt-0.5 block truncate font-bold uppercase text-white"
              style={{ fontSize: 'clamp(9px, 3.5cqw, 12px)', letterSpacing: '0.05em' }}
            >
              {holder}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span
              className="block font-bold uppercase text-white/60"
              style={{ fontSize: 'clamp(6px, 2.3cqw, 8px)', letterSpacing: '0.18em' }}
            >
              {isWallet ? 'Teléfono' : 'Vence'}
            </span>
            <span
              className="mt-0.5 block font-bold text-white"
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: 'clamp(9px, 3.4cqw, 12px)' }}
            >
              {isWallet ? card.phone || '—' : expiry}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function BankCardTile({
  card,
  isSelected,
  isSheetOpen,
  onOpenActions,
  onTransfer,
  onMovements,
  onEdit,
  onDelete,
}: {
  card: BankCard;
  isSelected: boolean;
  isSheetOpen: boolean;
  onOpenActions: () => void;
  onTransfer: () => void;
  onMovements: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const theme = getBankTheme(card.bank);
  const frozen = card.isActive === false;
  const last4 = lastFourOf(card);
  const short = getBankWordmark(card.bank).short;

  const actionBase =
    'flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-base bg-secondary font-bold text-secondary transition-colors hover:bg-subtle hover:text-primary';

  return (
    <div
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-2xl border bg-secondary shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-violet-500',
        isSelected ? 'border-violet-400 ring-1 ring-violet-300/70 dark:ring-violet-500/40' : 'border-base',
        frozen && 'border-amber-400/80',
      )}
    >
      <button
        type="button"
        onClick={onMovements}
        aria-label={`${short} — ${card.name || 'Cuenta'} terminada en ${last4}, saldo ${money(Number(card.balance) || 0)} ${card.currency}. Ver movimientos.`}
        className="relative block w-full cursor-pointer p-0 text-left"
      >
        <div style={{ filter: frozen ? 'saturate(.55) brightness(.94)' : undefined, transition: 'filter .2s' }}>
          <CardFace card={card} theme={theme} />
        </div>
      </button>

      {/* Franja de saldo + estado */}
      <div className="flex items-start justify-between gap-2 px-3 pt-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-black leading-tight text-primary" title={card.name}>
            {card.name || `${short} ****${last4}`}
          </p>
          <span
            className="mt-1.5 block font-black uppercase text-muted"
            style={{ fontSize: 11, letterSpacing: '0.12em' }}
          >
            Saldo disponible
          </span>
          <span className="mt-0.5 flex items-baseline gap-1.5">
            <span className={cn('text-2xl font-black tabular-nums leading-none', theme.accentText)}>
              {money(Number(card.balance) || 0)}
            </span>
            <span className="font-bold text-muted" style={{ fontSize: 12 }}>
              {card.currency}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-bold',
              frozen
                ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
            )}
            style={{ fontSize: 11 }}
          >
            {frozen ? <Snowflake size={11} aria-hidden="true" /> : <CheckCircle2 size={11} aria-hidden="true" />}
            {frozen ? 'Congelada' : 'Activa'}
          </span>
          <button
            type="button"
            onClick={onOpenActions}
            aria-haspopup="dialog"
            aria-expanded={isSheetOpen}
            aria-label={`Más acciones de ${short} ****${last4}`}
            title="Copiar número, congelar o eliminar la cuenta"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-base text-muted transition-colors hover:bg-subtle hover:text-primary"
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Acciones: botones hermanos del contenedor de la cara */}
      <div className="grid grid-cols-2 gap-1.5 px-3 pb-3 pt-2.5">
        <button
          type="button"
          onClick={onTransfer}
          disabled={frozen}
          title={frozen ? 'Reactiva la cuenta para transferir' : `Transferir desde ${short} ****${last4}`}
          className={actionBase}
        >
          <ArrowLeftRight size={14} aria-hidden="true" />
          <span style={{ fontSize: 12 }}>Transferir</span>
        </button>
        <button
          type="button"
          onClick={onMovements}
          title={`Ver movimientos de ${short} ****${last4}`}
          className={actionBase}
        >
          <List size={14} aria-hidden="true" />
          <span style={{ fontSize: 12 }}>Movimientos</span>
        </button>
        <button type="button" onClick={onEdit} title="Editar los datos de la cuenta" className={actionBase}>
          <Pencil size={14} aria-hidden="true" />
          <span style={{ fontSize: 12 }}>Editar</span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Eliminar la cuenta"
          className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-base bg-secondary font-bold text-secondary transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 dark:hover:border-red-900 dark:hover:bg-red-950/40 dark:hover:text-red-300"
        >
          <Trash2 size={14} aria-hidden="true" />
          <span style={{ fontSize: 12 }}>Eliminar</span>
        </button>
      </div>
    </div>
  );
}

function ActionRow({
  icon,
  title,
  subtitle,
  onClick,
  disabled,
  tone = 'default',
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  const danger = tone === 'danger';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
        danger
          ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50'
          : 'border-base bg-secondary text-primary hover:bg-subtle',
      )}
    >
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
          danger
            ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300'
            : 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
        )}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block font-black', danger ? '' : 'text-primary')} style={{ fontSize: 14 }}>
          {title}
        </span>
        {subtitle && (
          <span
            className={cn('mt-0.5 block truncate font-semibold', danger ? 'text-red-500 dark:text-red-300/80' : 'text-muted')}
            style={{ fontSize: 12 }}
          >
            {subtitle}
          </span>
        )}
      </span>
    </button>
  );
}

function CardActionsSheet({
  card,
  onClose,
  onTransfer,
  onMovements,
  onEdit,
  onCopy,
  onToggleFreeze,
  onDelete,
}: {
  card: BankCard;
  onClose: () => void;
  onTransfer: () => void;
  onMovements: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onToggleFreeze: () => void;
  onDelete: () => void;
}) {
  const theme = getBankTheme(card.bank);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const frozen = card.isActive === false;
  const hasNumber = onlyDigits(card.accountNumber || '').length >= 4;
  const short = getBankWordmark(card.bank).short;

  useEffect(() => {
    sheetRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bank-actions-title"
        className="relative max-h-[90dvh] w-full overflow-y-auto rounded-t-3xl border border-base bg-secondary p-4 shadow-2xl outline-none sm:max-w-sm sm:rounded-2xl"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-subtle sm:hidden" aria-hidden="true" />

        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 id="bank-actions-title" className="truncate text-base font-black text-primary">
              {card.name || short}
            </h2>
            <p className="truncate text-sm text-muted">
              {short} · ****{lastFourOf(card)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar acciones"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-base text-muted transition-colors hover:bg-subtle hover:text-primary"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="mt-3">
          <CardFace card={card} theme={theme} />
        </div>

        <div className="mt-3 space-y-2">
          <ActionRow
            icon={<ArrowLeftRight size={16} />}
            title="Transferir"
            subtitle={frozen ? 'Cuenta congelada: reactívala para transferir' : 'Registrar una transferencia desde esta cuenta'}
            onClick={onTransfer}
            disabled={frozen}
          />
          <ActionRow
            icon={<List size={16} />}
            title="Ver movimientos"
            subtitle="Filtra la tabla por esta cuenta"
            onClick={onMovements}
          />
          <ActionRow icon={<Pencil size={16} />} title="Editar" subtitle="Corregir datos, saldo o tipo" onClick={onEdit} />
          {hasNumber && (
            <ActionRow
              icon={<Copy size={16} />}
              title="Copiar número"
              subtitle={`Terminada en ${lastFourOf(card)}`}
              onClick={onCopy}
            />
          )}
          <ActionRow
            icon={frozen ? <Play size={16} /> : <Snowflake size={16} />}
            title={frozen ? 'Reactivar cuenta' : 'Congelar cuenta'}
            subtitle={frozen ? 'Volver a permitir transferencias' : 'Ocultar de las transferencias sin borrarla'}
            onClick={onToggleFreeze}
          />
        </div>

        <div className="mt-3 border-t border-base pt-3">
          <ActionRow
            icon={<Trash2 size={16} />}
            title="Eliminar cuenta"
            subtitle="Requiere confirmación; no se puede deshacer"
            onClick={onDelete}
            tone="danger"
          />
        </div>
      </div>
    </div>
  );
}

export default function Banks() {
  const {
    bankCards,
    bankTransactions,
    transactions,
    cashSessions,
    users,
    branches,
    addBankCard,
    updateBankCard,
    deleteBankCard,
    getBaseCurrency,
    addBankTransaction,
    deleteBankTransaction,
    addNotification
  } = useStore(useShallow((state) => ({ bankCards: state.bankCards, bankTransactions: state.bankTransactions, transactions: state.transactions, cashSessions: state.cashSessions, users: state.users, branches: state.branches, addBankCard: state.addBankCard, updateBankCard: state.updateBankCard, deleteBankCard: state.deleteBankCard, getBaseCurrency: state.getBaseCurrency, addBankTransaction: state.addBankTransaction, deleteBankTransaction: state.deleteBankTransaction, addNotification: state.addNotification })));

  // `refreshBankData` vive en bankActions pero el tipo AppState aún no lo declara
  // (mismo patrón que Reports.tsx para acciones fuera del contrato base).
  const refreshBankData = useStore(
    (state) => (state as any).refreshBankData as
      | ((options?: { force?: boolean }) => Promise<BankRefreshResult>)
      | undefined
  );
  const currentBranchId = useStore((state) => state.currentBranchId);
  const currencies = useStore((state) => state.currencies);

  // Distinguir "sin movimientos" de "no se pudo cargar" es obligatorio: antes la
  // página nunca pedía el historial y siempre parecía vacía.
  const [movementsStatus, setMovementsStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [movementsMessage, setMovementsMessage] = useState<string | null>(null);
  const [skippedMovements, setSkippedMovements] = useState(0);
  const lastLoadedBranchRef = useRef<string | undefined>(currentBranchId);

  const loadMovements = useCallback(async (options?: { force?: boolean }) => {
    if (!refreshBankData) {
      setMovementsStatus('loaded');
      return;
    }
    setMovementsStatus('loading');
    try {
      const result = await refreshBankData(options);
      setSkippedMovements(result.unknownTypeCount || 0);
      if (!result.success && result.offline) {
        // Sin conexión no es "no se pudo cargar": se muestran los movimientos
        // guardados en el dispositivo con un aviso, sin alarmar al operador.
        setMovementsStatus('loaded');
        setMovementsMessage(result.message || 'Sin conexión: se muestran los movimientos guardados en este dispositivo.');
        return;
      }
      if (!result.success) {
        setMovementsStatus('error');
        setMovementsMessage(result.message || 'No se pudo cargar el historial bancario.');
        return;
      }
      setMovementsStatus('loaded');
      setMovementsMessage(result.offline ? (result.message || null) : null);
    } catch (error) {
      console.warn('[Banks] No se pudo cargar el historial bancario:', error);
      setMovementsStatus('error');
      setMovementsMessage('No se pudo cargar el historial bancario. Inténtalo de nuevo.');
    }
  }, [refreshBankData]);

  useEffect(() => {
    // Al entrar a la página y al cambiar de sucursal el historial bancario se
    // pide a la nube. El cooldown de la acción del store evita ráfagas de
    // consultas (doble montaje en StrictMode, re-renders, foco de ventana).
    const branchChanged = lastLoadedBranchRef.current !== currentBranchId;
    lastLoadedBranchRef.current = currentBranchId;
    void loadMovements({ force: branchChanged });
  }, [loadMovements, currentBranchId]);


  const emptyForm = (): Partial<BankCard> => ({
    name: "",
    bank: "BPA",
    accountNumber: "",
    cardHolder: "",
    expiryDate: "",
    phone: "",
    lastFour: "",
    balance: 0,
    currency: getBaseCurrency().code,
    isActive: true,
    cardType: "MN",
  });

  const [showAddModal, setShowAddModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [editingCard, setEditingCard] = useState<BankCard | null>(null);

  const [formData, setFormData] = useState<Partial<BankCard>>(() => emptyForm());

  const [transferData, setTransferData] = useState({
    fromCardId: "",
    toCardId: "",
    toExternalCard: "",
    toExternalName: "",
    isExternal: false,
    amount: 0,
    reason: ""
  });

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [actionsCardId, setActionsCardId] = useState<string | null>(null);
  const bankCardById = useMemo(() => new Map(bankCards.map(card => [card.id, card])), [bankCards]);
  const [movementSearch, setMovementSearch] = useState('');
  const [movementDirection, setMovementDirection] = useState('all');
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [expandedRefs, setExpandedRefs] = useState<Set<string>>(() => new Set());
  const toggleRef = (id: string) => setExpandedRefs(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const [isTransferring, setIsTransferring] = useState(false);
  const transferLock = useRef(false);
  const selectedCard = selectedCardId ? bankCardById.get(selectedCardId) : undefined;
  const actionsCard = actionsCardId ? bankCardById.get(actionsCardId) : undefined;
  const filteredTransactions = useMemo(
    () => selectBankTransactions(bankTransactions, selectedCardId, movementSearch, movementDirection),
    [bankTransactions, selectedCardId, movementSearch, movementDirection]
  );

  const shiftIncome = useMemo(() => {
    const saleById = new Map<string, (typeof transactions)[number]>();
    for (const sale of transactions) {
      if (sale.deletedAt) continue;
      saleById.set(sale.id, sale);
      if (sale.remoteId) saleById.set(sale.remoteId, sale);
    }
    const activeSessions = cashSessions.filter(session => !session.deletedAt);
    const sessionById = new Map(activeSessions.map(session => [session.id, session]));
    const turnLabels = buildSessionTurnMap(activeSessions);
    const branchName = (id?: string) => branches.find(branch => branch.id === id)?.name || 'Sucursal principal';

    type Group = {
      key: string;
      label: string;
      worker: string;
      branch: string;
      date: string;
      totals: Map<string, number>;
      saleIds: Set<string>;
      cards: Set<string>;
    };
    const groups = new Map<string, Group>();

    for (const entry of bankTransactions) {
      if (entry.type !== 'payment_received') continue;
      if (selectedCardId && entry.cardId !== selectedCardId) continue;
      const card = bankCardById.get(entry.cardId);
      const sale = (entry.transactionId ? saleById.get(entry.transactionId) : undefined)
        || saleById.get(String(entry.reference || '').trim());
      const sessionId = sale?.sessionId || '';
      const session = sessionId ? sessionById.get(sessionId) : undefined;
      const key = session ? session.id : 'no-turno';
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          label: session ? (turnLabels.get(session.id) || 'Turno') : 'Sin turno',
          worker: session
            ? (findSessionEmployeeUser(session, users)?.name || session.workerName || 'Cajero')
            : (sale?.cashierName || 'Cobro sin turno'),
          branch: branchName(session?.branchId || sale?.branchId),
          date: session?.closingDate || session?.closedAt || session?.openedAt || sale?.date || entry.date,
          totals: new Map<string, number>(),
          saleIds: new Set<string>(),
          cards: new Set<string>(),
        };
        groups.set(key, group);
      }
      const currency = card?.currency || 'CUP';
      group.totals.set(currency, (group.totals.get(currency) || 0) + Number(entry.amount || 0));
      if (entry.transactionId) group.saleIds.add(entry.transactionId);
      if (card) group.cards.add(`${getBankWordmark(card.bank).short} ****${lastFourOf(card)}`);
    }

    return Array.from(groups.values())
      .map(group => ({ ...group, totalsList: Array.from(group.totals.entries()).sort((a, b) => b[1] - a[1]) }))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [bankTransactions, transactions, cashSessions, users, branches, selectedCardId, bankCardById]);

  // Link each bank receipt back to its POS sale and shift so the movement detail
  // reads "Venta … · Turno …" instead of a bare UUID.
  const bankMovementLink = useMemo(() => {
    const saleById = new Map<string, Transaction>();
    for (const sale of transactions) {
      if (sale.deletedAt) continue;
      saleById.set(sale.id, sale);
      if (sale.remoteId) saleById.set(sale.remoteId, sale);
    }
    const activeSessions = cashSessions.filter(session => !session.deletedAt);
    const sessionById = new Map(activeSessions.map(session => [session.id, session]));
    const turnLabels = buildSessionTurnMap(activeSessions);
    const links = new Map<string, { sale: Transaction; turnLabel: string }>();
    for (const entry of bankTransactions) {
      if (entry.type !== 'payment_received') continue;
      const sale = (entry.transactionId ? saleById.get(entry.transactionId) : undefined)
        || saleById.get(String(entry.reference || '').trim());
      if (!sale) continue;
      const session = sale.sessionId ? sessionById.get(sale.sessionId) : undefined;
      links.set(entry.id, { sale, turnLabel: session ? (turnLabels.get(session.id) || 'Turno') : '' });
    }
    return links;
  }, [transactions, cashSessions, bankTransactions]);
  const [cardToDelete, setCardToDelete] = useState<string | null>(null);
  const [movementToDelete, setMovementToDelete] = useState<BankTransaction | null>(null);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name?.trim() || !Number.isFinite(Number(formData.balance))) {
      addNotification('Completa el titular y un saldo válido.', 'error');
      return;
    }
    const cleanAccount = (formData.accountNumber || '').replace(/\s/g, '');
    if (cleanAccount && !/^\d{16}$/.test(cleanAccount)) {
      addNotification('El número de tarjeta debe contener 16 dígitos, o quedar vacío.', 'error');
      return;
    }
    const derivedLastFour = cleanAccount.length >= 4 ? cleanAccount.slice(-4) : (formData.lastFour || '');

    const cardPayload: Partial<BankCard> = {
      ...formData,
      balance: formData.balance !== undefined && Number.isFinite(Number(formData.balance))
        ? Number(formData.balance)
        : 0,
      accountNumber: cleanAccount,
      lastFour: derivedLastFour,
    };

    if (editingCard) {
      updateBankCard(editingCard.id, cardPayload);
      addNotification(`Tarjeta ${editingCard.bank} actualizada.`, 'info');
    } else {
      addBankCard({
        id: generateId('CRD'),
        ...(cardPayload as BankCard)
      });
      addNotification(`Tarjeta ${formData.bank} creada exitosamente.`, 'success');
    }
    setShowAddModal(false);
    setEditingCard(null);
    setFormData(emptyForm());
  };

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    const fromCard = bankCards.find(c => c.id === transferData.fromCardId);

    if (transferLock.current) return;
    const validationError = validateBankTransfer(fromCard, bankCards.find(c => c.id === transferData.toCardId), transferData.amount, transferData.isExternal);
    if (validationError || !fromCard) {
      addNotification(validationError || 'Selecciona una cuenta de origen.', 'error');
      return;
    }
    if (transferData.isExternal && (!transferData.toExternalName.trim() || !transferData.toExternalCard.trim())) {
      addNotification('Completa el destinatario y su tarjeta.', 'error');
      return;
    }
    transferLock.current = true;
    setIsTransferring(true);
    try {
    const date = new Date().toISOString();
    const ref = generateId('TRF');

    if (transferData.isExternal) {
      if (fromCard.balance < transferData.amount) {
        addNotification('Saldo insuficiente en la cuenta de origen.', 'error');
        return;
      }
      const saved = await addBankTransaction({
        id: generateId('BTX'),
        cardId: fromCard.id,
        type: 'withdrawal',
        amount: transferData.amount,
        date,
        reference: ref,
        description: `Transferencia Externa a ${transferData.toExternalName} (${transferData.toExternalCard}): ${transferData.reason}`
      });
      if (!saved) return;
      addNotification(`Transferencia externa de ${transferData.amount} registrada.`, 'success');
    } else {
      const toCard = bankCards.find(c => c.id === transferData.toCardId);
      if (!toCard) return;
      if (fromCard.balance < transferData.amount) {
        addNotification('Saldo insuficiente en la cuenta de origen.', 'error');
        return;
      }

      let targetAmount = transferData.amount;
      if (fromCard.currency !== toCard.currency) {
        const currencies = useStore.getState().currencies;
        const fromRate = currencies.find(c => c.code === fromCard.currency)?.rateToBase;
        const toRate = currencies.find(c => c.code === toCard.currency)?.rateToBase;
        if (!fromRate || !toRate) {
          addNotification(`No hay tasa configurada para ${fromCard.currency} → ${toCard.currency}. Registra la tasa antes de transferir entre monedas.`, 'error');
          return;
        }
        targetAmount = (transferData.amount * fromRate) / toRate;
      }

      const payload = {
        operationId: ref,
        fromCardId: fromCard.id,
        toCardId: toCard.id,
        amount: transferData.amount,
        targetAmount,
        date,
        reason: transferData.reason
      };
      const actionId = 'bank-transfer:' + ref;

      // Persist the intent before attempting the server call. If the response
      // is lost, the exact same operation is safely replayed on reconnect.
      await enqueueOfflineItem('bank_internal_transfer', payload, actionId);

      if (navigator.onLine) {
        try {
          const result = await callBankInternalTransferRPC(payload);
          if (!result.success) {
            const code = String((result as any).errorCode || '');
            const permanentCodes = new Set(['P0001','23503','23505','42501','22003','22P02','IDEMPOTENCY_CONFLICT']);
            if (permanentCodes.has(code)) {
              const queued = getOfflineQueue().find(item => item.type === 'bank_internal_transfer' && item.actionId === actionId);
              if (queued) await removeFromOfflineQueue(queued.id);
              throw Object.assign(new Error(result.error || 'La transferencia bancaria fue rechazada por el servidor'), { permanent: true });
            }

            // La petición pudo haber sido aplicada y solo se perdió la respuesta.
            // Conservamos la operación original, reflejamos el movimiento como
            // pendiente y evitamos que el usuario lo repita con otro operationId.
            useStore.setState(state => ({
              bankTransactions: [
                {
                  id: ref + ':IN', cardId: toCard.id, type: 'deposit',
                  amount: targetAmount, date, reference: ref, transactionId: ref,
                  description: `Transferencia desde ${fromCard.bank} (****${fromCard.lastFour}): ${transferData.reason}`
                },
                {
                  id: ref + ':OUT', cardId: fromCard.id, type: 'withdrawal',
                  amount: transferData.amount, date, reference: ref, transactionId: ref,
                  description: `Transferencia a ${toCard.bank} (****${toCard.lastFour}): ${transferData.reason}`
                },
                ...(state.bankTransactions || []).filter(t => t.reference !== ref)
              ],
              bankCards: (state.bankCards || []).map(card => {
                if (card.id === fromCard.id) return { ...card, balance: card.balance - transferData.amount };
                if (card.id === toCard.id) return { ...card, balance: card.balance + targetAmount };
                return card;
              })
            }));
            addNotification('Transferencia bancaria guardada localmente y pendiente de confirmación con la nube.', 'info');
            setShowTransferModal(false);
            setTransferData({ fromCardId: "", toCardId: "", toExternalCard: "", toExternalName: "", isExternal: false, amount: 0, reason: "" });
            return;
          }

          const queued = getOfflineQueue().find(item => item.type === 'bank_internal_transfer' && item.actionId === actionId);
          if (queued) await removeFromOfflineQueue(queued.id);

          const fromBalance = Number(result.data?.from_balance);
          const toBalance = Number(result.data?.to_balance);
          const outTx: BankTransaction = {
            id: ref + ':OUT',
            cardId: fromCard.id,
            type: 'withdrawal',
            amount: transferData.amount,
            date,
            reference: ref,
            description: `Transferencia a ${toCard.bank} (****${toCard.lastFour}): ${transferData.reason}`
          };
          const inTx: BankTransaction = {
            id: ref + ':IN',
            cardId: toCard.id,
            type: 'deposit',
            amount: targetAmount,
            date,
            reference: ref,
            description: `Transferencia desde ${fromCard.bank} (****${fromCard.lastFour}): ${transferData.reason}`
          };

          useStore.setState(state => ({
            bankTransactions: [inTx, outTx, ...(state.bankTransactions || []).filter(t => t.reference !== ref)],
            bankCards: (state.bankCards || []).map(card => {
              if (card.id === fromCard.id && Number.isFinite(fromBalance)) return { ...card, balance: fromBalance };
              if (card.id === toCard.id && Number.isFinite(toBalance)) return { ...card, balance: toBalance };
              return card;
            })
          }));
          addNotification(`Transferencia interna de ${transferData.amount} completada.`, 'success');
        } catch (err: any) {
          // Error de transporte: la operación ya está en la cola. El servidor
          // pudo haberla aplicado; reflejamos el mismo estado pendiente que en
          // una caída offline para que el usuario no genere una segunda operación.
          if (!err?.permanent) {
            useStore.setState(state => ({
              bankTransactions: [
                {
                  id: ref + ':IN', cardId: toCard.id, type: 'deposit',
                  amount: targetAmount, date, reference: ref, transactionId: ref,
                  description: `Transferencia desde ${fromCard.bank} (****${fromCard.lastFour}): ${transferData.reason}`
                },
                {
                  id: ref + ':OUT', cardId: fromCard.id, type: 'withdrawal',
                  amount: transferData.amount, date, reference: ref, transactionId: ref,
                  description: `Transferencia a ${toCard.bank} (****${toCard.lastFour}): ${transferData.reason}`
                },
                ...(state.bankTransactions || []).filter(t => t.reference !== ref)
              ],
              bankCards: (state.bankCards || []).map(card => {
                if (card.id === fromCard.id) return { ...card, balance: card.balance - transferData.amount };
                if (card.id === toCard.id) return { ...card, balance: card.balance + targetAmount };
                return card;
              })
            }));
            addNotification('No se pudo confirmar la respuesta. La transferencia quedó pendiente y no debes repetirla.', 'info');
            setShowTransferModal(false);
            setTransferData({ fromCardId: "", toCardId: "", toExternalCard: "", toExternalName: "", isExternal: false, amount: 0, reason: "" });
            return;
          }
          addNotification(err?.message || 'La transferencia quedó pendiente de sincronización.', 'error');
          return;
        }
      } else {
        // Offline fallback keeps both ledger entries durable. They are replayed
        // independently, while the internal RPC is used whenever connectivity
        // returns for online-originated transfers.
        await enqueueOfflineItem(
          'bank_internal_transfer',
          payload,
          actionId
        );
        useStore.setState(state => ({
          bankTransactions: [
            {
              id: ref + ':IN',
              cardId: toCard.id,
              type: 'deposit',
              amount: targetAmount,
              date,
              reference: ref,
              transactionId: ref,
              description: `Transferencia desde ${fromCard.bank} (****${fromCard.lastFour}): ${transferData.reason}`
            },
            {
              id: ref + ':OUT',
              cardId: fromCard.id,
              type: 'withdrawal',
              amount: transferData.amount,
              date,
              reference: ref,
              transactionId: ref,
              description: `Transferencia a ${toCard.bank} (****${toCard.lastFour}): ${transferData.reason}`
            },
            ...(state.bankTransactions || []).filter(t => t.reference !== ref)
          ],
          bankCards: (state.bankCards || []).map(card => {
            if (card.id === fromCard.id) return { ...card, balance: card.balance - transferData.amount };
            if (card.id === toCard.id) return { ...card, balance: card.balance + targetAmount };
            return card;
          })
        }));
        addNotification('Transferencia guardada offline; se sincronizará al reconectar.', 'info');
      }
    }

    setShowTransferModal(false);
    setTransferData({ fromCardId: "", toCardId: "", toExternalCard: "", toExternalName: "", isExternal: false, amount: 0, reason: "" });
    } catch (error) {
      addNotification(error instanceof Error ? error.message : 'No se pudo guardar la transferencia.', 'error');
    } finally {
      transferLock.current = false;
      setIsTransferring(false);
    }
  };

  const handleConfirmDeleteMovement = async () => {
    if (!movementToDelete) return;
    const deleted = await deleteBankTransaction(movementToDelete.id);
    if (!deleted) return;
    const ref = movementToDelete.reference;
    addNotification(
      ref
        ? `Movimiento ${ref} eliminado y saldo de tarjeta ajustado correctamente.`
        : 'Movimiento eliminado y saldo de tarjeta ajustado correctamente.',
      'info',
    );
    setMovementToDelete(null);
  };

  const openCreate = () => {
    setEditingCard(null);
    setFormData(emptyForm());
    setShowAddModal(true);
  };

  const openEdit = (card: BankCard) => {
    setEditingCard(card);
    setFormData({
      name: card.name || '',
      bank: card.bank || 'BPA',
      phone: card.phone || '',
      accountNumber: formatCardNumber(card.accountNumber || ''),
      expiryDate: card.expiryDate || '',
      cardHolder: card.cardHolder || '',
      lastFour: card.lastFour || '',
      balance: Number(card.balance) || 0,
      currency: card.currency || getBaseCurrency().code,
      isActive: card.isActive !== false,
      cardType: normalizeCardType(card),
    });
    setActionsCardId(null);
    setShowAddModal(true);
  };

  const openTransfer = (card?: BankCard) => {
    // Una cuenta congelada no aparece en el select de origen; precargarla
    // dejaría el formulario vacío sin explicación.
    const prefillId = card && card.isActive !== false ? card.id : '';
    setTransferData(prev => ({ ...prev, fromCardId: prefillId, isExternal: false }));
    if (card) setSelectedCardId(null);
    setActionsCardId(null);
    setShowTransferModal(true);
  };

  const goToMovements = (card: BankCard) => {
    setSelectedCardId(card.id);
    setActionsCardId(null);
    // El scroll real vive en el contenedor de Layout, no en la ventana.
    requestAnimationFrame(() => {
      const target = document.getElementById('movimientos-bancarios');
      if (!target) return;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
  };

  const copyCardNumber = async (card: BankCard) => {
    const digits = onlyDigits(card.accountNumber || '');
    if (digits.length < 4) {
      addNotification('Esta cuenta no tiene un número guardado.', 'info');
      return;
    }
    const fallbackCopy = () => {
      try {
        const area = document.createElement('textarea');
        area.value = digits;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        addNotification(ok ? 'Número de tarjeta copiado.' : 'No se pudo copiar el número.', ok ? 'success' : 'error');
      } catch {
        addNotification('No se pudo copiar el número.', 'error');
      }
    };
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(digits);
        addNotification('Número de tarjeta copiado.', 'success');
      } else {
        fallbackCopy();
      }
    } catch {
      // El WebView del POS puede negar la Clipboard API; se usa el fallback.
      fallbackCopy();
    }
  };

  const toggleFreeze = (card: BankCard) => {
    const reactivating = card.isActive === false;
    updateBankCard(card.id, { isActive: reactivating });
    addNotification(
      reactivating
        ? `Cuenta ${getBankWordmark(card.bank).short} ****${lastFourOf(card)} reactivada.`
        : `Cuenta ${getBankWordmark(card.bank).short} ****${lastFourOf(card)} congelada: no podrá usarse como origen de transferencias.`,
      reactivating ? 'success' : 'info'
    );
  };

  const mnTotal = bankCards
    .filter(c => c.currency === 'CUP' || c.currency === 'MN')
    .reduce((sum, c) => sum + (Number(c.balance) || 0), 0);
  const usdTotal = bankCards
    .filter(c => c.currency === 'USD')
    .reduce((sum, c) => sum + (Number(c.balance) || 0), 0);
  const mlcTotal = bankCards
    .filter(c => c.currency === 'MLC')
    .reduce((sum, c) => sum + (Number(c.balance) || 0), 0);
  const activeCount = bankCards.filter(c => c.isActive !== false).length;
  const frozenCount = bankCards.length - activeCount;

  // Cada movimiento está en la moneda de su tarjeta: sumar los importes sin
  // convertir mezclaba CUP, USD y MLC en un mismo total y el resumen mentía.
  const baseCode = getBaseCurrency().code;
  const rateByCode = new Map<string, number>(currencies.map(currency => [String(currency.code), Number(currency.rateToBase) || 1]));
  const toBase = (entry: BankTransaction) => {
    const code = bankCardById.get(entry.cardId)?.currency || baseCode;
    return Number(entry.amount || 0) * (rateByCode.get(code) || 1);
  };
  const incomeTotal = filteredTransactions
    .filter(t => t.type === 'deposit' || t.type === 'payment_received')
    .reduce((sum, t) => sum + toBase(t), 0);
  const expenseTotal = filteredTransactions
    .filter(t => t.type !== 'deposit' && t.type !== 'payment_received')
    .reduce((sum, t) => sum + toBase(t), 0);

  return (
    <PlanFeatureGate feature="banking" title="Cuentas bancarias" description="La gestión bancaria y sus movimientos están disponibles desde el plan Caravana." highlights={[
      "Cuentas y tarjetas organizadas por sucursal",
      "Depósitos, pagos y transferencias internas",
      "Saldos y movimientos con historial completo"
    ]} >
    {/* Márgenes negativos: la sección ocupa todo el ancho útil que Layout recorta con su padding.
        Se usa flex+gap (no space-y) para que los modales fixed no hereden márgenes. */}
    <OperationsSurface className="flex flex-col gap-4 -mx-3 -mt-3 px-3 pb-10 pt-3 sm:-mx-4 sm:-mt-4 sm:px-4 sm:pt-4 lg:-mx-6 lg:-mt-6 lg:px-6">
      {/* Delete Card Confirmation Modal */}
      {cardToDelete && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-2xl max-w-xs w-full text-center border border-base animate-in zoom-in-95 duration-200">
            <div className="w-12 h-12 bg-red-50 dark:bg-red-950/30 rounded-full flex items-center justify-center mx-auto mb-3">
              <Trash2 className="w-6 h-6 text-red-600 dark:text-red-400" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-black text-primary uppercase tracking-tight mb-1">¿Eliminar tarjeta?</h3>
            <p className="text-sm font-semibold text-muted mb-4">Esta acción no se puede deshacer y eliminará el registro de la cuenta.</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setCardToDelete(null)}
                className="min-h-11 bg-subtle text-secondary rounded-xl px-3 py-3 font-black uppercase tracking-wide transition-colors hover:bg-secondary cursor-pointer"
                style={{ fontSize: 12 }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  const id = cardToDelete;
                  const deleted = await deleteBankCard(id);
                  if (!deleted) return;
                  setCardToDelete(null);
                  if (selectedCardId === id) setSelectedCardId(null);
                  if (actionsCardId === id) setActionsCardId(null);
                  addNotification("Tarjeta eliminada correctamente.", 'info');
                }}
                className="min-h-11 bg-red-600 text-white rounded-xl px-3 py-3 font-black uppercase tracking-wide shadow-lg shadow-red-200 dark:shadow-none cursor-pointer hover:bg-red-700 transition-colors"
                style={{ fontSize: 12 }}
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Movement Confirmation Modal */}
      {movementToDelete && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-2xl max-w-xs w-full text-center border border-base animate-in zoom-in-95 duration-200">
            <div className="w-12 h-12 bg-red-50 dark:bg-red-950/30 rounded-full flex items-center justify-center mx-auto mb-3">
              <Trash2 className="w-6 h-6 text-red-600 dark:text-red-400" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-black text-primary uppercase tracking-tight mb-1">¿Eliminar movimiento?</h3>
            <p className="text-sm font-semibold text-muted mb-2">
              {movementToDelete.type === 'deposit' || movementToDelete.type === 'payment_received' ? 'Entrada' : 'Salida'} de{' '}
              <strong className="text-primary tabular-nums">
                {money(movementToDelete.amount)} {bankCardById.get(movementToDelete.cardId)?.currency || ''}
              </strong>
            </p>
            <p className="text-sm font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 p-2.5 rounded-xl mb-4">
              {movementToDelete.type === 'deposit' || movementToDelete.type === 'payment_received'
                ? 'Este monto será descontado del saldo actual de la tarjeta.'
                : 'Este monto será devuelto al saldo de la tarjeta.'}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMovementToDelete(null)}
                className="min-h-11 bg-subtle text-secondary rounded-xl px-3 py-3 font-black uppercase tracking-wide transition-colors hover:bg-secondary cursor-pointer"
                style={{ fontSize: 12 }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteMovement}
                className="min-h-11 bg-red-600 text-white rounded-xl px-3 py-3 font-black uppercase tracking-wide shadow-lg shadow-red-200 dark:shadow-none cursor-pointer hover:bg-red-700 transition-colors"
                style={{ fontSize: 12 }}
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header + acciones principales */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 data-palmi-content="banks" className="text-xl sm:text-2xl font-black text-primary tracking-tight">Cuentas y Bancos en Cuba</h1>
            <InfoTooltip text="Gestiona tus cuentas bancarias, tarjetas y transferencias. Registra aquí los movimientos que ya ocurrieron en el banco y conserva la referencia de cada operación." position="bottom" />
          </div>
          <p className="text-sm text-muted mt-1">Control de saldos en efectivo y transferencias bancarias de tu negocio.</p>
          <p className="text-muted mt-0.5" style={{ fontSize: 12 }}>
            Los diseños de tarjeta son referenciales por banco; no reproducen el plástico oficial.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => openTransfer(selectedCard)}
            title={selectedCard ? `Transferir desde ${getBankWordmark(selectedCard.bank).short} ****${lastFourOf(selectedCard)}` : "Registrar una transferencia bancaria"}
            className="bg-secondary border border-violet-300 dark:border-violet-500/40 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-500/10 px-3.5 py-2 rounded-xl font-bold text-sm transition-all shadow-2xs flex items-center gap-1.5 cursor-pointer"
          >
            <ArrowLeftRight size={15} />
            <span>Transferir</span>
          </button>

          <button
            type="button"
            onClick={openCreate}
            className="bg-violet-600 text-white hover:bg-violet-700 px-4 py-2 rounded-xl font-bold text-sm transition-all shadow-xs flex items-center gap-1.5 cursor-pointer"
          >
            <Plus size={15} /> Nueva Cuenta / Tarjeta
          </button>
        </div>
      </div>

      {/* KPIs en burbujas */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-violet-700 text-white shadow-sm" aria-hidden="true">
              <Wallet size={16} />
            </span>
            <span className="block font-black uppercase text-muted" style={{ fontSize: 11, letterSpacing: '0.12em' }}>
              Saldo total en MN
            </span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-black tabular-nums leading-none text-primary">{money(mnTotal)}</span>
            <span className="font-bold text-muted" style={{ fontSize: 11 }}>CUP</span>
          </div>
          <span className="mt-1 block font-semibold text-muted" style={{ fontSize: 12 }}>
            Todas las cuentas en MN registradas
          </span>
        </div>

        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow-sm" aria-hidden="true">
              <Banknote size={16} />
            </span>
            <span className="block font-black uppercase text-muted" style={{ fontSize: 11, letterSpacing: '0.12em' }}>
              Saldo total en USD
            </span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-black tabular-nums leading-none text-emerald-600 dark:text-emerald-400">{money(usdTotal)}</span>
            <span className="font-bold text-muted" style={{ fontSize: 11 }}>USD</span>
          </div>
          <span className="mt-1 block font-semibold text-muted" style={{ fontSize: 12 }}>
            Tarjetas Clásica USD registradas
          </span>
        </div>

        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-indigo-700 text-white shadow-sm" aria-hidden="true">
              <CreditCard size={16} />
            </span>
            <span className="block font-black uppercase text-muted" style={{ fontSize: 11, letterSpacing: '0.12em' }}>
              Saldo total en MLC
            </span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-black tabular-nums leading-none text-sky-600 dark:text-sky-400">{money(mlcTotal)}</span>
            <span className="font-bold text-muted" style={{ fontSize: 11 }}>MLC</span>
          </div>
          <span className="mt-1 block font-semibold text-muted" style={{ fontSize: 12 }}>
            Cuentas en moneda libremente convertible
          </span>
        </div>

        <div className="rounded-2xl border border-base bg-secondary p-4 shadow-2xs">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-slate-500 to-slate-700 text-white shadow-sm" aria-hidden="true">
              <CheckCircle2 size={16} />
            </span>
            <span className="block font-black uppercase text-muted" style={{ fontSize: 11, letterSpacing: '0.12em' }}>
              Cuentas operativas
            </span>
          </div>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-black tabular-nums leading-none text-primary">{activeCount}</span>
            <span className="font-bold text-muted" style={{ fontSize: 11 }}>de {bankCards.length} registradas</span>
          </div>
          <span className="mt-1 block font-semibold text-muted" style={{ fontSize: 12 }}>
            {frozenCount > 0 ? `${frozenCount} congelada(s) sin uso en transferencias` : 'Todas listas para recibir cobros en caja'}
          </span>
        </div>
      </div>

      {/* Grid de tarjetas (full-width, 1–5+ columnas) */}
      <div
        className="grid gap-3 sm:gap-4 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]"
        aria-label="Cuentas registradas"
      >
        {bankCards.map(card => (
          <BankCardTile
            key={card.id}
            card={card}
            isSelected={selectedCardId === card.id}
            isSheetOpen={actionsCardId === card.id}
            onOpenActions={() => setActionsCardId(prev => (prev === card.id ? null : card.id))}
            onTransfer={() => openTransfer(card)}
            onMovements={() => goToMovements(card)}
            onEdit={() => openEdit(card)}
            onDelete={() => { setActionsCardId(null); setCardToDelete(card.id); }}
          />
        ))}
        {!bankCards.length && (
          <div className="col-span-full flex flex-col items-center gap-3 rounded-3xl border border-dashed border-base p-12 text-center">
            <CreditCard size={32} className="text-muted" aria-hidden="true" />
            <h3 className="text-base font-black text-primary">No hay cuentas bancarias registradas</h3>
            <p className="text-sm text-muted max-w-md">
              Presiona «Nueva Cuenta / Tarjeta» para agregar tu primera cuenta en BPA, BANDEC, Banco Metropolitano o la billetera EnZona.
            </p>
            <button
              type="button"
              onClick={openCreate}
              className="mt-1 flex min-h-11 items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2 font-bold text-sm text-white transition-colors hover:bg-violet-700"
            >
              <Plus size={15} /> Agregar cuenta
            </button>
          </div>
        )}
      </div>

      {/* Movimientos */}
      <div id="movimientos-bancarios" className="scroll-mt-3 overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base p-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-base bg-subtle text-primary" aria-hidden="true">
              <Activity size={15} />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-black uppercase tracking-tight text-primary">Movimientos bancarios</h3>
              <p className="text-sm font-semibold text-muted">
                {selectedCard ? `Filtrado: ${getBankWordmark(selectedCard.bank).short} · ${selectedCard.name || 'Cuenta'} ****${lastFourOf(selectedCard)}` : 'Todos los movimientos'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void loadMovements({ force: true })}
              disabled={movementsStatus === 'loading'}
              title="Volver a cargar los movimientos desde la nube"
              aria-label="Actualizar movimientos bancarios"
              className="flex min-h-11 items-center gap-1.5 rounded-lg border border-base bg-secondary px-2.5 py-1 font-bold text-secondary transition-colors hover:bg-subtle disabled:opacity-50 sm:min-h-8"
              style={{ fontSize: 12 }}
            >
              <RefreshCw size={13} className={cn(movementsStatus === 'loading' && 'animate-spin')} aria-hidden="true" />
              {movementsStatus === 'loading' ? 'Cargando…' : 'Actualizar'}
            </button>
            <button
              type="button"
              onClick={() => setShowMaintenance(v => !v)}
              aria-pressed={showMaintenance}
              disabled={!selectedCard}
              title={selectedCard ? 'Muestra el botón para eliminar un movimiento y ajustar el saldo' : 'Selecciona una cuenta para corregir sus movimientos'}
              className={cn(
                'flex min-h-11 items-center gap-1.5 rounded-lg border px-2.5 py-1 font-bold transition-colors cursor-pointer sm:min-h-8',
                showMaintenance
                  ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                  : 'border-base bg-secondary text-secondary hover:bg-subtle',
              )}
              style={{ fontSize: 12 }}
            >
              <Wrench size={13} aria-hidden="true" /> Corrección
            </button>
            {selectedCardId && (
              <button
                type="button"
                onClick={() => setSelectedCardId(null)}
                className="min-h-11 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1 font-black uppercase tracking-wide text-violet-700 transition-colors hover:bg-violet-100 sm:min-h-8 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300"
                style={{ fontSize: 12 }}
              >
                Ver todas
              </button>
            )}
          </div>
        </div>

        {/* Burbujas de resumen */}
        <div className="grid grid-cols-2 gap-2 border-b border-base bg-subtle p-3 sm:grid-cols-4">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 dark:border-emerald-900/60 dark:bg-emerald-950/30">
            <span className="flex items-center gap-1.5 font-black uppercase text-emerald-700 dark:text-emerald-300" style={{ fontSize: 11, letterSpacing: '0.08em' }}>
              <ArrowDownRight size={13} aria-hidden="true" /> Entradas
            </span>
            <span className="mt-1 block font-black tabular-nums text-emerald-700 dark:text-emerald-300" style={{ fontSize: 16 }}>
              {money(incomeTotal)} <span className="font-bold text-muted" style={{ fontSize: 11 }}>{baseCode}</span>
            </span>
          </div>
          <div className="rounded-xl border border-base bg-secondary p-2.5">
            <span className="flex items-center gap-1.5 font-black uppercase" style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--danger)' }}>
              <ArrowUpRight size={13} aria-hidden="true" /> Salidas
            </span>
            <span className="mt-1 block font-black tabular-nums" style={{ fontSize: 16, color: 'var(--danger)' }}>
              {money(expenseTotal)} <span className="font-bold text-muted" style={{ fontSize: 11 }}>{baseCode}</span>
            </span>
          </div>
          <div className="rounded-xl border border-violet-200 bg-violet-50 p-2.5 dark:border-violet-900/60 dark:bg-violet-950/30">
            <span className="flex items-center gap-1.5 font-black uppercase text-violet-700 dark:text-violet-300" style={{ fontSize: 11, letterSpacing: '0.08em' }}>
              <Activity size={13} aria-hidden="true" /> Saldo neto
            </span>
            <span className="mt-1 block font-black tabular-nums text-violet-700 dark:text-violet-300" style={{ fontSize: 16 }}>
              {money(incomeTotal - expenseTotal)} <span className="font-bold text-muted" style={{ fontSize: 11 }}>{baseCode}</span>
            </span>
          </div>
          <div className="rounded-xl border border-base bg-secondary p-2.5">
            <span className="flex items-center gap-1.5 font-black uppercase text-muted" style={{ fontSize: 11, letterSpacing: '0.08em' }}>
              <List size={13} aria-hidden="true" /> Movimientos
            </span>
            <span className="mt-1 block font-black tabular-nums text-primary" style={{ fontSize: 16 }}>
              {filteredTransactions.length}
            </span>
          </div>
        </div>

        <div className="grid gap-2 border-b border-base p-3 sm:grid-cols-[1fr_200px]">
          <label className="block font-bold text-secondary">
            Buscar movimiento
            <input
              type="search"
              value={movementSearch}
              onChange={e => setMovementSearch(e.target.value)}
              placeholder="Detalle o referencia"
              className="mt-1 block w-full rounded-xl border border-base bg-secondary p-2 text-primary"
            />
          </label>
          <label className="block font-bold text-secondary">
            Tipo
            <select
              value={movementDirection}
              onChange={e => setMovementDirection(e.target.value)}
              className="mt-1 block w-full rounded-xl border border-base bg-secondary p-2 text-primary"
            >
              <option value="all">Todos</option>
              <option value="income">Entradas</option>
              <option value="expense">Salidas</option>
            </select>
          </label>
        </div>

        {movementsStatus === 'loaded' && (movementsMessage || skippedMovements > 0) && filteredTransactions.length > 0 ? (
          <p className="border-b border-base bg-amber-50/60 px-3 py-2 text-[12px] font-semibold text-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
            {movementsMessage}
            {skippedMovements > 0
              ? `${movementsMessage ? ' ' : ''}${skippedMovements} movimiento(s) se omitieron por tener un tipo no reconocido.`
              : ''}
          </p>
        ) : null}

        {(movementsStatus === 'loading' || movementsStatus === 'idle') && filteredTransactions.length === 0 ? (
          <div className="space-y-2 p-3" aria-busy="true" aria-live="polite">
            <p className="text-sm font-bold text-secondary">Cargando movimientos bancarios…</p>
            {[0, 1, 2].map(row => (
              <div key={row} className="flex items-center justify-between gap-3 rounded-xl border border-base bg-primary p-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3 w-2/5 rounded bg-subtle" />
                  <div className="h-2.5 w-3/5 rounded bg-subtle" />
                </div>
                <div className="h-4 w-16 shrink-0 rounded bg-subtle" />
              </div>
            ))}
          </div>
        ) : movementsStatus === 'error' && filteredTransactions.length === 0 ? (
          <div className="p-8 text-center">
            <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-full border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle size={20} aria-hidden="true" />
            </div>
            <h4 className="text-sm font-black text-primary">No se pudo cargar el historial</h4>
            <p className="mt-1 text-sm font-semibold text-muted">
              {movementsMessage || 'No se pudo consultar la nube. Revisa la conexión e inténtalo de nuevo.'}
            </p>
            <button
              type="button"
              onClick={() => void loadMovements({ force: true })}
              className="mx-auto mt-3 flex items-center gap-1.5 rounded-xl border border-base bg-secondary px-3 py-2 text-sm font-bold text-primary hover:bg-subtle"
            >
              <RefreshCw size={14} aria-hidden="true" /> Reintentar
            </button>
          </div>
        ) : filteredTransactions.length === 0 ? (
          <div className="p-8 text-center">
            <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-full border border-base bg-subtle text-muted">
              <List size={20} aria-hidden="true" />
            </div>
            <h4 className="text-sm font-black text-primary">Sin movimientos</h4>
            <p className="mt-1 text-sm font-semibold text-muted">
              Las transferencias y pagos confirmados aparecerán aquí. También puedes registrar una salida con «Transferir».
            </p>
            {movementsMessage ? (
              <p className="mt-2 text-[12px] font-semibold text-amber-700 dark:text-amber-300">{movementsMessage}</p>
            ) : null}
            {skippedMovements > 0 ? (
              <p className="mt-2 text-[12px] font-semibold text-amber-700 dark:text-amber-300">
                {skippedMovements} movimiento(s) se omitieron por tener un tipo no reconocido.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <ul className="divide-y divide-base md:hidden">
              {filteredTransactions.map(t => {
                const card = bankCardById.get(t.cardId);
                const isIncome = t.type === 'deposit' || t.type === 'payment_received';
                const link = bankMovementLink.get(t.id);
                return (
                  <li key={t.id} className="px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className="min-w-0 truncate text-[13px] font-black text-primary" title={card?.name || card?.bankName || card?.bank || 'Desconocida'}>
                          {card?.name || card?.bankName || card?.bank || 'Desconocida'}
                        </p>
                        <span className="shrink-0 rounded-md bg-subtle px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums text-secondary">
                          ••••{card ? lastFourOf(card) : '····'}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] font-semibold text-secondary" title={t.description}>{t.description}</p>
                      {link && (
                        <p className="truncate text-[11px] font-bold text-violet-700 dark:text-violet-300">
                          Venta #{String(link.sale.id).slice(0, 8)}{link.turnLabel ? ` · ${link.turnLabel}` : ''}
                        </p>
                      )}
                      {t.reference ? (
                        <div className="flex min-w-0 items-baseline gap-1.5">
                          <p
                            className={cn('min-w-0 text-[11px] font-bold uppercase text-muted', expandedRefs.has(t.id) ? 'break-all' : 'truncate')}
                            style={{ fontFamily: 'ui-monospace, monospace' }}
                            title={t.reference}
                          >
                            Ref. {t.reference}
                          </p>
                          {t.reference.length > 14 ? (
                            <button
                              type="button"
                              onClick={() => toggleRef(t.id)}
                              aria-expanded={expandedRefs.has(t.id)}
                              className="shrink-0 text-[11px] font-black text-primary underline-offset-2 hover:underline"
                            >
                              {expandedRefs.has(t.id) ? 'Ver menos' : 'Ver más'}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      <p className="text-[10px] font-bold tabular-nums text-muted">
                        {new Date(t.date).toLocaleString('es-CU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className={cn('text-[13px] font-black tabular-nums whitespace-nowrap', isIncome ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                        {isIncome ? '+' : '-'}{t.amount.toLocaleString('es-CU', { minimumFractionDigits: 2 })} {card?.currency || ''}
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-black uppercase tracking-wide',
                          isIncome
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                            : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
                        )}
                      >
                        {isIncome ? <ArrowDownRight size={12} aria-hidden="true" /> : <ArrowUpRight size={12} aria-hidden="true" />}
                        {isIncome ? 'Entrada' : 'Salida'}
                      </span>
                      {showMaintenance && selectedCard && (
                        <button
                          type="button"
                          aria-label={`Eliminar movimiento ${t.reference || t.id}`}
                          onClick={() => setMovementToDelete(t)}
                          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/50 dark:hover:text-red-300"
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[760px] text-sm [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_th]:py-2.5">
              <thead className="border-b border-base bg-subtle">
                <tr>
                  <th className="text-left font-black uppercase tracking-wider text-muted">Fecha</th>
                  <th className="text-left font-black uppercase tracking-wider text-muted">Cuenta</th>
                  <th className="text-left font-black uppercase tracking-wider text-muted">Tipo</th>
                  <th className="text-left font-black uppercase tracking-wider text-muted">Detalle</th>
                  <th className="text-right font-black uppercase tracking-wider text-muted">Monto</th>
                  {showMaintenance && selectedCard && (
                    <th className="text-center font-black uppercase tracking-wider text-muted">Corrección</th>
                  )}
                </tr>
              </thead>
              <tbody className="[&>tr+tr]:border-t [&>tr+tr]:border-base">
                {filteredTransactions.map(t => {
                  const card = bankCardById.get(t.cardId);
                  const isIncome = t.type === 'deposit' || t.type === 'payment_received';
                  const link = bankMovementLink.get(t.id);
                  return (
                    <tr key={t.id} className="transition-colors hover:bg-subtle">
                      <td className="text-sm font-semibold tabular-nums text-secondary whitespace-nowrap">
                        {new Date(t.date).toLocaleString('es-CU')}
                      </td>
                      <td className="whitespace-nowrap text-sm font-black text-primary">
                        {card?.name || card?.bankName || card?.bank || 'Desconocida'} <span className="font-bold text-muted">****{card ? lastFourOf(card) : '····'}</span>
                      </td>
                      <td className="whitespace-nowrap">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-black uppercase tracking-wide',
                            isIncome
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
                          )}
                          style={{ fontSize: 12 }}
                        >
                          {isIncome ? <ArrowDownRight size={12} aria-hidden="true" /> : <ArrowUpRight size={12} aria-hidden="true" />}
                          {isIncome ? 'Entrada' : 'Salida'}
                        </span>
                      </td>
                      <td className="max-w-[320px] align-top">
                        <p className="truncate text-sm font-semibold text-secondary" title={t.description}>
                          {t.description}
                        </p>
                        {link && (
                          <p className="truncate text-[11px] font-bold text-violet-700 dark:text-violet-300" title={`Venta #${link.sale.id}`}>
                            Venta #{String(link.sale.id).slice(0, 8)}{link.turnLabel ? ` · ${link.turnLabel}` : ''}
                          </p>
                        )}
                        {t.reference ? (
                          <div className="flex min-w-0 items-baseline gap-1.5">
                            <p
                              className={cn('min-w-0 text-[11px] font-bold uppercase text-muted', expandedRefs.has(t.id) ? 'break-all' : 'truncate')}
                              style={{ fontFamily: 'ui-monospace, monospace' }}
                              title={t.reference}
                            >
                              Ref. {expandedRefs.has(t.id) || t.reference.length <= 30
                                ? t.reference
                                : `${t.reference.slice(0, 14)}…${t.reference.slice(-10)}`}
                            </p>
                            {t.reference.length > 30 ? (
                              <button
                                type="button"
                                onClick={() => toggleRef(t.id)}
                                aria-expanded={expandedRefs.has(t.id)}
                                className="shrink-0 text-[11px] font-black text-primary underline-offset-2 hover:underline"
                              >
                                {expandedRefs.has(t.id) ? 'Ver menos' : 'Ver más'}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                      <td className={cn('text-right text-sm font-black tabular-nums whitespace-nowrap', isIncome ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                        {isIncome ? '+' : '-'}{t.amount.toLocaleString('es-CU', { minimumFractionDigits: 2 })} {card?.currency || ''}
                      </td>
                      {showMaintenance && selectedCard && (
                        <td className="text-center">
                          <button
                            type="button"
                            aria-label={`Eliminar movimiento ${t.reference || t.id}`}
                            onClick={() => setMovementToDelete(t)}
                            title="Eliminar este movimiento bancario y ajustar el saldo"
                            className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/50 dark:hover:text-red-300"
                          >
                            <Trash2 size={16} aria-hidden="true" />
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          </>
        )}
      </div>

      {/* Ingresos por turno */}
      <div id="ingresos-por-turno" className="scroll-mt-3 overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base p-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-base bg-subtle text-primary" aria-hidden="true">
              <Banknote size={15} />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-black uppercase tracking-wide text-primary">Ingresos por turno</h3>
              <p className="truncate text-sm font-semibold text-muted">
                {selectedCard
                  ? `Cobros de ${getBankWordmark(selectedCard.bank).short} · ${selectedCard.name || 'Cuenta'} ****${lastFourOf(selectedCard)}`
                  : 'Cobros bancarios de ventas agrupados por turno'}
              </p>
            </div>
          </div>
          <span className="rounded-lg border border-base bg-subtle px-2.5 py-1 text-[12px] font-black uppercase text-secondary">
            {shiftIncome.length} {shiftIncome.length === 1 ? 'turno' : 'turnos'}
          </span>
        </div>

        {shiftIncome.length === 0 ? (
          <div className="p-8 text-center">
            <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-full border border-base bg-subtle text-muted">
              <Banknote size={20} aria-hidden="true" />
            </div>
            <h4 className="text-sm font-black text-primary">Sin ingresos por turno</h4>
            <p className="mt-1 text-sm font-semibold text-muted">
              Cuando una venta se cobre por transferencia, el dinero aparecerá aquí agrupado por el turno de caja que lo registró.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-base">
            {shiftIncome.map(group => {
              const when = new Date(group.date);
              const whenLabel = Number.isNaN(when.getTime())
                ? group.branch
                : `${group.branch} · ${when.toLocaleDateString('es-CU', { day: '2-digit', month: 'short' })} ${when.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' })} · ${group.saleIds.size} cobro(s)`;
              return (
                <li key={group.key} className="flex flex-col gap-2 px-3 py-2.5 transition-colors hover:bg-subtle/60 sm:flex-row sm:items-center sm:gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                      <ArrowDownRight size={16} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className="truncate text-[13px] font-black text-primary" title={group.worker}>{group.worker}</p>
                        <span className="shrink-0 rounded-md border border-base bg-subtle px-1.5 py-0.5 text-[11px] font-black text-secondary">{group.label}</span>
                      </div>
                      <p className="truncate text-[12px] font-bold text-muted" title={whenLabel}>{whenLabel}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end" title={Array.from(group.cards).join(' · ')}>
                    {group.totalsList.map(([currency, total]) => (
                      <span
                        key={currency}
                        className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[12px] font-black tabular-nums text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                      >
                        +{money(total)} {currency}
                      </span>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Modal Agregar / Editar Tarjeta */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-3">
          <div className="bg-secondary rounded-2xl w-full max-w-lg max-h-[90dvh] overflow-y-auto shadow-2xl border border-base animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-base bg-subtle px-4 py-3">
              <h2 className="text-base font-black uppercase tracking-tight text-primary">{editingCard ? 'Editar cuenta' : 'Nueva cuenta'}</h2>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                aria-label="Cerrar formulario"
                className="flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-secondary hover:text-primary"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-2.5 p-4">
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-muted">Nombre o titular</label>
                <input
                  type="text"
                  required
                  value={formData.name || ''}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                  className="w-full rounded-lg border border-base bg-secondary px-3 py-1.5 text-sm font-bold text-primary"
                  placeholder="Ej: Juan Pérez"
                />
              </div>

              <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-muted">Banco</label>
                  <select
                    value={formData.bank}
                    onChange={e => setFormData({...formData, bank: e.target.value})}
                    className="w-full rounded-lg border border-base bg-secondary px-3 py-1.5 text-sm font-bold text-primary"
                  >
                    <option value="BPA">BPA - Banco Popular de Ahorro</option>
                    <option value="BANDEC">BANDEC - Banco de Crédito y Comercio</option>
                    <option value="Banco Metropolitano">Banco Metropolitano (BANMET)</option>
                    <option value="EnZona">EnZona (billetera)</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-muted" htmlFor="bank-card-type">
                    Tipo de tarjeta
                    <InfoTooltip text="El tipo ajusta la moneda de la cuenta: MN → CUP, MLC → MLC y Clásica USD → USD." position="top" />
                  </label>
                  <select
                    id="bank-card-type"
                    value={normalizeCardType(formData as BankCard)}
                    onChange={e => {
                      const cardType = e.target.value;
                      setFormData(prev => ({ ...prev, cardType, currency: cardTypeCurrency(cardType) }));
                    }}
                    className="w-full rounded-lg border border-base bg-secondary px-3 py-1.5 text-sm font-bold text-primary"
                  >
                    {CARD_TYPE_OPTIONS.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-muted">
                  Número de tarjeta (16 dígitos)
                  <InfoTooltip text="Prefijos de referencia: BPA 9204 / 9205 / 9224 / 9225 / 9227 / 9235 y BANDEC 9240 (Tropical). Es una guía, no una validación estricta." position="top" />
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={19}
                  placeholder="9202 XXXX XXXX XXXX"
                  value={formData.accountNumber || ''}
                  onChange={e => {
                    const raw = e.target.value.replace(/\D/g, '').slice(0, 16);
                    const formatted = raw.replace(/(\d{4})(?=\d)/g, '$1 ');
                    setFormData({
                      ...formData,
                      accountNumber: formatted,
                    });
                  }}
                  className="w-full rounded-lg border border-base bg-secondary px-3 py-1.5 text-sm font-bold text-primary"
                  style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.04em' }}
                />
              </div>

              <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-muted">Vence (MM/AA)</label>
                  <input
                    type="text"
                    maxLength={5}
                    placeholder="12/27"
                    value={formData.expiryDate || ''}
                    onChange={e => {
                      const raw = e.target.value.replace(/\D/g, '').slice(0, 4);
                      let formatted = raw;
                      if (raw.length >= 3) formatted = raw.slice(0, 2) + '/' + raw.slice(2, 4);
                      else if (raw.length === 2) formatted = raw + '/';
                      setFormData({ ...formData, expiryDate: formatted });
                    }}
                    className="w-full rounded-lg border border-base bg-secondary px-3 py-1.5 text-sm font-bold text-primary"
                  />
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-muted">
                    Teléfono
                    <InfoTooltip text="Número asociado a Transfermóvil para recibir transferencias a esta cuenta." position="top" />
                  </label>
                  <input
                    type="text"
                    inputMode="tel"
                    placeholder="Ej: 5351234567"
                    value={formData.phone || ''}
                    onChange={e => setFormData({...formData, phone: e.target.value})}
                    className="w-full rounded-lg border border-base bg-secondary px-3 py-1.5 text-sm font-bold text-primary"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-muted">Titular de la tarjeta</label>
                  <input
                    type="text"
                    placeholder="Ej: JUAN PEREZ GARCIA"
                    value={formData.cardHolder || ''}
                    onChange={e => setFormData({...formData, cardHolder: e.target.value.toUpperCase()})}
                    className="w-full rounded-lg border border-base bg-secondary px-3 py-1.5 text-sm font-bold text-primary"
                  />
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-muted">
                    Saldo inicial
                    <InfoTooltip text="Saldo que ya tiene la cuenta al registrarla. Solo sirve para el arqueo local; no mueve dinero en el banco." position="top" />
                  </label>
                  <input
                    type="number"
                    required
                    value={formData.balance ?? 0}
                    onChange={e => setFormData({...formData, balance: Number(e.target.value)})}
                    className="w-full rounded-lg border border-base bg-secondary px-3 py-1.5 text-sm font-bold tabular-nums text-primary"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-muted">Moneda</label>
                  <select
                    value={formData.currency}
                    onChange={e => setFormData({...formData, currency: e.target.value})}
                    className="w-full rounded-lg border border-base bg-secondary px-3 py-1.5 text-sm font-bold text-primary"
                  >
                    {Array.from(new Set([...useStore.getState().currencies.map(c => c.code), 'MLC'])).map(code => (
                      <option key={code} value={code}>{code}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-muted">Estado</label>
                  <select
                    value={formData.isActive ? 'true' : 'false'}
                    onChange={e => setFormData({...formData, isActive: e.target.value === 'true'})}
                    className="w-full rounded-lg border border-base bg-secondary px-3 py-1.5 text-sm font-bold text-primary"
                  >
                    <option value="true">Activa</option>
                    <option value="false">Congelada / inactiva</option>
                  </select>
                </div>
              </div>

              <div className="pt-1">
                <button
                  type="submit"
                  className="w-full rounded-xl bg-violet-600 py-2.5 font-black uppercase tracking-wide text-white shadow-md shadow-violet-600/20 transition-all hover:bg-violet-700 active:scale-95 cursor-pointer"
                  style={{ fontSize: 13 }}
                >
                  {editingCard ? 'Guardar cambios' : 'Crear cuenta'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Transferencia entre Tarjetas */}
      {showTransferModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-3">
          <div className="bg-secondary rounded-2xl w-full max-w-lg max-h-[90dvh] overflow-y-auto shadow-2xl border border-base animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-base bg-subtle px-4 py-3">
              <h2 className="text-base font-black uppercase tracking-tight text-primary">Transferencia</h2>
              <button
                type="button"
                disabled={isTransferring}
                aria-label="Cerrar transferencia"
                onClick={() => setShowTransferModal(false)}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-secondary hover:text-primary"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleTransfer} className="space-y-4 p-4">
              <p className="text-sm font-semibold text-secondary">Este registro no envía dinero al banco. Registra una transferencia ya realizada y conserva su referencia.</p>
              <fieldset disabled={isTransferring} className="space-y-4">
              <div className="flex rounded-lg border border-base bg-subtle p-0.5">
                <button
                  type="button"
                  onClick={() => setTransferData({...transferData, isExternal: false})}
                  className={cn(
                    "flex-1 rounded py-2.5 font-black uppercase tracking-wider transition-all cursor-pointer sm:py-1.5",
                    !transferData.isExternal ? "bg-secondary text-violet-600 shadow-xs" : "text-muted hover:text-primary"
                  )}
                  style={{ fontSize: 12 }}
                >
                  Interna
                </button>
                <button
                  type="button"
                  onClick={() => setTransferData({...transferData, isExternal: true})}
                  className={cn(
                    "flex-1 rounded py-2.5 font-black uppercase tracking-wider transition-all cursor-pointer sm:py-1.5",
                    transferData.isExternal ? "bg-secondary text-violet-600 shadow-xs" : "text-muted hover:text-primary"
                  )}
                  style={{ fontSize: 12 }}
                >
                  Externa
                </button>
              </div>

              <div>
                <label className="mb-1 block font-black uppercase tracking-wider text-muted">Desde</label>
                <select
                  required
                  value={transferData.fromCardId}
                  onChange={e => setTransferData({...transferData, fromCardId: e.target.value})}
                  className="w-full rounded-xl border border-base bg-secondary px-3 py-2 font-bold text-primary"
                >
                  <option value="">Seleccionar origen</option>
                  {bankCards.filter(c => c.isActive !== false).map(c => (
                    <option key={c.id} value={c.id}>{c.bank} - ****{lastFourOf(c)} ({money(c.balance)} {c.currency})</option>
                  ))}
                </select>
              </div>

              {!transferData.isExternal ? (
                <div>
                  <label className="mb-1 block font-black uppercase tracking-wider text-muted">Hacia</label>
                  <select
                    required
                    value={transferData.toCardId}
                    onChange={e => setTransferData({...transferData, toCardId: e.target.value})}
                    className="w-full rounded-xl border border-base bg-secondary px-3 py-2 font-bold text-primary"
                  >
                    <option value="">Seleccionar destino</option>
                    {bankCards.filter(c => c.id !== transferData.fromCardId && c.isActive !== false).map(c => (
                      <option key={c.id} value={c.id}>{c.bank} - ****{lastFourOf(c)} ({c.currency})</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block font-black uppercase tracking-wider text-muted">Tarjeta destino</label>
                    <input
                      type="text"
                      required
                      value={transferData.toExternalCard}
                      onChange={e => setTransferData({...transferData, toExternalCard: e.target.value})}
                      className="w-full rounded-xl border border-base bg-secondary px-3 py-2 font-bold text-primary"
                      placeholder="9202 XXXX XXXX XXXX"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-black uppercase tracking-wider text-muted">Nombre del destinatario</label>
                    <input
                      type="text"
                      required
                      value={transferData.toExternalName}
                      onChange={e => setTransferData({...transferData, toExternalName: e.target.value})}
                      className="w-full rounded-xl border border-base bg-secondary px-3 py-2 font-bold text-primary"
                      placeholder="Ej: Juan Pérez"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1 block font-black uppercase tracking-wider text-muted">Monto</label>
                <input
                  type="number"
                  required
                  min="0.01"
                  step="0.01"
                  value={transferData.amount || ''}
                  onChange={e => setTransferData({...transferData, amount: parseFloat(e.target.value) || 0})}
                  className="w-full rounded-xl border border-base bg-secondary px-3 py-2 font-bold tabular-nums text-primary"
                  placeholder="0.00"
                />
              </div>

              <div>
                <label className="mb-1 block font-black uppercase tracking-wider text-muted">Motivo</label>
                <input
                  type="text"
                  required
                  value={transferData.reason}
                  onChange={e => setTransferData({...transferData, reason: e.target.value})}
                  className="w-full rounded-xl border border-base bg-secondary px-3 py-2 font-bold text-primary"
                  placeholder="Ej: Reabastecimiento"
                />
              </div>

              <div className="pt-1">
                <button
                  type="submit"
                  className="w-full rounded-xl bg-emerald-600 py-2.5 font-black uppercase tracking-wide text-white shadow-md shadow-emerald-600/20 transition-all hover:bg-emerald-700 active:scale-95 disabled:opacity-60 cursor-pointer"
                  style={{ fontSize: 13 }}
                >
                  {isTransferring ? 'Guardando…' : 'Registrar transferencia'}
                </button>
              </div>
              </fieldset>
            </form>
          </div>
        </div>
      )}

      {/* Hoja de acciones de una cuenta */}
      {actionsCard && (
        <CardActionsSheet
          card={actionsCard}
          onClose={() => setActionsCardId(null)}
          onTransfer={() => openTransfer(actionsCard)}
          onMovements={() => goToMovements(actionsCard)}
          onEdit={() => openEdit(actionsCard)}
          onCopy={() => { void copyCardNumber(actionsCard); }}
          onToggleFreeze={() => toggleFreeze(actionsCard)}
          onDelete={() => { setActionsCardId(null); setCardToDelete(actionsCard.id); }}
        />
      )}
    </OperationsSurface>
    </PlanFeatureGate>
  );
}
