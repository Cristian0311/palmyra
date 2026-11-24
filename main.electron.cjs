const { app, BrowserWindow, dialog, shell, session, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { createDbMain } = require('./electron/dbMain.cjs');
const {
  SIGNATURE_PS_SCRIPT,
  VERSION_PS_SCRIPT,
  parseAuthenticodeJson,
  parseProductVersion,
  evaluateOfflineInstaller
} = require('./electron/offline-update.cjs');

const isDev = !app.isPackaged;
const PORT = Number(process.env.PORT) || 10000;
const LOOPBACK = '127.0.0.1';
const BASE_URL = `http://${LOOPBACK}:${PORT}`;
const DATA_DIR = app.getPath('userData');

// La base local se abre antes de la ventana; si falla, la app igual arranca y
// el estado queda en lastError para que la interfaz lo muestre.
// `hubBusyServing` es una declaración (hoisted) y solo se evalúa al restaurar.
const dbMain = createDbMain({
  filePath: path.join(DATA_DIR, 'palmyra.db'),
  log: logLine,
  isHubBusy: () => hubBusyServing()
});

// El acceso LAN se activa desde Configuración → Red local. El ajuste se lee al
// arrancar porque el servidor interno solo puede cambiar de interfaz al iniciar.
function lanAccessEnabled() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'palmyra-lan.json'), 'utf8'));
    return config?.enabled === true;
  } catch {
    return false;
  }
}

const HOST = lanAccessEnabled() ? '0.0.0.0' : LOOPBACK;

let mainWindow = null;
let devServerProcess = null;
let appLoaded = false;
let recoveryReloads = 0;
let logWrites = 0;

// En equipos antiguos o con drivers inestables, la aceleración por hardware
// puede dejar la ventana en blanco (o solo con el color de fondo). Un POS debe
// abrir siempre, así que renderizamos por software.
app.disableHardwareAcceleration();

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    const logPath = path.join(app.getPath('userData'), 'desktop.log');
    logWrites += 1;
    if (logWrites % 200 === 0) {
      // El POS puede quedar abierto semanas: evitar que el log llene el disco.
      try { if (fs.statSync(logPath).size > 2_000_000) fs.truncateSync(logPath, 0); } catch { /* aún no existe */ }
    }
    fs.appendFileSync(logPath, line + '\n');
  } catch { /* el log es best-effort */ }
}

// ─── Actualización automática (electron-updater) ─────────────────────────────
// La app se instala con NSIS por usuario. Al detectar una versión nueva se
// descarga en segundo plano el Setup publicado en el Release de GitHub y se
// aplica al reiniciar o al cerrar PALMYRA: el usuario nunca vuelve a bajar ni a
// ejecutar un instalador a mano. `publish` vive en electron-builder.yml; de ahí
// sale resources/app-update.yml, que electron-updater lee en cada equipo.
const UPDATE_STATE_CHANNEL = 'palmyra:update:state';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // cada 24 h
const UPDATE_BOOT_DELAY_MS = 20 * 1000; // 20 s: primero abre la caja
const UPDATE_FOCUS_MIN_GAP_MS = 24 * 60 * 60 * 1000; // al volver al foco, máx. 1/24 h
const UPDATE_MANIFEST_URL =
  process.env.UPDATE_MANIFEST_URL ||
  'https://github.com/Cristian0311/palmyra/releases/latest/download/update-manifest.json';
// Un fallo de firma del manifiesto nunca se degrada a "not-available".
const UPDATE_GUARD_REJECTIONS = new Set([
  'firma-invalida',
  'manifiesto-invalido',
  'manifiesto-sin-url',
  'manifiesto-demasiado-grande',
  'descarga-fallida',
  'sin-red',
  'clave-invalida',
  'invalid',
  'error'
]);

// Instalador local (USB o copia manual). Se verifica la firma Authenticode y la
// versión ANTES de ejecutar nada: sin firma válida, sin editor autorizado o sin
// una versión estrictamente más nueva, el archivo no se lanza jamás.
// La huella fijada es opcional (huella SHA1 del certificado en mayúsculas).
const UPDATE_PUBLISHER_THUMBPRINT = String(process.env.PALMYRA_UPDATE_PUBLISHER_THUMBPRINT || '').trim();
const INSTALLER_MAX_BYTES = 400 * 1024 * 1024;
const INSTALLER_VERIFY_TIMEOUT_MS = 20 * 1000;
const OFFLINE_REJECTION_MESSAGES = {
  unsigned: 'El instalador no tiene una firma digital válida. No se instalará.',
  'publisher-mismatch': 'El instalador no está firmado por el editor autorizado de PALMYRA. No se instalará.',
  'version-unknown': 'No se pudo leer la versión del instalador. Descarga de nuevo el Setup oficial.',
  'not-newer': 'El instalador es igual o más antiguo que la versión instalada. No se instalará.'
};

let autoUpdater = null;
let updateCheckInFlight = null;
let updatePollTimer = null;
let lastUpdateCheckAt = 0;
// Solo se descarga la versión cuyo manifiesto firmado ya se verificó.
let verifiedUpdateVersion = '';

const updateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  version: '',
  percent: 0,
  transferred: 0,
  total: 0,
  message: '',
  error: '',
  updatedAt: 0
};

const snapshotUpdateState = () => ({ ...updateState });

function broadcastUpdateState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(UPDATE_STATE_CHANNEL, snapshotUpdateState());
  } catch (error) {
    logLine(`No se pudo enviar el estado de actualización: ${error && error.message ? error.message : error}`);
  }
}

function setUpdateState(patch) {
  const previousStatus = updateState.status;
  Object.assign(updateState, patch, { updatedAt: Date.now() });
  if (patch.status && patch.status !== previousStatus) {
    logLine(`Actualización: ${patch.status}${updateState.version ? ` · v${updateState.version}` : ''}`);
  }
  broadcastUpdateState();
}

// Datos técnicos del fallo para desktop.log. Nunca se registran tokens ni
// cuerpos; solo estado HTTP, tipo de contenido y URL sin query.
function updaterErrorDetail(error) {
  if (!error) return 'sin detalle';
  const status = error.statusCode || error.status || (error.response && error.response.statusCode) || '';
  const code = error.code || '';
  const rawUrl = error.url || (error.request && error.request.url) || (error.response && error.response.url) || '';
  const url = typeof rawUrl === 'string' ? rawUrl.split('?')[0] : '';
  const headers = (error.response && error.response.headers) || error.headers || {};
  const rawType = headers && typeof headers === 'object' ? (headers['content-type'] || headers['Content-Type'] || '') : '';
  const parts = [];
  if (status) parts.push(`status=${status}`);
  if (code) parts.push(`code=${code}`);
  if (rawType) parts.push(`content-type=${String(rawType).split(';')[0]}`);
  if (url) parts.push(`url=${url}`);
  return parts.join(' ') || 'sin metadatos HTTP';
}

// Mensaje corto y en español: la UI nunca muestra rutas ni URLs internas.
function describeUpdateError(error, detail = '') {
  const raw = `${error && error.message ? error.message : error || ''} ${detail}`;
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|net::|getaddrinfo/i.test(raw)) {
    return 'Sin conexión con el servidor de actualizaciones. Se reintentará automáticamente.';
  }
  if (/text\/html/i.test(detail)) {
    return 'El servidor de actualizaciones devolvió una página web en lugar del archivo. Reintenta más tarde o descarga el Setup desde la página oficial.';
  }
  if (/app-update\.yml/i.test(raw)) {
    return 'Esta instalación no tiene configurado el origen de actualizaciones. Reinstala PALMYRA POS con el Setup oficial.';
  }
  if (/404|latest\.yml|Cannot find|ENOENT/i.test(raw)) {
    return 'El servidor todavía no publica esta actualización. Se reintentará automáticamente.';
  }
  if (/signature|code signature/i.test(raw)) {
    return 'La actualización descargada no superó la verificación de firma.';
  }
  return 'No se pudo aplicar la actualización. Se reintentará automáticamente.';
}

function checkForUpdatesNow(reason) {
  if (!autoUpdater) return Promise.resolve(snapshotUpdateState());
  if (updateCheckInFlight) return updateCheckInFlight;
  lastUpdateCheckAt = Date.now();
  logLine(`Buscando actualizaciones (${reason}).`);
  updateCheckInFlight = autoUpdater
    .checkForUpdates()
    .catch((error) => {
      const detail = updaterErrorDetail(error);
      const message = error && error.message ? error.message : String(error);
      logLine(`Falló la búsqueda de actualizaciones (${reason}): ${message} · ${detail}`);
      // Una descarga en curso o ya terminada no se degrada por un reintento.
      if (updateState.status !== 'downloading' && updateState.status !== 'downloaded') {
        setUpdateState({ status: 'error', error: describeUpdateError(error, detail) });
      }
      return snapshotUpdateState();
    })
    .finally(() => {
      updateCheckInFlight = null;
    });
  return updateCheckInFlight;
}

function downloadUpdateNow() {
  if (!autoUpdater) return Promise.resolve(snapshotUpdateState());
  if (updateState.status === 'downloaded') return Promise.resolve(snapshotUpdateState());
  if (!updateState.version || verifiedUpdateVersion !== updateState.version) {
    logLine('Descarga bloqueada: el manifiesto firmado todavía no se verificó.');
    setUpdateState({ status: 'blocked', error: 'La descarga se bloqueó porque el manifiesto firmado aún no se verificó.' });
    return Promise.resolve(snapshotUpdateState());
  }
  setUpdateState({ status: 'downloading', error: '', message: 'Descargando la actualización…' });
  return autoUpdater
    .downloadUpdate()
    .catch((error) => {
      const detail = updaterErrorDetail(error);
      logLine(`No se pudo descargar la actualización: ${error && error.message ? error.message : error} · ${detail}`);
      setUpdateState({ status: 'error', percent: 0, error: describeUpdateError(error, detail) });
      return null;
    })
    .then(() => snapshotUpdateState());
}

