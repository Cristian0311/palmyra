import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, HardDriveDownload, Usb } from "lucide-react";
import { getNativeAppInfo } from "../../lib/nativeApp";

type Phase =
  | { kind: "idle" }
  | { kind: "waiting"; what: "apk" | "bundle" }
  | { kind: "error"; message: string }
  | { kind: "installed"; version: string | null };

/**
 * Actualización sin Internet desde un archivo copiado por USB/SD.
 *
 * El shell ya verifica firma del desarrollador, versión estrictamente mayor y
 * hash del paquete; aquí solo se abre el selector y se muestra el resultado.
 */
export default function AndroidManualUpdate() {
  const native = getNativeAppInfo();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    if (!native) return;
    const onInstalled = (event: Event) => {
      const version = (event as CustomEvent<{ version?: string }>).detail?.version ?? null;
      setPhase({ kind: "installed", version });
    };
    const onError = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      setPhase({ kind: "error", message: message || "La actualización desde archivo no se pudo aplicar." });
    };
    window.addEventListener("palmyra:ota-installed", onInstalled);
    window.addEventListener("palmyra:ota-error", onError);
    return () => {
      window.removeEventListener("palmyra:ota-installed", onInstalled);
      window.removeEventListener("palmyra:ota-error", onError);
    };
  }, [native]);

  if (!native) return null;
  const bridge = typeof window === "undefined" ? undefined : window.PALMYRA_NATIVE;
  const canApk = typeof bridge?.importApk === "function";
  const canBundle = typeof bridge?.importBundle === "function";
  if (!canApk && !canBundle) return null;

  const start = (what: "apk" | "bundle") => {
    setPhase({ kind: "waiting", what });
    try {
      if (what === "apk") bridge?.importApk?.();
      else bridge?.importBundle?.();
    } catch {
      setPhase({ kind: "error", message: "El instalador no permitió abrir el selector de archivos." });
    }
  };

  return (
    <div className="rounded-2xl border border-base bg-primary p-4 space-y-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-600">
          <HardDriveDownload size={18} />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-primary">Actualizar desde archivo (USB/SD)</h3>
          <p className="text-xs text-muted">
            Copia el APK o el paquete .zip al dispositivo y elígelo aquí. Solo se aplican versiones más nuevas y con firma válida.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {canBundle && (
          <button
            type="button"
            onClick={() => start("bundle")}
            disabled={phase.kind === "waiting"}
            className="h-11 rounded-xl border border-base bg-secondary text-primary text-sm font-semibold flex items-center justify-center gap-2 hover:bg-subtle transition-colors disabled:opacity-50"
          >
            <Usb size={16} /> Paquete web (.zip)
          </button>
        )}
        {canApk && (
          <button
            type="button"
            onClick={() => start("apk")}
            disabled={phase.kind === "waiting"}
            className="h-11 rounded-xl border border-base bg-secondary text-primary text-sm font-semibold flex items-center justify-center gap-2 hover:bg-subtle transition-colors disabled:opacity-50"
          >
            <Usb size={16} /> Instalar APK
          </button>
        )}
      </div>

      <div role="status" aria-live="polite" className="text-xs">
        {phase.kind === "waiting" && <p className="text-muted">Elige el archivo en el selector del sistema…</p>}
        {phase.kind === "error" && (
          <p className="flex items-start gap-1.5 text-rose-600">
            <AlertCircle size={14} className="mt-0.5 shrink-0" /> {phase.message}
          </p>
        )}
        {phase.kind === "installed" && (
          <p className="flex items-start gap-1.5 text-emerald-600">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            Actualización aplicada{phase.version ? ` (${phase.version})` : ""}. La app se recargará.
          </p>
        )}
      </div>
    </div>
  );
}
