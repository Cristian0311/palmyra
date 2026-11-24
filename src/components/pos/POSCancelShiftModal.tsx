import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

type Props = {
  open: boolean;
  isCancelling: boolean;
  onCancel: () => void;
  onClose: () => void;
};

const CONSEQUENCES = [
  "Se elimina el turno y su historial de caja.",
  "Se borran todos los tickets vendidos en el turno.",
  "El stock de esos productos vuelve al inventario.",
  "No queda el turno marcado como cancelado: desaparece por completo.",
];

export function POSCancelShiftModal({
  open,
  isCancelling,
  onCancel,
  onClose,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="palmyra-overlay z-[var(--z-confirm)] flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="palmyra-modal-panel w-full max-w-sm max-h-[92dvh] overflow-y-auto animate-in zoom-in-95">
        <div className="space-y-4 p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-[var(--danger)]">
              <TriangleAlert className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-black uppercase leading-tight tracking-tight text-primary">Eliminar turno</h3>
              <p className="mt-1 text-xs font-semibold leading-relaxed text-secondary">
                Esta acción es definitiva y deja el turno como si nunca hubiera existido.
              </p>
            </div>
          </div>

          <ul className="space-y-1.5 rounded-2xl border border-base bg-subtle p-3">
            {CONSEQUENCES.map(item => (
              <li key={item} className="flex items-start gap-2 text-xs font-semibold leading-snug text-secondary">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />
                {item}
              </li>
            ))}
          </ul>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-11 flex-1 rounded-2xl border border-base bg-secondary text-xs font-black uppercase tracking-wider text-secondary transition-colors hover:bg-subtle"
            >
              Volver
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={isCancelling}
              className="h-11 flex-[1.6] rounded-2xl bg-[var(--danger)] text-xs font-black uppercase tracking-wider text-white transition-all hover:brightness-95 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isCancelling ? "Eliminando..." : "Eliminar turno"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