// Reinicia e instala con el Setup ya descargado. isSilent=true aplica la
// actualización NSIS sin mostrar páginas; isForceRunAfter=true vuelve a abrir
// PALMYRA al terminar. Antes de reiniciar se verifica la firma del archivo
// descargado: si no es válida, no se instala (igual que con un archivo USB).
async function installDownloadedUpdate() {
  if (!autoUpdater || updateState.status !== 'downloaded') {
    return { ok: false, error: 'No hay una actualización descargada.' };
  }
  const verification = await ensureDownloadedInstallerChecked();
  if (verification.state === 'rejected') {
    try { autoUpdater.autoInstallOnAppQuit = false; } catch { /* sin efecto */ }
    setUpdateState({ status: 'error', error: verification.error });
    return { ok: false, error: verification.error };
  }
  if (verification.state === 'unknown') {
    // No se localizó el archivo: se conserva el comportamiento anterior para no
    // bloquear las actualizaciones, pero queda registrado.
    logLine('Actualización: se instala sin verificación local del archivo descargado.');
  }
  setUpdateState({ message: 'Reiniciando PALMYRA para aplicar la actualización…' });
  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      logLine(`No se pudo iniciar el instalador: ${error && error.message ? error.message : error}`);
      setUpdateState({ error: 'No se pudo iniciar el instalador. Cierra y abre PALMYRA para reintentarlo.' });
    }
  }, 500);
  return { ok: true };
}

// ─── Verificación de instaladores (Authenticode + versión de producto) ───────
// La verificación vive aquí y no en el renderer: la ventana nunca elige rutas ni
// ejecuta archivos, solo pide «instalar desde archivo» y recibe un resultado.
function powershellExecutable() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const absolute = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    if (fs.existsSync(absolute)) return absolute;
  } catch { /* se usa el del PATH */ }
  return 'powershell.exe';
}

// La ruta entra entre comillas simples (LiteralPath): duplicar la comilla es la
// única interpretación que PowerShell hace dentro de una cadena literal.
function runPowerShellScript(script, filePath) {
  const safePath = String(filePath).replace(/'/g, "''");
  const command = String(script).split('__PATH__').join(safePath);
  return new Promise((resolve, reject) => {
    execFile(
      powershellExecutable(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        windowsHide: true,
        timeout: INSTALLER_VERIFY_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(typeof stdout === 'string' ? stdout : String(stdout || ''));
      }
    );
  });
}

function describeOfflineRejection(code) {
  return OFFLINE_REJECTION_MESSAGES[code] || 'El instalador no superó la verificación. No se instalará.';
}

/**
 * Verifica un .exe local con Get-AuthenticodeSignature y VersionInfo.ProductVersion.
 * Devuelve { ok:true } solo si evaluateOfflineInstaller lo acepta; en cualquier
 * otro caso devuelve { ok:false, code, error } y el archivo no debe ejecutarse.
 */
function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Sin certificado Authenticode todavía, el ancla de confianza es el manifiesto
 * firmado con ES256: el archivo elegido debe tener exactamente el SHA-256 y el
 * tamaño que publica el artefacto de Windows. Si hay huella de publisher
 * configurada no se usa esta vía: la política exige firma Authenticode.
 */
async function verifyInstallerWithManifest(filePath, size) {
  if (UPDATE_PUBLISHER_THUMBPRINT) {
    return { ok: false, error: 'Este equipo exige un instalador firmado con el publisher autorizado.' };
  }
  const { jwk } = updatePublicJwk();
  if (!jwk) {
    return { ok: false, error: 'No hay clave pública para verificar el manifiesto firmado. No se instalará.' };
  }
  const runtime = loadDesktopRuntime();
  if (!runtime || typeof runtime.verifyUpdateManifestForBoot !== 'function') {
    return { ok: false, error: 'El verificador de manifiestos no está disponible. No se instalará.' };
  }
  const result = await runtime.verifyUpdateManifestForBoot({
    manifestUrl: UPDATE_MANIFEST_URL,
    publicJwk: jwk,
    currentVersion: app.getVersion(),
    shellVersion: app.getVersion(),
    deviceId: stableDeviceId(),
    channel: 'stable'
  });
  if (!result || result.ok !== true || result.reason !== 'manifesto-verificado') {
    return { ok: false, error: 'El instalador no se pudo verificar contra el manifiesto firmado. No se instalará.' };
  }
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  const artifact = artifacts.find((item) => item && item.platform === 'windows');
  if (!artifact) {
    return { ok: false, error: 'El manifiesto firmado no publica un instalador para Windows.' };
  }
  let actual = '';
  try {
    actual = await hashFileSha256(filePath);
  } catch (error) {
    logLine(`Actualización: no se pudo calcular el SHA-256 del instalador: ${messageOf(error)}`);
    return { ok: false, error: 'No se pudo leer el archivo seleccionado. No se instalará.' };
  }
  if (actual !== String(artifact.sha256 || '').toLowerCase()) {
    return { ok: false, error: 'El instalador no coincide con el manifiesto firmado. No se instalará.' };
  }
  if (Number(artifact.bytes) !== size) {
    return { ok: false, error: 'El tamaño del instalador no coincide con el manifiesto firmado. No se instalará.' };
  }
  logLine(`Actualización: instalador verificado por manifiesto firmado (v${result.version || '?'}).`);
  return { ok: true, productVersion: result.version || null };
}

async function verifyInstallerFile(filePath, size) {
  let signature = null;
  try {
    signature = parseAuthenticodeJson(await runPowerShellScript(SIGNATURE_PS_SCRIPT, filePath));
  } catch (error) {
    logLine(`Actualización: no se pudo consultar la firma de Authenticode: ${messageOf(error)}`);
  }

  let productVersion = null;
  try {
    productVersion = parseProductVersion(await runPowerShellScript(VERSION_PS_SCRIPT, filePath));
  } catch (error) {
    logLine(`Actualización: no se pudo leer la versión del instalador: ${messageOf(error)}`);
  }

  if (signature) {
    const evaluation = evaluateOfflineInstaller({
      status: signature.status,
      subject: signature.subject,
      thumbprint: signature.thumbprint,
      productVersion,
      currentVersion: app.getVersion(),
      pinnedThumbprint: UPDATE_PUBLISHER_THUMBPRINT
    });
    if (evaluation.ok) {
      logLine(`Actualización: instalador verificado${productVersion ? ` (v${productVersion})` : ''}.`);
      return { ok: true, productVersion };
    }
    logLine(`Actualización: firma Authenticode rechazada (${evaluation.code}).`);
  }

  const fallback = await verifyInstallerWithManifest(filePath, size);
  if (fallback.ok) return fallback;
  return {
    ok: false,
    code: 'unsigned',
    error: fallback.error || 'No se pudo verificar la firma del instalador. No se instalará.'
  };
}

// Carpeta donde electron-updater deja el Setup descargado. El nombre depende del
// producto y de la versión de electron-updater, así que se buscan las variantes
// razonables y se elige el .exe más reciente.
function updatePendingDirectories() {
  const names = new Set(['palmyra-updater']);
  try {
    const appName = app.getName();
    if (appName) {
      names.add(`${appName}-updater`);
      names.add(`${appName.toLowerCase()}-updater`);
    }
  } catch { /* sin nombre de app */ }
  const bases = new Set();
  try { bases.add(path.join(DATA_DIR, '..')); } catch { /* sin userData */ }
  try { bases.add(app.getPath('appData')); } catch { /* sin appData */ }
  if (process.env.LOCALAPPDATA) bases.add(process.env.LOCALAPPDATA);

  const dirs = [];
  for (const base of bases) {
    if (!base) continue;
    for (const name of names) {
      dirs.push(path.join(base, name, 'pending'));
      dirs.push(path.join(base, name));
    }
  }
  return dirs;
}

function locateDownloadedInstaller(hint) {
  const direct = typeof hint === 'string' && /\.exe$/i.test(hint) ? hint : '';
  if (direct) {
    try { if (fs.statSync(direct).isFile()) return direct; } catch { /* se busca abajo */ }
  }
  let newest = '';
  let newestAt = 0;
  for (const dir of updatePendingDirectories()) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.exe$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile() || stat.size <= 0) continue;
      const at = stat.mtimeMs || 0;
      if (at >= newestAt) {
        newestAt = at;
        newest = full;
      }
    }
  }
  return newest;
}

const downloadedInstallerCheck = { state: 'idle', error: '', path: '', promise: null };

function resetDownloadedInstallerCheck() {
  downloadedInstallerCheck.state = 'idle';
  downloadedInstallerCheck.error = '';
  downloadedInstallerCheck.path = '';
  downloadedInstallerCheck.promise = null;
}

async function verifyDownloadedInstaller(hint) {
  const filePath = locateDownloadedInstaller(hint);
  if (!filePath) {
    logLine('Actualización: no se localizó el instalador descargado; se omite la verificación local.');
    return { state: 'unknown', error: '', path: '' };
  }
  let result;
  try {
    result = await verifyInstallerFile(filePath);
  } catch (error) {
    logLine(`Actualización: la verificación del instalador falló: ${messageOf(error)}`);
    return { state: 'unknown', error: '', path: filePath };
  }
  if (result.ok) return { state: 'verified', error: '', path: filePath };
  return { state: 'rejected', error: result.error, path: filePath };
}

function ensureDownloadedInstallerChecked(hint) {
  if (downloadedInstallerCheck.state === 'verified' || downloadedInstallerCheck.state === 'rejected') {
    return Promise.resolve(downloadedInstallerCheck);
  }
  if (downloadedInstallerCheck.promise) return downloadedInstallerCheck.promise;
  downloadedInstallerCheck.promise = verifyDownloadedInstaller(hint)
    .catch((error) => {
      logLine(`Actualización: la verificación del instalador falló: ${messageOf(error)}`);
      return { state: 'unknown', error: '', path: '' };
    })
    .then((result) => {
      downloadedInstallerCheck.state = result.state;
      downloadedInstallerCheck.error = result.error || '';
      downloadedInstallerCheck.path = result.path || '';
      downloadedInstallerCheck.promise = null;
      return result;
    });
  return downloadedInstallerCheck.promise;
}

// ─── Instalación desde un archivo local (USB o copia manual) ────────────────
let offlineInstallInFlight = false;

