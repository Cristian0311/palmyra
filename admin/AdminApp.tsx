import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { AlertCircle, RefreshCw, Shield, ShieldCheck } from "lucide-react";
import { loadPlatformSnapshot, type PlatformSnapshot } from "./platformAdminApi";
import { adminSignIn, adminSignOut, adminUser, getAdminSupabase } from "./supabase";
import { Button } from "./shared";
import "./admin.css";

const AdminShell = lazy(() => import("./AdminShell"));

function LoginScreen({ onAuthenticated }: { onAuthenticated: (snapshot: PlatformSnapshot) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const { error: signInError } = await adminSignIn(email, password);
      if (signInError) throw signInError;
      const snapshot = await loadPlatformSnapshot();
      onAuthenticated(snapshot);
    } catch (err) {
      await adminSignOut().catch(() => undefined);
      setError(err instanceof Error ? err.message : "No se pudo validar el acceso administrativo.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="admin-auth">
      <div className="admin-auth__glow admin-auth__glow--one" />
      <div className="admin-auth__glow admin-auth__glow--two" />
      <section className="admin-auth-card">
        <div className="admin-brand-mark"><span>✦</span></div>
        <p className="admin-eyebrow">PALMYRA · CONTROL CENTER</p>
        <h1>Acceso administrativo</h1>
        <p className="admin-auth-copy">
          Una consola independiente para operar el SaaS sin mezclar la administración de PALMYRA con el CRM de las empresas.
        </p>
        <form onSubmit={submit} className="admin-auth-form">
          <label>
            <span>Correo administrativo</span>
            <input
              autoComplete="username"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@palmyra..."
              required
            />
          </label>
          <label>
            <span>Contraseña</span>
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </label>
          {error ? <div className="admin-alert admin-alert--error"><AlertCircle size={16} />{error}</div> : null}
          <Button type="submit" variant="primary" disabled={loading} className="admin-auth-submit">
            {loading ? <RefreshCw size={16} className="spin" /> : <ShieldCheck size={16} />}
            {loading ? "Validando acceso..." : "Entrar al centro de control"}
          </Button>
        </form>
        <div className="admin-auth-foot">
          <Shield size={14} />
          La autorización real se verifica en Supabase mediante RPC seguro.
        </div>
      </section>
    </main>
  );
}
export default function AdminApp() {
  const [booting, setBooting] = useState(true);
  const [snapshot, setSnapshot] = useState<PlatformSnapshot | null>(null);

  const authenticateExistingSession = async () => {
    try {
      await adminUser();
      setSnapshot(await loadPlatformSnapshot());
    } catch {
      await adminSignOut().catch(() => undefined);
      setSnapshot(null);
    } finally {
      setBooting(false);
    }
  };

  useEffect(() => {
    void authenticateExistingSession();
    const { data } = getAdminSupabase().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") setSnapshot(null);
      if (event === "SIGNED_IN") void authenticateExistingSession();
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (booting) {
    return <main className="admin-auth admin-auth--boot"><div className="admin-brand-mark admin-brand-mark--pulse"><span>✦</span></div><p>Validando sesión administrativa…</p></main>;
  }

  if (!snapshot) {
    return <LoginScreen onAuthenticated={setSnapshot} />;
  }

  return (
    <Suspense fallback={<main className="admin-auth admin-auth--boot"><div className="admin-brand-mark admin-brand-mark--pulse"><span>✦</span></div><p>Cargando centro de control…</p></main>}>
      <AdminShell snapshot={snapshot} onSnapshotChange={setSnapshot} />
    </Suspense>
  );
}
