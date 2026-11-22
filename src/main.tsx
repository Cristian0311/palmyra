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
import { isPalmyraApp } from './lib/install';
import { installNativeUpdateHooks } from './lib/nativeApp';

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
const PALMYRA_UPDATE_RELOAD_GUARD_KEY = 'palmyra:update-reload-guard';
// Un archivo de precarga no debe colgar la actualización completa: 40s por
// petición y un reintento. Si aun así falla, el Service Worker lo buscará al
// activarse y la app sigue operativa.
const UPDATE_FILE_TIMEOUT_MS = 40_000;
const UPDATE_FILE_RETRIES = 1;
const UPDATE_MAX_CONCURRENCY = 4;
const UPDATE_SIZE_PROBE_TIMEOUT_MS = 12_000;
const UPDATE_RELOAD_GUARD_WINDOW_MS = 10 * 60_000;
let swCheckTimer: ReturnType<typeof setInterval> | null = null;

type PalmyraUpdatePhase = 'checking' | 'preparing' | 'downloading' | 'installing' | 'reloading' | 'up-to-date';

export type PalmyraUpdateProgress = {
  phase: PalmyraUpdatePhase;
  percent: number;
  filesDone?: number;
  filesTotal?: number;
  filesSkipped?: number;
  receivedBytes?: number;
  totalBytes?: number;
  version?: string;
  /** Mensaje corto en español listo para mostrar al usuario. */
  message?: string;
};

const reportUpdateProgress = (detail: PalmyraUpdateProgress) => {
  window.dispatchEvent(new CustomEvent<PalmyraUpdateProgress>('palmyra:update-progress', { detail }));
};

const clearUpdateMarkers = () => {
  try { localStorage.removeItem(PALMYRA_UPDATE_AVAILABLE_KEY); } catch {}
  try { localStorage.removeItem(PALMYRA_UPDATE_VERSION_KEY); } catch {}
  try { sessionStorage.removeItem(PALMYRA_UPDATE_APPLY_KEY); } catch {}
  window.dispatchEvent(new CustomEvent('palmyra:update-cleared'));
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

type ServerVersionCheckResult = 'checked' | 'offline' | 'failed';

// Un único chequeo de versión a la vez: arranque, reintentos, focus, online,
// visibilidad e intervalo comparten esta promesa. Así nunca hay dos peticiones
// a /version.json compitiendo ni avisos duplicados.
let serverVersionCheckInFlight: Promise<ServerVersionCheckResult> | null = null;

const checkServerVersion = (): Promise<ServerVersionCheckResult> => {
  if (serverVersionCheckInFlight) return serverVersionCheckInFlight;
  if (!navigator.onLine) return Promise.resolve('offline');

  const run = (async (): Promise<ServerVersionCheckResult> => {
    try {
      const manifest = await fetchServerManifest();
      if (!manifest) return 'failed';

      const localBuildId = localStorage.getItem(PALMYRA_BUILD_ID_KEY);
      if (!localBuildId) {
        // Primer arranque en este dispositivo: se fija la referencia sin avisar.
        try { localStorage.setItem(PALMYRA_BUILD_ID_KEY, manifest.buildId); } catch {}
        return 'checked';
      }
      if (localBuildId !== manifest.buildId) {
        markUpdateAvailable(manifest.version || undefined);
      } else {
        clearUpdateMarkers();
      }
      return 'checked';
    } catch {
      // Las interrupciones de red nunca deben afectar al POS ni al modo offline.
      return 'failed';
    }
  })();

  serverVersionCheckInFlight = run;
  return run.finally(() => { serverVersionCheckInFlight = null; });
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

type PrecachePlanEntry = { url: string; cached: boolean; size: number };

type PrecachePlan = {
  entries: PrecachePlanEntry[];
  filesTotal: number;
  cachedTotal: number;
  expectedBytes: number;
};

// El manifiesto de precarga se analiza UNA vez por actualización y se reutiliza
// para decidir qué falta de verdad. Antes se volvía a descargar toda la app.
let activeUpdatePlan: PrecachePlan | null = null;

const fetchWithTimeout = async (input: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
};

const buildPrecachePlan = async (): Promise<PrecachePlan> => {
  let targets: string[] = [];
  try {
    targets = await readPrecacheTargets();
  } catch {
    targets = [];
  }
  const cachesList = await openPrecacheCaches();
  const entries: PrecachePlanEntry[] = [];
  for (const url of targets) {
    let cached = false;
    for (const cache of cachesList) {
      try {
        if (await cache.match(url)) {
          cached = true;
          break;
        }
      } catch {
        // Una caché ilegible no debe impedir calcular el resto del plan.
      }
    }
    entries.push({ url, cached, size: 0 });
  }
  return {
    entries,
    filesTotal: entries.length,
    cachedTotal: entries.filter((entry) => entry.cached).length,
    expectedBytes: 0,
  };
};

/** HEAD/Content-Length para mostrar MB reales; si el servidor no lo publica se usa el conteo de archivos. */
const probeAssetSize = async (url: string): Promise<number> => {
  try {
    const response = await fetchWithTimeout(url, { method: 'HEAD', cache: 'no-store' }, 8_000);
    if (!response.ok) return 0;
    const declared = Number(response.headers.get('content-length') || 0);
    return Number.isFinite(declared) && declared > 0 ? declared : 0;
  } catch {
    return 0;
  }
};

const estimatePlanBytes = async (plan: PrecachePlan): Promise<void> => {
  const missing = plan.entries.filter((entry) => !entry.cached);
  if (!missing.length) {
    plan.expectedBytes = 0;
    return;
  }
  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const entry = missing[cursor++];
      entry.size = await probeAssetSize(entry.url);
    }
  };
  const sizing = Promise.all(Array.from({ length: Math.min(8, missing.length) }, worker));
  // El tanteo de tamaños es informativo: nunca debe retrasar la descarga real.
  await Promise.race([sizing, new Promise<void>((resolve) => window.setTimeout(resolve, UPDATE_SIZE_PROBE_TIMEOUT_MS))]);
  plan.expectedBytes = plan.entries.reduce((sum, entry) => sum + (entry.cached ? 0 : entry.size), 0);
};

