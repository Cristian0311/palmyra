import { useEffect, useState } from "react";
import { Download, X, Smartphone } from "lucide-react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function PWAInstallPrompt({
  visible,
  onClose
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const media = window.matchMedia?.("(display-mode: standalone)");
    const standalone = media?.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) {
      setInstalled(true);
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const done = () => {
      setInstalled(true);
      onClose();
    };

    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("appinstalled", done);
    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", done);
    };
  }, [onClose]);

  if (!visible || installed) return null;

  const install = async () => {
    if (!event) return;
    await event.prompt();
    const choice = await event.userChoice;
    setEvent(null);
    if (choice.outcome === "accepted") {
      setInstalled(true);
      onClose();
    }
  };

  const close = () => onClose();

  return (
    <div className="pwa-install-backdrop" role="dialog" aria-modal="true" aria-label="Instalar PALMYRA">
      <div className="pwa-install-card">
        <button type="button" className="pwa-install-close" onClick={close} aria-label="Cerrar">
          <X size={17} />
        </button>
        <div className="pwa-install-icon"><Smartphone size={25} /></div>
        <span className="pwa-install-kicker">NUMA · RECORRIDO COMPLETADO</span>
        <h2>Ten PALMYRA siempre contigo</h2>
        <p>El recorrido terminó. Ahora puedes instalar PALMYRA como aplicación para abrir tu negocio más rápido desde el dispositivo.</p>
        {event ? (
          <button type="button" className="pwa-install-primary" onClick={install}>
            <Download size={17} /> Instalar PALMYRA
          </button>
        ) : (
          <div className="pwa-install-manual">
            <strong>Instalación rápida</strong>
            <span>Si el navegador no muestra el botón automático, abre su menú y selecciona <b>Instalar aplicación</b> o <b>Añadir a pantalla de inicio</b>.</span>
          </div>
        )}
        <button type="button" className="pwa-install-later" onClick={close}>Ahora no</button>
      </div>
    </div>
  );
}
