import React, { useEffect, useState } from "react";
import { Download, ExternalLink, Smartphone, X } from "lucide-react";
import { getPalmyraScopedStorageKey } from "../../services/localScope";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;

function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

function isIOS() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isMobileLike() {
  if (typeof window === "undefined") return false;
  return navigator.maxTouchPoints > 0 || window.matchMedia("(max-width: 900px)").matches;
}

function installedKey() {
  return getPalmyraScopedStorageKey("palmyra_pwa_installed_v1") || "palmyra_pwa_installed_v1";
}

export default function PwaInstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ios, setIos] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const check = () => {
      const standalone = isStandalone();
      const iosDevice = isIOS();
      const mobile = isMobileLike();
      const alreadyInstalled = localStorage.getItem(installedKey()) === "1";
      setInstalled(standalone || alreadyInstalled);
      setIos(iosDevice);
      if (standalone || alreadyInstalled || !mobile) setVisible(false);
    };

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      deferredInstallPrompt = event as BeforeInstallPromptEvent;
      check();
    };

    const onInstalled = () => {
      deferredInstallPrompt = null;
      try { localStorage.setItem(installedKey(), "1"); } catch {}
      setInstalled(true);
      setVisible(false);
      setBusy(false);
    };

    const onTutorialFinished = () => {
      check();
      if (!isStandalone() && isMobileLike() && localStorage.getItem(installedKey()) !== "1") {
        setVisible(Boolean(deferredInstallPrompt) || isIOS());
      }
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall as EventListener);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("palmyra:tutorial-finished", onTutorialFinished);
    check();

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall as EventListener);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("palmyra:tutorial-finished", onTutorialFinished);
    };
  }, []);

  if (!visible || installed) return null;

  const install = async () => {
    if (!deferredInstallPrompt) return;
    setBusy(true);
    try {
      await deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === "accepted") {
        try { localStorage.setItem(installedKey(), "1"); } catch {}
        setInstalled(true);
        setVisible(false);
      } else {
        deferredInstallPrompt = null;
        setVisible(false);
      }
    } catch {
      deferredInstallPrompt = null;
      setVisible(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-x-0 bottom-4 z-[10040] flex justify-center px-4">
      <section className="w-full max-w-md rounded-3xl border border-violet-200 bg-white p-4 shadow-2xl shadow-slate-950/15">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet-50 text-violet-600">
            <Smartphone className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-violet-600">PALMYRA en tu teléfono</p>
            <h3 className="mt-1 text-base font-black text-slate-900">Instala la aplicación</h3>
            <p className="mt-1 text-xs leading-5 text-slate-600">
              Ábrela como una aplicación independiente y aprovecha el modo offline ya preparado en PALMYRA.
            </p>

            {ios && !deferredInstallPrompt ? (
              <div className="mt-3 rounded-2xl bg-slate-50 p-3 text-xs font-semibold leading-5 text-slate-600">
                En iPhone o iPad: pulsa <strong>Compartir</strong> en Safari y elige <strong>Añadir a pantalla de inicio</strong>.
              </div>
            ) : null}

            <div className="mt-4 flex items-center gap-2">
              {deferredInstallPrompt ? (
                <button
                  type="button"
                  onClick={() => void install()}
                  disabled={busy}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-xs font-black text-white disabled:opacity-60"
                >
                  <Download className="h-4 w-4" />
                  {busy ? "Instalando…" : "Instalar PALMYRA"}
                </button>
              ) : (
                <span className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-wide text-slate-400">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Sigue las instrucciones del navegador
                </span>
              )}
              <button
                type="button"
                onClick={() => setVisible(false)}
                className="ml-auto rounded-xl p-2 text-slate-400 hover:bg-slate-100"
                aria-label="Cerrar aviso de instalación"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
