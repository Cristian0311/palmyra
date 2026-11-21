import { useStore } from '../store/useStore';

type BusyOptions = { delayMs?: number; minVisibleMs?: number };

/**
 * Ejecuta una operación lenta mostrando una burbuja de carga global.
 * La burbuja aparece tras un breve retraso para no parpadear en acciones
 * que terminan al instante, y permanece visible al menos un instante mínimo
 * para que el usuario perciba que el sistema respondió.
 */
export async function runWithLoading<T>(message: string, task: () => Promise<T>, options: BusyOptions = {}): Promise<T> {
  const { addNotification, removeNotification } = useStore.getState();
  const delayMs = options.delayMs ?? 200;
  const minVisibleMs = options.minVisibleMs ?? 450;
  let id: string | null = null;
  let shownAt = 0;

  const timer = setTimeout(() => {
    id = addNotification(message, 'loading');
    shownAt = Date.now();
  }, delayMs);

  try {
    return await task();
  } finally {
    clearTimeout(timer);
    if (id) {
      const remaining = Math.max(0, minVisibleMs - (Date.now() - shownAt));
      if (remaining) await new Promise(resolve => setTimeout(resolve, remaining));
      removeNotification(id);
    }
  }
}
