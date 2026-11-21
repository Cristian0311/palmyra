import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';

export default function OperationsDialog({ title, onClose, busy = false, size = 'md', children }: { title: string; onClose: () => void; busy?: boolean; size?: 'md' | 'lg'; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    className={cn('fixed m-auto w-[calc(100%-2rem)] max-h-[90dvh] rounded-2xl border border-base bg-secondary p-0 text-primary shadow-xl backdrop:bg-slate-950/60', size === 'lg' ? 'max-w-4xl' : 'max-w-2xl')}>
    <div className="flex justify-between items-center gap-3 p-5 border-b border-base">
      <h2 id={titleId} className="text-xl font-bold">{title}</h2>
      <button type="button" onClick={onClose} disabled={busy} aria-label="Cerrar ventana" className="rounded-xl border border-base flex items-center justify-center"><X size={20} /></button>
    </div>
    <div className="p-5 max-h-[calc(90dvh-5.5rem)] overflow-y-auto">{children}</div>
  </dialog>;
}
