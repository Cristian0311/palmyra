// Puente seguro entre el proceso principal (electron-updater, SQLite y hub LAN)
// y la interfaz. Corre en un preload aislado (contextIsolation + sandbox): la
// ventana nunca recibe Node ni ipcRenderer, solo funciones con datos saneados.
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

const DB_CHANNEL = 'palmyra:db:invoke';
const SNAPSHOT_CHANNEL = 'palmyra:db:snapshot';
const RESTORE_CHANNEL = 'palmyra:db:restore';
const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;
const MAX_SNAPSHOT_B64 = Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4 + 4;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const HUB_PIN_CHANNEL = 'palmyra:hub:pin';
const HUB_DISCOVER_CHANNEL = 'palmyra:hub:discover';
const DISCOVER_DEFAULT_MS = 1500;
const DISCOVER_MIN_MS = 200;
const DISCOVER_MAX_MS = 5000;
const MAX_DISCOVERED_HUBS = 20;
const DB_OPS = new Set(['exec', 'run', 'all', 'status']);
const MAX_SQL_LENGTH = 200000;
const MAX_PARAMS = 1000;
const MAX_PARAM_STRING = 100000;
const MAX_B64_LENGTH = Math.ceil((MAX_PARAM_STRING / 3) * 4) + 16;
const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

const text = (value) => (typeof value === 'string' ? value.slice(0, 400) : '');
const count = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// La huella se compara como hex en minúsculas: se acepta lo que pegue el humano.
function normalizeFingerprint(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\s:]/g, '').toLowerCase();
  return SHA256_HEX.test(cleaned) ? cleaned : '';
}

// Solo raíces http/https absolutas: el renderer nunca elige otro esquema.
function cleanHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 500) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function cleanDiscoveryTimeout(value) {
  if (value === undefined || value === null) return DISCOVER_DEFAULT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const ms = Math.round(parsed);
  return ms >= DISCOVER_MIN_MS && ms <= DISCOVER_MAX_MS ? ms : 0;
}

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

function sanitizeParam(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'string') {
    return value.length <= MAX_PARAM_STRING ? { ok: true, value } : { ok: false };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (isPlainObject(value) && typeof value.b64 === 'string' && value.b64.length <= MAX_B64_LENGTH) {
    return { ok: true, value: { b64: value.b64 } };
  }
  return { ok: false };
}

// La ventana puede estar comprometida: se reconstruye la petición campo a campo.
function sanitizeDbRequest(raw) {
  if (!isPlainObject(raw)) return null;
  const op = typeof raw.op === 'string' ? raw.op : '';
  if (!DB_OPS.has(op)) return null;
  if (op === 'status') return { op: 'status' };

  const sql = raw.sql;
  if (typeof sql !== 'string' || sql.trim() === '' || sql.length > MAX_SQL_LENGTH) return null;

  const rawParams = raw.params === undefined ? [] : raw.params;
  if (!Array.isArray(rawParams) || rawParams.length > MAX_PARAMS) return null;
  const params = [];
  for (const candidate of rawParams) {
    const clean = sanitizeParam(candidate);
    if (!clean.ok) return null;
    params.push(clean.value);
  }
  return op === 'exec' ? { op, sql } : { op, sql, params };
}

// Los valores de las filas ya son datos locales: se normaliza el tipo, no el tamaño.
function primitiveValue(value) {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (isPlainObject(value) && typeof value.b64 === 'string') return { b64: value.b64 };
  return String(value).slice(0, 400);
}

function sanitizeDbStatus(raw) {
  return {
    ready: raw.ready === true,
    driver: raw.driver === 'sqljs' ? 'sqljs' : 'unavailable',
    filePath: text(raw.filePath),
    sizeBytes: count(raw.sizeBytes),
    schemaVersion: count(raw.schemaVersion),
    lastWriteAt: count(raw.lastWriteAt),
    lastError: text(raw.lastError)
  };
}

function sanitizeDbResult(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'La base local no respondió.' };
  if (raw.ok !== true) return { ok: false, error: text(raw.error) || 'No se pudo completar la operación.' };
  if (raw.status && typeof raw.status === 'object') {
    return { ok: true, status: sanitizeDbStatus(raw.status) };
  }
  if (Array.isArray(raw.rows)) {
    const rows = [];
    for (const row of raw.rows) {
      if (!isPlainObject(row)) continue;
      const clean = {};
      for (const [key, value] of Object.entries(row)) {
        clean[String(key).slice(0, 120)] = primitiveValue(value);
      }
      rows.push(clean);
    }
    return { ok: true, rows };
  }
  return { ok: true, changes: count(raw.changes) };
}

