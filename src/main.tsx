import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { applyDevicePerformanceProfile } from './utils/devicePerformance';
import { startPerformanceAudit } from './utils/performanceAudit';

applyDevicePerformanceProfile();
startPerformanceAudit();
import './index.css';

// Recover gracefully when a cached HTML/service-worker version references a
// chunk removed by a newer deployment. Vite emits this event for failed
// dynamic imports; prevent React from being left on a blank screen.
const CHUNK_RECOVERY_KEY = 'omnisync-chunk-recovery';
const CHUNK_RECOVERY_TTL_MS = 30_000;

const DYNAMIC_CHUNK_RECOVERY_KEY = 'palmyra-dynamic-chunk-recovery';
const DYNAMIC_CHUNK_RECOVERY_TTL_MS = 30_000;

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = String(reason?.message || reason || '');
  const looksLikeChunkFailure = /dynamically imported module|importing a module script failed|chunk|loading module/i.test(message);
  if (!looksLikeChunkFailure || !navigator.onLine) return;

  const now = Date.now();
  const previous = Number(sessionStorage.getItem(DYNAMIC_CHUNK_RECOVERY_KEY) || '0');
  if (!previous || now - previous > DYNAMIC_CHUNK_RECOVERY_TTL_MS) {
    sessionStorage.setItem(DYNAMIC_CHUNK_RECOVERY_KEY, String(now));
    event.preventDefault();
    window.location.reload();
  }
});

window.addEventListener('vite:preloadError', (event) => {
  const now = Date.now();
  const previous = Number(sessionStorage.getItem(CHUNK_RECOVERY_KEY) || '0');

  // Never reload an offline device just because a lazy chunk failed. A reload
  // cannot download a missing module and can turn a recoverable offline state
  // into a blank application. Online devices may refresh once to reconcile an
  // old HTML shell with the current hashed chunks.
  if (!navigator.onLine) {
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('omni:chunk-offline-error'));
    return;
  }

  if (!previous || now - previous > CHUNK_RECOVERY_TTL_MS) {
    sessionStorage.setItem(CHUNK_RECOVERY_KEY, String(now));
    event.preventDefault();
    window.location.reload();
  }
});

// Register Service Worker for Offline-First PWA support.
// The app must update itself after every Render deployment without requiring
// the user to manually clear the browser cache.

/**
 * PWA install bridge.
 * The browser can emit beforeinstallprompt before the authenticated shell
 * mounts, so keep the deferred event globally until Layout can present it.
 */
const PALMYRA_PWA_INSTALLED_KEY = 'palmyra:pwa-installed';

function isPALMYRAPWAInstalledAtBoot() {
  if (typeof window === 'undefined') return false;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
  const fullscreen = window.matchMedia?.('(display-mode: fullscreen)').matches;
  const minimalUi = window.matchMedia?.('(display-mode: minimal-ui)').matches;
  const windowControls = window.matchMedia?.('(display-mode: window-controls-overlay)').matches;
  const iosStandalone = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const rememberedInstalled = localStorage.getItem(PALMYRA_PWA_INSTALLED_KEY) === '1';
  return Boolean(standalone || fullscreen || minimalUi || windowControls || iosStandalone || rememberedInstalled);
}

window.addEventListener('beforeinstallprompt', (event) => {
  const installEvent = event as Event & {
    prompt?: () => Promise<void>;
    userChoice?: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  };

  // Never surface an installation prompt from an already-installed PALMYRA.
  // Android can keep firing beforeinstallprompt in browser contexts after the
  // PWA was installed, so the persistent marker is intentional.
  if (isPALMYRAPWAInstalledAtBoot()) {
    event.preventDefault();
    delete (window as typeof window & { __palmyraInstallPrompt?: unknown }).__palmyraInstallPrompt;
    return;
  }

  event.preventDefault();
  (window as typeof window & { __palmyraInstallPrompt?: typeof installEvent }).__palmyraInstallPrompt = installEvent;
  window.dispatchEvent(new Event('palmyra:pwa-install-available'));
});

window.addEventListener('appinstalled', () => {
  try { localStorage.setItem(PALMYRA_PWA_INSTALLED_KEY, '1'); } catch {}
  delete (window as typeof window & { __palmyraInstallPrompt?: unknown }).__palmyraInstallPrompt;
  window.dispatchEvent(new Event('palmyra:pwa-installed'));
});

if (isPALMYRAPWAInstalledAtBoot()) {
  delete (window as typeof window & { __palmyraInstallPrompt?: unknown }).__palmyraInstallPrompt;
}

import { registerSW } from 'virtual:pwa-register';

const SW_CHECK_INTERVAL_MS = 300_000;
let swCheckTimer: ReturnType<typeof setInterval> | null = null;

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // El usuario decide cuándo aplicar una nueva versión para no interrumpir
    // una venta, un arqueo o una operación offline.
    window.dispatchEvent(new CustomEvent('palmyra:update-available'));
  },
  onRegisteredSW(swUrl, registration) {
    if (!registration) return;

    const checkForFreshWorker = async () => {
      try {
        // Bypass intermediary/browser caching when checking the worker script.
        await fetch(swUrl, {
          cache: 'no-store',
          headers: {
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
          },
        });
        await registration.update();
      } catch (error) {
        // Connectivity can be transient on mobile; the next interval/focus
        // check will retry without disrupting the offline POS.
        console.debug('[PWA] Service Worker update check deferred:', error);
      }
    };

    void checkForFreshWorker();
    swCheckTimer = setInterval(checkForFreshWorker, SW_CHECK_INTERVAL_MS);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void checkForFreshWorker();
    };
    window.addEventListener('focus', checkForFreshWorker);
    document.addEventListener('visibilitychange', handleVisibility);

    // Store cleanup on the registration object without changing its public API.
    (registration as ServiceWorkerRegistration & { __omniCleanup?: () => void }).__omniCleanup = () => {
      if (swCheckTimer) {
        clearInterval(swCheckTimer);
        swCheckTimer = null;
      }
      window.removeEventListener('focus', checkForFreshWorker);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  },
  onOfflineReady() {
    console.log('App is ready for offline use.');
  },
  onRegisterError(error) {
    console.warn('[PWA] Service Worker registration error:', error);
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
