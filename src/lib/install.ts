export const ANDROID_APK_DOWNLOAD =
  (import.meta.env.VITE_ANDROID_DOWNLOAD_URL as string | undefined)?.trim() || '/download/android';

export const APK_PROMO_DISMISSED_KEY = 'palmyra:apk-promo-dismissed';

export function isAndroidDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent);
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function isRunningStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone
  );
}