function sanitizeHubStatus(raw) {
  return {
    enabled: raw.enabled === true,
    running: raw.running === true,
    host: text(raw.host),
    port: count(raw.port),
    companyId: text(raw.companyId),
    pairingCode: text(raw.pairingCode),
    pairingExpiresAt: text(raw.pairingExpiresAt),
    lastError: text(raw.lastError),
    tlsEnabled: raw.tlsEnabled === true,
    tlsFingerprint: normalizeFingerprint(raw.tlsFingerprint)
  };
}

function sanitizeHubResult(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'El hub LAN no respondió.' };
  if (raw.ok !== true) return { ok: false, error: text(raw.error) || 'No se pudo completar la operación.' };
  return { ok: true, status: sanitizeHubStatus(raw.status && typeof raw.status === 'object' ? raw.status : {}) };
}

const invokeDb = async (request) => {
  const clean = sanitizeDbRequest(request);
  if (!clean) return { ok: false, error: 'Solicitud de base de datos inválida.' };
  try {
    return sanitizeDbResult(await ipcRenderer.invoke(DB_CHANNEL, clean));
  } catch {
    return { ok: false, error: 'No se pudo acceder a la base local.' };
  }
};

// ─── Imagen binaria SQLite (exportar/restaurar el archivo completo) ──────────
// Solo se cruzan base64, un hash hexadecimal y la secuencia del journal; ningún
// canal ni ruta del proceso principal llega a la ventana. Los límites duplican
// los del main (200 MB) y la petición de restauración se reconstruye campo a
// campo: el renderer nunca propone rutas de archivo.
function sanitizeSnapshotResult(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'La base local no respondió.' };
  if (raw.ok !== true) {
    return {
      ok: false,
      unavailable: raw.unavailable === true,
      busy: raw.busy === true,
      error: text(raw.error) || 'No se pudo exportar la imagen binaria.'
    };
  }
  if (
    typeof raw.bytesBase64 !== 'string' ||
    raw.bytesBase64.length === 0 ||
    raw.bytesBase64.length > MAX_SNAPSHOT_B64
  ) {
    return { ok: false, error: 'La imagen binaria llegó incompleta.' };
  }
  if (typeof raw.sha256 !== 'string' || !SHA256_HEX.test(raw.sha256)) {
    return { ok: false, error: 'La imagen binaria no incluye un hash válido.' };
  }
  const size = count(raw.size);
  if (size <= 0 || size > MAX_SNAPSHOT_BYTES) {
    return { ok: false, error: 'La imagen binaria declara un tamaño inválido.' };
  }
  return { ok: true, bytesBase64: raw.bytesBase64, size, sha256: raw.sha256, latestSeq: count(raw.latestSeq) };
}

function sanitizeRestoreRequest(raw) {
  if (!isPlainObject(raw)) return null;
  const bytesBase64 = raw.bytesBase64;
  if (
    typeof bytesBase64 !== 'string' ||
    bytesBase64.length === 0 ||
    bytesBase64.length > MAX_SNAPSHOT_B64 ||
    bytesBase64.length % 4 !== 0
  ) {
    return null;
  }
  if (typeof raw.expectedSha256 !== 'string' || !SHA256_HEX.test(raw.expectedSha256)) return null;
  return { bytesBase64, expectedSha256: raw.expectedSha256 };
}

function sanitizeRestoreResult(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'La base local no respondió.' };
  if (raw.ok !== true) {
    return {
      ok: false,
      unavailable: raw.unavailable === true,
      busy: raw.busy === true,
      error: text(raw.error) || 'No se pudo restaurar la imagen binaria.'
    };
  }
  if (raw.restartRequired !== true) {
    return { ok: false, error: 'El proceso principal no confirmó el reinicio obligatorio.' };
  }
  return {
    ok: true,
    restartRequired: true,
    size: count(raw.size),
    sha256: typeof raw.sha256 === 'string' && SHA256_HEX.test(raw.sha256) ? raw.sha256 : '',
    latestSeq: count(raw.latestSeq)
  };
}

