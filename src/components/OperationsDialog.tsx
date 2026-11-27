import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';

export default function OperationsDialog({ title, onClose, busy = false, size = 'md', children }: { title: string; onClose: () => void; busy?: boolean; size?: 'md' | 'lg'; children: ReactNode }) {
  const titleId = useId();
  // El efecto debe vivir solo el montaje: los padres pasan `onClose` como flecha
  // inline, así que con deps [busy, onClose] cada tecla re-ejecutaba el cleanup y
  // devolvía el foco al campo activo al abrir (el de Nombre), robándoselo al actual.
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  const modalRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    closeRef.current = onClose;
    busyRef.current = busy;
  });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busyRef.current) closeRef.current(); };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      // Solo si el foco sigue dentro del diálogo: si el usuario lo sacó fuera,
      // no se lo devolvemos a un disparador que ya no es su punto de interés.
      if (previous && modalRef.current?.contains(previous)) previous.focus();
    };
  }, []);
  return (
    <div
      role="presentation"
      className="palmyra-overlay z-[var(--z-modal)] flex items-end justify-center p-0 sm:items-center sm:p-4"
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <section
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn('palmyra-modal-panel palmyra-mobile-modal flex max-h-[92dvh] w-full flex-col overflow-hidden p-0 text-primary', size === 'lg' ? 'sm:max-w-4xl' : 'sm:max-w-2xl')}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-base p-4">
          <h2 id={titleId} className="text-base font-semibold text-primary">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Cerrar ventana" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-base text-muted transition-colors hover:bg-subtle hover:text-primary disabled:opacity-50"><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </section>
    </div>
  );
}
