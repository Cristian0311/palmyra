import { useEffect } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { cn } from '../../lib/utils';

type Props = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export default function TeamConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  onConfirm,
  onClose
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="team-confirm-title"
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        onClick={event => event.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-3xl border border-base bg-secondary shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-base p-5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--danger)]/10 text-[var(--danger)]">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="team-confirm-title" className="text-base font-black text-primary leading-tight">{title}</h2>
            <p className="mt-1 text-xs font-medium leading-5 text-secondary">{description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Cerrar"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-base bg-subtle text-muted transition hover:bg-primary hover:text-primary disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col-reverse gap-2 p-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-11 rounded-xl border border-base bg-subtle px-4 text-xs font-black uppercase tracking-wider text-primary transition hover:bg-primary disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn('flex h-11 items-center justify-center gap-2 rounded-xl bg-[var(--danger)] px-4 text-xs font-black uppercase tracking-wider text-white transition hover:opacity-90 disabled:opacity-60')}
          >
            {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
            {busy ? 'Eliminando…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
