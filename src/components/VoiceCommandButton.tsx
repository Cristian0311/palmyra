import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

type Props = {
  onCommand: (text: string) => void;
  disabled?: boolean;
};

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  maxAlternatives: number;
};

export function VoiceCommandButton({ onCommand, disabled }: Props) {
  const recognitionRef = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSupported(!!SpeechRecognition);
    return () => {
      try { recognitionRef.current?.stop(); } catch {}
      recognitionRef.current = null;
    };
  }, []);

  const toggle = () => {
    if (disabled || !supported) return;
    if (listening) {
      try { recognitionRef.current?.stop(); } catch {}
      setListening(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSupported(false);
      return;
    }

    const recognition = new SpeechRecognition() as Recognition;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.lang = navigator.language?.toLowerCase().startsWith("es") ? navigator.language : "es-ES";
    recognition.onresult = (event) => {
      const text = event?.results?.[0]?.[0]?.transcript?.trim();
      if (text) {
        setMessage("");
        onCommand(text);
      }
    };
    recognition.onerror = (event) => {
      const code = event?.error || "";
      if (code === "not-allowed" || code === "service-not-allowed") {
        setMessage("Activa el permiso del micrófono.");
      } else if (code === "network") {
        setMessage("El reconocimiento de voz requiere un motor disponible en el dispositivo.");
      } else if (code) {
        setMessage("No se pudo reconocer la orden.");
      }
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setMessage("");
    setListening(true);
    try {
      recognition.start();
    } catch {
      setListening(false);
      setMessage("No se pudo activar el micrófono.");
    }
  };

  if (!supported) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        title={listening ? "Detener comando de voz" : "Comando de voz"}
        aria-label={listening ? "Detener comando de voz" : "Comando de voz"}
        className={cn(
          "shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-xl border transition-all",
          listening
            ? "bg-rose-50 border-rose-300 text-rose-600"
            : "bg-slate-50 border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-300",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
      </button>
      {listening && (
        <div className="palmyra-tooltip absolute right-0 top-11 z-[var(--z-tooltip)] whitespace-nowrap px-2.5 py-1.5 font-bold">
          Escuchando...
        </div>
      )}
      {message && !listening && (
        <div className="palmyra-tooltip absolute right-0 top-11 z-[var(--z-tooltip)] max-w-64 px-2.5 py-1.5 font-bold">
          {message}
        </div>
      )}
    </div>
  );
}
