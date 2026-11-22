import React, { ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  /**
   * "app" (por defecto) = pantalla completa de recuperación del shell.
   * "content" = aisla el fallo de una página para que la navegación y el resto
   * del shell sigan operativos; ofrece «Recargar sección» sin recargar la app.
   */
  variant?: "app" | "content";
  title?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  resetCount: number;
}

// Errores que no indican que la app esté rota: observadores de tamaño,
// cancelaciones de fetch y scripts de terceros sin información. Sustituir la
// pantalla completa por cualquiera de ellos cierra la sesión de trabajo del
// usuario sin motivo (p. ej. al tocar una gráfica de recharts).
const BENIGN_GLOBAL_ERROR_PATTERNS = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /AbortError/i,
  /The operation was aborted/i,
  /The user aborted a request/i,
  /^NotAllowedError/i,
  /Non-Error promise rejection/i,
];

function isBenignGlobalError(message: string): boolean {
  return BENIGN_GLOBAL_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

// React montado = el árbol sigue vivo en pantalla. Un fallo global (handler de
// click, promesa de fondo, callback de una gráfica) no justifica reemplazar la
// aplicación: React solo desmonta el árbol cuando un render se rompe sin
// boundary, y entonces #root queda vacío.
function isReactStillMounted(): boolean {
  const root = document.getElementById("root");
  return !!root && root.childElementCount > 0;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = {
    hasError: false,
    error: null,
    resetCount: 0,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public override componentDidMount() {
    // El ámbito de contenido no escucha eventos globales: esos fallos los
    // centraliza la instancia de nivel de aplicación. Escucharlos aquí haría
    // que un rechazo de una promesa de fondo sustituyera la página actual.
    if (this.props.variant === "content") return;
    // React Error Boundaries no capturan errores fuera del render (por ejemplo,
    // fallos globales de ejecución o promesas rechazadas sin manejar). Mostrar
    // una pantalla recuperable evita dejar la ventana aparentemente en blanco.
    window.addEventListener("error", this.handleWindowError);
    window.addEventListener("unhandledrejection", this.handleUnhandledRejection);
  }

  public override componentWillUnmount() {
    if (this.props.variant === "content") return;
    window.removeEventListener("error", this.handleWindowError);
    window.removeEventListener("unhandledrejection", this.handleUnhandledRejection);
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error in component tree:", error, errorInfo);
  }

  private handleWindowError = (event: ErrorEvent) => {
    const message = event.error instanceof Error ? event.error.message : event.message;
    console.error("[PALMYRA] Error global de ejecución:", event.error || event.message);
    if (isBenignGlobalError(message || "")) return;
    if (isReactStillMounted()) return;
    this.setState((state) => state.hasError ? null : {
      hasError: true,
      error: event.error instanceof Error ? event.error : new Error(event.message || "Error inesperado de ejecución"),
    });
  };

  private handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason ?? "");
    console.error("[PALMYRA] Promesa sin manejar:", reason);
    // Un rechazo de fondo no rompe la interfaz: ya está montada y operativa.
    if (isBenignGlobalError(message) || isReactStillMounted()) return;
    this.setState((state) => state.hasError ? null : {
      hasError: true,
      error: reason instanceof Error ? reason : new Error(message || "Operación inesperada"),
    });
  };

  private handleReload = () => {
    window.location.reload();
  };

  private handleHardReset = () => {
    // La recuperación nunca debe borrar ventas, la cola offline ni la sesión.
    window.location.reload();
  };

  // Recuperación sin recargar: vuelve a montar el contenido de la sección.
  // El estado del store (carrito, cola offline, turno) se conserva intacto.
  private handleResetSection = () => {
    this.setState((state) => ({
      hasError: false,
      error: null,
      resetCount: state.resetCount + 1,
    }));
  };

  public override render() {
    if (this.state.hasError && this.props.variant === "content") {
      return (
        <div className="flex min-h-[40vh] w-full items-center justify-center p-4" role="alert" aria-live="assertive">
          <div className="w-full max-w-md rounded-2xl border border-rose-100 bg-white p-5 text-center shadow-sm">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <h2 className="mt-3 text-sm font-black uppercase tracking-tight text-slate-900">
              {this.props.title || "Esta sección encontró un problema"}
            </h2>
            <p className="mt-1.5 text-[10px] font-bold leading-4 text-slate-500">
              El resto de PALMYRA sigue funcionando. No se perdió ninguna venta ni operación pendiente.
            </p>
            {this.state.error?.message && (
              <div className="mt-2 max-h-20 overflow-y-auto break-words rounded-xl border border-slate-200 bg-slate-50 p-2 text-left font-mono text-[9px] text-rose-700">
                {this.state.error.message}
              </div>
            )}
            <button
              type="button"
              onClick={this.handleResetSection}
              className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-[#6535C5] text-[10px] font-black uppercase tracking-wider text-white active:scale-[.98]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Recargar sección
            </button>
          </div>
        </div>
      );
    }

    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center p-6">
          <div className="bg-slate-800 border border-slate-700 rounded-3xl p-6 sm:p-8 max-w-md w-full text-center shadow-2xl space-y-5 animate-in zoom-in-95">
            <div className="w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-7 h-7" />
            </div>
            
            <div className="space-y-1.5">
              <h2 className="text-lg font-black tracking-tight text-white uppercase">
                Problema Detectado en Dispositivo
              </h2>
              <p className="text-xs text-slate-400 font-medium">
                La aplicación encontró un bloqueo o datos locales desactualizados en este dispositivo.
              </p>
            </div>

            {this.state.error?.message && (
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-[10px] text-rose-300 font-mono text-left break-words max-h-24 overflow-y-auto">
                {this.state.error.message}
              </div>
            )}

            <div className="flex flex-col gap-2.5 pt-2">
              <button
                onClick={this.handleReload}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-lg active:scale-95"
              >
                <RefreshCw className="w-4 h-4" />
                Recargar Pantalla
              </button>

              <button
                onClick={this.handleHardReset}
                className="w-full py-2.5 bg-slate-700/60 hover:bg-rose-950/40 text-slate-300 hover:text-rose-300 border border-slate-600/50 hover:border-rose-800 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2 active:scale-95"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reiniciar sin borrar datos
              </button>
            </div>
          </div>
        </div>
      );
    }

    // La clave solo cambia en el ámbito de contenido tras «Recargar sección»,
    // para forzar un montaje limpio de la página sin recargar la aplicación.
    return (
      <React.Fragment key={this.props.variant === "content" ? this.state.resetCount : "app"}>
        {this.props.children}
      </React.Fragment>
    );
  }
}