const ensureUpdatePlan = async (version?: string): Promise<PrecachePlan> => {
  if (activeUpdatePlan) return activeUpdatePlan;
  reportUpdateProgress({ phase: 'preparing', percent: 3, version, message: 'Preparando la actualización…' });
  const plan = await buildPrecachePlan();
  activeUpdatePlan = plan;
  reportUpdateProgress({
    phase: 'preparing',
    percent: 5,
    version,
    filesDone: plan.cachedTotal,
    filesTotal: plan.filesTotal,
    receivedBytes: 0,
    totalBytes: 0,
    message: 'Preparando la actualización…',
  });
  await estimatePlanBytes(plan);
  reportUpdateProgress({
    phase: 'preparing',
    percent: 8,
    version,
    filesDone: plan.cachedTotal,
    filesTotal: plan.filesTotal,
    receivedBytes: 0,
    totalBytes: plan.expectedBytes,
    message: 'Preparando la actualización…',
  });
  return plan;
};

const downloadOneAsset = async (entry: PrecachePlanEntry, onBytes: (bytes: number) => void): Promise<boolean> => {
  for (let attempt = 0; attempt <= UPDATE_FILE_RETRIES; attempt += 1) {
    // El tiempo límite cubre la petición completa (cabeceras Y cuerpo): un
    // enlace que se queda a medias se aborta y no bloquea la actualización.
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), UPDATE_FILE_TIMEOUT_MS);
    let attemptError: unknown = null;
    try {
      const response = await fetch(entry.url, { cache: 'force-cache', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (response.body) {
        const reader = response.body.getReader();
        let readBytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value && chunk.value.byteLength > 0) {
            readBytes += chunk.value.byteLength;
            onBytes(chunk.value.byteLength);
          }
        }
        if (readBytes === 0 && entry.size > 0) onBytes(entry.size);
      } else {
        const blob = await response.blob();
        if (blob.size > 0) onBytes(blob.size);
      }
      return true;
    } catch (error) {
      attemptError = error;
    } finally {
      window.clearTimeout(timer);
    }
    if (attempt >= UPDATE_FILE_RETRIES) {
      // Un archivo opcional caído no cancela la actualización: el nuevo
      // Service Worker lo pedirá al activarse.
      console.warn('[PWA] No se pudo precargar un archivo; el Service Worker lo reintentará:', entry.url, attemptError);
      return false;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
  }
  return false;
};

type UpdateDownloadResult = {
  failed: number;
  receivedBytes: number;
  totalBytes: number;
};

