import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { applyDevicePerformanceProfile } from './utils/devicePerformance';
import { startPerformanceAudit } from './utils/performanceAudit';

applyDevicePerformanceProfile();
startPerformanceAudit();
import './index.css';

// Las estaciones que abren PALMYRA por LAN (http://IP:puerto) son origen
// inseguro: algunos navegadores no exponen crypto.randomUUID y toda la app
// lo usa para IDs de ventas, turnos y cola offline. Se garantiza aquí.
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  (crypto as unknown as { randomUUID?: () => string }).randomUUID = () => {
    const bytes = new Uint8Array(16);
    if (typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
import { protectPwaStorage } from './services/pwaStorageHealth';

// Recover gracefully when a cached HTML/service-worker version references a
// chunk removed by a newer deployment. Vite emits this event for failed
// dynamic imports; prevent React from being left on a blank screen.
const CHUNK_RECOVERY_KEY = 'palmyra-chunk-recovery';
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
    window.dispatchEvent(new CustomEvent('palmyra:chunk-offline-error'));
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

const SW_CHECK_INTERVAL_MS = 5 * 60_000;
const PALMYRA_UPDATE_AVAILABLE_KEY = 'palmyra:update-available';
const PALMYRA_UPDATE_VERSION_KEY = 'palmyra:update-version';
const PALMYRA_BUILD_ID_KEY = 'palmyra:build-id';
const PALMYRA_UPDATE_APPLY_KEY = 'palmyra:update-applying';
let swCheckTimer: ReturnType<typeof setInterval> | null = null;

type PalmyraUpdatePhase = 'checking' | 'downloading' | 'installing' | 'reloading' | 'up-to-date';

export type PalmyraUpdateProgress = {
  phase: PalmyraUpdatePhase;
  percent: number;
  filesDone?: number;
  filesTotal?: number;
  receivedBytes?: number;
  version?: string;
};

const reportUpdateProgress = (detail: PalmyraUpdateProgress) => {
  window.dispatchEvent(new CustomEvent<PalmyraUpdateProgress>('palmyra:update-progress', { detail }));
};

const clearUpdateMarkers = () => {
  try { localStorage.removeItem(PALMYRA_UPDATE_AVAILABLE_KEY); } catch {}
  try { localStorage.removeItem(PALMYRA_UPDATE_VERSION_KEY); } catch {}
  try { sessionStorage.removeItem(PALMYRA_UPDATE_APPLY_KEY); } catch {}
};

const markUpdateAvailable = (version?: string) => {
  try { localStorage.setItem(PALMYRA_UPDATE_AVAILABLE_KEY, '1'); } catch {}
  if (version) {
    try { localStorage.setItem(PALMYRA_UPDATE_VERSION_KEY, version); } catch {}
  }
  window.dispatchEvent(new CustomEvent('palmyra:update-available', { detail: { version } }));
};

type ServerManifest = { buildId: string; version: string };

const fetchServerManifest = async (): Promise<ServerManifest | null> => {
  try {
    const response = await fetch('/version.json?ts=' + Date.now(), {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    });
    if (!response.ok) return null;
    const payload = await response.json() as { buildId?: string; version?: string };
    const buildId = String(payload?.buildId || '');
    if (!buildId) return null;
    return { buildId, version: String(payload?.version || '') };
  } catch {
    return null;
  }
};

const checkServerVersion = async () => {
  if (!navigator.onLine) return;
  try {
    const manifest = await fetchServerManifest();
    if (!manifest) return;

    const localBuildId = localStorage.getItem(PALMYRA_BUILD_ID_KEY);
    if (!localBuildId) {
      localStorage.setItem(PALMYRA_BUILD_ID_KEY, manifest.buildId);
      return;
    }
    if (localBuildId !== manifest.buildId) {
      markUpdateAvailable(manifest.version || undefined);
    } else {
      clearUpdateMarkers();
    }
  } catch {
    // Network interruptions must never affect POS/offline operation.
  }
};

/**
 * Lee el manifiesto de precarga que genera Workbox en /sw.js para conocer
 * exactamente qué archivos trae la nueva versión. Se usa para mostrar un
 * avance real de la descarga al cliente.
 */
const readPrecacheTargets = async (): Promise<string[]> => {
  const response = await fetch('/sw.js?ts=' + Date.now(), {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  });
  if (!response.ok) return [];
  const source = await response.text();
  const callIndex = source.indexOf('precacheAndRoute(');
  if (callIndex < 0) return [];
  const arrayStart = source.indexOf('[', callIndex);
  const arrayEnd = source.indexOf(']', arrayStart);
  if (arrayStart < 0 || arrayEnd < 0) return [];

  const targets: string[] = [];
  const entryPattern = /\{url:"([^"]+)",revision:(?:"([^"]*)"|null)\}/g;
  let match: RegExpExecArray | null;
  const manifest = source.slice(arrayStart, arrayEnd + 1);
  while ((match = entryPattern.exec(manifest))) {
    try {
      const url = new URL(match[1], window.location.origin);
      if (url.origin !== window.location.origin) continue;
      if (match[2]) url.searchParams.set('__WB_REVISION__', match[2]);
      targets.push(url.pathname + url.search);
    } catch {
      // Una entrada inválida no debe detener la actualización.
    }
  }
  return Array.from(new Set(targets));
};

const openPrecacheCaches = async (): Promise<Cache[]> => {
  if (typeof caches === 'undefined') return [];
  try {
    const names = await caches.keys();
    const opened: Cache[] = [];
    for (const name of names) {
      if (!/precache/i.test(name)) continue;
      opened.push(await caches.open(name));
    }
    return opened;
  } catch {
    return [];
  }
};

const downloadUpdateAssets = async (version?: string) => {
  let targets: string[] = [];
  try {
    targets = await readPrecacheTargets();
  } catch {
    targets = [];
  }
  const filesTotal = targets.length;
  if (!filesTotal) return;

  let filesDone = 0;
  let receivedBytes = 0;
  let lastReportAt = 0;
  let lastPercent = 8;
  const cachesList = await openPrecacheCaches();

  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReportAt < 120) return;
    lastReportAt = now;
    const percent = Math.min(85, 8 + Math.round((filesDone / filesTotal) * 77));
    lastPercent = Math.max(lastPercent, percent);
    reportUpdateProgress({
      phase: 'downloading',
      percent: lastPercent,
      filesDone,
      filesTotal,
      receivedBytes,
      version,
    });
  };

  report(true);

  let cursor = 0;
  const downloadOne = async () => {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      try {
        let alreadyStored = false;
        for (const cache of cachesList) {
          if (await cache.match(target)) {
            alreadyStored = true;
            break;
          }
        }
        if (!alreadyStored) {
          const response = await fetch(target);
          if (!response.ok) throw new Error('HTTP ' + response.status);
          if (response.body) {
            const reader = response.body.getReader();
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (chunk.value) receivedBytes += chunk.value.byteLength;
            }
          } else {
            receivedBytes += (await response.blob()).size;
          }
        }
      } catch {
        // Si un archivo falla, el Service Worker lo reintenta al instalar.
      }
      filesDone += 1;
      report();
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, filesTotal) }, downloadOne));
  report(true);
};