async function installFromFile() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'La instalación desde archivo solo está disponible en Windows.' };
  }
  if (offlineInstallInFlight) {
    return { ok: false, error: 'Ya hay una instalación en curso.' };
  }
  let selection = null;
  try {
    const options = {
      title: 'Instalar actualización desde archivo',
      buttonLabel: 'Verificar e instalar',
      filters: [{ name: 'Instalador Palmyra', extensions: ['exe'] }],
      properties: ['openFile']
    };
    selection = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
  } catch (error) {
    logLine(`Actualización: no se pudo abrir el selector de archivos: ${messageOf(error)}`);
    return { ok: false, error: 'No se pudo abrir el selector de archivos.' };
  }
  if (!selection || selection.canceled === true || !Array.isArray(selection.filePaths) || selection.filePaths.length === 0) {
    return { ok: false, error: 'Cancelado.' };
  }

  const filePath = String(selection.filePaths[0] || '');
  if (!/\.exe$/i.test(filePath)) {
    return { ok: false, error: 'Selecciona un archivo .exe del instalador de PALMYRA.' };
  }
  let size = 0;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ok: false, error: 'El archivo seleccionado no es válido.' };
    size = stat.size;
  } catch {
    return { ok: false, error: 'No se pudo leer el archivo seleccionado.' };
  }
  if (size <= 0) return { ok: false, error: 'El archivo seleccionado está vacío.' };
  if (size > INSTALLER_MAX_BYTES) {
    return { ok: false, error: 'El archivo supera el tamaño máximo permitido para un instalador.' };
  }

  offlineInstallInFlight = true;
  try {
    const verified = await verifyInstallerFile(filePath, size);
    if (!verified.ok) {
      setUpdateState({ error: verified.error });
      return { ok: false, error: verified.error };
    }

    setUpdateState({ message: 'Instalando la actualización desde archivo…', error: '' });
    // NSIS silencioso (/S) y desacoplado: el proceso actual se cierra enseguida.
    const child = spawn(filePath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    child.on('error', (error) => logLine(`Actualización: el instalador no arrancó: ${messageOf(error)}`));
    setTimeout(() => {
      try { app.quit(); } catch { /* el cierre es best-effort */ }
    }, 600);
    return { ok: true };
  } finally {
    offlineInstallInFlight = false;
  }
}

function isTrustedRenderer(event) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (event.sender !== mainWindow.webContents) return false;
    const url = event.senderFrame && event.senderFrame.url ? event.senderFrame.url : event.sender.getURL();
    return typeof url === 'string' && url.startsWith(BASE_URL);
  } catch {
    return false;
  }
}

function registerUpdateIpc() {
  ipcMain.handle('palmyra:update:get-state', (event) => (isTrustedRenderer(event) ? snapshotUpdateState() : null));
  ipcMain.handle('palmyra:update:check', async (event) => {
    if (!isTrustedRenderer(event)) return null;
    await checkForUpdatesNow('manual');
    return snapshotUpdateState();
  });
  ipcMain.handle('palmyra:update:download', async (event) => {
    if (!isTrustedRenderer(event)) return null;
    await downloadUpdateNow();
    return snapshotUpdateState();
  });
  ipcMain.handle('palmyra:update:install', async (event) => {
    if (!isTrustedRenderer(event)) return { ok: false, error: 'Origen no autorizado.' };
    return installDownloadedUpdate();
  });
  // Instalación desde USB o copia manual: la ventana solo pide abrir el diálogo;
  // la verificación de firma, versión y el lanzamiento ocurren en este proceso.
  ipcMain.handle('palmyra:update:install-file', async (event) => {
    if (!isTrustedRenderer(event)) return { ok: false, error: 'Origen no autorizado.' };
    return installFromFile();
  });
}

function initAutoUpdater() {
  // En desarrollo no hay app-update.yml ni instalación NSIS: se informa y la UI
  // no muestra ningún aviso.
  if (!app.isPackaged) {
    setUpdateState({ status: 'unsupported', message: 'Las actualizaciones automáticas se aplican en la versión instalada.' });
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    logLine(`electron-updater no está disponible: ${error && error.message ? error.message : error}`);
    setUpdateState({ status: 'unsupported', message: 'Este instalador no incluye el actualizador automático.' });
    return;
  }

  // La descarga solo se dispara tras validar el manifiesto firmado.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (message) => logLine(`updater: ${typeof message === 'string' ? message : JSON.stringify(message)}`),
    warn: (message) => logLine(`updater aviso: ${typeof message === 'string' ? message : JSON.stringify(message)}`),
    error: (message) => logLine(`updater error: ${typeof message === 'string' ? message : JSON.stringify(message)}`),
    debug: () => {}
  };

  autoUpdater.on('checking-for-update', () => {
    resetDownloadedInstallerCheck();
    verifiedUpdateVersion = '';
    setUpdateState({ status: 'checking', error: '' });
  });
  autoUpdater.on('update-available', (info) => {
    const file = info && Array.isArray(info.files) && info.files[0] ? info.files[0] : null;
    logLine(`updater: versión disponible v${String((info && info.version) || '?')}`
      + `${file && file.url ? ` · archivo=${String(file.url).split('?')[0]}` : ''}`
      + `${file && file.sha512 ? ' · sha512 presente' : ''}`);
    resetDownloadedInstallerCheck();
    setUpdateState({
      status: 'available',
      version: String((info && info.version) || ''),
      percent: 0,
      transferred: 0,
      total: 0,
      error: '',
      message: 'Verificando la firma de la actualización…'
    });
    void verifyAndDownloadUpdate(info);
  });
  autoUpdater.on('update-not-available', (info) => {
    setUpdateState({
      status: 'not-available',
      version: String((info && info.version) || ''),
      percent: 0,
      transferred: 0,
      total: 0,
      error: '',
      message: 'PALMYRA POS ya está actualizado.'
    });
  });
  autoUpdater.on('download-progress', (progress) => {
    const rawPercent = Number(progress && progress.percent);
    setUpdateState({
      status: 'downloading',
      percent: Number.isFinite(rawPercent) ? Math.min(100, Math.max(0, Math.round(rawPercent))) : updateState.percent,
      transferred: Math.max(0, Number(progress && progress.transferred) || 0),
      total: Math.max(0, Number(progress && progress.total) || 0),
      error: ''
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({
      status: 'downloaded',
      version: String((info && info.version) || updateState.version),
      percent: 100,
      error: '',
      message: 'La actualización está lista. Reinicia PALMYRA para aplicarla.'
    });
    // La firma del Setup descargado se comprueba en cuanto termina la descarga,
    // antes de que el usuario pueda reiniciar para instalarlo.
    resetDownloadedInstallerCheck();
    const hint = info && typeof info.downloadedFile === 'string' ? info.downloadedFile : '';
    const currentUpdater = autoUpdater;
    void ensureDownloadedInstallerChecked(hint).then((result) => {
      if (!currentUpdater) return;
      if (result.state === 'rejected') {
        // Nunca instalar al cerrar un archivo que no superó la verificación.
        try { currentUpdater.autoInstallOnAppQuit = false; } catch { /* sin efecto */ }
        setUpdateState({ status: 'error', error: result.error });
        return;
      }
      if (result.state === 'verified') {
        // Firma comprobada: se restaura el comportamiento habitual al cerrar.
        try { currentUpdater.autoInstallOnAppQuit = true; } catch { /* sin efecto */ }
        return;
      }
      if (result.state === 'unknown') {
        setUpdateState({
          message: 'La actualización está lista. No se pudo verificar la firma del archivo descargado; se aplicará como antes.'
        });
      }
    });
  });
  autoUpdater.on('error', (error) => {
    const detail = updaterErrorDetail(error);
    logLine(`Error de actualización: ${error && error.stack ? error.stack : error} · ${detail}`);
    // Si el paquete ya está descargado, un fallo posterior no lo invalida.
    if (updateState.status === 'downloaded') return;
    setUpdateState({ status: 'error', percent: 0, error: describeUpdateError(error, detail) });
  });

  // El reloj del foco arranca aquí: así la primera ventana al abrirse no
  // dispara un chequeo antes del retardo de arranque.
  lastUpdateCheckAt = Date.now();
  setTimeout(() => { void checkForUpdatesNow('arranque'); }, UPDATE_BOOT_DELAY_MS);
  updatePollTimer = setInterval(() => { void checkForUpdatesNow('intervalo'); }, UPDATE_CHECK_INTERVAL_MS);
}

// ─── Hub LAN ────────────────────────────────────────────────────────────────
const COMPANY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

let desktopRuntime = null;
let hubRuntime = null;
let hubStatus = {
  enabled: lanAccessEnabled(),
  running: false,
  host: lanAccessEnabled() ? '0.0.0.0' : LOOPBACK,
  port: Number(process.env.PALMYRA_HUB_PORT) || 48900,
  companyId: '',
  pairingCode: '',
  pairingExpiresAt: '',
  lastError: '',
  tlsEnabled: false,
  tlsFingerprint: ''
};

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

/**
 * El hub solo bloquea una restauración cuando está escuchando para equipos;
 * detenido o deshabilitado no hay lecturas concurrentes que proteger.
 */
function hubBusyServing() {
  try {
    return hubStatus.running === true;
  } catch {
    return false;
  }
}

// dist/desktop-runtime.cjs concentra el hub y el guardián del manifiesto. En
// desarrollo puede no existir todavía: se registra y el hub queda deshabilitado.
function loadDesktopRuntime() {
  if (desktopRuntime) return desktopRuntime;
  const file = path.join(app.getAppPath(), 'dist', 'desktop-runtime.cjs');
  try {
    desktopRuntime = require(file);
    logLine(`Runtime de escritorio cargado: ${file}`);
  } catch (error) {
    desktopRuntime = null;
    logLine(`Runtime de escritorio no disponible (${file}): ${messageOf(error)}`);
  }
  return desktopRuntime;
}

function ensureHubRuntime() {
  if (hubRuntime) return hubRuntime;
  const runtime = loadDesktopRuntime();
  if (!runtime || typeof runtime.createHubRuntime !== 'function') {
    hubStatus = { ...hubStatus, running: false, lastError: 'El hub LAN no está disponible en esta instalación.' };
    return null;
  }
  try {
    hubRuntime = runtime.createHubRuntime({
      adapter: dbMain.getAdapter(),
      dataDir: DATA_DIR,
      log: logLine,
      lanEnabled: lanAccessEnabled(),
      hubId: os.hostname() || 'palmyra'
    });
    hubStatus = { ...hubStatus, enabled: lanAccessEnabled() };
  } catch (error) {
    logLine(`No se pudo crear el runtime del hub: ${messageOf(error)}`);
    hubStatus = { ...hubStatus, lastError: `No se pudo crear el hub LAN: ${messageOf(error)}` };
    return null;
  }
  return hubRuntime;
}

function applyHubStatus(next) {
  if (!next || typeof next !== 'object') return hubStatus;
  hubStatus = {
    enabled: next.enabled === true,
    running: next.running === true,
    host: String(next.host || ''),
    port: Number(next.port) || 0,
    companyId: String(next.companyId || ''),
    pairingCode: String(next.pairingCode || ''),
    pairingExpiresAt: String(next.pairingExpiresAt || ''),
    lastError: String(next.lastError || ''),
    tlsEnabled: next.tlsEnabled === true,
    tlsFingerprint: String(next.tlsFingerprint || '')
  };
  return hubStatus;
}

async function hubStart(companyId) {
  if (typeof companyId !== 'string' || !COMPANY_ID_RE.test(companyId)) {
    return { ok: false, error: 'Identificador de empresa inválido.' };
  }
  const runtime = ensureHubRuntime();
  if (!runtime) {
    return { ok: false, error: hubStatus.lastError || 'El hub LAN no está disponible.' };
  }
  try {
    const status = applyHubStatus(await runtime.start({ companyId }));
    logLine(`Hub LAN: ${status.running ? 'activo' : 'detenido'}${status.lastError ? ` · ${status.lastError}` : ''}`);
    return status.running ? { ok: true, status } : { ok: false, error: status.lastError || 'No se pudo iniciar el hub.' };
  } catch (error) {
    logLine(`No se pudo iniciar el hub: ${messageOf(error)}`);
    return { ok: false, error: 'No se pudo iniciar el hub LAN.' };
  }
}

async function hubStop() {
  const runtime = ensureHubRuntime();
  if (!runtime) return { ok: true, status: hubStatus };
  try {
    return { ok: true, status: applyHubStatus(await runtime.stop()) };
  } catch (error) {
    logLine(`No se pudo detener el hub: ${messageOf(error)}`);
    return { ok: false, error: 'No se pudo detener el hub LAN.' };
  }
}

async function hubPairing() {
  const runtime = ensureHubRuntime();
  if (!runtime) {
    return { ok: false, error: hubStatus.lastError || 'El hub LAN no está disponible.' };
  }
  try {
    const status = applyHubStatus(await runtime.newPairingCode());
    return status.running ? { ok: true, status } : { ok: false, error: status.lastError || 'El hub LAN no está iniciado.' };
  } catch (error) {
    logLine(`No se pudo crear el código de emparejamiento: ${messageOf(error)}`);
    return { ok: false, error: 'No se pudo crear el código de emparejamiento.' };
  }
}

// ─── Huella TLS del hub y descubrimiento mDNS ───────────────────────────────
// El certificado del hub es autofirmado: Chromium lo rechazaría. La huella se
// fija por hostname en memoria y `setCertificateVerifyProc` acepta el
// certificado solo si el sha256 de su DER coincide. Sin pin guardado se usa el
// resultado por defecto de Chromium (-3), así el resto de navegación no cambia.
const hubCertPins = new Map();
let certificatePinVerifierInstalled = false;

function sha256OfCertificatePem(pem) {
  try {
    const raw = new crypto.X509Certificate(pem).raw;
    return crypto.createHash('sha256').update(raw).digest('hex');
  } catch {
    return '';
  }
}

function installCertificatePinVerifier() {
  if (certificatePinVerifierInstalled) return;
  certificatePinVerifierInstalled = true;
  try {
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      const hostname = String(request && request.hostname ? request.hostname : '').toLowerCase();
      const pin = hostname ? hubCertPins.get(hostname) : null;
      // -3: sin pin, decide Chromium con su verificación normal.
      if (!pin) return callback(-3);
      const pem = request && request.certificate && typeof request.certificate.data === 'string'
        ? request.certificate.data
        : '';
      const actual = sha256OfCertificatePem(pem);
      // -2: hay pin y no coincide (o el certificado no se pudo leer).
      return callback(actual && actual === pin ? 0 : -2);
    });
  } catch (error) {
    logLine(`No se pudo instalar la verificación de huella TLS: ${messageOf(error)}`);
  }
}

