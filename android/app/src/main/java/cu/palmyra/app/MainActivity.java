package cu.palmyra.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

import fi.iki.elonen.NanoHTTPD;

/**
 * Shell de escritorio móvil: sirve la aplicación web ya compilada desde los
 * assets sobre 127.0.0.1 para conservar un origen seguro (service worker,
 * localStorage e IndexedDB) y funcionar sin internet.
 */
public class MainActivity extends Activity {
    private static final int PORT = 45643;
    private WebView web;
    private LocalServer server;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#5B2DBA"));
        getWindow().setNavigationBarColor(Color.parseColor("#3B1B78"));

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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }
        WebView.setWebContentsDebuggingEnabled(true);

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

        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl("http://127.0.0.1:" + PORT + "/");
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
            String assetPath = "web" + clean;

            InputStream stream = null;
            try {
                stream = getAssets().open(assetPath);
            } catch (IOException notFound) {
                // Sin extensión: rutas del SPA.
                String last = clean.substring(clean.lastIndexOf('/') + 1);
                if (!last.contains(".")) {
                    try {
                        stream = getAssets().open("web/index.html");
                        assetPath = "web/index.html";
                    } catch (IOException ignored) {
                        stream = null;
                    }
                }
            }

            if (stream == null) {
                return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found");
            }

            String mime = mimeOf(assetPath);
            Response response = newChunkedResponse(Response.Status.OK, mime, stream);
            boolean fresh = assetPath.endsWith("index.html") || assetPath.endsWith("sw.js");
            response.addHeader("Cache-Control", fresh
                    ? "no-store"
                    : "public, max-age=31536000, immutable");
            if (assetPath.endsWith("sw.js")) {
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
            if (lower.endsWith(".txt") || lower.endsWith(".map")) return "text/plain; charset=utf-8";
            return "application/octet-stream";
        }
    }
}