const waitForWorkerInstalled = (worker: ServiceWorker, timeoutMs: number) =>
  new Promise<void>((resolve) => {
    if (worker.state === 'installed' || worker.state === 'activated') {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      worker.removeEventListener('statechange', onState);
      resolve();
    };
    const onState = () => {
      if (['installed', 'activated', 'redundant'].includes(worker.state)) finish();
    };
    worker.addEventListener('statechange', onState);
    window.setTimeout(finish, timeoutMs);
  });

// Último recurso: cuando version.json confirma una versión nueva pero el shell
// cacheado no tiene worker nuevo, se reconstruye desde la red. Solo se limpian
// caches del shell; IndexedDB y localStorage del negocio quedan intactos.
const resetShellForFreshBuild = async () => {
  const probe = await fetch('/?ts=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
  if (!probe.ok) throw new Error('El servidor no está disponible para descargar la nueva versión.');
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() || [];
    await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
  } catch {}
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key).catch(() => false)));
    }
  } catch {}
};

// La app de escritorio ya sirve todo desde el disco: un Service Worker allí
// solo puede quedar obsoleto tras una actualización y devolver un shell viejo.
const isDesktopShell = /\bElectron\//i.test(navigator.userAgent);

if (isDesktopShell) {
  // Una marca heredada de una ejecución en navegador sobre el mismo puerto no
  // debe mostrar el aviso de actualización dentro de la app de escritorio.
  clearUpdateMarkers();
}

