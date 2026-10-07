import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import AdminApp from "./AdminApp";
import "./admin.css";

class AdminBootstrapBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[PALMYRA ADMIN BOOT]", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="admin-auth admin-error-screen">
          <section className="admin-auth-card">
            <div className="admin-brand-mark"><span>!</span></div>
            <p className="admin-eyebrow">PALMYRA · CONTROL CENTER</p>
            <h1>No se pudo iniciar el panel</h1>
            <p className="admin-auth-copy">
              PALMYRA detectó un error de arranque y evitó dejar una pantalla en blanco.
            </p>
            <div className="admin-alert admin-alert--error">
              {this.state.error.message || "Error inesperado de interfaz."}
            </div>
            <div className="admin-error-actions">
              <button type="button" className="admin-btn admin-btn--primary" onClick={() => window.location.reload()}>
                Recargar panel
              </button>
              <button type="button" className="admin-btn admin-btn--secondary" onClick={() => localStorage.clear()}>
                Limpiar sesión local y recargar
              </button>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

const root = document.getElementById("admin-root");

if (!root) {
  document.body.innerHTML = "<main style='padding:40px;font-family:system-ui'>No se encontró el contenedor de PALMYRA Admin.</main>";
  throw new Error("No se encontró #admin-root.");
}

createRoot(root).render(
  <AdminBootstrapBoundary>
    <AdminApp />
  </AdminBootstrapBoundary>,
);
