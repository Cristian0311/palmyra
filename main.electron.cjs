const { app, BrowserWindow, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;
const PORT = Number(process.env.PORT) || 10000;
const LOOPBACK = '127.0.0.1';
const BASE_URL = `http://${LOOPBACK}:${PORT}`;
const DATA_DIR = app.getPath('userData');

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

function createWindow() {
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
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

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

    try {
      startServer();
    } catch (error) {
      logLine(`Error al iniciar el servidor empaquetado: ${error && error.stack ? error.stack : error}`);
      dialog.showErrorBox('PALMYRA no pudo iniciar', String(error && error.message ? error.message : error));
    }
    createWindow();
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
  if (devServerProcess) {
    try { devServerProcess.kill(); } catch { /* ya terminó */ }
    devServerProcess = null;
  }
});
