package cu.palmyra.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Permisos de hardware que usa el Punto de Venta del APK.
 *
 * El POS imprime tickets por Bluetooth (perfil SPP/RFCOMM) o por USB y muestra
 * avisos del centro de notificaciones. Esos tres accesos son permisos de
 * tiempo de ejecución y Android los repartió distinto según la API:
 *
 *  - API 31+: BLUETOOTH_CONNECT y BLUETOOTH_SCAN (con neverForLocation en el
 *    manifiesto, así el escaneo no arrastra permiso de ubicación).
 *  - API 30 e inferiores: BLUETOOTH / BLUETOOTH_ADMIN son de instalación y no
 *    se pueden pedir aquí; solo hace falta ACCESS_FINE_LOCATION para escanear,
 *    declarado con maxSdkVersion="30".
 *  - API 33+: POST_NOTIFICATIONS para que el sistema muestre los avisos.
 *
 * No se añade ninguna dependencia: usa Activity.requestPermissions y el shell
 * atiende el resultado en MainActivity.onRequestPermissionsResult con
 * REQUEST_CODE.
 */
public final class PalmyraPermissions {
    private PalmyraPermissions() {
    }

    /** Código de solicitud: único dentro de MainActivity (1001..1005 ya usados). */
    public static final int REQUEST_CODE = 1006;

    /** Permisos que esta versión del shell sabe pedir en tiempo de ejecución. */
    public static String[] runtimePermissions() {
        List<String> wanted = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            wanted.add("android.permission.BLUETOOTH_CONNECT");
            wanted.add("android.permission.BLUETOOTH_SCAN");
        } else if (Build.VERSION.SDK_INT >= 23) {
            // Bajo API 31 el escaneo SPP no exige ubicación si la impresora ya
            // está vinculada, pero el vinculo nuevo desde la app sí la necesita.
            wanted.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33) {
            wanted.add("android.permission.POST_NOTIFICATIONS");
        }
        return wanted.toArray(new String[0]);
    }

    /** Verdadero cuando falta al menos un permiso pedido. */
    public static boolean hasMissing(Activity activity, String[] permissions) {
        for (String permission : permissions) {
            if (activity.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                return true;
            }
        }
        return false;
    }

    /**
     * Pide lo que falte. Devuelve el envelope que espera la web: ok:true con
     * granted/pending (también es ok cuando todo estaba concedido), ok:false
     * con permission_denied si el sistema no permite preguntar (API &lt; 23 o
     * sin ventana de actividad).
     *
     * `Activity.requestPermissions` tiene que correr en el hilo de la interfaz:
     * los @JavascriptInterface llegan desde el hilo JavaBridge de la WebView y
     * pedir un diálogo desde ahí no muestra nada. Se lanza al UI thread y se
     * responde "pending"; el resultado real sale por
     * MainActivity.onRequestPermissionsResult hacia la web.
     */
    public static String requestRuntime(Activity activity) {
        try {
            String[] all = runtimePermissions();
            List<String> missing = new ArrayList<>();
            for (String permission : all) {
                if (activity.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                    missing.add(permission);
                }
            }
            if (missing.isEmpty()) {
                return doneEnvelope(true, all.length, 0);
            }
            if (Build.VERSION.SDK_INT < 23) {
                return errorEnvelope("permission_denied");
            }
            String[] payload = missing.toArray(new String[0]);
            activity.runOnUiThread(() -> {
                try {
                    activity.requestPermissions(payload, REQUEST_CODE);
                } catch (Throwable error) {
                    Log.w("PALMYRA", "no se pudo abrir el diálogo de permisos");
                }
            });
            return pendingEnvelope(payload.length);
        } catch (Throwable error) {
            return errorEnvelope("bridge_error");
        }
    }

    /**
     * Estado de los permisos sin abrir ningún diálogo. Los permisos clásicos de
     * Bluetooth se conceden en la instalación (no se pueden revocar ahí), así que
     * bajo API 31 cuentan como concedidos; POST_NOTIFICATIONS tampoco existe antes
     * de Android 13.
     */
    public static boolean notificationsGranted(Activity activity) {
        if (Build.VERSION.SDK_INT < 33) return true;
        return activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                == PackageManager.PERMISSION_GRANTED;
    }

    public static boolean bluetoothGranted(Activity activity) {
        if (Build.VERSION.SDK_INT < 31) return true;
        return activity.checkSelfPermission("android.permission.BLUETOOTH_CONNECT")
                == PackageManager.PERMISSION_GRANTED;
    }

    /** Envelope tras recibir onRequestPermissionsResult. */
    public static String doneEnvelope(boolean allGranted, int granted, int pending) {
        try {
            JSONObject body = new JSONObject();
            body.put("ok", allGranted);
            body.put("state", "done");
            body.put("granted", granted);
            body.put("pending", pending);
            if (!allGranted) body.put("code", "permission_denied");
            return body.toString();
        } catch (Exception ignored) {
            return "{\"ok\":false,\"code\":\"bad_response\"}";
        }
    }

    private static String pendingEnvelope(int requested) {
        try {
            JSONObject body = new JSONObject();
            body.put("ok", true);
            body.put("state", "pending");
            body.put("requested", requested);
            return body.toString();
        } catch (Exception ignored) {
            return "{\"ok\":true,\"state\":\"pending\"}";
        }
    }

    private static String errorEnvelope(String code) {
        return "{\"ok\":false,\"code\":\"" + code + "\"}";
    }
}
