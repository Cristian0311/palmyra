package cu.palmyra.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Puente SQLite nativo del shell Android.
 *
 * El driver TypeScript del almacén local ({@code createSqliteDriver}) solo
 * necesita exec/run/all/close; esta clase los expone como JSON sobre
 * {@code window.PALMYRA_DB}. Todas las sentencias se ejecutan en UN único hilo
 * dedicado porque el driver envía BEGIN/COMMIT como SQL suelto: si cada
 * llamada del JavascriptInterface cayera en un hilo distinto, cada hilo podría
 * usar una conexión del pool y la transacción se rompería.
 *
 * El archivo ({@code palmyra.db} en el directorio privado de la app) no es
 * configurable desde JS y ninguna respuesta incluye rutas del dispositivo.
 */
public final class NativeDb {
    private static final String TAG = "PALMYRA";
    private static final String DB_NAME = "palmyra.db";
    private static final int STATEMENT_CACHE_LIMIT = 120;
    private static final Object[] NO_PARAMS = new Object[0];

    private final ExecutorService worker;
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final Map<String, SQLiteStatement> statements = new LinkedHashMap<>();

    /** Solo se toca desde el hilo de trabajo. */
    private SQLiteDatabase db;
    /** Diagnóstico de apertura; se lee desde el hilo de trabajo. */
    private volatile String openError;