const invokeSnapshot = async () => {
  try {
    return sanitizeSnapshotResult(await ipcRenderer.invoke(SNAPSHOT_CHANNEL));
  } catch {
    return { ok: false, error: 'No se pudo exportar la imagen de la base local.' };
  }
};

const invokeRestore = async (request) => {
  const clean = sanitizeRestoreRequest(request);
  if (!clean) return { ok: false, error: 'Solicitud de restauración inválida.' };
  try {
    return sanitizeRestoreResult(await ipcRenderer.invoke(RESTORE_CHANNEL, clean));
  } catch {
    return { ok: false, error: 'No se pudo restaurar la imagen de la base local.' };
  }
};

const invokeHub = async (channel, argument) => {
  try {
    return sanitizeHubResult(await ipcRenderer.invoke(channel, argument));
  } catch {
    return { ok: false, error: 'El hub LAN no respondió.' };
  }
};

// ─── Huella TLS y descubrimiento mDNS del hub ───────────────────────────────
const invokeHubPin = async (baseUrl, fingerprint) => {
  const url = cleanHttpUrl(baseUrl);
  if (!url) return { ok: false, error: 'La dirección del hub no es válida.' };
  const pin = normalizeFingerprint(fingerprint);
  if (!pin) return { ok: false, error: 'La huella TLS del hub no es válida.' };
  try {
    const result = await ipcRenderer.invoke(HUB_PIN_CHANNEL, { baseUrl: url, fingerprint: pin });
    if (result && typeof result === 'object' && result.ok === true) return { ok: true };
    return {
      ok: false,
      error: text(result && result.error) || 'No se pudo fijar el certificado del hub.'
    };
  } catch {
    return { ok: false, error: 'No se pudo fijar el certificado del hub.' };
  }
};

function sanitizeDiscoveredHub(raw) {
  if (!isPlainObject(raw)) return null;
  const host = text(raw.host);
  const port = count(raw.port);
  const url = cleanHttpUrl(raw.url);
  if (!host || port < 1 || port > 65535 || !url) return null;
  return { host, port, url, fingerprint: normalizeFingerprint(raw.fingerprint), name: text(raw.name) };
}

function sanitizeDiscoveryResult(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'El descubrimiento no respondió.' };
  if (raw.ok !== true) {
    return { ok: false, error: text(raw.error) || 'No se pudo buscar el hub en la red.' };
  }
  const hubs = [];
  for (const candidate of Array.isArray(raw.hubs) ? raw.hubs : []) {
    if (hubs.length >= MAX_DISCOVERED_HUBS) break;
    const clean = sanitizeDiscoveredHub(candidate);
    if (clean) hubs.push(clean);
  }
  return { ok: true, hubs };
}

const invokeHubDiscover = async (timeoutMs) => {
  const ms = cleanDiscoveryTimeout(timeoutMs);
  if (!ms) return { ok: false, error: 'El tiempo de búsqueda debe estar entre 200 y 5000 ms.' };
  try {
    return sanitizeDiscoveryResult(await ipcRenderer.invoke(HUB_DISCOVER_CHANNEL, ms));
  } catch {
    return { ok: false, error: 'No se pudo buscar el hub en la red.' };
  }
};

// ─── Respaldos del hub: listar y restaurar ──────────────────────────────────
// La ventana solo elige un nombre de archivo de una lista cerrada y escribe la
// palabra de confirmación. La carpeta, la clave, la instantánea de seguridad y
// el diálogo nativo viven en el proceso principal; aquí solo se sanean datos.
const HUB_BACKUP_LIST_CHANNEL = 'palmyra:hub:backup:list';
const HUB_BACKUP_RESTORE_CHANNEL = 'palmyra:hub:backup:restore';
const HUB_BACKUP_NAME_RE = /^(?:palmyra-\d{4}-\d{2}-\d{2}|weekly-\d{4}-W\d{2}|safety-\d{8}-\d{6})\.pbak$/;
const HUB_RESTORE_CONFIRMATION_WORD = 'RESTAURAR';
const MAX_HUB_BACKUPS = 40;

function sanitizeHubBackupEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const fileName = typeof raw.fileName === 'string' ? raw.fileName : '';
  if (!HUB_BACKUP_NAME_RE.test(fileName)) return null;
  const createdAt = text(raw.createdAt);
  return {
    fileName,
    createdAt: Number.isFinite(Date.parse(createdAt)) ? createdAt : '',
    sizeBytes: count(raw.sizeBytes),
    totalRows: count(raw.totalRows),
    tableCount: count(raw.tableCount),
    companyId: text(raw.companyId),
    safety: raw.safety === true
  };
}

function sanitizeHubBackupListResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'El hub no respondió.' };
  }
  if (raw.ok !== true) {
    return { ok: false, error: text(raw.error) || 'No se pudieron leer los respaldos del hub.' };
  }
  const backups = [];
  for (const candidate of Array.isArray(raw.backups) ? raw.backups : []) {
    if (backups.length >= MAX_HUB_BACKUPS) break;
    const clean = sanitizeHubBackupEntry(candidate);
    if (clean) backups.push(clean);
  }
  return { ok: true, backups };
}

function sanitizeHubRestoreResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'El hub no respondió.' };
  }
  const restoredFrom = typeof raw.restoredFrom === 'string' && HUB_BACKUP_NAME_RE.test(raw.restoredFrom)
    ? raw.restoredFrom
    : '';
  const safetySnapshot = typeof raw.safetySnapshot === 'string' && HUB_BACKUP_NAME_RE.test(raw.safetySnapshot)
    ? raw.safetySnapshot
    : '';
  if (raw.ok !== true) {
    return {
      ok: false,
      cancelled: raw.cancelled === true,
      restoredFrom: '',
      safetySnapshot,
      error: text(raw.error) || 'No se pudo restaurar el hub.'
    };
  }
  if (!restoredFrom) {
    return { ok: false, restoredFrom: '', safetySnapshot, error: 'El hub no confirmó qué respaldo restauró.' };
  }
  if (!safetySnapshot) {
    return { ok: false, restoredFrom: '', safetySnapshot: '', error: 'Falta la instantánea de seguridad previa.' };
  }
  return {
    ok: true,
    restoredFrom,
    safetySnapshot,
    written: count(raw.written),
    tables: count(raw.tables)
  };
}

function sanitizeHubRestoreRequest(raw) {
  if (!isPlainObject(raw)) return null;
  const fileName = typeof raw.fileName === 'string' ? raw.fileName : '';
  if (!HUB_BACKUP_NAME_RE.test(fileName)) return null;
  if (raw.confirmation !== HUB_RESTORE_CONFIRMATION_WORD) return null;
  return { fileName, confirmation: HUB_RESTORE_CONFIRMATION_WORD };
}

const invokeHubBackupList = async () => {
  try {
    return sanitizeHubBackupListResult(await ipcRenderer.invoke(HUB_BACKUP_LIST_CHANNEL));
  } catch {
    return { ok: false, error: 'No se pudieron leer los respaldos del hub.' };
  }
};

const invokeHubBackupRestore = async (request) => {
  const clean = sanitizeHubRestoreRequest(request);
  if (!clean) {
    return {
      ok: false,
      restoredFrom: '',
      safetySnapshot: '',
      error: `Escribe ${HUB_RESTORE_CONFIRMATION_WORD} y elige un respaldo válido del hub.`
    };
  }
  try {
    return sanitizeHubRestoreResult(await ipcRenderer.invoke(HUB_BACKUP_RESTORE_CHANNEL, clean));
  } catch {
    return { ok: false, restoredFrom: '', safetySnapshot: '', error: 'No se pudo restaurar el hub.' };
  }
};

// ─── Almacén seguro de secretos (safeStorage en el proceso principal) ────────
// El renderer solo puede leer/escribir claves con un formato fijo y textos
// acotados; los nombres de archivo y el cifrado quedan del lado del main.
const SECURE_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const MAX_SECRET_LENGTH = 200000;
// Los secretos de licencia (copia de la clave del equipo y del lease) son
// sobres pequeños: se acotan aparte para que la ventana no use el canal como
// almacén de datos arbitrarios.
const LICENSE_SECRET_PREFIX = 'license-';
const MAX_LICENSE_SECRET_LENGTH = 16384;

const cleanSecretKey = (value) =>
  typeof value === 'string' && SECURE_KEY_PATTERN.test(value) ? value : null;

const maxSecretLength = (key) =>
  key.startsWith(LICENSE_SECRET_PREFIX) ? MAX_LICENSE_SECRET_LENGTH : MAX_SECRET_LENGTH;