function hubPinCertificate(baseUrl, fingerprint) {
  let url;
  try {
    url = new URL(typeof baseUrl === 'string' ? baseUrl.trim() : '');
  } catch {
    return { ok: false, error: 'La dirección del hub no es válida.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'La dirección del hub no es válida.' };
  }
  const hostname = url.hostname.toLowerCase();
  const pin = typeof fingerprint === 'string'
    ? fingerprint.replace(/[\s:]/g, '').toLowerCase()
    : '';
  if (!hostname || !/^[a-f0-9]{64}$/.test(pin)) {
    return { ok: false, error: 'La huella TLS del hub no es válida.' };
  }
  hubCertPins.set(hostname, pin);
  installCertificatePinVerifier();
  logLine(`Huella TLS fijada para ${hostname} (${pin.slice(0, 8)}…).`);
  return { ok: true };
}

async function hubDiscoverHubs(timeoutMs) {
  const requested = Number(timeoutMs);
  const ms = Number.isFinite(requested)
    ? Math.min(5000, Math.max(200, Math.round(requested)))
    : 1500;
  const runtime = loadDesktopRuntime();
  if (!runtime || typeof runtime.discoverHubs !== 'function') {
    return { ok: false, error: 'El descubrimiento mDNS no está disponible en esta instalación.' };
  }
  try {
    const result = await runtime.discoverHubs(ms);
    if (!result || result.ok !== true || !Array.isArray(result.hubs)) {
      return {
        ok: false,
        error: (result && typeof result.error === 'string' && result.error) || 'No se pudo buscar el hub en la red.'
      };
    }
    return { ok: true, hubs: result.hubs };
  } catch (error) {
    logLine(`No se pudo buscar el hub en la red: ${messageOf(error)}`);
    return { ok: false, error: 'No se pudo buscar el hub en la red.' };
  }
}

// ─── Respaldo y restauración del hub ─────────────────────────────────────────
// Solo el proceso principal toca los respaldos: la ventana puede listarlos y
// pedir una restauración, pero la carpeta, la clave, la instantánea de
// seguridad y la escritura se resuelven aquí. Un respaldo del hub es un sobre
// cifrado (services/lanHub/backup.ts) con todas las tablas de negocio.
const HUB_BACKUP_DIR_NAME = 'hub-backups';
const HUB_BACKUP_FORMAT = 'palmyra-backup-v1';
// Nombres que produce el runtime (diario/semanal) y las instantáneas previas a
// restaurar. Nada más se acepta: así una ruta propuesta por la ventana no sirve.
const HUB_BACKUP_FILE_RE = /^(?:palmyra-\d{4}-\d{2}-\d{2}|weekly-\d{4}-W\d{2}|safety-\d{8}-\d{6})\.pbak$/;
const HUB_BACKUP_SAFETY_RE = /^safety-\d{8}-\d{6}\.pbak$/;
const HUB_BACKUP_LIST_LIMIT = 12;
const HUB_BACKUP_MAX_PARSE_BYTES = 96 * 1024 * 1024;
const HUB_RESTORE_CONFIRMATION_WORD = 'RESTAURAR';

let hubRestoreInFlight = false;
let hubBackupModules = null;

function hubBackupDir() {
  return path.join(DATA_DIR, HUB_BACKUP_DIR_NAME);
}

function hubBackupsDir() {
  return path.join(hubBackupDir(), 'backups');
}

/** Ruta absoluta dentro de la carpeta de respaldos, o null si el nombre no vale. */
function hubBackupPath(fileName) {
  if (typeof fileName !== 'string' || !HUB_BACKUP_FILE_RE.test(fileName)) return null;
  const root = path.resolve(hubBackupsDir());
  const target = path.resolve(path.join(root, fileName));
  return path.dirname(target) === root ? target : null;
}

/**
 * Carga las rutinas REALES de respaldo (cripto, clave y driver). En el paquete
 * esbuild resuelve estas rutas y las incluye en el bundle; en desarrollo se
 * registra el cargador de TypeScript de tsx. No se reimplementa la cripto.
 */
function loadHubBackupModules() {
  if (hubBackupModules) return hubBackupModules;
  try {
    if (isDev) {
      // `Function` evita que esbuild intente empaquetar el cargador de tsx.
      try { Function('return require')()('tsx/cjs'); } catch { /* sin tsx */ }
    }
    const backup = require('./src/services/lanHub/backup.ts');
    const store = require('./src/services/lanHub/backupStoreNode.ts');
    const sqlite = require('./src/services/localDb/sqlite/driver.ts');
    if (
      !backup || typeof backup.createBackup !== 'function' || typeof backup.restoreBackup !== 'function' ||
      !store || typeof store.loadOrCreateBackupKey !== 'function' ||
      !sqlite || typeof sqlite.createSqliteDriver !== 'function'
    ) {
      return null;
    }
    hubBackupModules = { backup, store, sqlite };
  } catch (error) {
    logLine(`Respaldo del hub no disponible: ${messageOf(error)}`);
    return null;
  }
  return hubBackupModules;
}

/**
 * Metadatos del sobre SIN descifrar: la fecha, la empresa y los conteos viajan
 * en claro a propósito para poder listar respaldos sin la clave. Se extraen con
 * búsquedas puntuales para no cargar en memoria el contenido cifrado completo.
 */
function readEnvelopeSummary(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!raw.includes(`"format":"${HUB_BACKUP_FORMAT}"`)) return null;
  const createdMatch = /"createdAt":"([^"]+)"/.exec(raw);
  const createdAt = createdMatch ? createdMatch[1] : '';
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) return null;
  const companyMatch = /"companyId":"([^"]+)"/.exec(raw);
  const companyId = companyMatch ? companyMatch[1].slice(0, 64) : '';
  let totalRows = 0;
  let tableCount = 0;
  const countsIndex = raw.lastIndexOf('"counts":{');
  if (countsIndex >= 0) {
    const end = raw.indexOf('}', countsIndex);
    const body = end > countsIndex ? raw.slice(countsIndex + 10, end) : '';
    const pattern = /"([A-Za-z_]+)":(\d+)/g;
    let match = pattern.exec(body);
    while (match) {
      const value = Number(match[2]);
      if (Number.isFinite(value) && value >= 0) {
        totalRows += value;
        if (value > 0) tableCount += 1;
      }
      match = pattern.exec(body);
    }
  }
  return { createdAt, companyId, totalRows, tableCount };
}