    public NativeDb(Context context) {
        worker = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "palmyra-sqlite");
            // Un hilo de la base nunca debe impedir que la app termine.
            thread.setDaemon(true);
            return thread;
        });

        // getDatabasePath ya apunta al almacenamiento privado de la aplicación.
        File file = context.getApplicationContext().getDatabasePath(DB_NAME);
        try {
            worker.submit((Callable<Void>) () -> {
                open(file);
                return null;
            }).get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            openError = "La apertura de la base SQLite fue interrumpida";
        } catch (ExecutionException error) {
            Throwable cause = error.getCause() == null ? error : error.getCause();
            openError = "No se pudo abrir la base SQLite local";
            Log.e(TAG, "SQLite nativo no disponible", cause);
        }
    }

    // ---------------------------------------------------------------------
    // API expuesta a la web
    // ---------------------------------------------------------------------

    /**
     * Ejecuta una sentencia sin parámetros (DDL, BEGIN/COMMIT, PRAGMA).
     * Devuelve {@code {"ok":true}} o un envelope de error.
     */
    @JavascriptInterface
    public String exec(final String sql) {
        if (sql == null || sql.trim().isEmpty()) {
            return errorEnvelope("invalid_argument", "La sentencia SQL está vacía");
        }
        return submit("exec", () -> {
            database().execSQL(sql);
            JSONObject payload = new JSONObject();
            payload.put("ok", true);
            return payload.toString();
        });
    }

    /**
     * Ejecuta una sentencia con parámetros y devuelve los cambios aplicados.
     * Parámetros JSON: null, string, número o {@code {"b64":"..."}}.
     */
    @JavascriptInterface
    public String run(final String sql, final String paramsJson) {
        if (sql == null || sql.trim().isEmpty()) {
            return errorEnvelope("invalid_argument", "La sentencia SQL está vacía");
        }
        return submit("run", () -> {
            Object[] params = parseParams(paramsJson);
            SQLiteStatement statement = statement(sql);
            statement.clearBindings();
            bindAll(statement, params);
            int changes = statement.executeUpdateDelete();
            JSONObject payload = new JSONObject();
            payload.put("ok", true);
            payload.put("changes", changes);
            return payload.toString();
        });
    }

    /**
     * Ejecuta una consulta con parámetros y devuelve {@code {"rows":[...]}}.
     * Los enteros y reales viajan como números y los BLOB como
     * {@code {"b64":"..."}}.
     */
    @JavascriptInterface
    public String all(final String sql, final String paramsJson) {
        if (sql == null || sql.trim().isEmpty()) {
            return errorEnvelope("invalid_argument", "La sentencia SQL está vacía");
        }
        return submit("all", () -> {
            Object[] params = parseParams(paramsJson);
            JSONArray rows = new JSONArray();
            // rawQuery de Android solo acepta args de texto, así que los
            // parámetros tipados (números, BLOB, NULL) se insertan como
            // literales SQL seguros para no perder su afinidad.
            Cursor cursor = database().rawQuery(inlineParams(sql, params), null);
            try {
                while (cursor.moveToNext()) {
                    rows.put(readRow(cursor));
                }
            } finally {
                cursor.close();
            }
            JSONObject payload = new JSONObject();
            payload.put("ok", true);
            payload.put("rows", rows);
            return payload.toString();
        });
    }

    /**
     * Ejecuta {@code PRAGMA integrity_check} y devuelve
     * {@code {"ok":true,"result":"ok"}} o {@code {"ok":false,"result":"..."}}.
     * Un fallo del chequeo no es una excepción: la web necesita el texto para
     * informar al usuario y no debe recibir un error genérico del puente.
     */
    @JavascriptInterface
    public String integrity() {
        return submit("integrity", () -> {
            StringBuilder detail = new StringBuilder();
            boolean healthy = true;
            Cursor cursor = database().rawQuery("PRAGMA integrity_check", null);
            try {
                while (cursor.moveToNext()) {
                    String line = cursor.getString(0);
                    if (line == null || line.isEmpty()) continue;
                    if (!"ok".equalsIgnoreCase(line)) healthy = false;
                    if (detail.length() > 0) detail.append("; ");
                    // Techo defensivo: una base muy dañada devuelve muchas líneas.
                    if (detail.length() < 4000) detail.append(line);
                }
            } finally {
                cursor.close();
            }
            String result = healthy && detail.length() > 0 ? "ok" : detail.toString();
            if (result.isEmpty()) {
                healthy = false;
                result = "Sin respuesta de integrity_check";
            }
            JSONObject payload = new JSONObject();
            payload.put("ok", healthy);
            payload.put("result", result);
            return payload.toString();
        });
    }

    /**
     * Vuelca el WAL al archivo principal antes de que el sistema pause la app.
     * Se envía al hilo de la base sin esperar (onPause no puede bloquearse) y
     * cualquier fallo se ignora: es mantenimiento, no una operación de datos.
     */
    @JavascriptInterface
    public void checkpoint() {
        if (closed.get()) return;
        try {
            worker.submit((Runnable) () -> {
                try {
                    database().execSQL("PRAGMA wal_checkpoint(TRUNCATE)");
                } catch (RuntimeException ignored) {
                    // Con otra transacción abierta el checkpoint no puede
                    // completarse; la base sigue siendo válida.
                }
            });
        } catch (RejectedExecutionException ignored) {
            // La base ya está cerrada: no hay nada que volcar.
        }
    }

    /** Cierra la base y el hilo de trabajo. Llamarlo dos veces no hace nada. */
    @JavascriptInterface
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        try {
            Future<?> future = worker.submit(() -> shutdown());
            future.get(5, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        } catch (Exception ignored) {
            // El cierre es best-effort: nunca debe propagar al puente.
        } finally {
            worker.shutdown();
        }
    }

    // ---------------------------------------------------------------------
    // Hilo único y apertura
    // ---------------------------------------------------------------------

    private String submit(String operation, Callable<String> task) {
        if (closed.get()) {
            return errorEnvelope("closed", "La base SQLite local está cerrada");
        }
        try {
            Future<String> future = worker.submit(task);
            return future.get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return errorEnvelope("interrupted", "La operación SQLite fue interrumpida");
        } catch (ExecutionException error) {
            Throwable cause = error.getCause() == null ? error : error.getCause();
            return errorEnvelope(cause.getClass().getSimpleName(), messageOf(cause));
        } catch (RejectedExecutionException error) {
            return errorEnvelope("closed", "La base SQLite local está cerrada");
        }
    }

    private void open(File file) {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IllegalStateException("No se pudo crear la carpeta de la base de datos");
        }
        SQLiteDatabase database = SQLiteDatabase.openOrCreateDatabase(file, null);
        db = database;
        try {
            applyPragma("PRAGMA journal_mode = WAL");
            applyPragma("PRAGMA synchronous = NORMAL");
            applyPragma("PRAGMA busy_timeout = 5000");
            applyPragma("PRAGMA foreign_keys = OFF");
        } catch (RuntimeException error) {
            db = null;
            try {
                database.close();
            } catch (RuntimeException ignored) {
                // Se descarta la conexión recién abierta.
            }
            throw error;
        }
    }

    /** Varios PRAGMA devuelven fila (journal_mode, user_version...). */
    private void applyPragma(String sql) {
        Cursor cursor = db.rawQuery(sql, null);
        try {
            if (cursor.moveToFirst() && cursor.getColumnCount() > 0) {
                cursor.getString(0);
            }
        } finally {
            cursor.close();
        }
    }

    private SQLiteDatabase database() {
        SQLiteDatabase database = db;
        if (database == null) {
            throw new IllegalStateException(openError == null
                    ? "La base SQLite local está cerrada"
                    : openError);
        }
        return database;
    }

    private void shutdown() {
        for (SQLiteStatement statement : statements.values()) {
            try {
                statement.close();
            } catch (RuntimeException ignored) {
                // La sentencia ya estaba cerrada.
            }
        }
        statements.clear();
        SQLiteDatabase database = db;
        db = null;
        if (database != null) {
            try {
                database.close();
            } catch (RuntimeException error) {
                Log.w(TAG, "No se pudo cerrar la base SQLite", error);
            }
        }
    }

    private SQLiteStatement statement(String sql) {
        SQLiteStatement cached = statements.get(sql);
        if (cached != null) return cached;
        SQLiteStatement created = database().compileStatement(sql);
        if (statements.size() >= STATEMENT_CACHE_LIMIT) {
            for (SQLiteStatement value : statements.values()) {
                try {
                    value.close();
                } catch (RuntimeException ignored) {
                    // La sentencia ya estaba cerrada.
                }
            }
            statements.clear();
        }
        statements.put(sql, created);
        return created;
    }

    // ---------------------------------------------------------------------
    // Parámetros y filas
    // ---------------------------------------------------------------------

    private static Object[] parseParams(String paramsJson) {
        if (paramsJson == null || paramsJson.trim().isEmpty()) return NO_PARAMS;
        JSONArray array;
        try {
            array = new JSONArray(paramsJson);
        } catch (JSONException error) {
            throw new IllegalArgumentException("Parámetros JSON inválidos");
        }
        Object[] params = new Object[array.length()];
        for (int i = 0; i < params.length; i++) {
            Object value = array.opt(i);
            if (value == null || value == JSONObject.NULL) {
                params[i] = null;
            } else if (value instanceof JSONObject) {
                JSONObject object = (JSONObject) value;
                String encoded = object.optString("b64", null);
                if (encoded == null || object.length() != 1) {
                    throw new IllegalArgumentException("BLOB inválido en la posición " + i);
                }
                try {
                    params[i] = Base64.decode(encoded, Base64.DEFAULT);
                } catch (IllegalArgumentException error) {
                    throw new IllegalArgumentException("BLOB inválido en la posición " + i);
                }
            } else if (value instanceof String) {
                params[i] = value;
            } else if (value instanceof Integer || value instanceof Long
                    || value instanceof Double || value instanceof Float) {
                params[i] = value;
            } else {
                // Booleanos, arrays y objetos no forman parte del contrato.
                throw new IllegalArgumentException("Parámetro no soportado en la posición " + i);
            }
        }
        return params;
    }

    private static void bindAll(SQLiteStatement statement, Object[] params) {
        for (int i = 0; i < params.length; i++) {
            Object value = params[i];
            int index = i + 1;
            if (value == null) {
                statement.bindNull(index);
            } else if (value instanceof byte[]) {
                statement.bindBlob(index, (byte[]) value);
            } else if (value instanceof String) {
                statement.bindString(index, (String) value);
            } else if (value instanceof Double || value instanceof Float) {
                double number = ((Number) value).doubleValue();
                if (Double.isNaN(number) || Double.isInfinite(number)) {
                    throw new IllegalArgumentException("Número no válido en la posición " + i);
                }
                statement.bindDouble(index, number);
            } else if (value instanceof Number) {
                statement.bindLong(index, ((Number) value).longValue());
            } else {
                throw new IllegalArgumentException("Parámetro no soportado en la posición " + i);
            }
        }
    }

    private static JSONObject readRow(Cursor cursor) throws JSONException {
        JSONObject row = new JSONObject();
        String[] columns = cursor.getColumnNames();
        for (int i = 0; i < columns.length; i++) {
            String name = columns[i];
            switch (cursor.getType(i)) {
                case Cursor.FIELD_TYPE_NULL:
                    row.put(name, JSONObject.NULL);
                    break;
                case Cursor.FIELD_TYPE_INTEGER:
                    row.put(name, cursor.getLong(i));
                    break;
                case Cursor.FIELD_TYPE_FLOAT: {
                    double value = cursor.getDouble(i);
                    row.put(name, Double.isNaN(value) || Double.isInfinite(value)
                            ? JSONObject.NULL
                            : value);
                    break;
                }
                case Cursor.FIELD_TYPE_BLOB: {
                    JSONObject blob = new JSONObject();
                    blob.put("b64", Base64.encodeToString(cursor.getBlob(i), Base64.NO_WRAP));
                    row.put(name, blob);
                    break;
                }
                default: {
                    String value = cursor.getString(i);
                    row.put(name, value == null ? JSONObject.NULL : value);
                    break;
                }
            }
        }
        return row;
    }

    // ---------------------------------------------------------------------
    // Literales para all(): conserva la afinidad de números y BLOB
    // ---------------------------------------------------------------------

    private static String inlineParams(String sql, Object[] params) {
        if (params.length == 0) return sql;
        StringBuilder out = new StringBuilder(sql.length() + params.length * 12);
        int next = 0;
        int index = 0;
        int length = sql.length();
        while (index < length) {
            char current = sql.charAt(index);
            if (current == '\'' || current == '"' || current == '`') {
                int end = index + 1;
                while (end < length) {
                    if (sql.charAt(end) == current) {
                        if (end + 1 < length && sql.charAt(end + 1) == current) {
                            end += 2;
                            continue;
                        }
                        end += 1;
                        break;
                    }
                    end += 1;
                }
                end = Math.min(end, length);
                out.append(sql, index, end);
                index = end;
            } else if (current == '[') {
                int end = sql.indexOf(']', index + 1);
                end = end < 0 ? length - 1 : end;
                out.append(sql, index, end + 1);
                index = end + 1;
            } else if (current == '-' && index + 1 < length && sql.charAt(index + 1) == '-') {
                int end = sql.indexOf('\n', index);
                end = end < 0 ? length : end;
                out.append(sql, index, end);
                index = end;
            } else if (current == '/' && index + 1 < length && sql.charAt(index + 1) == '*') {
                int end = sql.indexOf("*/", index + 2);
                end = end < 0 ? length : end + 2;
                out.append(sql, index, end);
                index = end;
            } else if (current == '?') {
                if (next >= params.length) {
                    throw new IllegalArgumentException("Faltan parámetros para la consulta");
                }
                out.append(sqlLiteral(params[next]));
                next += 1;
                index += 1;
            } else {
                out.append(current);
                index += 1;
            }
        }
        if (next != params.length) {
            throw new IllegalArgumentException("Sobran parámetros para la consulta");
        }
        return out.toString();
    }

    private static String sqlLiteral(Object value) {
        if (value == null) return "NULL";
        if (value instanceof byte[]) {
            return "X'" + hexOf((byte[]) value) + "'";
        }
        if (value instanceof Double || value instanceof Float) {
            double number = ((Number) value).doubleValue();
            if (Double.isNaN(number) || Double.isInfinite(number)) {
                throw new IllegalArgumentException("Número no válido en los parámetros");
            }
            return Double.toString(number);
        }
        if (value instanceof Number) {
            return Long.toString(((Number) value).longValue());
        }
        return quoteText(String.valueOf(value));
    }

    private static String quoteText(String text) {
        if (text.indexOf('\u0000') >= 0) {
            throw new IllegalArgumentException("El texto contiene un byte nulo no soportado");
        }
        StringBuilder out = new StringBuilder(text.length() + 2);
        out.append('\'');
        for (int i = 0; i < text.length(); i++) {
            char current = text.charAt(i);
            if (current == '\'') out.append("''");
            else out.append(current);
        }
        out.append('\'');
        return out.toString();
    }

    private static String hexOf(byte[] bytes) {
        final char[] digits = "0123456789ABCDEF".toCharArray();
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            int unsigned = value & 0xff;
            out.append(digits[unsigned >>> 4]);
            out.append(digits[unsigned & 0x0f]);
        }
        return out.toString();
    }

    // ---------------------------------------------------------------------
    // Envelopes de error
    // ---------------------------------------------------------------------

    private static String messageOf(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
                ? error.getClass().getSimpleName()
                : message;
    }

    private static String errorEnvelope(String code, String message) {
        try {
            JSONObject envelope = new JSONObject();
            envelope.put("ok", false);
            envelope.put("error", code == null || code.isEmpty() ? "error" : code);
            envelope.put("message", message == null || message.isEmpty()
                    ? "Error SQLite desconocido"
                    : message);
            return envelope.toString();
        } catch (JSONException ignored) {
            return "{\"ok\":false,\"error\":\"error\",\"message\":\"Error SQLite desconocido\"}";
        }
    }
}
