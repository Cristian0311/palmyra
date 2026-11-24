package cu.palmyra.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.net.UnknownHostException;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import fi.iki.elonen.NanoHTTPD;

/**
 * Shell móvil de PALMYRA. Sirve la app desde 127.0.0.1 para conservar un origen
 * seguro (localStorage/IndexedDB) y permite actualizaciones internas: el
 * cliente descarga una sola vez el APK; las versiones siguientes se bajan como
 * paquete web verificado y se aplican al reiniciar, sin instalar otro APK.
 */
public class MainActivity extends Activity {
    private static final int PORT = 45643;
    private static final String BASE_URL = "http://127.0.0.1:" + PORT + "/";
    private static final String PREFS = "palmyra_ota";
    private static final String KEY_CURRENT = "current_version";
    private static final String KEY_PREVIOUS = "previous_version";
    private static final String KEY_PURGED_SHELL = "purged_shell";
    private static final String KEY_CONFIRMED = "confirmed_";
    private static final String KEY_ATTEMPT = "attempt_";
    private static final long MAX_BUNDLE_BYTES = 300L * 1024L * 1024L;
    /** Un APK ronda 10-25 MB; 200 MB deja margen sin permitir abusos. */
    private static final long MAX_APK_BYTES = 200L * 1024L * 1024L;
    /** Enlace de acceso de dispositivo (src/services/deviceAccess.ts). */
    private static final String DEEP_LINK_SCHEME = "palmyra";
    private static final String DEEP_LINK_HOST = "device-access";
    private static final String DEEP_LINK_APP_LINK_HOST = "palmyracrm.onrender.com";
    private static final String DEEP_LINK_PATH = "/device-access";
    private static final String DEEP_LINK_ROUTE = "device-access";
    /** Un token de acceso es opaco y corto: nada más entra en la URL local. */
    private static final int DEEP_LINK_TOKEN_MAX = 256;
    private static final int REQUEST_FILE_CHOOSER = 1001;
    private static final int REQUEST_CAMERA_PERMISSION = 1002;
    private static final int REQUEST_APK_IMPORT = 1003;
    private static final int REQUEST_BUNDLE_IMPORT = 1005;

    private WebView web;
    private LocalServer server;
    private SharedPreferences prefs;
    private File releasesDir;
    private NativeDb nativeDb;
    /** Respaldo cifrado a Descargas y restauración desde archivo. */
    private AndroidBackup backup;
    private volatile String activeVersion = "";
    private final AtomicBoolean updateRunning = new AtomicBoolean(false);
    /** Evita dos instalaciones de APK (descarga o importación USB) a la vez. */
    private final AtomicBoolean apkUpdateRunning = new AtomicBoolean(false);
    /** Clave de licencia del dispositivo: se crea bajo demanda en el Keystore. */
    private final DeviceKeystore deviceKeystore = new DeviceKeystore();
    // Selección de archivos (<input type="file">) y permiso de cámara pedido
    // desde la web: ambos viven en el hilo principal del Activity.
    private ValueCallback<Uri[]> fileChooserCallback;
    private PermissionRequest pendingCameraRequest;
    /** Última ruta de acceso de dispositivo ya cargada: evita aplicarla dos veces. */
    private volatile String lastDeepLinkRoute = "";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#5B2DBA"));
        getWindow().setNavigationBarColor(Color.parseColor("#3B1B78"));

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        releasesDir = new File(getFilesDir(), "web-releases");
        // Un Service Worker del shell anterior puede servir una app vieja
        // aunque el APK ya traiga la nueva. Se limpia una vez por instalador;
        // localStorage e IndexedDB del negocio no se tocan.
        purgeStaleServiceWorkerOnce();
        resolveActiveRelease();
        pruneOldReleases();

