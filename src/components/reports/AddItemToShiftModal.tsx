import { useEffect } from 'react';

/** Legacy entry retained only to fail safely if an older caller still imports it. */
export default function AddItemToShiftModal({ onCancel }: { onCancel: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="palmyra-overlay z-[var(--z-modal)] flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <section role="dialog" aria-modal="true" aria-labelledby="report-correction-unavailable" className="palmyra-modal-panel palmyra-mobile-modal w-full max-w-md p-6 text-sm leading-relaxed text-primary max-h-[92dvh] overflow-y-auto">
        <h2 id="report-correction-unavailable" className="text-lg font-semibold">Los reportes son de consulta</h2>
        <p className="mt-3">No se crean ventas ni ingresos desde un informe. Para corregir una venta, usa una devolución o anulación con motivo y registro de auditoría.</p>
        <button type="button" autoFocus onClick={onCancel} className="mt-5 min-h-11 rounded-xl border border-base bg-subtle px-4 focus-visible:outline-2">Cerrar</button>
      </section>
    </div>
  );
}
