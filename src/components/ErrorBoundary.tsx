import React, { ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidMount() {
    // React Error Boundaries no capturan errores fuera del render (por ejemplo,
    // fallos globales de ejecución o promesas rechazadas sin manejar). Mostrar
    // una pantalla recuperable evita dejar la ventana aparentemente en blanco.
    window.addEventListener("error", this.handleWindowError);
    window.addEventListener("unhandledrejection", this.handleUnhandledRejection);
  }

  public override componentWillUnmount() {
    window.removeEventListener("error", this.handleWindowError);
    window.removeEventListener("unhandledrejection", this.handleUnhandledRejection);
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error in component tree:", error, errorInfo);
  }

  private handleWindowError = (event: ErrorEvent) => {
    console.error("[PALMYRA] Error global de ejecución:", event.error || event.message);
    this.setState((state) => state.hasError ? null : {
      hasError: true,
      error: event.error instanceof Error ? event.error : new Error(event.message || "Error inesperado de ejecución"),
    });
  };

  private handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    console.error("[PALMYRA] Promesa sin manejar:", event.reason);
    const reason = event.reason;
    this.setState((state) => state.hasError ? null : {
      hasError: true,
      error: reason instanceof Error ? reason : new Error(String(reason || "Operación inesperada")),
    });
  };

  private handleReload = () => {
    window.location.reload();
  };

  private handleHardReset = () => {
    // La recuperación nunca debe borrar ventas, la cola offline ni la sesión.
    window.location.reload();
  };

  public override render() {
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
                <Trash2 className="w-3.5 h-3.5" />
                Limpiar Caché Local y Reparar
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