/**
 * Lista los respaldos del hub (máximo 12 más recientes para no leer de más).
 * Un archivo ilegible o ajeno se omite: nunca se informa de un respaldo roto
 * como si sirviera.
 */
async function hubListBackups() {
  try {
    const dir = hubBackupsDir();
    let names;
    try {
      names = await fs.promises.readdir(dir);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return { ok: true, backups: [] };
      }
      throw error;
    }

    const files = [];
    for (const name of names) {
      if (!HUB_BACKUP_FILE_RE.test(name)) continue;
      try {
        const info = await fs.promises.stat(path.join(dir, name));
        if (!info.isFile() || info.size <= 0) continue;
        files.push({ name, sizeBytes: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // Archivo desaparecido entre readdir y stat.
      }
    }
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);

    const backups = [];
    for (const file of files.slice(0, HUB_BACKUP_LIST_LIMIT)) {
      let summary = null;
      if (file.sizeBytes <= HUB_BACKUP_MAX_PARSE_BYTES) {
        try {
          summary = readEnvelopeSummary(await fs.promises.readFile(path.join(dir, file.name), 'utf8'));
        } catch {
          summary = null;
        }
      }
      if (!summary) continue;
      backups.push({
        fileName: file.name,
        createdAt: summary.createdAt,
        sizeBytes: file.sizeBytes,
        totalRows: summary.totalRows,
        tableCount: summary.tableCount,
        companyId: summary.companyId,
        safety: HUB_BACKUP_SAFETY_RE.test(file.name)
      });
    }
    return { ok: true, backups };
  } catch (error) {
    logLine(`No se pudieron listar los respaldos del hub: ${messageOf(error)}`);
    return { ok: false, error: 'No se pudieron leer los respaldos del hub.' };
  }
}

/** Marca UTC `YYYYMMDD-HHMMSS` para la instantánea previa a restaurar. */
function hubSafetyStamp(moment = new Date()) {
  const iso = moment.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/**
 * Escribe la instantánea de seguridad (el respaldo del estado ACTUAL) antes de
 * restaurar. Es una escritura atómica y con nombre propio: no sobrescribe los
 * respaldos diarios ni entra en la rotación 7+4.
 */
async function writeHubSafetySnapshot(envelope) {
  if (!envelope || envelope.format !== HUB_BACKUP_FORMAT || typeof envelope.data !== 'string') {
    throw new Error('La instantánea de seguridad quedó vacía.');
  }
  const dir = hubBackupsDir();
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const fileName = `safety-${hubSafetyStamp()}.pbak`;
  const target = path.join(dir, fileName);
  const temp = `${target}.tmp`;
  const text = JSON.stringify(envelope);
  try {
    await fs.promises.writeFile(temp, text, { mode: 0o600 });
    await fs.promises.rename(temp, target);
  } catch (error) {
    try { await fs.promises.unlink(temp); } catch { /* sin temporal */ }
    throw error;
  }
  let totalRows = 0;
  for (const value of Object.values(envelope.counts || {})) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) totalRows += value;
  }
  return { ok: true, fileName, sizeBytes: text.length, createdAt: envelope.createdAt, totalRows };
}

/** Empresa del hub: la activa o, si está detenido, la única del almacén local. */
async function hubRestoreCompanyId(envelope) {
  if (COMPANY_ID_RE.test(String(hubStatus.companyId || ''))) return hubStatus.companyId;
  try {
    const result = await dbMain.invoke('renderer', { op: 'all', sql: 'SELECT id FROM companies LIMIT 2' });
    if (result && result.ok === true && Array.isArray(result.rows) && result.rows.length === 1) {
      const id = result.rows[0] && result.rows[0].id;
      if (typeof id === 'string' && COMPANY_ID_RE.test(id)) return id;
    }
    // Almacén recién instalado: el respaldo puede traer la primera empresa.
    if (result && result.ok === true && Array.isArray(result.rows) && result.rows.length === 0) {
      const declared = envelope && typeof envelope.companyId === 'string' ? envelope.companyId.trim() : '';
      if (COMPANY_ID_RE.test(declared)) return declared;
    }
  } catch {
    // Se informa abajo como empresa desconocida.
  }
  return '';
}

/**
 * Guarda previa (misma regla que la función pura de scripts/restore-drill.ts):
 * confirmación explícita, sin otra restauración en curso, empresa resuelta y
 * una instantánea de seguridad creada con éxito.
 */
function evaluateHubRestorePreflight(input) {
  if (!input || input.confirmed !== true) {
    return { ok: false, error: 'La restauración exige confirmación explícita.' };
  }
  if (input.inFlight === true) {
    return { ok: false, error: 'Ya hay una restauración del hub en curso.' };
  }
  if (typeof input.companyId !== 'string' || input.companyId.trim() === '') {
    return { ok: false, error: 'No se pudo determinar la empresa del hub.' };
  }
  if (!input.safetySnapshot || input.safetySnapshot.ok !== true) {
    return { ok: false, error: 'La instantánea de seguridad falló; no se restaura nada.' };
  }
  return { ok: true };
}

/** Diálogo nativo: la última palabra la tiene el operador, no la ventana. */
async function confirmHubRestore(fileName, companyId, summary) {
  const options = {
    type: 'warning',
    buttons: ['Cancelar', 'Restaurar el hub'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Restaurar el hub LAN',
    message: '¿Restaurar el hub desde este respaldo?',
    detail: [
      'Se reemplazarán TODOS los datos del hub por el contenido del respaldo seleccionado.',
      `Respaldo: ${fileName}`,
      summary && summary.createdAt ? `Creado: ${summary.createdAt}` : '',
      summary && summary.totalRows ? `Filas en el respaldo: ${summary.totalRows}` : '',
      `Empresa: ${companyId}`,
      'Antes de escribir se guardará una instantánea de seguridad del estado actual.',
      'Las ventas y movimientos posteriores al respaldo se perderán. Esta acción no se puede deshacer desde la aplicación.'
    ].filter(Boolean).join('\n')
  };
  try {
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    return Boolean(result) && result.response === 1;
  } catch (error) {
    logLine(`No se pudo confirmar la restauración del hub: ${messageOf(error)}`);
    return false;
  }
}

/**
 * Restaura un respaldo del hub. Orden estricto:
 *   validar nombre → resolver empresa → diálogo nativo → DETENER el hub →
 *   crear instantánea de seguridad (si falla, abortar) → restoreBackup →
 *   persistir → reabrir el hub. Nada se escribe sin confirmación y sin una
 *   copia previa del estado actual.
 */
async function hubRestoreBackup(request) {
  if (hubRestoreInFlight) {
    return { ok: false, error: 'Ya hay una restauración del hub en curso.' };
  }
  const fileName = request && request.fileName;
  const confirmation = request && request.confirmation;
  const target = hubBackupPath(fileName);
  if (!target) return { ok: false, error: 'El respaldo seleccionado no es válido.' };
  if (confirmation !== HUB_RESTORE_CONFIRMATION_WORD) {
    return { ok: false, error: `Escribe ${HUB_RESTORE_CONFIRMATION_WORD} para confirmar la restauración.` };
  }
  const modules = loadHubBackupModules();
  if (!modules) {
    return { ok: false, error: 'La restauración del hub no está disponible en esta instalación.' };
  }

  let envelopeText;
  try {
    envelopeText = await fs.promises.readFile(target, 'utf8');
  } catch {
    return { ok: false, error: 'No se pudo leer el respaldo seleccionado.' };
  }
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    return { ok: false, error: 'El respaldo seleccionado está dañado.' };
  }
  const summary = readEnvelopeSummary(envelopeText);
  if (!summary || !envelope || envelope.format !== HUB_BACKUP_FORMAT) {
    return { ok: false, error: 'El respaldo seleccionado no es un respaldo del hub.' };
  }

  const companyId = await hubRestoreCompanyId(envelope);
  if (!companyId) {
    return { ok: false, error: 'No se pudo determinar la empresa del hub. Inicia sesión en la empresa correcta.' };
  }
  if (summary.companyId && summary.companyId !== companyId) {
    return {
      ok: false,
      error: `El respaldo pertenece a otra empresa (${summary.companyId}); la instalación es ${companyId}.`
    };
  }

  const confirmed = await confirmHubRestore(fileName, companyId, summary);
  if (!confirmed) {
    return { ok: false, cancelled: true, error: 'Restauración cancelada por el operador.' };
  }

  hubRestoreInFlight = true;
  const wasRunning = hubStatus.running === true;
  let driver = null;
  try {
    if (wasRunning) {
      const stopped = await hubStop();
      if (!stopped.ok) {
        return { ok: false, error: stopped.error || 'No se pudo detener el hub para restaurar.' };
      }
    }

    const adapter = dbMain.getAdapter();
    if (adapter && typeof adapter.whenFree === 'function') await adapter.whenFree();
    driver = await modules.sqlite.createSqliteDriver({
      adapter,
      filePath: path.join(DATA_DIR, 'palmyra.db')
    });

    const keyHandle = await modules.store.loadOrCreateBackupKey(hubBackupDir());
    const key = keyHandle && keyHandle.key;
    if (!key) return { ok: false, error: 'No se pudo abrir la clave de los respaldos del hub.' };

    // Instantánea de seguridad ANTES de escribir: si falla, no se restaura.
    let safety;
    try {
      const current = await modules.backup.createBackup(driver, { companyId, key });
      safety = await writeHubSafetySnapshot(current);
    } catch (error) {
      logLine(`No se pudo crear la instantánea de seguridad del hub: ${messageOf(error)}`);
      return {
        ok: false,
        error: 'No se pudo crear la instantánea de seguridad; la restauración se canceló sin escribir nada.'
      };
    }

    const preflight = evaluateHubRestorePreflight({
      confirmed: true,
      inFlight: false,
      companyId,
      safetySnapshot: safety
    });
    if (!preflight.ok) return { ok: false, error: preflight.error };

    const report = await modules.backup.restoreBackup(driver, envelope, key, { companyId });
    try { dbMain.flush(); } catch { /* el siguiente guardado lo reintenta */ }
    logLine(
      `Hub restaurado desde ${fileName}: ${report.restored} filas escritas en ` +
        `${Object.keys(report.counts || {}).length} tablas; instantánea ${safety.fileName}.`
    );
    return {
      ok: true,
      restoredFrom: fileName,
      safetySnapshot: safety.fileName,
      written: report.restored,
      tables: Object.keys(report.counts || {}).length
    };
  } catch (error) {
    logLine(`No se pudo restaurar el hub desde ${fileName}: ${messageOf(error)}`);
    return {
      ok: false,
      safetySnapshot: '',
      error: 'No se pudo restaurar el hub; la base quedó como estaba. Revisa desktop.log.'
    };
  } finally {
    if (driver) {
      try { await driver.close(); } catch { /* ya cerrado */ }
    }
    if (wasRunning) {
      const restarted = await hubStart(companyId);
      if (!restarted.ok) {
        logLine(`El hub no se pudo reiniciar tras la restauración: ${restarted.error || 'sin detalle'}`);
      }
    }
    hubRestoreInFlight = false;
  }
}