        server = new LocalServer();
        try {
            server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        } catch (IOException error) {
            throw new RuntimeException("No se pudo iniciar el servidor local de PALMYRA", error);
        }

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        // El selector de archivos devuelve URI content:// (foto del producto,
        // importar respaldo). Sin acceso a content:// la WebView no puede leer
        // el archivo elegido y el <input type="file"> queda muerto.
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        // Marca que la app corre dentro del APK oficial. La web la lee para no
        // volver a ofrecer la descarga del APK ni la instalación de la PWA.
        settings.setUserAgentString(settings.getUserAgentString() + " PALMYRAApp/1.0");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }
        // La depuración remota solo en compilaciones de desarrollo: en el APK
        // que usan los negocios no debe quedar ningún puerto de inspección.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        web.addJavascriptInterface(new NativeBridge(), "PALMYRA_NATIVE");
        // Almacén local SQLite de la tablet: NativeDb serializa todas las
        // sentencias en su propio hilo (BEGIN/COMMIT incluidos) y no permite
        // elegir otro archivo ni expone rutas del dispositivo.
        nativeDb = new NativeDb(this);
        web.addJavascriptInterface(nativeDb, "PALMYRA_DB");
        // Identidad criptográfica del equipo para el lease de licencia. La
        // superficie es mínima (publicKey/sign/verify y sellado AES-GCM de la
        // copia local) y la clave privada nunca sale del Keystore; las
        // respuestas son JSON con ok:false si algo falla, jamás una excepción
        // hacia la web.
        web.addJavascriptInterface(new KeystoreBridge(), "PALMYRA_KEYSTORE");
        // Respaldo cifrado en Descargas públicas y restauración desde archivo.
        // Solo cruzan Base64 y nombres de archivo; las respuestas son siempre
        // envelopes JSON y el archivo importado se lee por trozos.
        backup = new AndroidBackup(this, web);
        web.addJavascriptInterface(new BackupBridge(), "PALMYRA_BACKUP");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                String host = url.getHost();
                if (host == null || host.equals("127.0.0.1") || host.equals("localhost")) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                    // Un enlace externo sin app disponible no debe romper la sesión.
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // Sin este puente los <input type="file"> (foto de inventario,
            // importar respaldo) no abren nada y quedan inservibles.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileChooserCallback != null) {
                    fileChooserCallback.onReceiveValue(null);
                }
                fileChooserCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, REQUEST_FILE_CHOOSER);
                    return true;
                } catch (Exception error) {
                    fileChooserCallback = null;
                    Toast.makeText(MainActivity.this,
                            "No hay una aplicación disponible para elegir el archivo.",
                            Toast.LENGTH_LONG).show();
                    return false;
                }
            }

            // El escáner del POS pide la cámara con getUserMedia. Solo se
            // concede a la app servida por el servidor local: ningún sitio
            // externo puede quedarse con la cámara del dispositivo.
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsCamera = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            wantsCamera = true;
                        }
                    }
                    Uri origin = request.getOrigin();
                    String host = origin == null ? "" : origin.getHost();
                    if (!wantsCamera || !("127.0.0.1".equals(host) || "localhost".equals(host))) {
                        request.deny();
                        return;
                    }
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                        return;
                    }
                    pendingCameraRequest = request;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA_PERMISSION);
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingCameraRequest == request) {
                    pendingCameraRequest = null;
                }
            }
        });

        // Respaldo para instaladores antiguos: si una versión anterior aún
        // ofrece el APK, la descarga sigue funcionando desde la app.
        web.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType("application/vnd.android.package-archive");
                request.addRequestHeader("User-Agent", userAgent);
                request.setTitle("PALMYRA");
                request.setDescription("Descargando PALMYRA…");
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "PALMYRA-Android.apk");
                DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (manager == null) throw new IllegalStateException("DownloadManager no disponible");
                manager.enqueue(request);
                Toast.makeText(this, "Descargando PALMYRA. Al terminar, abre el archivo para instalar.", Toast.LENGTH_LONG).show();
            } catch (Exception error) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {
                    Toast.makeText(this, "No se pudo iniciar la descarga.", Toast.LENGTH_LONG).show();
                }
            }
        });

        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // Arranque en frío desde un enlace: se abre directamente la ruta local
        // del acceso de dispositivo. Al recrear la actividad (rotación) el
        // intent original se ignora para no repetir la navegación.
        String initialRoute = savedInstanceState == null ? deepLinkRouteFrom(getIntent()) : "";
        if (!initialRoute.isEmpty()) {
            lastDeepLinkRoute = initialRoute;
        }
        web.loadUrl(initialRoute.isEmpty() ? BASE_URL : BASE_URL + initialRoute);
    }

    /**
     * La actividad es singleTask: un enlace abierto con la app en marcha llega
     * aquí en lugar de crear otra instancia.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String route = deepLinkRouteFrom(intent);
        if (route.isEmpty() || route.equals(lastDeepLinkRoute)) return;
        lastDeepLinkRoute = route;
        openDeepLinkRoute(route);
    }

    /** Carga la ruta local del enlace sobre el servidor interno de la WebView. */
    private void openDeepLinkRoute(final String route) {
        final WebView target = web;
        if (target == null) return;
        runOnUiThread(() -> {
            try {
                target.loadUrl(BASE_URL + route);
            } catch (Exception error) {
                Log.w("PALMYRA", "No se pudo abrir el enlace de acceso de dispositivo.");
            }
        });
    }

    /**
     * Traduce el intent de un enlace de acceso de dispositivo a la ruta local
     * "device-access?token=..." (relativa a BASE_URL). Devuelve "" si el intent
     * no es un enlace de PALMYRA: la instalación del APK de actualización y el
     * resto de flujos no se ven afectados.
     *
     * Acepta el esquema propio palmyra://device-access y el App Link
     * https://palmyracrm.onrender.com/device-access. El token se valida y se
     * vuelve a codificar: nunca se concatena texto arbitrario en la URL local.
     */
    private static String deepLinkRouteFrom(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return "";
        Uri data = intent.getData();
        if (data == null) return "";
        String scheme = data.getScheme();
        String host = data.getHost();
        if (scheme == null || host == null) return "";
        if (DEEP_LINK_SCHEME.equalsIgnoreCase(scheme)) {
            if (!DEEP_LINK_HOST.equalsIgnoreCase(host)) return "";
        } else if ("https".equalsIgnoreCase(scheme)) {
            if (!DEEP_LINK_APP_LINK_HOST.equalsIgnoreCase(host)) return "";
            String path = data.getPath();
            if (path == null || !path.startsWith(DEEP_LINK_PATH)) return "";
        } else {
            return "";
        }
        String token = data.getQueryParameter("token");
        token = token == null ? "" : token.trim();
        if (token.isEmpty()) {
            // Enlace de PALMYRA sin token: la propia página explica el problema.
            return DEEP_LINK_ROUTE;
        }
        if (!isSafeDeepLinkToken(token)) return "";
        return DEEP_LINK_ROUTE + "?token=" + Uri.encode(token);
    }

    /** Solo caracteres de un token opaco (Base64/hex/UUID); nada de espacios ni rutas. */
    private static boolean isSafeDeepLinkToken(String token) {
        if (token.length() > DEEP_LINK_TOKEN_MAX) return false;
        for (int i = 0; i < token.length(); i++) {
            char c = token.charAt(i);
            boolean allowed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9')
                    || c == '.' || c == '_' || c == '~' || c == '+' || c == '/'
                    || c == '=' || c == '-';
            if (!allowed) return false;
        }
        return true;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        // El sistema puede matar el proceso en segundo plano. Volcar el WAL
        // (best-effort) deja el archivo completo aunque no haya cierre limpio.
        if (nativeDb != null) {
            nativeDb.checkpoint();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Volver de segundo plano es el momento de buscar una versión nueva en
        // el manifiesto firmado. En WebView el ciclo de la actividad no siempre
        // publica visibilitychange, así que se avisa explícitamente a la web.
        dispatchNativeResume();
    }

    private void dispatchNativeResume() {
        final WebView target = web;
        if (target == null) return;
        try {
            target.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        target.evaluateJavascript(
                                "window.dispatchEvent(new CustomEvent('palmyra:native-resume'));",
                                null);
                    } catch (Exception ignored) {
                        // Sin puente la web sigue comprobando por temporizador.
                    }
                }
            });
        } catch (Exception ignored) {
            // La actividad puede estar terminando.
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE_CHOOSER) {
            ValueCallback<Uri[]> callback = fileChooserCallback;
            fileChooserCallback = null;
            if (callback == null) {
                super.onActivityResult(requestCode, resultCode, data);
                return;
            }
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            // Un resultado nulo es la forma correcta de avisar "cancelado".
            callback.onReceiveValue(results);
            return;
        }
        if (requestCode == REQUEST_APK_IMPORT) {
            Uri source = resultCode == RESULT_OK && data != null ? data.getData() : null;
            if (source == null) {
                apkUpdateRunning.set(false);
                return;
            }
            new Thread(() -> verifyImportedApk(source), "palmyra-apk-import").start();
            return;
        }
        if (backup != null && backup.handleActivityResult(requestCode, resultCode, data)) {
            return;
        }
        if (requestCode == REQUEST_BUNDLE_IMPORT) {
            Uri source = resultCode == RESULT_OK && data != null ? data.getData() : null;
            if (source == null) {
                updateRunning.set(false);
                emitError("Importación cancelada: no se eligió ningún paquete.");
                return;
            }
            new Thread(() -> installImportedBundle(source), "palmyra-bundle-import").start();
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQUEST_CAMERA_PERMISSION) {
            PermissionRequest request = pendingCameraRequest;
            pendingCameraRequest = null;
            if (request == null) return;
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else {
                request.deny();
                Toast.makeText(this,
                        "Sin permiso de cámara no se puede escanear. Puedes activarlo en Ajustes de la app.",
                        Toast.LENGTH_LONG).show();
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    protected void onDestroy() {
        if (server != null) {
            server.stop();
        }
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }

    // ---------------------------------------------------------------------
    // Versiones locales y rollback
    // ---------------------------------------------------------------------

    private String shellVersion() {
        try {
            String name = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            return name == null ? "" : name;
        } catch (Exception ignored) {
            return "";
        }
    }

    private File releaseDir(String version) {
        if (version == null || !version.matches("[0-9A-Za-z._-]{1,32}")) return null;
        File dir = new File(releasesDir, version);
        return new File(dir, "index.html").isFile() ? dir : null;
    }

    private void resolveActiveRelease() {
        String current = prefs.getString(KEY_CURRENT, "");
        File dir = releaseDir(current);
        if (dir == null) {
            if (!current.isEmpty()) {
                prefs.edit().remove(KEY_CURRENT).apply();
            }
            activeVersion = "";
            return;
        }

        if (!prefs.getBoolean(KEY_CONFIRMED + current, false)) {
            int attempts = prefs.getInt(KEY_ATTEMPT + current, 0) + 1;
            if (attempts >= 2) {
                // La versión nueva no llegó a confirmar arranque dos veces:
                // se restaura la anterior en lugar de dejar la app en blanco.
                String previous = prefs.getString(KEY_PREVIOUS, "");
                File previousDir = releaseDir(previous);
                SharedPreferences.Editor editor = prefs.edit()
                        .putInt(KEY_ATTEMPT + current, 0)
                        .putBoolean(KEY_CONFIRMED + current, false);
                if (previousDir != null) {
                    editor.putString(KEY_CURRENT, previous);
                    editor.putString(KEY_PREVIOUS, "");
                    editor.putBoolean(KEY_CONFIRMED + previous, true);
                    activeVersion = previous;
                } else {
                    editor.remove(KEY_CURRENT);
                    editor.putString(KEY_PREVIOUS, "");
                    activeVersion = "";
                }
                editor.apply();
                deleteRecursive(dir);
                return;
            }
            prefs.edit().putInt(KEY_ATTEMPT + current, attempts).apply();
        }
        activeVersion = current;
    }

    // Cada OTA deja una carpeta de ~5 MB y las versiones descartadas nunca se
    // borraban. Se conservan solo la activa y la anterior (para el rollback).
    private void pruneOldReleases() {
        try {
            File[] dirs = releasesDir.listFiles();
            if (dirs == null) return;
            String current = prefs.getString(KEY_CURRENT, "");
            String previous = prefs.getString(KEY_PREVIOUS, "");
            for (File dir : dirs) {
                if (dir == null || !dir.isDirectory()) continue;
                String name = dir.getName();
                if (name.equals(current) || name.equals(previous) || name.equals(activeVersion)) {
                    continue;
                }
                deleteRecursive(dir);
            }
        } catch (Exception ignored) {
            // La poda es mantenimiento: nunca debe impedir abrir la app.
        }
    }

    private void purgeStaleServiceWorkerOnce() {
        try {
            String shell = shellVersion();
            if (shell == null || shell.isEmpty()) return;
            if (shell.equals(prefs.getString(KEY_PURGED_SHELL, ""))) return;
            File webViewData = new File(getApplicationInfo().dataDir, "app_webview");
            deleteRecursive(new File(webViewData, "Default/Service Worker"));
            deleteRecursive(new File(webViewData, "Service Worker"));
            prefs.edit().putString(KEY_PURGED_SHELL, shell).apply();
        } catch (Exception ignored) {
            // La limpieza es preventiva: nunca debe impedir abrir la app.
        }
    }

    // ---------------------------------------------------------------------
    // Actualización interna (paquete web)
    // ---------------------------------------------------------------------

    private class NativeBridge {
        @JavascriptInterface
        public String getInfo() {
            try {
                JSONObject info = new JSONObject();
                info.put("platform", "android");
                info.put("shellVersion", shellVersion());
                info.put("webVersion", activeVersion == null ? "" : activeVersion);
                info.put("ota", true);
                return info.toString();
            } catch (Exception ignored) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void confirmBoot() {
            String version = activeVersion;
            if (version == null || version.isEmpty()) return;
            prefs.edit()
                    .putBoolean(KEY_CONFIRMED + version, true)
                    .putInt(KEY_ATTEMPT + version, 0)
                    .apply();
        }

        @JavascriptInterface
        public void startUpdate(String version, String url, String sha256, long bytes) {
            beginUpdate(version, url, sha256, bytes);
        }

        /**
         * Actualización del APK: descarga HTTPS, exige SHA-256 publicado,
         * versión estrictamente mayor y la misma firma de desarrollador antes
         * de abrir el instalador. Si algo no coincide, se avisa y no se instala.
         */
        @JavascriptInterface
        public void startApkUpdate(String version, String url, String sha256, long bytes) {
            beginApkUpdate(version, url, sha256, bytes);
        }

        /**
         * Importación desde archivo (USB/SD): se elige el APK con el selector
         * del sistema y pasa la misma verificación (paquete, versión, firma).
         * No hay hash publicado para un archivo local, así que la confianza
         * viene de la firma del desarrollador ya instalada.
         */
        @JavascriptInterface
        public void importApk() {
            importApkFromFile();
        }

        /**
         * Instalación del paquete web desde archivo (USB/SD): elige el ZIP con
         * el selector del sistema y reutiliza el desempaquetado protegido de la
         * OTA. Sin Internet la tablet puede actualizarse copiando el bundle.
         */
        @JavascriptInterface
        public void importBundle() {
            importBundleFromFile();
        }
    }

    /**
     * Puente del respaldo del dispositivo: AndroidBackup ya devuelve envelopes
     * JSON, aquí solo se captura cualquier Throwable para que la WebView nunca
     * reciba una excepción del hilo nativo.
     */
    private class BackupBridge {
        @JavascriptInterface
        public String save(String fileName, String dataBase64, String sha256Expected) {
            try {
                return backup.save(fileName, dataBase64, sha256Expected);
            } catch (Throwable error) {
                return backupErrorEnvelope("save_failed");
            }
        }

        @JavascriptInterface
        public String list() {
            try {
                return backup.list();
            } catch (Throwable error) {
                return backupErrorEnvelope("list_failed");
            }
        }

        @JavascriptInterface
        public String remove(String name) {
            try {
                return backup.remove(name);
            } catch (Throwable error) {
                return backupErrorEnvelope("delete_failed");
            }
        }

        /**
         * El selector se abre en el hilo de UI y el resultado llega a
         * onActivityResult; el aviso a la web viaja como evento
         * palmyra-backup-imported, por eso este método no devuelve nada.
         */
        @JavascriptInterface
        public void openPicker() {
            try {
                backup.openPicker(MainActivity.this);
            } catch (Throwable error) {
                // Sin explorador de archivos: el polling de la web expira.
            }
        }

        @JavascriptInterface
        public String pendingInfo() {
            try {
                return backup.pendingInfo();
            } catch (Throwable error) {
                return backupErrorEnvelope("no_pending");
            }
        }

        @JavascriptInterface
        public String readPending(int offset, int length) {
            try {
                return backup.readPending(offset, length);
            } catch (Throwable error) {
                return backupErrorEnvelope("read_failed");
            }
        }

        @JavascriptInterface
        public String clearPending() {
            try {
                return backup.clearPending();
            } catch (Throwable error) {
                return backupErrorEnvelope("delete_failed");
            }
        }
    }

    /** Envelope de último recurso: los códigos son literales, sin datos. */
    private static String backupErrorEnvelope(String code) {
        return "{\"ok\":false,\"error\":\"" + code + "\"}";
    }

    /**
     * Puente acotado del Keystore del dispositivo: solo operaciones sobre datos
     * Base64 (firma, verificación y sellado AES-GCM de la identidad/lease).
     * DeviceKeystore valida tamaños y devuelve siempre un envelope JSON; aquí
     * no se propaga ninguna excepción ni se registra material de clave.
     */
    private class KeystoreBridge {
        @JavascriptInterface
        public String publicKey() {
            try {
                return deviceKeystore.publicKey();
            } catch (Exception error) {
                return DeviceKeystore.errorEnvelope("keystore_unavailable",
                        "No se pudo abrir la clave segura del dispositivo.");
            }
        }

        @JavascriptInterface
        public String sign(String dataBase64) {
            try {
                return deviceKeystore.sign(dataBase64);
            } catch (Exception error) {
                return DeviceKeystore.errorEnvelope("keystore_unavailable",
                        "No se pudo firmar con la clave segura del dispositivo.");
            }
        }

        @JavascriptInterface
        public String verify(String dataBase64, String signatureBase64) {
            try {
                return deviceKeystore.verify(dataBase64, signatureBase64);
            } catch (Exception error) {
                return DeviceKeystore.errorEnvelope("keystore_unavailable",
                        "No se pudo verificar con la clave segura del dispositivo.");
            }
        }

        /**
         * Cifra la copia de la identidad del equipo y del lease con AES-GCM del
         * Keystore. El sobre resultante es lo único que se guarda en IndexedDB.
         */
        @JavascriptInterface
        public String sealSecret(String plainBase64) {
            try {
                return deviceKeystore.sealSecret(plainBase64);
            } catch (Exception error) {
                return DeviceKeystore.errorEnvelope("keystore_unavailable",
                        "No se pudo cifrar el secreto del dispositivo.");
            }
        }

        /**
         * Abre un sobre sellado por este mismo equipo. En otra tableta el GCM
         * falla y el puente responde ok:false: la app rehace la identidad.
         */
        @JavascriptInterface
        public String openSecret(String envelopeBase64) {
            try {
                return deviceKeystore.openSecret(envelopeBase64);
            } catch (Exception error) {
                return DeviceKeystore.errorEnvelope("keystore_unavailable",
                        "El secreto del dispositivo no se puede abrir en este equipo.");
            }
        }
    }

    /**
     * Mismo criterio que la web (isSecureUpdateUrl en
     * src/services/updates/android.ts): HTTPS sin credenciales embebidas y sin
     * destinos loopback. Evita que un manifiesto alterado apunte al propio
     * dispositivo o robe credenciales por la URL.
     */
    private static boolean isSecureUpdateUrl(String raw) {
        if (raw == null || raw.isEmpty() || raw.length() > 2048) return false;
        URI uri;
        try {
            uri = new URI(raw);
        } catch (URISyntaxException error) {
            return false;
        }
        if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
        if (uri.getRawUserInfo() != null) return false;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return false;
        host = host.toLowerCase(Locale.ROOT);
        if (host.equals("localhost") || host.endsWith(".localhost")) return false;
        if (host.equals("::1") || host.equals("[::1]") || host.equals("0.0.0.0")) return false;
        if (host.matches("(\\d{1,3}\\.){3}\\d{1,3}")) {
            try {
                int first = Integer.parseInt(host.split("\\.")[0]);
                if (first == 0 || first == 127) return false;
            } catch (NumberFormatException error) {
                return false;
            }
        }
        return true;
    }

    private void beginUpdate(final String version, final String url, final String sha256, final long bytes) {
        if (version == null || !version.matches("[0-9A-Za-z._-]{1,32}")) {
            emitError("Versión de actualización inválida.");
            return;
        }
        if (sha256 == null || !sha256.matches("[0-9a-fA-F]{64}")) {
            emitError("El paquete de actualización no tiene una firma válida.");
            return;
        }
        if (!isSecureUpdateUrl(url)) {
            emitError("La actualización debe descargarse por una conexión segura.");
            return;
        }
        if (bytes <= 0 || bytes > MAX_BUNDLE_BYTES) {
            emitError("El paquete de actualización tiene un tamaño no permitido.");
            return;
        }
        // La versión solo avanza: aplicar un paquete igual o anterior
        // reemplazaría la app por una versión ya superada. Para volver atrás
        // existe el rollback automático, no una "actualización" descendente.
        String installed = shellVersion();
        String applied = activeVersion == null ? "" : activeVersion;
        if (compareVersions(version, installed) <= 0) {
            emitError("La versión " + installed + " ya está instalada. Solo se aplican versiones más nuevas.");
            return;
        }
        if (compareVersions(version, applied) <= 0) {
            emitError("La versión " + applied + " ya está aplicada. Solo se aplican versiones más nuevas.");
            return;
        }
        if (!updateRunning.compareAndSet(false, true)) {
            return;
        }

        new Thread(() -> {
            File zipFile = new File(getCacheDir(), "palmyra-web-update.zip");
            File staging = new File(releasesDir, ".staging-" + version);
            try {
                // Un enlace lento puede cortar la primera lectura: se reintenta
                // una vez desde cero, borrando siempre el archivo parcial.
                // Verificación PRE-aplicación: tamaño y sha256 contra el
                // manifiesto firmado. Si la descarga no coincide, se descarta y
                // se reintenta UNA sola vez; el segundo desajuste no se aplica.
                boolean verified = false;
                for (int attempt = 1; attempt <= 2 && !verified; attempt++) {
                    downloadWithRetry(url, zipFile, bytes);
                    if (zipFile.length() != bytes) {
                        emitProgress("downloading", 2, zipFile.length(), bytes);
                        //noinspection ResultOfMethodCallIgnored
                        zipFile.delete();
                        if (attempt < 2) {
                            continue; // La descarga no coincide con la versión firmada. Reintentando…
                        }
                        throw new IOException("La descarga no coincide con la versión firmada (tamaño esperado "
                                + bytes + ", recibido " + zipFile.length() + "). No se aplicará.");
                    }
                    String actual = sha256Of(zipFile);
                    if (!actual.equalsIgnoreCase(sha256)) {
                        emitProgress("downloading", 2, zipFile.length(), bytes);
                        //noinspection ResultOfMethodCallIgnored
                        zipFile.delete();
                        if (attempt < 2) {
                            continue; // La descarga no coincide con la versión firmada. Reintentando…
                        }
                        throw new IOException("La descarga no coincide con la versión firmada y no se aplicará. Vuelve a buscar actualizaciones.");
                    }
                    verified = true;
                }
                emitProgress("verifying", 82, zipFile.length(), zipFile.length());
                unpackBundle(zipFile, staging);
                emitProgress("applying", 94, zipFile.length(), zipFile.length());

                String previous = activeVersion == null ? "" : activeVersion;
                File target = new File(releasesDir, version);
                deleteRecursive(target);
                if (!staging.renameTo(target)) {
                    throw new IOException("No se pudo preparar la nueva versión en el dispositivo. Verifica el espacio libre.");
                }

                SharedPreferences.Editor editor = prefs.edit()
                        .putString(KEY_CURRENT, version)
                        .putBoolean(KEY_CONFIRMED + version, false)
                        .putInt(KEY_ATTEMPT + version, 0);
                if (!version.equals(previous)) {
                    editor.putString(KEY_PREVIOUS, previous);
                }
                editor.apply();
                activeVersion = version;

                emitInstalled(version);
                emitProgress("reloading", 100, zipFile.length(), zipFile.length());
                runOnUiThread(() -> web.postDelayed(() -> web.loadUrl(BASE_URL), 1200));
            } catch (Exception error) {
                deleteRecursive(staging);
                //noinspection ResultOfMethodCallIgnored
                zipFile.delete();
                emitError(friendlyUpdateError(error));
            } finally {
                //noinspection ResultOfMethodCallIgnored
                zipFile.delete();
                updateRunning.set(false);
            }
        }, "palmyra-ota").start();
    }

    // ---------------------------------------------------------------------
    // Actualización del APK: descarga verificada e importación desde archivo
    // ---------------------------------------------------------------------

    /**
     * Descarga el APK por HTTPS, comprueba SHA-256, paquete, versión creciente
     * y firma del desarrollador ANTES de abrir el instalador. Cualquier
     * discrepancia deja el archivo borrado y avisa a la web.
     */
    private void beginApkUpdate(final String version, final String url, final String sha256, final long bytes) {
        if (version == null || !version.matches("[0-9A-Za-z._-]{1,32}")) {
            emitError("Versión de actualización inválida.");
            return;
        }
        if (sha256 == null || !sha256.matches("[0-9a-fA-F]{64}")) {
            emitError("El instalador no incluye una huella SHA-256 válida.");
            return;
        }
        if (!isSecureUpdateUrl(url)) {
            emitError("La actualización debe descargarse por una conexión segura.");
            return;
        }
        if (bytes <= 0 || bytes > MAX_APK_BYTES) {
            emitError("El instalador tiene un tamaño no permitido.");
            return;
        }
        String installed = shellVersion();
        if (compareVersions(version, installed) <= 0) {
            emitError("La versión " + installed + " ya está instalada. Solo se instalan versiones más nuevas.");
            return;
        }
        if (!apkUpdateRunning.compareAndSet(false, true)) {
            emitError("Ya hay una actualización en curso.");
            return;
        }

        new Thread(() -> {
            File download = new File(getCacheDir(), "palmyra-apk-update.bin");
            try {
                // Verificación PRE-instalación: tamaño y sha256 contra el
                // manifiesto firmado. Un desajuste descarta el archivo y se
                // reintenta UNA sola vez; el segundo desajuste no se instala.
                boolean verified = false;
                for (int attempt = 1; attempt <= 2 && !verified; attempt++) {
                    downloadWithRetry(url, download, bytes);
                    if (download.length() != bytes) {
                        emitProgress("downloading", 2, download.length(), bytes);
                        //noinspection ResultOfMethodCallIgnored
                        download.delete();
                        if (attempt < 2) {
                            continue; // La descarga no coincide con la versión firmada. Reintentando…
                        }
                        throw new IOException("La descarga no coincide con la versión firmada (tamaño esperado "
                                + bytes + ", recibido " + download.length() + "). No se instalará.");
                    }
                    String actual = sha256Of(download);
                    if (!actual.equalsIgnoreCase(sha256)) {
                        emitProgress("downloading", 2, download.length(), bytes);
                        //noinspection ResultOfMethodCallIgnored
                        download.delete();
                        if (attempt < 2) {
                            continue; // La descarga no coincide con la versión firmada. Reintentando…
                        }
                        throw new IOException("La descarga no coincide con la versión firmada y no se instalará. Vuelve a buscar actualizaciones.");
                    }
                    verified = true;
                }
                emitProgress("verifying", 82, download.length(), download.length());
                verifyApkForInstall(download, version);
                File dir = UpdateApkProvider.directory(this);
                if (dir == null) {
                    throw new IOException("No hay espacio en el dispositivo para preparar el instalador.");
                }
                File target = new File(dir, "palmyra-" + version + ".apk");
                copyFile(download, target);
                // La copia que verá el instalador debe ser byte a byte la misma.
                if (!sha256Of(target).equalsIgnoreCase(sha256)) {
                    throw new IOException("La copia local del instalador cambió y no se instalará.");
                }
                pruneApkDir(dir, target);
                openInstaller(target, version);
            } catch (Exception error) {
                emitError(friendlyUpdateError(error));
            } finally {
                //noinspection ResultOfMethodCallIgnored
                download.delete();
                apkUpdateRunning.set(false);
            }
        }, "palmyra-apk").start();
    }

    /** Abre el selector de archivos para importar un APK desde USB/SD. */
    private void importApkFromFile() {
        if (!apkUpdateRunning.compareAndSet(false, true)) {
            emitError("Ya hay una actualización en curso.");
            return;
        }
        runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/vnd.android.package-archive");
                startActivityForResult(intent, REQUEST_APK_IMPORT);
            } catch (Exception error) {
                apkUpdateRunning.set(false);
                emitError("No hay un explorador de archivos disponible para importar la actualización.");
            }
        });
    }

    private void verifyImportedApk(final Uri source) {
        File staged = new File(getCacheDir(), "palmyra-apk-import.bin");
        try {
            copyFromUri(source, staged);
            emitProgress("verifying", 40, staged.length(), staged.length());
            PackageInfo candidate = verifyApkForInstall(staged, "");
            String version = candidate.versionName == null ? "" : candidate.versionName;
            File dir = UpdateApkProvider.directory(this);
            if (dir == null) {
                throw new IOException("No hay espacio en el dispositivo para preparar el instalador.");
            }
            File target = new File(dir, "palmyra-import-" + safeFileName(version) + ".apk");
            copyFile(staged, target);
            pruneApkDir(dir, target);
            openInstaller(target, version);
        } catch (Exception error) {
            emitError(friendlyUpdateError(error));
        } finally {
            //noinspection ResultOfMethodCallIgnored
            staged.delete();
            apkUpdateRunning.set(false);
        }
    }

    // ---------------------------------------------------------------------
    // Actualización del bundle web desde archivo (USB/SD)
    // ---------------------------------------------------------------------

    /** Abre el selector de archivos para instalar un paquete web local. */
    private void importBundleFromFile() {
        if (!updateRunning.compareAndSet(false, true)) {
            emitError("Ya hay una actualización en curso.");
            return;
        }
        runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/zip");
                // Muchos exploradores entregan los .zip como octet-stream.
                intent.putExtra(Intent.EXTRA_MIME_TYPES,
                        new String[]{"application/zip", "application/octet-stream"});
                startActivityForResult(intent, REQUEST_BUNDLE_IMPORT);
            } catch (Exception error) {
                updateRunning.set(false);
                emitError("No hay un explorador de archivos disponible para importar la actualización.");
            }
        });
    }

    /**
     * Instala el paquete web elegido. Se copia completo al caché (tope de la
     * OTA), se lee su versión, se exige estrictamente mayor que la instalada y
     * la aplicada, y se desempaqueta con la misma protección zip-slip de la
     * OTA. Cualquier fallo deja intacta la versión en uso.
     */
    private void installImportedBundle(final Uri source) {
        File zipFile = new File(getCacheDir(), "palmyra-web-import.zip");
        File staging = new File(releasesDir, ".staging-import");
        try {
            copyFromUri(source, zipFile, MAX_BUNDLE_BYTES);
            if (zipFile.length() < 1024) {
                throw new IOException("El archivo elegido no es un paquete de actualización de PALMYRA.");
            }
            String version = bundleVersion(zipFile, displayNameOf(source));
            if (version == null || !version.matches("[0-9A-Za-z._-]{1,32}")) {
                throw new IOException("El paquete no declara una versión válida. Usa el ZIP del bundle de PALMYRA (index.html y version.json en la raíz).");
            }
            String installed = shellVersion();
            String applied = activeVersion == null ? "" : activeVersion;
            if (compareVersions(version, installed) <= 0) {
                throw new IOException("La versión " + installed + " ya está instalada. Solo se aplican versiones más nuevas.");
            }
            if (compareVersions(version, applied) <= 0) {
                throw new IOException("La versión " + applied + " ya está aplicada. Solo se aplican versiones más nuevas.");
            }

            unpackBundle(zipFile, staging);
            File target = new File(releasesDir, version);
            deleteRecursive(target);
            if (!staging.renameTo(target)) {
                throw new IOException("No se pudo preparar la nueva versión en el dispositivo. Verifica el espacio libre.");
            }

            String previous = activeVersion == null ? "" : activeVersion;
            SharedPreferences.Editor editor = prefs.edit()
                    .putString(KEY_CURRENT, version)
                    .putBoolean(KEY_CONFIRMED + version, false)
                    .putInt(KEY_ATTEMPT + version, 0);
            if (!version.equals(previous)) {
                editor.putString(KEY_PREVIOUS, previous);
            }
            editor.apply();
            activeVersion = version;

            emitInstalled(version);
            runOnUiThread(() -> web.postDelayed(() -> web.loadUrl(BASE_URL), 1200));
        } catch (Exception error) {
            deleteRecursive(staging);
            emitError(friendlyUpdateError(error));
        } finally {
            //noinspection ResultOfMethodCallIgnored
            zipFile.delete();
            updateRunning.set(false);
        }
    }

    /**
     * Versión del paquete leída de version.json en la raíz del ZIP. El ZIP que
     * publica la OTA excluye ese manifiesto (lo verifica por SHA-256), así que
     * un archivo copiado a mano puede identificarse por su nombre
     * palmyra-web-&lt;versión&gt;.zip. Nunca acepta una versión inventada.
     */
    private static String bundleVersion(File zipFile, String fallbackName) {
        try (ZipInputStream zip = new ZipInputStream(
                new BufferedInputStream(new FileInputStream(zipFile)))) {
            ZipEntry entry;
            byte[] buffer = new byte[16 * 1024];
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName().replace('\\', '/');
                if (!"version.json".equals(name)) continue;
                ByteArrayOutputStream collected = new ByteArrayOutputStream();
                int read;
                while ((read = zip.read(buffer)) != -1) {
                    collected.write(buffer, 0, read);
                    if (collected.size() > 64 * 1024) return "";
                }
                try {
                    JSONObject manifest = new JSONObject(collected.toString("UTF-8"));
                    String version = manifest.optString("version", "").trim();
                    if (!version.isEmpty()) return version;
                } catch (Exception ignored) {
                    // Un version.json ilegible se trata como ausente.
                }
                break;
            }
        } catch (Exception ignored) {
            // ZIP dañado: se intenta el nombre del archivo y, si no, se rechaza.
        }
        return versionFromName(fallbackName);
    }

    /**
     * Solo el nombre canónico de la OTA (palmyra-web-&lt;versión&gt;.zip) sirve
     * como respaldo: aceptar dígitos sueltos dejaría que un ZIP cualquiera se
     * declarara versión "2026".
     */
    private static String versionFromName(String name) {
        if (name == null) return "";
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("(?i)palmyra-web-(\\d+(?:\\.\\d+){1,3})(?:\\.zip)?$")
                .matcher(name.trim());
        return matcher.find() ? matcher.group(1) : "";
    }

    private String displayNameOf(Uri source) {
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(
                    source, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) {
            // Sin nombre visible se usa solo el contenido del ZIP.
        } finally {
            if (cursor != null) {
                try { cursor.close(); } catch (Exception ignored) {}
            }
        }
        return "";
    }

    private void copyFromUri(Uri source, File destination) throws IOException {
        copyFromUri(source, destination, MAX_APK_BYTES);
    }

    private void copyFromUri(Uri source, File destination, long maxBytes) throws IOException {
        InputStream input = null;
        OutputStream output = null;
        boolean copied = false;
        try {
            input = getContentResolver().openInputStream(source);
            if (input == null) {
                throw new IOException("No se pudo leer el archivo seleccionado.");
            }
            output = new BufferedOutputStream(new FileOutputStream(destination));
            byte[] buffer = new byte[64 * 1024];
            long total = 0L;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > maxBytes) {
                    throw new IOException("El archivo supera el tamaño máximo permitido.");
                }
                output.write(buffer, 0, read);
            }
            copied = true;
        } finally {
            if (output != null) try { output.close(); } catch (Exception ignored) {}
            if (input != null) try { input.close(); } catch (Exception ignored) {}
            if (!copied) {
                //noinspection ResultOfMethodCallIgnored
                destination.delete();
            }
        }
    }

    private void copyFile(File source, File destination) throws IOException {
        try (InputStream input = new BufferedInputStream(new FileInputStream(source));
             OutputStream output = new BufferedOutputStream(new FileOutputStream(destination))) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
    }

    /**
     * Valida un APK local antes de instalarlo: mismo paquete que PALMYRA,
     * versionCode estrictamente mayor, versión anunciada (si la hay) y misma
     * clave de firma que la app instalada. Devuelve el PackageInfo leído.
     */
    private PackageInfo verifyApkForInstall(File apk, String expectedVersion) throws IOException {
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        PackageInfo candidate;
        try {
            candidate = getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        } catch (Exception error) {
            throw new IOException("No se pudo leer el instalador descargado.", error);
        }
        if (candidate == null || candidate.packageName == null) {
            throw new IOException("El archivo no es un APK de Android válido.");
        }
        if (!getPackageName().equals(candidate.packageName)) {
            throw new IOException("El instalador pertenece a otra aplicación y no se instalará.");
        }
        long candidateCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? candidate.getLongVersionCode()
                : candidate.versionCode;
        long installedCode = installedVersionCode();
        if (installedCode >= 0 && candidateCode <= installedCode) {
            throw new IOException("El instalador no es más nuevo que la versión instalada ("
                    + shellVersion() + ").");
        }
        String candidateName = candidate.versionName == null ? "" : candidate.versionName;
        if (expectedVersion != null && !expectedVersion.isEmpty() && !expectedVersion.equals(candidateName)) {
            throw new IOException("El instalador no corresponde a la versión anunciada ("
                    + expectedVersion + ").");
        }
        if (!sameSigner(installedPackage(), candidate)) {
            throw new IOException("El instalador no está firmado con la clave de PALMYRA y no se instalará.");
        }
        return candidate;
    }

    /** La app instalada y el APK candidato deben compartir al menos un firmante. */
    private static boolean sameSigner(PackageInfo installed, PackageInfo candidate) {
        if (installed == null || candidate == null) return false;
        android.content.pm.Signature[] candidateSignatures = signaturesOf(candidate);
        if (candidateSignatures.length == 0) return false;
        for (android.content.pm.Signature installedSignature : signaturesOf(installed)) {
            if (installedSignature == null) continue;
            byte[] expected = installedSignature.toByteArray();
            for (android.content.pm.Signature candidateSignature : candidateSignatures) {
                if (candidateSignature != null
                        && MessageDigest.isEqual(expected, candidateSignature.toByteArray())) {
                    return true;
                }
            }
        }
        return false;
    }

    private PackageInfo installedPackage() {
        try {
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? PackageManager.GET_SIGNING_CERTIFICATES
                    : PackageManager.GET_SIGNATURES;
            return getPackageManager().getPackageInfo(getPackageName(), flags);
        } catch (Exception ignored) {
            return null;
        }
    }

    private long installedVersionCode() {
        PackageInfo info = installedPackage();
        if (info == null) return -1L;
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;
    }

    private static android.content.pm.Signature[] signaturesOf(PackageInfo info) {
        android.content.pm.Signature[] signatures = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            android.content.pm.SigningInfo signing = info.signingInfo;
            signatures = signing.hasMultipleSigners()
                    ? signing.getApkContentsSigners()
                    : signing.getSigningCertificateHistory();
        }
        if (signatures == null || signatures.length == 0) {
            // Android 7-8 aún expone el arreglo simple de firmas.
            signatures = info.signatures;
        }
        return signatures == null ? new android.content.pm.Signature[0] : signatures;
    }

    /** Abre el instalador del sistema con un content:// de solo lectura. */
    private void openInstaller(final File apk, final String version) {
        final Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(UpdateApkProvider.uriFor(apk), "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        runOnUiThread(() -> {
            try {
                startActivity(intent);
                emitApkReady(version);
            } catch (Exception error) {
                emitError("El dispositivo no pudo abrir el instalador de Android. Revisa \"Instalar apps desconocidas\".");
            }
        });
    }

    /** La caché conserva solo el APK que se está instalando. */
    private static void pruneApkDir(File dir, File keep) {
        try {
            File[] files = dir.listFiles();
            if (files == null) return;
            for (File file : files) {
                if (file == null || !file.isFile() || file.equals(keep)) continue;
                if (file.getName().endsWith(".apk")) {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                }
            }
        } catch (Exception ignored) {
            // La poda es mantenimiento: nunca debe impedir instalar.
        }
    }

    private static String safeFileName(String version) {
        String cleaned = version == null ? "" : version.replaceAll("[^0-9A-Za-z._-]", "-");
        if (cleaned.length() > 32) cleaned = cleaned.substring(0, 32);
        return cleaned.isEmpty() ? "manual" : cleaned;
    }

    /**
     * Comparación semántica por segmentos numéricos: "1.10.0" > "1.9.9" y la
     * estable "1.4.0" es más nueva que "1.4.0-beta.2". No lanza nunca.
     */
    private static int compareVersions(String left, String right) {
        String a = left == null ? "" : left.trim();
        String b = right == null ? "" : right.trim();
        int aDash = a.indexOf('-');
        int bDash = b.indexOf('-');
        String aCore = aDash >= 0 ? a.substring(0, aDash) : a;
        String bCore = bDash >= 0 ? b.substring(0, bDash) : b;
        int core = compareSegments(aCore, bCore);
        if (core != 0) return core;
        String aPre = aDash >= 0 ? a.substring(aDash + 1) : "";
        String bPre = bDash >= 0 ? b.substring(bDash + 1) : "";
        if (aPre.isEmpty() && bPre.isEmpty()) return 0;
        if (aPre.isEmpty()) return 1;
        if (bPre.isEmpty()) return -1;
        return compareSegments(aPre, bPre);
    }

    private static int compareSegments(String left, String right) {
        String[] a = left.split("\\.");
        String[] b = right.split("\\.");
        int length = Math.max(a.length, b.length);
        for (int i = 0; i < length; i++) {
            int compared = compareSegment(i < a.length ? a[i] : "", i < b.length ? b[i] : "");
            if (compared != 0) return compared;
        }
        return 0;
    }

    private static int compareSegment(String left, String right) {
        // Un segmento vacío ("1.4" frente a "1.4.0", o "") cuenta como 0.
        String a = left == null || left.isEmpty() ? "0" : left;
        String b = right == null || right.isEmpty() ? "0" : right;
        boolean leftNumeric = isNumeric(a);
        boolean rightNumeric = isNumeric(b);
        if (leftNumeric && rightNumeric) {
            String x = stripLeadingZeros(a);
            String y = stripLeadingZeros(b);
            if (x.length() != y.length()) return x.length() < y.length() ? -1 : 1;
            int compared = x.compareTo(y);
            return compared < 0 ? -1 : (compared > 0 ? 1 : 0);
        }
        // Semver: un identificador numérico precede a uno alfanumérico.
        if (leftNumeric) return -1;
        if (rightNumeric) return 1;
        int compared = a.compareToIgnoreCase(b);
        return compared < 0 ? -1 : (compared > 0 ? 1 : 0);
    }

    private static boolean isNumeric(String value) {
        if (value == null || value.isEmpty()) return false;
        for (int i = 0; i < value.length(); i++) {
            if (!Character.isDigit(value.charAt(i))) return false;
        }
        return true;
    }

    private static String stripLeadingZeros(String value) {
        int index = 0;
        while (index < value.length() - 1 && value.charAt(index) == '0') index++;
        return value.substring(index);
    }

    private void downloadWithRetry(String url, File destination, long expectedBytes) throws IOException {
        IOException lastError = null;
        for (int attempt = 1; attempt <= 2; attempt++) {
            try {
                downloadBundle(url, destination, expectedBytes);
                return;
            } catch (IOException error) {
                lastError = error;
                // Un archivo parcial jamás debe pasar a verificación/hash.
                //noinspection ResultOfMethodCallIgnored
                destination.delete();
                if (attempt >= 2) break;
                emitProgress("downloading", 2, 0, expectedBytes);
                try {
                    Thread.sleep(900);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IOException("La actualización fue cancelada.", interrupted);
                }
            }
        }
        throw lastError != null ? lastError : new IOException("No se pudo descargar la actualización.");
    }

    private void downloadBundle(String url, File destination, long expectedBytes) throws IOException {
        HttpURLConnection connection = null;
        InputStream input = null;
        OutputStream output = null;
        boolean completed = false;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(20_000);
            // 120s: en enlaces móviles/lentos una lectura puede tardar mucho más
            // de 60s entre bloques. HttpURLConnection no permite reiniciar el
            // timeout por lectura, así que se amplía y se emite progreso real.
            connection.setReadTimeout(120_000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("Accept", "application/octet-stream, application/zip;q=0.9, */*;q=0.8");
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.connect();
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IOException("El servidor respondió " + status + " al pedir la actualización.");
            }
            long declared = connection.getContentLengthLong();
            long total = expectedBytes > 0 ? expectedBytes : declared;
            if (total > MAX_BUNDLE_BYTES) {
                throw new IOException("El paquete de actualización es demasiado grande.");
            }
            // El manifiesto firmado manda sobre el Content-Length del servidor:
            // un CDN o un proxy puede mentir, la firma no.
            if (expectedBytes > 0 && declared > 0 && declared != expectedBytes) {
                throw new IOException("El servidor anuncia " + declared + " bytes y la versión firmada " + expectedBytes + ".");
            }
            emitProgress("downloading", 4, 0, total);

            input = new BufferedInputStream(connection.getInputStream());
            output = new BufferedOutputStream(new FileOutputStream(destination));
            byte[] buffer = new byte[64 * 1024];
            long received = 0;
            long lastEmit = 0L;
            int lastPercent = -1;
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
                received += read;
                if (received > MAX_BUNDLE_BYTES) {
                    throw new IOException("El paquete de actualización excede el tamaño permitido.");
                }
                long now = System.currentTimeMillis();
                int percent = total > 0
                        ? (int) Math.min(79, 5 + (received * 74) / total)
                        : (int) Math.min(75, 5 + received / (1024 * 1024));
                // Al menos cada 250 ms y en cada cambio de porcentaje: la UI
                // muestra "X de Y MB" aunque el enlace sea muy lento.
                if (now - lastEmit > 250 || percent != lastPercent) {
                    lastEmit = now;
                    lastPercent = percent;
                    emitProgress("downloading", percent, received, total);
                }
            }
            output.flush();
            emitProgress("downloading", 80, received, total);
            // El manifiesto firmado manda: la descarga debe terminar con
            // exactamente los bytes declarados en la firma.
            long required = expectedBytes > 0 ? expectedBytes : declared;
            if (required > 0 && received != required) {
                throw new IOException("La descarga quedó incompleta (" + received + " de " + required + " bytes). Reintenta con mejor conexión.");
            }
            completed = true;
        } finally {
            if (output != null) try { output.close(); } catch (Exception ignored) {}
            if (input != null) try { input.close(); } catch (Exception ignored) {}
            if (connection != null) connection.disconnect();
            if (!completed) {
                //noinspection ResultOfMethodCallIgnored
                destination.delete();
            }
        }
    }

    private void unpackBundle(File zipFile, File staging) throws IOException {
        deleteRecursive(staging);
        if (!staging.mkdirs()) {
            throw new IOException("No hay espacio para preparar la actualización.");
        }
        String root = staging.getCanonicalPath() + File.separator;
        long total = 0L;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(new FileInputStream(zipFile)))) {
            ZipEntry entry;
            byte[] buffer = new byte[64 * 1024];
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName().replace('\\', '/');
                if (name.isEmpty() || name.startsWith("/") || name.contains("..")) {
                    throw new IOException("El paquete contiene una ruta no permitida.");
                }
                File output = new File(staging, name);
                if (!output.getCanonicalPath().startsWith(root)) {
                    throw new IOException("El paquete intenta escribir fuera de la aplicación.");
                }
                if (entry.isDirectory()) {
                    if (!output.isDirectory() && !output.mkdirs()) {
                        throw new IOException("No se pudo crear la estructura de la actualización.");
                    }
                    continue;
                }
                File parent = output.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    throw new IOException("No se pudo crear la carpeta de la actualización.");
                }
                try (OutputStream out = new BufferedOutputStream(new FileOutputStream(output))) {
                    int read;
                    while ((read = zip.read(buffer)) != -1) {
                        total += read;
                        if (total > MAX_BUNDLE_BYTES) {
                            throw new IOException("El paquete de actualización excede el tamaño permitido.");
                        }
                        out.write(buffer, 0, read);
                    }
                }
            }
        }
        if (!new File(staging, "index.html").isFile()) {
            throw new IOException("La actualización no contiene la aplicación de PALMYRA.");
        }
    }

    private String sha256Of(File file) throws IOException {
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            MessageDigest digest;
            try {
                digest = MessageDigest.getInstance("SHA-256");
            } catch (Exception error) {
                throw new IOException("Este dispositivo no puede verificar la actualización.", error);
            }
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
            StringBuilder hex = new StringBuilder(64);
            for (byte value : digest.digest()) {
                hex.append(String.format(Locale.ROOT, "%02x", value & 0xff));
            }
            return hex.toString();
        }
    }

    private String friendlyUpdateError(Exception error) {
        if (error instanceof SocketTimeoutException) {
            return "La conexión es demasiado lenta para descargar la actualización. Acércate al WiFi y vuelve a intentarlo.";
        }
        if (error instanceof UnknownHostException || error instanceof ConnectException) {
            return "No se pudo conectar con el servidor de actualizaciones. Revisa tu conexión e inténtalo de nuevo.";
        }
        if (error instanceof java.io.FileNotFoundException) {
            return "El paquete de actualización ya no está disponible en el servidor. Inténtalo más tarde.";
        }
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) {
            return "No se pudo descargar la actualización. Revisa la conexión e inténtalo de nuevo.";
        }
        return message;
    }

    private void emitProgress(final String phase, final int percent, final long received, final long total) {
        evaluate("window.__palmyraOtaProgress&&window.__palmyraOtaProgress({phase:"
                + JSONObject.quote(phase) + ",percent:" + percent
                + ",receivedBytes:" + received + ",totalBytes:" + total + "})");
    }

    private void emitInstalled(final String version) {
        evaluate("window.__palmyraOtaInstalled&&window.__palmyraOtaInstalled(" + JSONObject.quote(version) + ")");
    }

    private void emitError(final String message) {
        evaluate("window.__palmyraOtaError&&window.__palmyraOtaError(" + JSONObject.quote(message) + ")");
    }

    /** El APK quedó verificado y se abrió el instalador del sistema. */
    private void emitApkReady(final String version) {
        evaluate("window.__palmyraApkReady&&window.__palmyraApkReady(" + JSONObject.quote(version) + ")");
    }

    private void evaluate(final String script) {
        runOnUiThread(() -> {
            if (web != null) {
                web.evaluateJavascript(script, null);
            }
        });
    }

    private static void deleteRecursive(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursive(child);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    // ---------------------------------------------------------------------
    // Servidor local
    // ---------------------------------------------------------------------

    class LocalServer extends NanoHTTPD {
        LocalServer() {
            super(PORT);
        }

        @Override
        public Response serve(IHTTPSession session) {
            Method method = session.getMethod();
            // NanoHTTPD 2.3.1 deja el cuerpo de un POST/PUT en el socket si el
            // handler no lo consume. La siguiente petición keep-alive empieza a
            // leer ese JSON como línea HTTP y devuelve "BAD REQUEST: Syntax
            // error. HTTP verb {...} unhandled." (issue #356). Se drena siempre.
            if (method != Method.GET && method != Method.HEAD) {
                try {
                    session.parseBody(new HashMap<String, String>());
                } catch (Exception ignored) {
                    // Cuerpo vacío o truncado: la respuesta 503/404 sigue siendo válida.
                }
            }

            String uri = session.getUri();
            if (uri == null || uri.isEmpty()) {
                uri = "/index.html";
            }

            // Salud del servidor local del APK (usada por el diagnóstico de Ayuda).
            if ("/healthz".equals(uri) || "/api/healthz".equals(uri)) {
                return newFixedLengthResponse(Response.Status.OK, "application/json",
                        "{\"ok\":true,\"server\":\"palmyra-android\"}");
            }

            // Las rutas del servidor Node no existen dentro del APK: respondemos
            // JSON para que la app lo trate como servicio no disponible.
            if (uri.startsWith("/api/")) {
                Log.w("PALMYRA", "API local no disponible: " + method + " " + uri
                        + " content-type=" + session.getHeaders().get("content-type")
                        + " content-length=" + session.getHeaders().get("content-length"));
                Response unavailable = newFixedLengthResponse(Response.Status.lookup(503),
                        "application/json", "{\"success\":false,\"error\":\"Servicio no disponible sin conexión.\"}");
                // El cuerpo ya se drenó; cerrar evita reutilizar una conexión
                // que un cliente antiguo pudo dejar a medias.
                unavailable.addHeader("Connection", "close");
                return unavailable;
            }

            String clean = uri.replace("..", "");
            String servedPath = "/index.html";
            InputStream stream = null;

            File releaseRoot = releaseDir(activeVersion);
            if (releaseRoot != null) {
                try {
                    File candidate = new File(releaseRoot, clean);
                    String canonicalRoot = releaseRoot.getCanonicalPath() + File.separator;
                    if (candidate.getCanonicalPath().startsWith(canonicalRoot) && candidate.isFile()) {
                        stream = new FileInputStream(candidate);
                        servedPath = clean;
                    } else {
                        String last = clean.substring(clean.lastIndexOf('/') + 1);
                        File fallback = new File(releaseRoot, "index.html");
                        if (!last.contains(".") && fallback.isFile()) {
                            stream = new FileInputStream(fallback);
                            servedPath = "/index.html";
                        }
                    }
                } catch (Exception ignored) {
                    stream = null;
                }
            } else {
                String assetPath = "web" + clean;
                try {
                    stream = getAssets().open(assetPath);
                    servedPath = clean;
                } catch (IOException notFound) {
                    servedPath = "";
                    String last = clean.substring(clean.lastIndexOf('/') + 1);
                    if (!last.contains(".")) {
                        try {
                            stream = getAssets().open("web/index.html");
                            servedPath = "/index.html";
                        } catch (IOException ignored) {
                            stream = null;
                        }
                    }
                    if (servedPath.isEmpty()) servedPath = "/index.html";
                }
            }

            if (stream == null) {
                return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found");
            }

            String mime = mimeOf(servedPath);
            Response response = newChunkedResponse(Response.Status.OK, mime, stream);
            boolean fresh = servedPath.endsWith("index.html") || servedPath.endsWith("sw.js");
            response.addHeader("Cache-Control", fresh
                    ? "no-store"
                    : "public, max-age=31536000, immutable");
            if (servedPath.endsWith("sw.js")) {
                response.addHeader("Service-Worker-Allowed", "/");
            }
            return response;
        }

        private String mimeOf(String path) {
            String lower = path.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".html")) return "text/html; charset=utf-8";
            if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
            if (lower.endsWith(".css")) return "text/css; charset=utf-8";
            if (lower.endsWith(".json")) return "application/json; charset=utf-8";
            if (lower.endsWith(".webmanifest")) return "application/manifest+json";
            if (lower.endsWith(".svg")) return "image/svg+xml";
            if (lower.endsWith(".png")) return "image/png";
            if (lower.endsWith(".webp")) return "image/webp";
            if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
            if (lower.endsWith(".ico")) return "image/x-icon";
            if (lower.endsWith(".woff2")) return "font/woff2";
            if (lower.endsWith(".woff")) return "font/woff";
            if (lower.endsWith(".ttf")) return "font/ttf";
            if (lower.endsWith(".zip")) return "application/zip";
            if (lower.endsWith(".txt") || lower.endsWith(".map")) return "text/plain; charset=utf-8";
            return "application/octet-stream";
        }
    }
}
