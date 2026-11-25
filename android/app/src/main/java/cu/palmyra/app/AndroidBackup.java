package cu.palmyra.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Respaldo cifrado a Descargas y restauración desde un archivo del dispositivo.
 *
 * La web entrega el sobre cifrado en Base64 y aquí solo se escribe el archivo:
 * ningún método devuelve rutas privadas, registra contenido ni lanza hacia el
 * puente JavascriptInterface. Todas las respuestas son envelopes JSON con
 * {@code ok:false} y un código corto cuando algo falla.
 *
 * En API 29+ se usa MediaStore (no hace falta permiso de almacenamiento); en
 * versiones anteriores se escribe en la carpeta pública de Descargas con
 * WRITE_EXTERNAL_STORAGE.
 */
public final class AndroidBackup {
    /** Código de resultado del selector de archivos; lo consume MainActivity. */
    public static final int REQUEST_OPEN_BACKUP = 1004;

    private static final String PREFS = "palmyra_backup";
    private static final String KEY_PENDING_NAME = "pending_name";
    private static final String KEY_PENDING_SHA256 = "pending_sha256";
    private static final String PREFIX = "palmyra-backup-";
    private static final String SUFFIX = ".bin";
    private static final String MIME = "application/octet-stream";
    private static final String TEMP_NAME = "backup-import.tmp";
    private static final String ISO_PATTERN = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'";
    /** Un respaldo cifrado real ronda pocos MB; 64 MB descarta abusos. */
    private static final long MAX_BACKUP_BYTES = 64L * 1024L * 1024L;
    /** Techo por trozo: el Base64 de 1 MB viaja sin bloquear la WebView. */
    private static final int MAX_READ_BYTES = 1024 * 1024;

    private final Activity activity;
    private final WebView webView;
    private final SharedPreferences prefs;

