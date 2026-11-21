package cu.palmyra.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.security.MessageDigest;
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

    private WebView web;
    private LocalServer server;
    private SharedPreferences prefs;
    private File releasesDir;
    private volatile String activeVersion = "";
    private final AtomicBoolean updateRunning = new AtomicBoolean(false);

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
        settings.setAllowContentAccess(false);
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
        WebView.setWebContentsDebuggingEnabled(true);
        web.addJavascriptInterface(new NativeBridge(), "PALMYRA_NATIVE");

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
        web.setWebChromeClient(new WebChromeClient());

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
        web.loadUrl(BASE_URL);
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
        if (url == null || !url.startsWith("https://")) {
            emitError("La actualización debe descargarse por una conexión segura.");
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
                downloadWithRetry(url, zipFile, bytes);
                emitProgress("verifying", 82, zipFile.length(), zipFile.length());
                String actual = sha256Of(zipFile);
                if (!actual.equalsIgnoreCase(sha256)) {
                    throw new IOException("El archivo descargado está dañado (firma distinta). Vuelve a intentarlo.");
                }
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
            connection.setRequestProperty("Accept", "application/zip");
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
            if (declared > 0 && received != declared) {
                throw new IOException("La descarga quedó incompleta (" + received + " de " + declared + " bytes). Reintenta con mejor conexión.");
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
            String uri = session.getUri();
            if (uri == null || uri.isEmpty()) {
                uri = "/index.html";
            }

            // Las rutas del servidor Node no existen dentro del APK: respondemos
            // JSON para que la app lo trate como servicio no disponible.
            if (uri.startsWith("/api/")) {
                return newFixedLengthResponse(Response.Status.lookup(503),
                        "application/json", "{\"success\":false,\"error\":\"Servicio no disponible sin conexión.\"}");
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