// ─── Almacén de secretos locales (safeStorage) ───────────────────────────────
// safeStorage usa el llavero del sistema (DPAPI en Windows, Keychain en macOS,
// libsecret en Linux). Cada secreto es un archivo independiente con nombre
// validado; el cifrado y la ruta nunca dependen del renderer. Si el sistema no
// ofrece backend se responde `unavailable` y la interfaz degrada a IndexedDB.
const SECURE_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const MAX_SECRET_LENGTH = 200000;
// Los secretos de licencia (identidad del equipo y copia del lease) son
// sobres pequeños: el main aplica el mismo techo que el preload para que el
// canal no se convierta en almacén arbitrario. El material de clave nunca se
// registra en el log; solo el nombre de la clave y el error.
const LICENSE_SECRET_PREFIX = 'license-';
const MAX_LICENSE_SECRET_LENGTH = 16384;
const SECURE_DIR = path.join(DATA_DIR, 'secrets');

function secureKeyPath(key) {
  return path.join(SECURE_DIR, `${key}.bin`);
}

function safeStorageReady() {
  try {
    return safeStorage.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}

/**
 * Backend real del llavero. En Linux Electron puede informar `basic_text`
 * cuando no hay libsecret/gnome-keyring: eso NO cifra de verdad, así que el
 * almacén se declara no disponible y nunca se escribe un secreto en claro.
 * Todo va envuelto: un fallo del backend jamás debe impedir el arranque.
 */
function secureStoreBackend() {
  try {
    if (!safeStorageReady()) return 'none';
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      const backend = safeStorage.getSelectedStorageBackend();
      return backend ? String(backend) : 'unknown';
    }
    if (process.platform === 'win32') return 'dpapi';
    if (process.platform === 'darwin') return 'keychain';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function secureStoreAvailable() {
  if (!safeStorageReady()) return false;
  // `basic_text` guarda en claro: se degrada igual que si no hubiera llavero.
  return secureStoreBackend() !== 'basic_text';
}

/** Diagnóstico visible (IPC y log): nunca incluye rutas, claves ni secretos. */
function secureStoreStatus() {
  let available = false;
  let backend = 'none';
  try {
    available = secureStoreAvailable();
    backend = secureStoreBackend();
    if (backend === 'basic_text') available = false;
  } catch {
    available = false;
    backend = 'unknown';
  }
  const reason = available
    ? 'El llavero del sistema cifra los secretos en reposo.'
    : backend === 'basic_text'
      ? 'Linux no ofrece llavero (solo basic_text): no se guardan secretos en claro; se usa IndexedDB del renderer.'
      : 'El cifrado del sistema no está disponible: no se guardan secretos en claro; se usa IndexedDB del renderer.';
  return {
    ok: true,
    available,
    backend,
    platform: process.platform,
    fallback: available ? 'none' : 'indexeddb',
    reason
  };
}

function secureGet(key) {
  if (typeof key !== 'string' || !SECURE_KEY_PATTERN.test(key)) {
    return { ok: false, error: 'Clave de secreto inválida.' };
  }
  if (!secureStoreAvailable()) {
    return { ok: false, unavailable: true, error: 'El cifrado del sistema no está disponible.' };
  }
  try {
    const raw = fs.readFileSync(secureKeyPath(key));
    return { ok: true, value: safeStorage.decryptString(raw) };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, value: null };
    logLine(`Almacén seguro: no se pudo descifrar "${key}": ${messageOf(error)}`);
    return { ok: false, error: 'No se pudo descifrar el secreto guardado.' };
  }
}

function secureSet(key, value) {
  if (typeof key !== 'string' || !SECURE_KEY_PATTERN.test(key)) {
    return { ok: false, error: 'Clave de secreto inválida.' };
  }
  const maxLength = key.startsWith(LICENSE_SECRET_PREFIX)
    ? MAX_LICENSE_SECRET_LENGTH
    : MAX_SECRET_LENGTH;
  if (typeof value !== 'string' || value.length > maxLength) {
    return { ok: false, error: 'El secreto no tiene un formato válido.' };
  }
  if (!secureStoreAvailable()) {
    return { ok: false, unavailable: true, error: 'El cifrado del sistema no está disponible.' };
  }
  try {
    const encrypted = safeStorage.encryptString(value);
    fs.mkdirSync(SECURE_DIR, { recursive: true });
    const target = secureKeyPath(key);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, encrypted);
    fs.renameSync(tmp, target);
    return { ok: true };
  } catch (error) {
    logLine(`Almacén seguro: no se pudo cifrar "${key}": ${messageOf(error)}`);
    return { ok: false, error: 'No se pudo guardar el secreto cifrado.' };
  }
}

function secureDelete(key) {
  if (typeof key !== 'string' || !SECURE_KEY_PATTERN.test(key)) {
    return { ok: false, error: 'Clave de secreto inválida.' };
  }
  if (!secureStoreAvailable()) {
    return { ok: false, unavailable: true, error: 'El cifrado del sistema no está disponible.' };
  }
  try {
    fs.rmSync(secureKeyPath(key), { force: true });
    return { ok: true };
  } catch (error) {
    logLine(`Almacén seguro: no se pudo borrar "${key}": ${messageOf(error)}`);
    return { ok: false, error: 'No se pudo borrar el secreto guardado.' };
  }
}

function registerDesktopIpc() {
  ipcMain.handle('palmyra:db:invoke', (event, request) => {
    if (!isTrustedRenderer(event)) return { ok: false, error: 'Origen no autorizado.' };
    return dbMain.invoke('renderer', request);
  });
  // Imagen binaria real del MEMFS de sql.js. Sin rutas ni detalles de disco en
  // la respuesta; el hub en servicio bloquea la restauración con `busy`. El
  // renderer solo envía base64 + hash: una ruta propuesta se ignora, porque el
  // destino lo decide siempre este proceso.
  ipcMain.handle('palmyra:db:snapshot', (event) =>
    isTrustedRenderer(event) ? dbMain.snapshotBinary() : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:db:restore', (event, request) =>
    isTrustedRenderer(event) ? dbMain.restoreBinary(request) : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:secure:status', (event) =>
    isTrustedRenderer(event) ? secureStoreStatus() : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:secure:get', (event, key) =>
    isTrustedRenderer(event) ? secureGet(key) : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:secure:set', (event, request) =>
    isTrustedRenderer(event)
      ? secureSet(request && request.key, request && request.value)
      : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:secure:delete', (event, key) =>
    isTrustedRenderer(event) ? secureDelete(key) : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:hub:status', (event) =>
    isTrustedRenderer(event) ? { ok: true, status: hubStatus } : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:hub:start', (event, companyId) =>
    isTrustedRenderer(event) ? hubStart(companyId) : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:hub:stop', (event) =>
    isTrustedRenderer(event) ? hubStop() : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:hub:pairing', (event) =>
    isTrustedRenderer(event) ? hubPairing() : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:hub:pin', (event, request) =>
    isTrustedRenderer(event)
      ? hubPinCertificate(request && request.baseUrl, request && request.fingerprint)
      : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:hub:discover', (event, timeoutMs) =>
    isTrustedRenderer(event) ? hubDiscoverHubs(timeoutMs) : { ok: false, error: 'Origen no autorizado.' }
  );
  // Respaldo del hub: listar no escribe nada; restaurar exige diálogo nativo,
  // instantánea de seguridad correcta y confirmación escrita por el operador.
  ipcMain.handle('palmyra:hub:backup:list', (event) =>
    isTrustedRenderer(event) ? hubListBackups() : { ok: false, error: 'Origen no autorizado.' }
  );
  ipcMain.handle('palmyra:hub:backup:restore', (event, request) =>
    isTrustedRenderer(event) ? hubRestoreBackup(request) : { ok: false, error: 'Origen no autorizado.' }
  );
}

let hubAutoStartAttempted = false;
let hubAutoStartTimer = null;
/** La importación en sombra llega unos segundos después de cargar la ventana. */
const HUB_AUTOSTART_MAX_ATTEMPTS = 24;
const HUB_AUTOSTART_DELAY_MS = 5000;