const updateSW = isDesktopShell
  ? async (_reloadPage?: boolean) => { window.location.reload(); }
  : registerSW({
  immediate: true,
  onNeedRefresh() {
    markUpdateAvailable();
  },
  onRegisteredSW(swUrl, registration) {
    if (!registration) return;

    const checkForFreshWorker = async () => {
      try {
        await fetch(swUrl, {
          cache: 'no-store',
          headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
        });
        await registration.update();
      } catch (error) {
        console.debug('[PWA] Service Worker update check deferred:', error);
      }
      await checkServerVersion();
    };

    void checkForFreshWorker();
    swCheckTimer = setInterval(checkForFreshWorker, SW_CHECK_INTERVAL_MS);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void checkForFreshWorker();
    };
    window.addEventListener('focus', checkForFreshWorker);
    window.addEventListener('online', checkForFreshWorker);
    document.addEventListener('visibilitychange', handleVisibility);

    (registration as ServiceWorkerRegistration & { __palmyraCleanup?: () => void }).__palmyraCleanup = () => {
      if (swCheckTimer) {
        clearInterval(swCheckTimer);
        swCheckTimer = null;
      }
      window.removeEventListener('focus', checkForFreshWorker);
      window.removeEventListener('online', checkForFreshWorker);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  },
  onOfflineReady() {
    console.log('[PWA] PALMYRA está lista para trabajar sin conexión.');
  },
  onRegisterError(error) {
    console.warn('[PWA] Service Worker registration error:', error);
  },
});

const applyPalmyraUpdate = async (): Promise<'reloaded' | 'up-to-date'> => {
  if (!navigator.onLine) throw new Error('La actualización requiere conexión.');
  try {
    try { sessionStorage.setItem(PALMYRA_UPDATE_APPLY_KEY, String(Date.now())); } catch {}
    reportUpdateProgress({ phase: 'checking', percent: 3 });

    const manifest = await fetchServerManifest();
    const localBuildId = localStorage.getItem(PALMYRA_BUILD_ID_KEY);

    if (manifest && localBuildId && manifest.buildId === localBuildId) {
      clearUpdateMarkers();
      reportUpdateProgress({ phase: 'up-to-date', percent: 100, version: manifest.version });
      return 'up-to-date';
    }

    await downloadUpdateAssets(manifest?.version);
    reportUpdateProgress({ phase: 'installing', percent: 88, version: manifest?.version });

    const registration = await navigator.serviceWorker?.getRegistration();
    if (!registration) {
      if (manifest) localStorage.setItem(PALMYRA_BUILD_ID_KEY, manifest.buildId);
      reportUpdateProgress({ phase: 'reloading', percent: 100 });
      window.location.reload();
      return 'reloaded';
    }

    // El plugin de PWA coordina SKIP_WAITING/controllerchange/reload. No se
    // fuerza una recarga manual en paralelo para no dejar el shell en blanco.
    await registration.update().catch(() => {});
    let worker = registration.waiting || registration.installing;
    if (worker) await waitForWorkerInstalled(worker, 15_000);

    worker = registration.waiting || (registration.installing?.state === 'installed' ? registration.installing : null);
    if (worker && worker.state !== 'activated') {
      if (manifest) localStorage.setItem(PALMYRA_BUILD_ID_KEY, manifest.buildId);
      reportUpdateProgress({ phase: 'reloading', percent: 97, version: manifest?.version });
      // library-supported activation path: prompt flow + updateSW, never a
      // forced SKIP_WAITING postMessage mid-sale. The user already confirmed.
      await updateSW(true);
      return 'reloaded';
    }

    if (manifest) {
      await resetShellForFreshBuild();
      localStorage.setItem(PALMYRA_BUILD_ID_KEY, manifest.buildId);
      reportUpdateProgress({ phase: 'reloading', percent: 100, version: manifest.version });
      window.location.reload();
      return 'reloaded';
    }

    clearUpdateMarkers();
    reportUpdateProgress({ phase: 'up-to-date', percent: 100 });
    return 'up-to-date';
  } catch (error) {
    console.warn('[PALMYRA] No se pudo aplicar la actualización:', error);
    try { localStorage.setItem(PALMYRA_UPDATE_AVAILABLE_KEY, '1'); } catch {}
    try { sessionStorage.removeItem(PALMYRA_UPDATE_APPLY_KEY); } catch {}
    throw error;
  }
};

(window as typeof window & { __palmyraApplyUpdate?: () => Promise<'reloaded' | 'up-to-date'> }).__palmyraApplyUpdate = applyPalmyraUpdate;

// Storage protection is best-effort and never blocks application startup.
void protectPwaStorage().then((health) => {
  if (health.warning) {
    window.dispatchEvent(new CustomEvent('palmyra:storage-warning', { detail: health }));
  }
  if (!health.indexedDbAvailable) {
    console.warn('[PWA] IndexedDB no está disponible; PALMYRA usará su respaldo local cuando sea posible.');
  }
}).catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
