import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import PwaInstallPrompt from './components/help/PwaInstallPrompt';
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
import { registerSW } from 'virtual:pwa-register';

const SW_CHECK_INTERVAL_MS = 300_000;
let swCheckTimer: ReturnType<typeof setInterval> | null = null;

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // autoUpdate already enables skipWaiting/clientsClaim; explicitly applying
    // the new worker makes the freshly deployed shell/chunks active immediately.
    updateSW(true);
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
    <PwaInstallPrompt />
  </StrictMode>,
);
