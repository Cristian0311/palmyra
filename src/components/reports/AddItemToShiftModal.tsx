/** Legacy entry retained only to fail safely if an older caller still imports it. */
export default function AddItemToShiftModal({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby="report-correction-unavailable" className="w-full max-w-md rounded-2xl border border-base bg-secondary p-6 text-sm leading-relaxed text-primary">
        <h2 id="report-correction-unavailable" className="text-lg font-semibold">Los reportes son de consulta</h2>
        <p className="mt-3">No se crean ventas ni ingresos desde un informe. Para corregir una venta, usa una devolución o anulación con motivo y registro de auditoría.</p>
        <button type="button" autoFocus onClick={onCancel} className="mt-5 min-h-11 rounded-xl border border-base bg-subtle px-4 focus-visible:outline-2">Cerrar</button>
      </section>
    </div>
  );
}