    public AndroidBackup(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.prefs = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    // ---------------------------------------------------------------------
    // Guardado en Descargas
    // ---------------------------------------------------------------------

    /** Escribe el respaldo ya cifrado en Descargas públicas. */
    public String save(String fileName, String dataBase64, String sha256Expected) {
        try {
            String name = sanitizeName(fileName);
            if (name == null) return errorEnvelope("invalid_name");
            if (dataBase64 == null || dataBase64.isEmpty()) return errorEnvelope("invalid_argument");
            byte[] data;
            try {
                data = Base64.decode(dataBase64, Base64.DEFAULT);
            } catch (IllegalArgumentException invalid) {
                return errorEnvelope("invalid_base64");
            }
            if (data.length == 0) return errorEnvelope("empty_data");
            if (data.length > MAX_BACKUP_BYTES) return errorEnvelope("too_large");

            String expected = sha256Expected == null ? "" : sha256Expected.trim();
            if (!expected.isEmpty()) {
                if (!expected.matches("[0-9a-fA-F]{64}")) return errorEnvelope("invalid_checksum");
                if (!expected.equalsIgnoreCase(sha256Hex(data))) return errorEnvelope("checksum_mismatch");
            }

            writeDownload(name, data, MIME);
            JSONObject payload = new JSONObject();
            payload.put("ok", true);
            payload.put("location", Environment.DIRECTORY_DOWNLOADS + "/" + name);
            payload.put("bytes", data.length);
            return payload.toString();
        } catch (Exception error) {
            return errorEnvelope("permission_denied".equals(error.getMessage())
                    ? "permission_denied"
                    : "write_failed");
        }
    }

    /**
     * Guarda un archivo exportado por la web (Excel, CSV, TXT) en Descargas
     * públicas. Es el camino de las descargas de reportes: el DownloadListener
     * nativo no puede leer URLs blob:, así que el contenido llega en Base64.
     */
    public String saveExport(String fileName, String dataBase64, String mimeType) {
        try {
            String name = sanitizeName(fileName);
            if (name == null) return errorEnvelope("invalid_name");
            if (dataBase64 == null || dataBase64.isEmpty()) return errorEnvelope("invalid_argument");
            byte[] data;
            try {
                data = Base64.decode(dataBase64, Base64.DEFAULT);
            } catch (IllegalArgumentException invalid) {
                return errorEnvelope("invalid_base64");
            }
            if (data.length == 0) return errorEnvelope("empty_data");
            if (data.length > MAX_BACKUP_BYTES) return errorEnvelope("too_large");

            writeDownload(name, data, sanitizeMime(mimeType));
            JSONObject payload = new JSONObject();
            payload.put("ok", true);
            payload.put("location", Environment.DIRECTORY_DOWNLOADS + "/" + name);
            payload.put("bytes", data.length);
            return payload.toString();
        } catch (Exception error) {
            return errorEnvelope("permission_denied".equals(error.getMessage())
                    ? "permission_denied"
                    : "write_failed");
        }
    }

    /** MIME conocido para MediaStore; cualquier otro valor cae a octet-stream. */
    private static String sanitizeMime(String raw) {
        if (raw == null) return MIME;
        String base = raw.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return base.matches("[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*") ? base : MIME;
    }

    private void writeDownload(String name, byte[] data, String mime) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri target = activity.getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (target == null) throw new IOException("insert_failed");
            boolean written = false;
            try {
                OutputStream output = activity.getContentResolver().openOutputStream(target);
                if (output == null) throw new IOException("open_failed");
                try {
                    output.write(data);
                    output.flush();
                    written = true;
                } finally {
                    try { output.close(); } catch (Exception ignored) {}
                }
            } finally {
                if (!written) {
                    try { activity.getContentResolver().delete(target, null, null); } catch (Exception ignored) {}
                }
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            activity.getContentResolver().update(target, done, null, null);
            // Solo después de escribir se descartan copias previas con el
            // mismo nombre: un fallo nunca borra un respaldo ya guardado.
            deleteOlderDownloadCopies(name, target);
            return;
        }

        if (activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            throw new IOException("permission_denied");
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) throw new IOException("unavailable");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("unavailable");
        File target = new File(dir, name);
        boolean written = false;
        try {
            OutputStream output = new BufferedOutputStream(new FileOutputStream(target));
            try {
                output.write(data);
                output.flush();
                written = true;
            } finally {
                try { output.close(); } catch (Exception ignored) {}
            }
        } finally {
            if (!written) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
            }
        }
    }

    // ---------------------------------------------------------------------
    // Listado y borrado de respaldos del dispositivo
    // ---------------------------------------------------------------------

    /** Solo los archivos que siguen el patrón de respaldo de PALMYRA. */
    public String list() {
        try {
            List<BackupFile> files = new ArrayList<>();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                collectFromMediaStore(files);
            } else {
                collectFromDownloadsDir(files);
            }
            files.sort((left, right) -> {
                int byTime = Long.compare(right.savedAt, left.savedAt);
                return byTime != 0 ? byTime : left.name.compareToIgnoreCase(right.name);
            });

            JSONArray backups = new JSONArray();
            for (BackupFile file : files) {
                JSONObject item = new JSONObject();
                item.put("name", file.name);
                item.put("bytes", file.bytes);
                if (file.savedAt > 0) {
                    item.put("savedAt", formatMoment(file.savedAt));
                } else {
                    item.put("savedAt", JSONObject.NULL);
                }
                backups.put(item);
            }
            JSONObject payload = new JSONObject();
            payload.put("ok", true);
            payload.put("backups", backups);
            return payload.toString();
        } catch (Exception error) {
            return errorEnvelope("list_failed");
        }
    }

    private void collectFromMediaStore(List<BackupFile> files) {
        String[] projection = {
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED
        };
        Cursor cursor = null;
        try {
            cursor = activity.getContentResolver().query(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    projection,
                    MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?",
                    new String[]{PREFIX + "%" + SUFFIX},
                    null);
            if (cursor == null) return;
            int nameIndex = cursor.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME);
            int sizeIndex = cursor.getColumnIndex(MediaStore.MediaColumns.SIZE);
            int modifiedIndex = cursor.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED);
            while (cursor.moveToNext()) {
                String name = nameIndex >= 0 ? cursor.getString(nameIndex) : null;
                if (!isBackupName(name)) continue;
                long bytes = sizeIndex >= 0 ? cursor.getLong(sizeIndex) : 0L;
                // DATE_MODIFIED viene en segundos desde la época.
                long modified = modifiedIndex >= 0 ? cursor.getLong(modifiedIndex) : 0L;
                files.add(new BackupFile(name, bytes, modified > 0 ? modified * 1000L : 0L));
            }
        } catch (Exception ignored) {
            // Un MediaStore sin permiso o corrupto devuelve la lista vacía.
        } finally {
            if (cursor != null) {
                try { cursor.close(); } catch (Exception ignored) {}
            }
        }
    }

    private void collectFromDownloadsDir(List<BackupFile> files) {
        if (activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        File[] entries = dir == null ? null : dir.listFiles();
        if (entries == null) return;
        for (File entry : entries) {
            if (entry == null || !entry.isFile() || !isBackupName(entry.getName())) continue;
            files.add(new BackupFile(entry.getName(), entry.length(), entry.lastModified()));
        }
    }

    /** Borra solo archivos de respaldo; nunca otra descarga del usuario. */
    public String remove(String name) {
        try {
            if (!isBackupName(name)) return errorEnvelope("invalid_name");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                int deleted = activity.getContentResolver().delete(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                        new String[]{name});
                return deleted > 0 ? okEnvelope() : errorEnvelope("not_found");
            }
            if (activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                return errorEnvelope("permission_denied");
            }
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            File target = dir == null ? null : new File(dir, name);
            if (target == null || !target.isFile()) return errorEnvelope("not_found");
            return target.delete() ? okEnvelope() : errorEnvelope("delete_failed");
        } catch (Exception error) {
            return errorEnvelope("delete_failed");
        }
    }

    private void deleteOlderDownloadCopies(String name, Uri keep) {
        try {
            String keepId = keep == null ? "" : keep.getLastPathSegment();
            if (keepId == null || keepId.isEmpty()) return;
            activity.getContentResolver().delete(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    MediaStore.MediaColumns.DISPLAY_NAME + "=? AND "
                            + MediaStore.MediaColumns._ID + "<>?",
                    new String[]{name, keepId});
        } catch (Exception ignored) {
            // La limpieza de duplicados es best-effort: el archivo nuevo ya está.
        }
    }

    // ---------------------------------------------------------------------
    // Importación desde el selector del sistema (temp privado por trozos)
    // ---------------------------------------------------------------------

    /**
     * Abre el selector del sistema. El resultado llega a
     * {@link #handleActivityResult(int, int, Intent)}, copia el archivo a la
     * caché privada y avisa a la web con el evento
     * {@code palmyra-backup-imported}. La web lee el contenido por trozos con
     * readPending para no cruzar un archivo completo por el puente.
     */
    public void openPicker(final Activity activity) {
        if (activity == null) {
            emitImportResult(false, null, "picker_unavailable");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES,
                        new String[]{"application/octet-stream", "application/zip"});
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivityForResult(intent, REQUEST_OPEN_BACKUP);
            } catch (Exception error) {
                emitImportResult(false, null, "picker_unavailable");
            }
        });
    }

    /** Devuelve true si el resultado pertenece a este componente. */
    public boolean handleActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_OPEN_BACKUP) return false;
        Uri source = resultCode == Activity.RESULT_OK && data != null ? data.getData() : null;
        if (source == null) {
            clearPendingInternal();
            emitImportResult(false, null, "cancelled");
            return true;
        }
        final String displayName = displayNameOf(source);
        new Thread(() -> importFromUri(source, displayName), "palmyra-backup-import").start();
        return true;
    }

    private void importFromUri(Uri source, String displayName) {
        File temp = pendingFile();
        try {
            File parent = temp.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                throw new IOException("unavailable");
            }
            copyToFile(source, temp);
            long size = temp.length();
            if (size <= 0) throw new IOException("empty_file");
            String sha256 = sha256Of(temp);
            String name = sanitizeName(displayName);
            if (name == null) name = "respaldo.bin";
            prefs.edit()
                    .putString(KEY_PENDING_NAME, name)
                    .putString(KEY_PENDING_SHA256, sha256)
                    .apply();
            emitImportResult(true, name, null);
        } catch (Exception error) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            clearPendingInternal();
            emitImportResult(false, null, codeOf(error));
        }
    }

    private void copyToFile(Uri source, File destination) throws IOException {
        InputStream input = null;
        OutputStream output = null;
        boolean copied = false;
        try {
            input = activity.getContentResolver().openInputStream(source);
            if (input == null) throw new IOException("read_failed");
            output = new BufferedOutputStream(new FileOutputStream(destination));
            byte[] buffer = new byte[64 * 1024];
            long total = 0L;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_BACKUP_BYTES) throw new IOException("too_large");
                output.write(buffer, 0, read);
            }
            output.flush();
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

    private static String codeOf(Exception error) {
        String message = error == null ? null : error.getMessage();
        if ("too_large".equals(message)) return "too_large";
        if ("empty_file".equals(message)) return "empty_file";
        if ("read_failed".equals(message)) return "read_failed";
        if ("unavailable".equals(message)) return "unavailable";
        return "import_failed";
    }

    /** Metadatos del archivo importado (nombre original, tamaño y SHA-256). */
    public String pendingInfo() {
        try {
            File temp = pendingFile();
            if (!temp.isFile()) return errorEnvelope("no_pending");
            String name = prefs.getString(KEY_PENDING_NAME, "");
            if (name == null || name.isEmpty()) return errorEnvelope("no_pending");
            String sha256 = prefs.getString(KEY_PENDING_SHA256, "");
            JSONObject payload = new JSONObject();
            payload.put("ok", true);
            payload.put("name", name);
            payload.put("bytes", temp.length());
            payload.put("sha256", sha256 == null ? "" : sha256);
            return payload.toString();
        } catch (Exception error) {
            return errorEnvelope("no_pending");
        }
    }

    /** Lee un trozo del temporal; el techo por llamada es 1 MB. */
    public String readPending(int offset, int length) {
        try {
            File temp = pendingFile();
            if (!temp.isFile()) return errorEnvelope("no_pending");
            long size = temp.length();
            if (offset < 0 || length <= 0 || length > MAX_READ_BYTES || offset > size) {
                return errorEnvelope("invalid_argument");
            }
            int toRead = (int) Math.min((long) length, size - offset);
            byte[] buffer = new byte[toRead];
            int read = 0;
            RandomAccessFile file = new RandomAccessFile(temp, "r");
            try {
                file.seek(offset);
                while (read < toRead) {
                    int chunk = file.read(buffer, read, toRead - read);
                    if (chunk <= 0) break;
                    read += chunk;
                }
            } finally {
                try { file.close(); } catch (Exception ignored) {}
            }
            if (read != toRead) return errorEnvelope("read_failed");

            JSONObject payload = new JSONObject();
            payload.put("ok", true);
            payload.put("dataBase64", Base64.encodeToString(buffer, Base64.NO_WRAP));
            payload.put("eof", offset + (long) toRead >= size);
            return payload.toString();
        } catch (Exception error) {
            return errorEnvelope("read_failed");
        }
    }

    /** Borra el temporal y sus metadatos; llamarlo sin pendiente no falla. */
    public String clearPending() {
        try {
            clearPendingInternal();
            return okEnvelope();
        } catch (Exception error) {
            return errorEnvelope("delete_failed");
        }
    }

    private void clearPendingInternal() {
        //noinspection ResultOfMethodCallIgnored
        pendingFile().delete();
        prefs.edit()
                .remove(KEY_PENDING_NAME)
                .remove(KEY_PENDING_SHA256)
                .apply();
    }

    private File pendingFile() {
        return new File(activity.getCacheDir(), TEMP_NAME);
    }

    private String displayNameOf(Uri source) {
        Cursor cursor = null;
        try {
            cursor = activity.getContentResolver().query(
                    source, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) {
            // Sin nombre visible se usa el nombre genérico.
        } finally {
            if (cursor != null) {
                try { cursor.close(); } catch (Exception ignored) {}
            }
        }
        return null;
    }

    // ---------------------------------------------------------------------
    // Envelopes y ayudas
    // ---------------------------------------------------------------------

    private void emitImportResult(boolean ok, String name, String code) {
        JSONObject detail = new JSONObject();
        try {
            detail.put("ok", ok);
            if (ok) {
                detail.put("name", name == null ? "" : name);
            } else {
                detail.put("error", code == null ? "import_failed" : code);
            }
        } catch (Exception error) {
            return;
        }
        final String script = "window.dispatchEvent(new CustomEvent('palmyra-backup-imported',{detail:"
                + detail.toString() + "}))";
        activity.runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private static String okEnvelope() {
        try {
            JSONObject payload = new JSONObject();
            payload.put("ok", true);
            return payload.toString();
        } catch (Exception ignored) {
            return "{\"ok\":true}";
        }
    }

    private static String errorEnvelope(String code) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("ok", false);
            payload.put("error", code == null || code.isEmpty() ? "error" : code);
            return payload.toString();
        } catch (Exception ignored) {
            return "{\"ok\":false,\"error\":\"error\"}";
        }
    }

    /** Nombre seguro: sin rutas ni caracteres reservados, máximo 80. */
    static String sanitizeName(String raw) {
        if (raw == null) return null;
        String cleaned = raw.trim().replaceAll("[^A-Za-z0-9._-]", "-");
        if (cleaned.length() > 80) cleaned = cleaned.substring(0, 80);
        if (cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned)) return null;
        return cleaned;
    }

    private static boolean isBackupName(String name) {
        return name != null
                && name.length() <= 80
                && name.startsWith(PREFIX)
                && name.endsWith(SUFFIX)
                && name.matches("[A-Za-z0-9._-]+");
    }

    private static String formatMoment(long millis) {
        SimpleDateFormat format = new SimpleDateFormat(ISO_PATTERN, Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(millis));
    }

    private static String sha256Hex(byte[] data) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return hex(digest.digest(data));
        } catch (Exception error) {
            throw new IOException("hash_failed", error);
        }
    }

    private static String sha256Of(File file) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (Exception error) {
            throw new IOException("hash_failed", error);
        }
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }
        return hex(digest.digest());
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return out.toString();
    }

    private static final class BackupFile {
        final String name;
        final long bytes;
        final long savedAt;

        BackupFile(String name, long bytes, long savedAt) {
            this.name = name;
            this.bytes = bytes;
            this.savedAt = savedAt;
        }
    }
}