const downloadUpdateAssets = async (version?: string): Promise<UpdateDownloadResult> => {
  const plan = activeUpdatePlan || await ensureUpdatePlan(version);
  const pending = plan.entries.filter((entry) => !entry.cached);
  const totalBytes = plan.expectedBytes;
  let filesDone = plan.cachedTotal;
  let filesSkipped = 0;
  let receivedBytes = 0;
  let lastReportAt = 0;
  let lastPercent = 8;
  const toMb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReportAt < 200) return;
    lastReportAt = now;
    const fraction = totalBytes > 0
      ? Math.min(1, receivedBytes / totalBytes)
      : plan.filesTotal > 0 ? filesDone / plan.filesTotal : 1;
    lastPercent = Math.max(lastPercent, Math.min(85, 8 + Math.round(fraction * 77)));
    reportUpdateProgress({
      phase: 'downloading',
      percent: lastPercent,
      filesDone,
      filesTotal: plan.filesTotal,
      filesSkipped,
      receivedBytes,
      totalBytes,
      version,
      // Mensaje listo para la UI: tamaño real cuando el servidor lo publica.
      message: totalBytes > 0
        ? `Descargando actualización ${toMb(Math.min(receivedBytes, totalBytes))} MB de ${toMb(totalBytes)} MB…`
        : `Descargando actualización ${lastPercent}%…`,
    });
  };

  if (!pending.length) {
    // Todo el precache ya está en el dispositivo: no se vuelve a descargar.
    reportUpdateProgress({
      phase: 'downloading',
      percent: 85,
      filesDone: plan.filesTotal,
      filesTotal: plan.filesTotal,
      filesSkipped: 0,
      receivedBytes: 0,
      totalBytes: 0,
      version,
      message: 'Archivos ya disponibles en este dispositivo.',
    });
    return { failed: 0, receivedBytes: 0, totalBytes: 0 };
  }

  report(true);
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const entry = pending[cursor++];
      const ok = await downloadOneAsset(entry, (bytes) => {
        receivedBytes += bytes;
        report();
      });
      if (!ok) filesSkipped += 1;
      filesDone += 1;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPDATE_MAX_CONCURRENCY, pending.length) }, worker));
  report(true);
  return { failed: filesSkipped, receivedBytes, totalBytes };
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
// El APK también sirve desde 127.0.0.1 y se actualiza con su propio paquete
// verificado: un Service Worker adicional solo serviría código viejo.
const isDesktopShell = /\bElectron\//i.test(navigator.userAgent);
const isPalmyraAndroidApp = isPalmyraApp();
const usesNativeShell = isDesktopShell || isPalmyraAndroidApp;

// El shell Android necesita estos callbacks antes de cualquier actualización.
installNativeUpdateHooks();

if (usesNativeShell) {
  // Una marca heredada de una ejecución en navegador sobre el mismo puerto no
  // debe mostrar el aviso de actualización PWA dentro de la app instalada.
  clearUpdateMarkers();
}

const updateSW = usesNativeShell
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

// Cuando un Service Worker nuevo toma el control (por ejemplo, tras aplicar la
// actualización o al cerrar todas las pestañas), el shell que corre ya es el
// desplegado. Se actualiza la marca de build para no volver a avisar la misma
// versión una y otra vez (aviso fantasma).
if (!usesNativeShell && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    void fetchServerManifest().then((manifest) => {
      if (!manifest) return;
      try { localStorage.setItem(PALMYRA_BUILD_ID_KEY, manifest.buildId); } catch {}
      clearUpdateMarkers();
    }).catch(() => {});
  });
}

type UpdateReloadGuard = { buildId: string; at: number };