// La empresa ya está en el almacén local: con una sola fila el hub puede
// arrancar sin esperar a que el usuario lo pida desde Configuración.
async function autoStartHub(attempt = 0) {
  if (hubAutoStartAttempted) return;
  if (!lanAccessEnabled()) {
    hubAutoStartAttempted = true;
    return;
  }
  const retry = () => {
    if (attempt + 1 >= HUB_AUTOSTART_MAX_ATTEMPTS) {
      hubAutoStartAttempted = true;
      return;
    }
    hubAutoStartTimer = setTimeout(() => void autoStartHub(attempt + 1), HUB_AUTOSTART_DELAY_MS);
    if (hubAutoStartTimer && typeof hubAutoStartTimer.unref === 'function') hubAutoStartTimer.unref();
  };
  try {
    const result = await dbMain.invoke('renderer', { op: 'all', sql: 'SELECT id FROM companies LIMIT 2' });
    if (!result || result.ok !== true || !Array.isArray(result.rows)) {
      retry();
      return;
    }
    // Sin empresa todavía: el almacén se llena tras la escritura en sombra.
    if (result.rows.length === 0) {
      retry();
      return;
    }
    // Varias empresas en el mismo equipo: el hub exige una elección manual.
    if (result.rows.length !== 1) {
      hubAutoStartAttempted = true;
      return;
    }
    const companyId = result.rows[0] && result.rows[0].id;
    if (typeof companyId !== 'string' || !COMPANY_ID_RE.test(companyId)) {
      retry();
      return;
    }
    const response = await hubStart(companyId);
    if (response.ok) {
      hubAutoStartAttempted = true;
      logLine('Hub LAN iniciado automáticamente.');
    } else {
      retry();
    }
  } catch (error) {
    logLine(`No se pudo iniciar el hub automáticamente: ${messageOf(error)}`);
    retry();
  }
}

// ─── Guardián del manifiesto de actualización ───────────────────────────────
function updatePublicJwk() {
  const raw = process.env.UPDATE_MANIFEST_PUBLIC_JWK;
  if (!raw || !raw.trim()) {
    // Clave estable incrustada en el build; el entorno solo la sustituye para rotarla.
    try {
      const baked = require('./src/services/updates/update-public-key.json');
      if (baked && typeof baked === 'object' && baked.kty === 'EC' && typeof baked.x === 'string') {
        return { jwk: baked, invalid: false };
      }
    } catch {
      // Sin clave incrustada no se puede verificar: se rechaza la actualización.
    }
    return { jwk: null, invalid: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.kty === 'string') {
      return { jwk: parsed, invalid: false };
    }
  } catch {
    // Clave ilegible: se rechaza la actualización en lugar de ignorar la firma.
  }
  return { jwk: null, invalid: true };
}

// Identificador estable del equipo para el reparto por porcentaje (rollout).
function stableDeviceId() {
  try {
    return crypto.createHash('sha256').update(app.getPath('userData')).digest('hex');
  } catch {
    return 'palmyra-desktop';
  }
}

async function verifyAndDownloadUpdate(info) {
  const version = String((info && info.version) || '');
  const { jwk, invalid } = updatePublicJwk();
  if (!jwk) {
    if (invalid) {
      logLine('Actualización rechazada: la clave pública configurada no es un JWK válido.');
      setUpdateState({
        status: 'error',
        version,
        error: 'La actualización fue rechazada: la clave pública del manifiesto no es válida.'
      });
      return;
    }
    logLine('Actualización rechazada: no hay clave pública para verificar el manifiesto.');
    setUpdateState({
      status: 'error',
      version,
      error: 'La actualización fue rechazada: no hay clave pública para verificar el manifiesto.'
    });
    return;
  }

  const runtime = loadDesktopRuntime();
  if (!runtime || typeof runtime.verifyUpdateManifestForBoot !== 'function') {
    logLine('Actualización rechazada: el verificador de manifiestos no está disponible.');
    setUpdateState({
      status: 'error',
      version,
      error: 'La actualización fue rechazada: el manifiesto no supera la verificación de firma.'
    });
    return;
  }

  const result = await runtime.verifyUpdateManifestForBoot({
    manifestUrl: UPDATE_MANIFEST_URL,
    publicJwk: jwk,
    currentVersion: app.getVersion(),
    shellVersion: app.getVersion(),
    deviceId: stableDeviceId(),
    channel: 'stable'
  });

  if (result && result.ok === true && result.reason === 'manifesto-verificado') {
    verifiedUpdateVersion = version;
    logLine(`Actualización: manifiesto verificado${result.version ? ` para v${result.version}` : ''}.`);
    await downloadUpdateNow();
    return;
  }

  const reason = String((result && result.reason) || 'desconocido');
  logLine(`Actualización bloqueada por el guardián: ${reason}.`);
  if (UPDATE_GUARD_REJECTIONS.has(reason)) {
    setUpdateState({
      status: 'error',
      version,
      error: 'La actualización fue rechazada: el manifiesto no supera la verificación de firma.'
    });
    return;
  }
  setUpdateState({
    status: 'not-available',
    version,
    percent: 0,
    error: '',
    message: 'Esta actualización no aplica a este equipo.'
  });
}

function loadingPage(status) {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>PALMYRA POS</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#32145F;color:#fff;
       font-family:Segoe UI,Arial,sans-serif;flex-direction:column;gap:22px}
  .mark{width:84px;height:84px;border-radius:26px;background:#fff;color:#4C1D95;
        display:flex;align-items:center;justify-content:center;font-weight:800;font-size:30px;
        letter-spacing:.04em;box-shadow:0 18px 44px rgba(0,0,0,.28)}
  h1{margin:0;font-size:20px;letter-spacing:.18em;font-weight:800}
  .spinner{width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.25);
           border-top-color:#fff;animation:spin 1s linear infinite}
  p{margin:0;font-size:13px;opacity:.8;max-width:420px;text-align:center;line-height:1.5}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
  <div class="mark">P</div>
  <h1>PALMYRA POS</h1>
  <div class="spinner"></div>
  <p id="status">${status}</p>
</body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function errorPage(detail) {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>PALMYRA POS</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#32145F;color:#fff;
       font-family:Segoe UI,Arial,sans-serif;flex-direction:column;gap:18px;padding:32px;box-sizing:border-box}
  .mark{width:64px;height:64px;border-radius:20px;background:#fff;color:#4C1D95;
        display:flex;align-items:center;justify-content:center;font-weight:800;font-size:24px}
  h1{margin:0;font-size:18px;letter-spacing:.12em}
  p{margin:0;font-size:13px;opacity:.85;max-width:520px;text-align:center;line-height:1.6}
  code{background:rgba(255,255,255,.12);padding:8px 12px;border-radius:8px;font-size:11px;max-width:520px;
       white-space:pre-wrap;word-break:break-word}
</style></head><body>
  <div class="mark">P</div>
  <h1>NO SE PUDO INICIAR</h1>
  <p>El servidor interno de PALMYRA no respondió. Cierra otras ventanas de PALMYRA y vuelve a abrir la aplicación.</p>
  <code>${detail}</code>
  <p>Si el problema continúa, envía el archivo <b>desktop.log</b> de la carpeta de datos de PALMYRA.</p>
</body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function startServer() {
  process.env.PORT = String(PORT);
  process.env.HOST = HOST;
  process.env.PALMYRA_DATA_DIR = DATA_DIR;
  process.env.NODE_ENV = isDev ? 'development' : 'production';

  if (isDev) {
    // Desarrollo: el servidor TypeScript (Vite middleware) corre en un proceso
    // aparte para no bloquear la ventana durante el hot reload.
    devServerProcess = spawn(
      process.execPath,
      [path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(__dirname, 'server.ts')],
      {
        cwd: __dirname,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
    devServerProcess.stdout.on('data', (data) => logLine(`Server: ${String(data).trim()}`));
    devServerProcess.stderr.on('data', (data) => logLine(`Server Error: ${String(data).trim()}`));
    devServerProcess.on('error', (error) => logLine(`No se pudo iniciar el servidor de desarrollo: ${error.message}`));
    return;
  }

  // Producción: el servidor empaquetado es un único archivo autocontenido que se
  // carga en el mismo proceso. Sin proceso hijo, sin ELECTRON_RUN_AS_NODE y sin
  // depender de node_modules: menos piezas que puedan impedir el arranque.
  const entry = path.join(app.getAppPath(), 'dist', 'desktop-server.cjs');
  logLine(`Cargando servidor: ${entry}`);
  require(entry);
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 400) resolve();
        else retry(`HTTP ${response.statusCode}`);
      });
      request.on('error', (error) => retry(error.message));
      request.setTimeout(2000, () => request.destroy());
    };
    let lastReason = '';
    const retry = (reason) => {
      lastReason = reason || lastReason;
      if (Date.now() > deadline) {
        reject(new Error(`Sin respuesta en ${Math.round(timeoutMs / 1000)} s (${lastReason || 'sin detalle'})`));
        return;
      }
      setTimeout(probe, 400);
    };
    probe();
  });
}

// ─── Permisos de hardware (impresora térmica) ───────────────────────────────
// La ventana corre con sandbox y sin Node: el único acceso a periféricos es Web
// Serial (USB/OTG) y Web Bluetooth. Sin manejadores, Chromium deniega
// navigator.serial.requestPort() y la impresión por cable del escritorio falla.
// La lista blanca es por ORIGEN: solo el servidor local de PALMYRA. Todo lo
// demás queda denegado. En Electron 33 no existe el permiso 'bluetooth' (se
// resuelve con select-bluetooth-device); se acepta por si otra versión lo nombra.
const HARDWARE_PERMISSIONS = new Set(['serial', 'bluetooth']);
// La página de Notificaciones usa la API Web; se mantiene el comportamiento
// previo (permitida solo en el origen propio) sin registrar cada consulta.
const WEB_PERMISSIONS = new Set(['notifications']);
let hardwarePermissionHandlersInstalled = false;

function appOrigin() {
  try {
    return new URL(BASE_URL).origin;
  } catch {
    return '';
  }
}

