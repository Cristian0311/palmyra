package cu.palmyra.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * Expone SOLO el APK de actualización ya verificado a la app de instalación del
 * sistema. Desde Android 7 el instalador no acepta {@code file://}: hace falta
 * un {@code content://} con permiso temporal de lectura (FLAG_GRANT_READ_URI_PERMISSION).
 *
 * El proveedor no está exportado, no lista archivos y solo abre un nombre plano
 * dentro de {@code cache/apk-updates}; cualquier otra ruta es FileNotFound.
 * Así la verificación (SHA-256 + paquete + versión + firma) no puede saltarse
 * pidiendo otro archivo al proveedor.
 */
public final class UpdateApkProvider extends ContentProvider {
    public static final String AUTHORITY = "cu.palmyra.app.updates";
    private static final String MIME_APK = "application/vnd.android.package-archive";
    private static final String DIR_NAME = "apk-updates";
    private static final String SAFE_NAME = "[A-Za-z0-9._-]{1,64}";

    /** Carpeta privada de APKs de actualización; null si no se pudo crear. */
    static File directory(Context context) {
        if (context == null) return null;
        File dir = new File(context.getCacheDir(), DIR_NAME);
        if (dir.isDirectory()) return dir;
        return dir.mkdirs() ? dir : null;
    }

    /** URI content:// para un archivo dentro de {@link #directory(Context)}. */
    static Uri uriFor(File file) {
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(file.getName())
                .build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        String name = uri == null ? null : uri.getLastPathSegment();
        return name != null && name.toLowerCase(java.util.Locale.ROOT).endsWith(".apk")
                ? MIME_APK
                : "application/octet-stream";
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) {
            // El instalador solo lee; no se permite sobrescribir el APK.
            throw new FileNotFoundException("Solo lectura");
        }
        String name = uri == null ? null : uri.getLastPathSegment();
        if (name == null || !name.matches(SAFE_NAME) || name.contains("..")) {
            throw new FileNotFoundException("Recurso no permitido");
        }
        File dir = directory(getContext());
        if (dir == null) {
            throw new FileNotFoundException("Carpeta de actualizaciones no disponible");
        }
        File file = new File(dir, name);
        String root;
        String path;
        try {
            root = dir.getCanonicalPath() + File.separator;
            path = file.getCanonicalPath();
        } catch (IOException error) {
            throw new FileNotFoundException("Ruta de actualización inválida");
        }
        if (!path.startsWith(root) || !file.isFile()) {
            throw new FileNotFoundException("APK de actualización no encontrado");
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        // El proveedor solo sirve bytes de lectura; no hay consultas.
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("El proveedor de actualizaciones es de solo lectura");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("El proveedor de actualizaciones es de solo lectura");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("El proveedor de actualizaciones es de solo lectura");
    }
}