const readReloadGuard = (): UpdateReloadGuard | null => {
  try {
    const raw = sessionStorage.getItem(PALMYRA_UPDATE_RELOAD_GUARD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UpdateReloadGuard>;
    if (!parsed || typeof parsed.buildId !== 'string' || typeof parsed.at !== 'number') return null;
    return { buildId: parsed.buildId, at: Number(parsed.at) };
  } catch {
    return null;
  }
};

const writeReloadGuard = (buildId: string) => {
  try {
    sessionStorage.setItem(PALMYRA_UPDATE_RELOAD_GUARD_KEY, JSON.stringify({ buildId, at: Date.now() } satisfies UpdateReloadGuard));
  } catch {}
};

type PalmyraUpdateApplyResult = 'reloaded' | 'up-to-date';

const runPalmyraUpdate = async (): Promise<PalmyraUpdateApplyResult> => {
  if (!navigator.onLine) throw new Error('La actualización requiere conexión.');
  // Un solo plan de precarga por intento (nunca se analiza dos veces /sw.js).
  activeUpdatePlan = null;
  try {
    try { sessionStorage.setItem(PALMYRA_UPDATE_APPLY_KEY, String(Date.now())); } catch {}
    // Fase "Preparando" visible de inmediato mientras se planifica la descarga.
    reportUpdateProgress({ phase: 'preparing', percent: 2, message: 'Preparando la actualización…' });

    const manifest = await fetchServerManifest();
    const localBuildId = localStorage.getItem(PALMYRA_BUILD_ID_KEY);

    if (manifest && localBuildId && manifest.buildId === localBuildId) {
      // Nada nuevo en el servidor: se limpia el aviso en lugar de "no hacer nada".
      activeUpdatePlan = null;
      clearUpdateMarkers();
      try { sessionStorage.removeItem(PALMYRA_UPDATE_APPLY_KEY); } catch {}
      reportUpdateProgress({ phase: 'up-to-date', percent: 100, version: manifest.version, message: 'PALMYRA ya está actualizada.' });
      return 'up-to-date';
    }

    // Descarga inmediata y solo de lo que falta en las cachés actuales.
    await ensureUpdatePlan(manifest?.version);
    let download = await downloadUpdateAssets(manifest?.version);

    // Si la red se cayó a mitad de la descarga (ningún byte recibido), se
    // reintenta una vez con un plan nuevo en lugar de dejar la UI colgada.
    if (download.failed > 0 && download.receivedBytes === 0 && navigator.onLine) {
      reportUpdateProgress({
        phase: 'downloading',
        percent: 10,
        version: manifest?.version,
        message: 'No se pudo descargar. Reintentando…',
      });
      await new Promise((resolve) => window.setTimeout(resolve, 1_500));
      activeUpdatePlan = null;
      await ensureUpdatePlan(manifest?.version);
      download = await downloadUpdateAssets(manifest?.version);
    }

    // Todo falló y seguimos sin datos: se informa en vez de recargar a ciegas.
    if (download.failed > 0 && download.receivedBytes === 0 && !navigator.onLine) {
      throw new Error('Sin conexión durante la descarga. La actualización se reintentará al recuperar la red.');
    }

    reportUpdateProgress({ phase: 'installing', percent: 88, version: manifest?.version, message: 'Instalando la actualización…' });

    const registration = await navigator.serviceWorker?.getRegistration();
    if (!registration) {
      if (manifest) { try { localStorage.setItem(PALMYRA_BUILD_ID_KEY, manifest.buildId); } catch {} }
      reportUpdateProgress({ phase: 'reloading', percent: 100, version: manifest?.version, message: 'Actualización instalada. Reiniciando…' });
      window.location.reload();
      return 'reloaded';
    }

    // El plugin de PWA coordina SKIP_WAITING/controllerchange/reload.
    await registration.update().catch(() => {});
    let worker = registration.waiting || registration.installing;
    if (worker) await waitForWorkerInstalled(worker, 20_000);

    worker = registration.waiting || (registration.installing?.state === 'installed' ? registration.installing : null);
    if (worker && worker.state !== 'activated' && worker.state !== 'redundant') {
      if (manifest) { try { localStorage.setItem(PALMYRA_BUILD_ID_KEY, manifest.buildId); } catch {} }
      // Red de seguridad: si el controllerchange no ocurre, una única recarga
      // toma el shell nuevo. La UI nunca queda "Actualizando" para siempre.
      window.setTimeout(() => { window.location.reload(); }, 10_000);
      reportUpdateProgress({ phase: 'reloading', percent: 97, version: manifest?.version, message: 'Actualización instalada. Reiniciando…' });
      // library-supported activation path: prompt flow + updateSW, never a
      // forced SKIP_WAITING postMessage mid-sale. The user already confirmed.
      await updateSW(true);
      return 'reloaded';
    }

    // No hay worker esperando: el aviso pudo ser un falso positivo por rotación
    // de buildId. Se verifica el servidor otra vez antes de recargar nada.
    const confirmed = await fetchServerManifest();
    const runningBuildId = localStorage.getItem(PALMYRA_BUILD_ID_KEY);
    if (!confirmed || (runningBuildId && confirmed.buildId === runningBuildId)) {
      activeUpdatePlan = null;
      clearUpdateMarkers();
      try { sessionStorage.removeItem(PALMYRA_UPDATE_APPLY_KEY); } catch {}
      reportUpdateProgress({ phase: 'up-to-date', percent: 100, version: confirmed?.version, message: 'PALMYRA ya está actualizada.' });
      return 'up-to-date';
    }

    const guard = readReloadGuard();
    if (guard && guard.buildId === confirmed.buildId && Date.now() - guard.at < UPDATE_RELOAD_GUARD_WINDOW_MS) {
      // Ya se recargó una vez para este build y el shell sigue sin tomarlo:
      // no se entra en un bucle de recargas. Se informa para reintentar.
      throw new Error('La actualización no se pudo confirmar en este dispositivo. Cierra y abre PALMYRA para terminar de aplicarla.');
    }
    writeReloadGuard(confirmed.buildId);

    // Recarga única y protegida: el shell cacheado serviría el HTML anterior,
    // así que se reconstruye desde la red sin tocar IndexedDB/localStorage.
    await resetShellForFreshBuild();
    try { localStorage.setItem(PALMYRA_BUILD_ID_KEY, confirmed.buildId); } catch {}
    reportUpdateProgress({ phase: 'reloading', percent: 100, version: confirmed.version, message: 'Actualización instalada. Reiniciando…' });
    window.location.reload();
    return 'reloaded';
  } catch (error) {
    console.warn('[PALMYRA] No se pudo aplicar la actualización:', error);
    activeUpdatePlan = null;
    try { localStorage.setItem(PALMYRA_UPDATE_AVAILABLE_KEY, '1'); } catch {}
    try { sessionStorage.removeItem(PALMYRA_UPDATE_APPLY_KEY); } catch {}
    throw error;
  }
};

// Una sola instalación a la vez: si Layout y el aviso público (o dos toques
// seguidos) piden actualizar, todos esperan la misma promesa en lugar de lanzar
// dos descargas en paralelo sobre la misma caché.
let applyInFlight: Promise<PalmyraUpdateApplyResult> | null = null;

const applyPalmyraUpdate = (): Promise<PalmyraUpdateApplyResult> => {
  if (applyInFlight) return applyInFlight;
  const run = runPalmyraUpdate().finally(() => { applyInFlight = null; });
  applyInFlight = run;
  return run;
};

(window as typeof window & { __palmyraApplyUpdate?: () => Promise<PalmyraUpdateApplyResult> }).__palmyraApplyUpdate = applyPalmyraUpdate;

// Chequeo de versión inmediato, independiente del registro del Service Worker.
// Arranca con el propio bundle (antes de montar React), reintenta rápido si la
// red falla (0 s / 3 s / 10 s) y sigue vigilando cada 60 s mientras la pestaña
// está visible y en línea. La landing pública también lo ejecuta.
const UPDATE_BOOT_RETRY_DELAYS_MS = [0, 3_000, 10_000];
const UPDATE_VISIBLE_CHECK_INTERVAL_MS = 60_000;
let updateWatchStarted = false;

const runBootVersionCheck = (attempt: number) => {
  void checkServerVersion().then((result) => {
    if (result !== 'failed') return;
    const nextDelay = UPDATE_BOOT_RETRY_DELAYS_MS[attempt + 1];
    if (nextDelay === undefined) return;
    const wait = Math.max(0, nextDelay - UPDATE_BOOT_RETRY_DELAYS_MS[attempt]);
    window.setTimeout(() => runBootVersionCheck(attempt + 1), wait);
  }).catch(() => {});
};

const startImmediateUpdateWatch = () => {
  if (updateWatchStarted) return;
  updateWatchStarted = true;

  const tick = () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    void checkServerVersion();
  };

  runBootVersionCheck(0);
  window.setInterval(tick, UPDATE_VISIBLE_CHECK_INTERVAL_MS);
  window.addEventListener('focus', tick);
  window.addEventListener('online', tick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });
};

// El shell nativo (Electron/APK) se actualiza con su propio paquete OTA: este
// vigilante web solo aplica al navegador/PWA.
if (!usesNativeShell) startImmediateUpdateWatch();

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

// Refuerzo tras el primer render: cubre un despliegue ocurrido mientras se
// descargaba el propio bundle. Comparte el guard de in-flight con el resto.
if (!usesNativeShell) {
  window.setTimeout(() => { void checkServerVersion(); }, 1_500);
}
