import React, { useState } from "react";
import { AlertTriangle, CheckCircle2, LogOut, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { loadSaaSContext, signOutSaaSAccount } from "../services/saas";
import { useStore } from "../store/useStore";

export default function AccountStatus() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [suspended, setSuspended] = useState(false);

  const refresh = async () => {
    setBusy(true);
    setMessage("");
    try {
      const ctx = await loadSaaSContext(true);
      setSuspended(Boolean(ctx?.membershipStatus && ctx.membershipStatus !== "active" && !ctx?.company));
      if (ctx?.company?.account_status === "active" && ctx?.membershipStatus === "active") {
        useStore.setState({ currentUser: ctx.user, currentBranchId: ctx.warehouseIds[0] || "" });
        navigate("/", { replace: true });
      } else {
        setMessage(ctx?.membershipStatus && ctx.membershipStatus !== "active"
          ? "Tu acceso a esta empresa está suspendido o revocado. Un administrador debe reactivarlo."
          : "La cuenta todavía no está habilitada para entrar al panel.");
      }
    } catch (err: any) {
      setMessage(err?.message || "No se pudo comprobar el estado.");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    await signOutSaaSAccount();
    useStore.setState({ currentUser: null, currentBranchId: "", activeSessionId: null, cart: [] });
    navigate("/auth", { replace: true });
  };

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 flex items-center justify-center">
      <div className="w-full max-w-lg bg-white border border-slate-200 rounded-[2rem] shadow-xl p-7 sm:p-9 text-center">
        <div className="w-16 h-16 mx-auto rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center">
          <AlertTriangle className="w-8 h-8" />
        </div>
        <p className="text-[10px] font-black tracking-[0.18em] uppercase text-slate-400 mt-6">Estado de la cuenta</p>
        <h1 className="text-2xl font-black text-slate-950 mt-2">{suspended ? "Acceso suspendido" : "La empresa necesita activación"}</h1>
        <p className="text-sm text-slate-500 mt-3 leading-6">
          {suspended
            ? "Tu cuenta sigue existiendo, pero el acceso a esta empresa está suspendido."
            : "Tu empresa está creada, pero el plan seleccionado necesita completar su activación antes de usar el panel."}
        </p>
        <div className="rounded-2xl bg-slate-50 border border-slate-200 text-left p-4 mt-6 text-sm text-slate-600">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 shrink-0" />
            La empresa y su almacén ya están registrados.
          </div>
          <div className="flex items-start gap-2 mt-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 shrink-0" />
            La solicitud de plan quedó asociada a tu empresa.
          </div>
        </div>
        {message && <div className="rounded-xl border border-slate-200 bg-white p-3 mt-4 text-sm text-slate-600">{message}</div>}
        <div className="grid sm:grid-cols-2 gap-3 mt-6">
          <button type="button" onClick={refresh} disabled={busy} className="h-11 rounded-xl bg-slate-950 text-white font-bold flex items-center justify-center gap-2 disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />
            Comprobar
          </button>
          <button type="button" onClick={signOut} disabled={busy} className="h-11 rounded-xl border border-slate-200 text-slate-700 font-bold flex items-center justify-center gap-2">
            <LogOut className="w-4 h-4" />
            Cerrar sesión
          </button>
        </div>
      </div>
    </main>
  );
}
