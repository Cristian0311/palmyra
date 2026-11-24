/**
 * Toast central de PALMYRA con contrato de UI:
 *   - clase `.palmyra-toast` con variantes -success/-error/-warning/-info
 *   - z-index `var(--z-toast)` (110) aplicado por el host, nunca números sueltos
 *   - cola con autodismiss, límite de apilado y cierre manual
 *   - host con `aria-live` para lectores de pantalla
 *
 * El sistema global de avisos del shell (store `addNotification`) sigue siendo
 * el canal de la app; este componente es la implementación reutilizable del
 * contrato para pantallas y módulos.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import "./toast.css";

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
}

/** Clase contrato: `.palmyra-toast` + variante por token de color. */
export function palmyraToastClass(variant: ToastVariant): string {
  return cn("palmyra-toast", `palmyra-toast-${variant}`);
}

export interface ToastStackOptions {
  /** Autodismiss en ms. Los mensajes largos (>90 chars) duran el doble. */
  ttlMs?: number;
  /** Máximo de toasts apilados a la vez; los más viejos se descartan. */
  max?: number;
}

/**
 * Cola de toasts con autodismiss. `push` devuelve el id para permitir
 * despedirlo manualmente. Los temporizadores se limpian al despedir.
 */
export function useToastStack(options: ToastStackOptions = {}) {
  const ttlMs = options.ttlMs ?? 4000;
  const max = options.max ?? 4;
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const push = useCallback((variant: ToastVariant, message: string) => {
    const id = crypto.randomUUID();
    const item: ToastItem = { id, variant, message };
    setToasts((items) => [...items, item].slice(-max));
    const duration = message.length > 90 ? ttlMs * 2 : ttlMs;
    const timer = setTimeout(() => dismiss(id), duration);
    timers.current.set(id, timer);
    return id;
  }, [dismiss, max, ttlMs]);

  // Limpieza al desmontar: ningún temporizador huérfano.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

export interface ToastHostProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

/** Stack visual de toasts; se ubica solo con el token de z-index. */
export function ToastHost({ toasts, onDismiss }: ToastHostProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="palmyra-toast-host" aria-live="polite" role="status">
      {toasts.map((toast) => (
        <div key={toast.id} className={palmyraToastClass(toast.variant)}>
          <span className="min-w-0 flex-1 break-words">{toast.message}</span>
          <button
            type="button"
            className="palmyra-toast-close"
            onClick={() => onDismiss(toast.id)}
            aria-label="Cerrar aviso"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
