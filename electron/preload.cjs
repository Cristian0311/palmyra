// Puente seguro entre el proceso principal (electron-updater) y la interfaz.
// Corre en un preload aislado (contextIsolation + sandbox): la ventana nunca
// recibe Node ni ipcRenderer, solo las funciones de actualización necesarias.
const { contextBridge, ipcRenderer } = require('electron');

const STATE_CHANNEL = 'palmyra:update:state';
const UPDATE_STATUSES = new Set([
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'not-available',
  'error',
  'unsupported'
]);

const text = (value) => (typeof value === 'string' ? value.slice(0, 400) : '');
const count = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);

// Solo se cruzan primitivas conocidas: nada de objetos del proceso principal.
function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = text(raw.status);
  return {
    status: UPDATE_STATUSES.has(status) ? status : 'idle',
    currentVersion: text(raw.currentVersion),
    version: text(raw.version),
    percent: Math.min(100, count(raw.percent)),
    transferred: count(raw.transferred),
    total: count(raw.total),
    message: text(raw.message),
    error: text(raw.error),
    updatedAt: count(raw.updatedAt)
  };
}

const invokeState = async (channel) => {
  try {
    return sanitizeState(await ipcRenderer.invoke(channel));
  } catch {
    return null;
  }
};

contextBridge.exposeInMainWorld('palmyraDesktopUpdate', {
  getState: () => invokeState('palmyra:update:get-state'),
  check: () => invokeState('palmyra:update:check'),
  download: () => invokeState('palmyra:update:download'),
  install: async () => {
    try {
      const result = await ipcRenderer.invoke('palmyra:update:install');
      if (!result || typeof result !== 'object') return { ok: false, error: 'No se pudo reiniciar para instalar.' };
      return { ok: result.ok === true, error: text(result.error) };
    } catch {
      return { ok: false, error: 'No se pudo reiniciar para instalar.' };
    }
  },
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, raw) => {
      const state = sanitizeState(raw);
      if (state) callback(state);
    };
    ipcRenderer.on(STATE_CHANNEL, listener);
    return () => {
      try { ipcRenderer.removeListener(STATE_CHANNEL, listener); } catch {}
    };
  }
});
