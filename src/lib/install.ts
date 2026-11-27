// `import.meta.env` solo existe en el build de Vite: fuera de él (pruebas con
// tsx) es undefined, y leer propiedades directas reventaba el import del módulo.
const buildEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const ANDROID_APK_DOWNLOAD =
  buildEnv.VITE_ANDROID_DOWNLOAD_URL?.trim() || '/download/android';

// Origen público de PALMYRA. Dentro del APK la web se sirve desde
// 127.0.0.1, así que las descargas y la versión nueva deben pedirse siempre
// a este origen remoto.
export const PALMYRA_REMOTE_ORIGIN =
  buildEnv.VITE_APP_ORIGIN?.trim() || 'https://palmyracrm.onrender.com';

export const REMOTE_APK_DOWNLOAD = `${PALMYRA_REMOTE_ORIGIN}/download/android`;

export function isPalmyraApp(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /PALMYRAApp\//i.test(navigator.userAgent);
}

export const APK_PROMO_DISMISSED_KEY = 'palmyra:apk-promo-dismissed';

export function isAndroidDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent);
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

// En iOS todos los navegadores usan WebKit, pero solo Safari puede añadir la
// app a la pantalla de inicio. Devuelve null fuera de iOS.
export function getIosBrowserName(): string | null {
  if (!isIosDevice()) return null;
  const ua = navigator.userAgent;
  const known: Array<[RegExp, string]> = [
    [/CriOS/i, 'Chrome'],
    [/FxiOS/i, 'Firefox'],
    [/EdgiOS/i, 'Edge'],
    [/OPiOS/i, 'Opera'],
    [/DuckDuckGo/i, 'DuckDuckGo']
  ];
  for (const [pattern, name] of known) {
    if (pattern.test(ua)) return name;
  }
  if (/Safari\//i.test(ua)) return 'Safari';
  return 'otro navegador';
}

export function isRunningStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone
  );
}