/** true solo para el origen exacto del servidor local de la app. */
function isTrustedRequestOrigin(candidate) {
  const origin = appOrigin();
  if (!origin || typeof candidate !== 'string') return false;
  const normalized = candidate.trim();
  return normalized === origin || normalized.startsWith(`${origin}/`);
}

function hardwarePermissionLabel(permission) {
  if (permission === 'serial') return 'puerto serie (USB/OTG)';
  if (permission === 'bluetooth') return 'Bluetooth';
  return String(permission || 'desconocido').slice(0, 40);
}

function installHardwarePermissionHandlers() {
  if (hardwarePermissionHandlersInstalled) return;
  hardwarePermissionHandlersInstalled = true;
  try {
    const ses = session.defaultSession;
    // Consulta previa: decide si la API de hardware está permitida en el origen.
    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      const isHardware = HARDWARE_PERMISSIONS.has(permission);
      const allowed =
        (isHardware || WEB_PERMISSIONS.has(permission)) && isTrustedRequestOrigin(requestingOrigin);
      if (isHardware && !allowed) {
        logLine(`Permiso de hardware denegado: ${hardwarePermissionLabel(permission)}.`);
      }
      return allowed;
    });
    // Solicitud real (cuando Chromium no puede resolverla con la consulta).
    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const requestedFrom = details && (details.requestingUrl || details.requestingOrigin);
      const isHardware = HARDWARE_PERMISSIONS.has(permission);
      const allowed =
        (isHardware || WEB_PERMISSIONS.has(permission)) && isTrustedRequestOrigin(requestedFrom);
      if (isHardware) {
        logLine(
          `Permiso ${allowed ? 'concedido' : 'denegado'}: ${hardwarePermissionLabel(permission)}.`
        );
      }
      callback(allowed);
    });
  } catch (error) {
    logLine(`No se pudieron instalar los permisos de hardware: ${messageOf(error)}`);
  }
}

function serialPortName(port) {
  if (!port) return 'puerto sin nombre';
  const label = port.displayName || port.portName || port.portId;
  return typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : 'puerto sin nombre';
}

/**
 * Sin este manejador Electron cancela navigator.serial.requestPort() siempre.
 * Se elige el primer puerto expuesto por el sistema (orden determinista) y se
 * registra solo el nombre visible del puerto; no se guardan rutas ni datos del
 * sistema más allá de ese nombre.
 */
function installSerialPortHandlers(window) {
  const contents = window.webContents;
  contents.on('select-serial-port', (event, portList, _webContents, callback) => {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const ports = Array.isArray(portList) ? portList : [];
    if (ports.length === 0) {
      logLine('Web Serial: no hay puertos disponibles; selección cancelada.');
      callback('');
      return;
    }
    const chosen = ports[0];
    logLine(`Web Serial: puerto seleccionado (${serialPortName(chosen)}).`);
    callback(chosen && typeof chosen.portId === 'string' ? chosen.portId : '');
  });
  contents.on('serial-port-added', (_event, port) => {
    logLine(`Web Serial: puerto agregado (${serialPortName(port)}).`);
  });
  contents.on('serial-port-removed', (_event, port) => {
    logLine(`Web Serial: puerto retirado (${serialPortName(port)}).`);
  });
}

function createWindow() {
  installHardwarePermissionHandlers();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'PALMYRA POS',
    backgroundColor: '#32145F',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Único puente permitido hacia Node: actualizaciones, base local y hub LAN
      // (ver electron/preload.cjs).
      preload: path.join(app.getAppPath(), 'electron', 'preload.cjs')
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // La impresora por cable USB/OTG necesita elegir el puerto en este proceso.
  installSerialPortHandlers(mainWindow);

  // Volver a PALMYRA (alt-tab) es el mejor momento para buscar actualizaciones:
  // el usuario ya está frente al equipo y el aviso no interrumpe una venta.
  mainWindow.on('focus', () => {
    if (!autoUpdater) return;
    if (Date.now() - lastUpdateCheckAt < UPDATE_FOCUS_MIN_GAP_MS) return;
    void checkForUpdatesNow('foco');
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = ['LOG', 'WARN', 'ERROR', 'DEBUG'][level] || `N${level}`;
    logLine(`Renderer ${tag}: ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    logLine(`Error de preload (${preloadPath}): ${error.message}`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    // ERR_ABORTED (-3) sobre la página de carga es normal: la sustituimos por la app.
    if (code === -3 && url.startsWith('data:')) return;
    logLine(`Fallo de carga (${code} ${description}): ${url}`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow.webContents.getURL();
    if (url.startsWith('data:')) {
      logLine('Pantalla de carga mostrada.');
      return;
    }
    logLine(`Ventana cargada: ${url}`);
    if (!url.startsWith(BASE_URL)) return;
    appLoaded = true;
    // Una recarga (o la recuperación de la interfaz) pierde el último estado:
    // se reenvía para que el banner de actualización no desaparezca.
    broadcastUpdateState();
    void autoStartHub();
    mainWindow.webContents
      .executeJavaScript(
        `(() => {
          const root = document.getElementById('root');
          return { rootChildren: root ? root.children.length : -1, htmlLength: document.body.innerHTML.length };
        })()`
      )
      .then((info) => {
        logLine(`DOM tras cargar: root hijos=${info.rootChildren}, html=${info.htmlLength} caracteres`);
        if (info.rootChildren > 0) return;
        if (recoveryReloads >= 2) {
          logLine('La interfaz no se renderizó tras dos recargas.');
          if (mainWindow && !mainWindow.isDestroyed()) {
            void mainWindow
              .loadURL(errorPage('La interfaz no se pudo renderizar. Revisa desktop.log.'))
              .catch(() => {});
          }
          return;
        }
        recoveryReloads += 1;
        logLine(`La interfaz no se renderizó; recargando (${recoveryReloads}/2).`);
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
        }, 1500);
      })
      .catch((error) => logLine(`No se pudo inspeccionar el DOM: ${error.message}`));
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logLine(`Renderer finalizado: ${details.reason} (código ${details.exitCode})`);
  });

  // Nunca dejar al usuario mirando una pantalla vacía: mostrar el estado real.
  const loadingReady = mainWindow
    .loadURL(loadingPage('Iniciando el servidor local de PALMYRA…'))
    .catch(() => {});
  const loadingTimeout = new Promise((resolve) => setTimeout(resolve, 4000));

  const showStartFailure = (message) => {
    logLine(`El servidor local no respondió: ${message}`);
    if (appLoaded) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.loadURL(errorPage(message)).catch(() => {});
    }
    dialog.showErrorBox(
      'PALMYRA no pudo iniciar',
      `El servidor local no respondió.\n\n${message}\n\nCierra otras ventanas de PALMYRA y vuelve a intentarlo.`
    );
  };

  const loadApp = (attempt = 1) => {
    if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve();
    return mainWindow.loadURL(BASE_URL).catch((error) => {
      const message = String(error && error.message ? error.message : error);
      // La página de carga puede abortar la navegación anterior: es benigno.
      if (attempt < 3 && /ERR_ABORTED|\(-3\)/.test(message)) {
        logLine(`Navegación inicial abortada, reintentando (intento ${attempt + 1}).`);
        return new Promise((resolve) => setTimeout(resolve, 500)).then(() => loadApp(attempt + 1));
      }
      throw error;
    });
  };

  waitForServer(`${BASE_URL}/version.json`, 60000)
    .then(() => Promise.race([loadingReady, loadingTimeout]))
    .then(() => {
      logLine('Servidor listo, cargando la aplicación.');
      return loadApp();
    })
    .catch((error) => showStartFailure(String(error && error.message ? error.message : error)));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('ready', async () => {
    try {
      // Una versión anterior de la app (o el servidor de desarrollo) pudo dejar
      // un Service Worker cacheado en 127.0.0.1:10000. Ese worker sirve el shell
      // viejo y deja la ventana morada sin contenido. Solo se limpian los caches
      // del shell: IndexedDB y localStorage con los datos del negocio se respetan.
      await session.defaultSession
        .clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
        .catch((error) => logLine(`No se pudieron limpiar los caches del shell: ${error.message}`));
    } catch (error) {
      logLine(`Error limpiando caches: ${error && error.message ? error.message : error}`);
    }

    // Una sola instalación por sesión: la huella del hub se consulta en cada TLS.
    installCertificatePinVerifier();

    try {
      startServer();
    } catch (error) {
      logLine(`Error al iniciar el servidor empaquetado: ${error && error.stack ? error.stack : error}`);
      dialog.showErrorBox('PALMYRA no pudo iniciar', String(error && error.message ? error.message : error));
    }

    // Base local primero: la ventana puede pedirla desde el primer render.
    try {
      await dbMain.init();
      const dbStatus = dbMain.status();
      logLine(`Base local lista (${dbStatus.driver}, ${dbStatus.sizeBytes} bytes, esquema ${dbStatus.schemaVersion}).`);
    } catch (error) {
      // Un fallo de SQLite no impide abrir la caja: el estado queda en lastError.
      logLine(`La base local no está disponible: ${messageOf(error)}`);
    }

    // Diagnóstico del llavero: en Linux sin libsecret la app debe arrancar igual
    // y la interfaz cae a IndexedDB sin que se guarde ningún secreto en claro.
    try {
      const secure = secureStoreStatus();
      logLine(
        secure.available
          ? `Almacén seguro disponible (${secure.backend}, ${secure.platform}).`
          : `Almacén seguro no disponible (${secure.backend}, ${secure.platform}); fallback ${secure.fallback}.`
      );
    } catch (error) {
      logLine(`No se pudo diagnosticar el almacén seguro: ${messageOf(error)}`);
    }

    registerUpdateIpc();
    registerDesktopIpc();
    createWindow();
    initAutoUpdater();
  });
}

app.on('window-all-closed', () => {
  if (devServerProcess) {
    try { devServerProcess.kill(); } catch { /* ya terminó */ }
    devServerProcess = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('will-quit', () => {
  try {
    dbMain.flush();
  } catch (error) {
    logLine(`No se pudo guardar la base local al salir: ${messageOf(error)}`);
  }
  if (devServerProcess) {
    try { devServerProcess.kill(); } catch { /* ya terminó */ }
    devServerProcess = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
});
