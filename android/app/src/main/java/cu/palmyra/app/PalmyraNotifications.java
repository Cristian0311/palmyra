package cu.palmyra.app;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

/**
 * Avisos del sistema para el APK.
 *
 * La WebView del shell no implementa la API Web de notificaciones: alli
 * Notification.permission queda en "denied" de forma permanente y tampoco existe
 * PushManager, así que ningún aviso del POS puede salir de la página por esa vía.
 * El unico canal real es NotificationManager del propio shell, que es lo que usa
 * este helper.
 *
 * El permiso POST_NOTIFICATIONS (Android 13+) se pide al entrar con
 * PalmyraPermissions; si el usuario lo rechazo, show() devuelve el motivo en vez
 * de abrir un diálogo nuevo, porque desde la segunda denegación el sistema ya no
 * lo vuelve a ofrecer.
 */
public final class PalmyraNotifications {
    private PalmyraNotifications() {
    }

    /** Canal único: todos los avisos del POS comparten configuración de usuario. */
    public static final String CHANNEL_ID = "palmyra-avisos";

    private static final String CHANNEL_NAME = "Avisos de PALMYRA";
    private static final int MAX_TITLE = 90;
    private static final int MAX_BODY = 400;

    /**
     * Publica un aviso. Devuelve el envelope JSON que espera la web y nunca
     * lanza: si el sistema no coopera, el aviso simplemente no sale y la
     * campana de PALMYRA sigue mostrando lo mismo.
     */
    public static String show(Activity activity, String rawTitle, String rawBody, String rawTag) {
        try {
            if (activity == null) return envelope(false, "no_activity");
            if (!PalmyraPermissions.notificationsGranted(activity)) {
                return envelope(false, "permission_denied");
            }
            NotificationManager manager =
                    (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return envelope(false, "no_manager");
            String title = clip(rawTitle, MAX_TITLE);
            if (title.isEmpty()) title = "PALMYRA";
            String body = clip(rawBody, MAX_BODY);
            int id = notificationId(rawTag);
            manager.notify(id, build(activity, manager, title, body, id));
            return envelope(true, "");
        } catch (Throwable error) {
            Log.w("PALMYRA", "no se pudo publicar el aviso del sistema");
            return envelope(false, "notify_failed");
        }
    }

    private static Notification build(Activity activity, NotificationManager manager,
                                      String title, String body, int id) {
        // El canal tiene que existir antes de construir la notificación: en
        // Android 8+ un id de canal desconocido hace que el sistema descarte el
        // aviso sin avisar.
        ensureChannel(manager);
        Intent open = new Intent(activity, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent content = PendingIntent.getActivity(activity, id, open, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(activity, CHANNEL_ID)
                : new Notification.Builder(activity);
        Notification notice = builder
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setAutoCancel(true)
                .setContentIntent(content)
                .setWhen(System.currentTimeMillis())
                .build();
        return notice;
    }

    /**
     * El canal se crea en cada aviso porque la configuración puede venir
     * cambiada por el usuario y ensureChannel es idempotente: la segunda vez el
     * sistema conserva lo que ya existe.
     */
    private static void ensureChannel(NotificationManager manager) {
        try {
            if (Build.VERSION.SDK_INT < 26) return;
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Avisos del punto de venta: stock, turnos, sincronización y actualizaciones.");
            manager.createNotificationChannel(channel);
        } catch (Throwable ignored) {
            // Sin canal no hay aviso en Android 8+; show() ya controla el fallo.
        }
    }

    /** Mismo aviso (misma tag) cae en la misma ranura y se reemplaza, no se apila. */
    private static int notificationId(String tag) {
        String safeTag = tag == null ? "" : tag.trim();
        if (safeTag.isEmpty()) return Math.abs(CHANNEL_ID.hashCode() % 100000);
        return Math.abs(safeTag.hashCode() % 100000);
    }

    private static String clip(String value, int max) {
        if (value == null) return "";
        String trimmed = value.trim();
        if (trimmed.length() <= max) return trimmed;
        return trimmed.substring(0, max - 1) + "…";
    }

    private static String envelope(boolean ok, String code) {
        try {
            JSONObject body = new JSONObject();
            body.put("ok", ok);
            if (!ok) body.put("code", code);
            return body.toString();
        } catch (Exception ignored) {
            return ok ? "{\"ok\":true}" : "{\"ok\":false,\"code\":\"bad_response\"}";
        }
    }
}