// Se reconstruye la respuesta: nunca se cruza un objeto del proceso principal.
function sanitizeSecureResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'El almacén seguro no respondió.' };
  }
  if (raw.ok !== true) {
    return {
      ok: false,
      unavailable: raw.unavailable === true,
      error: text(raw.error) || 'No se pudo acceder al almacén seguro.'
    };
  }
  if (typeof raw.value === 'string') return { ok: true, value: raw.value.slice(0, MAX_SECRET_LENGTH) };
  return { ok: true, value: null };
}

const invokeSecure = async (channel, argument) => {
  try {
    return sanitizeSecureResult(await ipcRenderer.invoke(channel, argument));
  } catch {
    return { ok: false, error: 'No se pudo acceder al almacén seguro.' };
  }
};

// Diagnóstico del llavero del sistema (p. ej. Linux sin libsecret). Es solo
// informativo: nunca devuelve rutas, claves ni el contenido de los secretos.
function sanitizeSecureStatus(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      available: false,
      backend: 'none',
      platform: '',
      fallback: 'indexeddb',
      reason: 'No se pudo consultar el almacén seguro.'
    };
  }
  return {
    ok: raw.ok === true,
    available: raw.available === true,
    backend: text(raw.backend) || 'unknown',
    platform: text(raw.platform),
    fallback: raw.fallback === 'indexeddb' ? 'indexeddb' : 'none',
    reason: text(raw.reason)
  };
}

const invokeSecureStatus = async () => {
  try {
    return sanitizeSecureStatus(await ipcRenderer.invoke('palmyra:secure:status'));
  } catch {
    return sanitizeSecureStatus(null);
  }
};

contextBridge.exposeInMainWorld('palmyraSecureStore', {
  get: (key) => {
    const clean = cleanSecretKey(key);
    if (!clean) return Promise.resolve({ ok: false, error: 'Clave de secreto inválida.' });
    return invokeSecure('palmyra:secure:get', clean);
  },
  set: (key, value) => {
    const clean = cleanSecretKey(key);
    if (!clean) return Promise.resolve({ ok: false, error: 'Clave de secreto inválida.' });
    if (typeof value !== 'string' || value.length > maxSecretLength(clean)) {
      return Promise.resolve({ ok: false, error: 'El secreto no tiene un formato válido.' });
    }
    return invokeSecure('palmyra:secure:set', { key: clean, value });
  },
  delete: (key) => {
    const clean = cleanSecretKey(key);
    if (!clean) return Promise.resolve({ ok: false, error: 'Clave de secreto inválida.' });
    return invokeSecure('palmyra:secure:delete', clean);
  },
  status: () => invokeSecureStatus()
});

contextBridge.exposeInMainWorld('palmyraDesktopDb', { invoke: invokeDb });
contextBridge.exposeInMainWorld('palmyraDbSnapshot', () => invokeSnapshot());
contextBridge.exposeInMainWorld('palmyraDbRestore', (request) => invokeRestore(request));

contextBridge.exposeInMainWorld('palmyraDesktopHub', {
  status: () => invokeHub('palmyra:hub:status'),
  start: (companyId) => {
    const id = typeof companyId === 'string' ? companyId.trim() : '';
    if (!COMPANY_ID.test(id)) return Promise.resolve({ ok: false, error: 'Identificador de empresa inválido.' });
    return invokeHub('palmyra:hub:start', id);
  },
  stop: () => invokeHub('palmyra:hub:stop'),
  newPairingCode: () => invokeHub('palmyra:hub:pairing'),
  pinCertificate: (baseUrl, fingerprint) => invokeHubPin(baseUrl, fingerprint),
  discoverHubs: (timeoutMs) => invokeHubDiscover(timeoutMs)
});

// Respaldo del hub: la ventana lista copias y pide restaurar; la confirmación
// nativa y la instantánea de seguridad son responsabilidad del proceso principal.
contextBridge.exposeInMainWorld('palmyraHubBackup', {
  list: () => invokeHubBackupList(),
  restore: (request) => invokeHubBackupRestore(request)
});

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
  // Instalador local (.exe en USB o copia manual). El diálogo, la firma y el
  // lanzamiento quedan en el proceso principal: aquí solo cruza el resultado.
  installFile: async () => {
    try {
      const result = await ipcRenderer.invoke('palmyra:update:install-file');
      if (!result || typeof result !== 'object') {
        return { ok: false, error: 'No se pudo instalar desde el archivo.' };
      }
      return { ok: result.ok === true, error: text(result.error) };
    } catch {
      return { ok: false, error: 'No se pudo instalar desde el archivo.' };
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
