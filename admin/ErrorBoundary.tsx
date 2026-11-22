import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, Wrench } from "lucide-react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class AdminErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[PALMYRA ADMIN] La interfaz no pudo dibujarse:", error, info.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  private repair = async () => {
    try {
      const registrations = await navigator.serviceWorker?.getRegistrations?.();
      await Promise.all((registrations || []).map((registration) => registration.unregister().catch(() => false)));
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key).catch(() => false)));
      }
    } catch {
      // Si el navegador bloquea la limpieza, la recarga igual reconcilia el shell.
    }
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="admin-auth">
        <section className="admin-auth-card" role="alert">
          <div className="admin-brand-mark"><AlertTriangle size={22} /></div>
          <p className="admin-eyebrow">PALMYRA · CONTROL CENTER</p>
          <h1>La consola no pudo dibujar esta sección</h1>
          <p className="admin-auth-copy">
            Tus datos siguen seguros. Recarga para reconciliar la versión publicada; si el problema continúa,
            repara la caché de la consola.
          </p>
          <pre className="admin-error-detail">{this.state.error.message || "Error de interfaz desconocido."}</pre>
          <div className="admin-error-actions">
            <button type="button" className="admin-btn admin-btn--primary" onClick={this.reload}>
              <RefreshCw size={15} />Recargar consola
            </button>
            <button type="button" className="admin-btn admin-btn--secondary" onClick={() => void this.repair()}>
              <Wrench size={15} />Reparar caché y recargar
            </button>
          </div>
        </section>
      </main>
    );
  }
}
