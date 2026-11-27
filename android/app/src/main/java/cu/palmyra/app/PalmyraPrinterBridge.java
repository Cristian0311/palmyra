package cu.palmyra.app;

import android.app.Activity;
import android.app.PendingIntent;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.Intent;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;

/**
 * Impresora térmica del APK, expuesta a la web como PALMYRA_PRINTER.
 *
 * La WebView de Android no expone Web Bluetooth ni Web Serial, así que el POS no
 * puede imprimir desde JS dentro del shell. Este puente hace ese trabajo con las
 * APIs del sistema:
 *
 *  - Bluetooth: perfil SPP (RFCOMM) con la impresora ya vinculada en Ajustes.
 *    El canal se abre una vez y se reutiliza entre tickets; se escribe en trozos
 *    de PRINT_CHUNK_BYTES con una pausa, igual que la ruta BLE de escpos.ts, para
 *    no desbordar el búfer de impresoras térmicas baratas.
 *  - USB: UsbManager sobre el primer endpoint bulk OUT del dispositivo conectado
 *    (impresoras con interfaz de clase printer o perfiles propietarios).
 *
 * Contrato con la web (idéntico al resto de puentes del shell): cada método
 * devuelve un envelope JSON {ok:boolean, code?:string, deviceName?:string,
 * bytes?:number}, nunca lanza hacia la WebView y nunca registra contenido del
 * ticket: solo el código de error y el tamaño del envío.
 */
public final class PalmyraPrinterBridge {
    private static final String TAG = "PALMYRA";
    /** Perfil SPP serial: el que usan las impresoras térmicas ESC/POS. */
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    /** Mismo trozo y pausa que printReceiptOverBluetooth en src/lib/escpos.ts. */
    private static final int PRINT_CHUNK_BYTES = 180;
    private static final long PRINT_PAUSE_MS = 15L;
    /** Un ticket ESC/POS ronda 1-4 KB; 2 MB es un techo absurdo pero seguro. */
    private static final int MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int WRITE_TIMEOUT_MS = 12000;
    private static final int USB_TRANSFER_TIMEOUT_MS = 8000;
    /** Acción del broadcast propio de autorización USB (se envía a esta app). */
    private static final String ACTION_USB_PERMISSION = "cu.palmyra.app.USB_PERMISSION";
    /** El diálogo del sistema no se repite más de una vez cada 15 s por dispositivo. */
    private static final long USB_ASK_COOLDOWN_MS = 15000L;

    private final Activity activity;
    private BluetoothSocket bluetoothSocket;
    private OutputStream bluetoothOut;
    private String connectedAddress = "";
    private String connectedName = "";
    private UsbDevice usbDevice;
    private String usbDeviceName = "";
    private long usbAskedAt;
    private String usbAskedFor = "";

    public PalmyraPrinterBridge(Activity activity) {
        this.activity = activity;
    }

    // ------------------------------------------------------------------
    // Métodos expuestos a la WebView
    // ------------------------------------------------------------------

    /**
     * Hay adaptador Bluetooth (encendido o no) o una impresora USB conectada.
     * Devuelve el nombre del último vínculo activo para que el POS lo muestre.
     */
    @JavascriptInterface
    public String available() {
        try {
            JSONObject body = new JSONObject();
            boolean hasUsb = firstPrinterUsbDevice() != null;
            if (hasUsb) {
                body.put("ok", true);
                body.put("transport", "usb");
                body.put("deviceName", usbDeviceName);
                return body.toString();
            }
            BluetoothAdapter adapter = adapter();
            if (adapter == null) {
                return error("no_adapter");
            }
            body.put("ok", true);
            body.put("transport", "bluetooth");
            body.put("powered", adapter.isEnabled());
            body.put("pairedCount", safePairedCount(adapter));
            body.put("deviceName", connectedName);
            return body.toString();
        } catch (Throwable error) {
            return fail("available", error);
        }
    }

    /** Pide Bluetooth/ubicación/notificaciones según la API del equipo. */
    @JavascriptInterface
    public String requestPermissions() {
        try {
            return PalmyraPermissions.requestRuntime(activity);
        } catch (Throwable error) {
            return fail("requestPermissions", error);
        }
    }

    /**
     * Estado de los permisos, sin abrir diálogos: la web lo usa para no ofrecer un
     * aviso repetido y para saber si el USB ya está autorizado. Bajo API 31 los
     * permisos clásicos de Bluetooth se conceden al instalar (no se pueden revocar
     * ahí) y POST_NOTIFICATIONS no existe antes de Android 13.
     */
    @JavascriptInterface
    public String permissionStatus() {
        try {
            JSONObject body = new JSONObject();
            body.put("ok", true);
            body.put("notifications", PalmyraPermissions.notificationsGranted(activity));
            body.put("bluetooth", PalmyraPermissions.bluetoothGranted(activity));
            body.put("usb", usbAuthorized());
            return body.toString();
        } catch (Throwable error) {
            return fail("permissionStatus", error);
        }
    }

    private boolean usbAuthorized() {
        UsbDevice device = usbDevice != null ? usbDevice : firstPrinterUsbDevice();
        if (device == null) return false;
        UsbManager manager = (UsbManager) activity.getSystemService(Context.USB_SERVICE);
        return manager != null && manager.hasPermission(device);
    }

    /**
     * Abre el diálogo de autorización USB del sistema. El resultado llega por
     * broadcast y Android lo recuerda mientras el dispositivo siga conectado; no
     * hace falta escucharlo porque `hasPermission` se consulta en cada impresión.
     */
    private void requestUsbPermission(UsbManager manager, UsbDevice device) {
        try {
            String key = device.getDeviceName();
            long now = System.currentTimeMillis();
            if (key.equals(usbAskedFor) && now - usbAskedAt < USB_ASK_COOLDOWN_MS) return;
            usbAskedFor = key;
            usbAskedAt = now;
            int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_IMMUTABLE : 0;
            PendingIntent broadcast = PendingIntent.getBroadcast(activity, 0,
                    new Intent(ACTION_USB_PERMISSION).setPackage(activity.getPackageName()), flags);
            manager.requestPermission(device, broadcast);
        } catch (Throwable error) {
            Log.w(TAG, "no se pudo pedir el permiso USB: " + error.getClass().getSimpleName());
        }
    }

    /** Dispositivos vinculados que pueden ser una impresora SPP. */
    @JavascriptInterface
    public String listDevices() {
        try {
            BluetoothAdapter adapter = adapter();
            JSONArray items = new JSONArray();
            if (adapter != null) {
                Set<BluetoothDevice> paired = adapter.getBondedDevices();
                if (paired != null) {
                    for (BluetoothDevice device : paired) {
                        try {
                            JSONObject item = new JSONObject();
                            item.put("address", device.getAddress());
                            item.put("name", device.getName());
                            items.put(item);
                        } catch (Exception ignored) {
                            // Un enlace sin nombre/dirección legible no debe romper la lista.
                        }
                    }
                }
            }
            JSONObject body = new JSONObject();
            body.put("ok", true);
            body.put("devices", items);
            return body.toString();
        } catch (Throwable error) {
            return fail("listDevices", error);
        }
    }

    /**
     * Imprime el payload ESC/POS ya codificado.
     *
     * @param payloadBase64 bytes del ticket en Base64 (sin saltos de línea)
     * @param deviceAddress dirección MAC de la impresora; vacío = última usada
     */
    @JavascriptInterface
    public String printRawBase64(String payloadBase64, String deviceAddress) {
        byte[] payload;
        try {
            if (payloadBase64 == null || payloadBase64.isEmpty()) return error("empty_data");
            if (payloadBase64.length() > MAX_PAYLOAD_BYTES * 2) return error("too_large");
            payload = Base64.decode(payloadBase64, Base64.DEFAULT);
            if (payload.length == 0) return error("empty_data");
            if (payload.length > MAX_PAYLOAD_BYTES) return error("too_large");
        } catch (Exception error) {
            return error("empty_data");
        }
        String address = deviceAddress == null ? "" : deviceAddress.trim().toUpperCase();
        try {
            if (address.isEmpty() && usbDevice != null) {
                return writeOverUsb(payload);
            }
            if (!address.isEmpty() && isUsbAddress(address)) {
                return writeOverUsb(payload);
            }
            return writeOverBluetooth(payload, address);
        } catch (Throwable error) {
            closeQuietly();
            return fail("print", error);
        }
    }

    /** Cierra el canal abierto; no borra la impresora recordada por la web. */
    @JavascriptInterface
    public String close() {
        try {
            closeQuietly();
            return "{\"ok\":true}";
        } catch (Throwable error) {
            return fail("close", error);
        }
    }

    // ------------------------------------------------------------------
    // Bluetooth SPP
    // ------------------------------------------------------------------

    private String writeOverBluetooth(byte[] payload, String address) throws Exception {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) return error("no_adapter");
        if (!adapter.isEnabled()) return error("no_adapter");

        String target = address.isEmpty() ? connectedAddress : address;
        if (target.isEmpty()) {
            target = bestBondedPrinter(adapter);
            if (target.isEmpty()) return error("not_paired");
        }
        if (!target.matches("(?i)[0-9A-F]{2}(:[0-9A-F]{2}){5}")) return error("not_paired");

        if (!openIfNeeded(adapter, target)) return error("connect_failed");

        long deadline = System.currentTimeMillis() + WRITE_TIMEOUT_MS;
        OutputStream out = bluetoothOut;
        for (int offset = 0; offset < payload.length; offset += PRINT_CHUNK_BYTES) {
            int length = Math.min(PRINT_CHUNK_BYTES, payload.length - offset);
            out.write(payload, offset, length);
            if (offset + length < payload.length) {
                try {
                    Thread.sleep(PRINT_PAUSE_MS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return error("timeout");
                }
                if (System.currentTimeMillis() > deadline) {
                    closeQuietly();
                    return error("timeout");
                }
            }
        }
        out.flush();
        return okPrint(payload.length, connectedName);
    }

    /**
     * Abre (o reutiliza) el socket RFCOMM hacia la dirección pedida. El método es
     * sincronizado: dos tickets seguidos no pueden abrir dos canales SPP, y un
     * connect() bloqueante solo ocurre en el hilo de JS de la WebView.
     */
    private synchronized boolean openIfNeeded(BluetoothAdapter adapter, String address) {
        try {
            if (bluetoothSocket != null && bluetoothSocket.isConnected() && address.equals(connectedAddress)) {
                return true;
            }
            closeQuietly();
            BluetoothDevice device = adapter.getRemoteDevice(address);
            if (device == null) return false;
            if (device.getBondState() != BluetoothDevice.BOND_BONDED) return false;
            BluetoothSocket socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
            // Cancelar el descubrimiento libera el radio: sin esto el connect
            // suele tardar segundos o fallar en adaptadores combo.
            try {
                adapter.cancelDiscovery();
            } catch (Exception ignored) {
            }
            socket.connect();
            OutputStream stream = socket.getOutputStream();
            if (stream == null) {
                try {
                    socket.close();
                } catch (Exception ignored) {
                }
                return false;
            }
            bluetoothSocket = socket;
            bluetoothOut = stream;
            connectedAddress = address;
            connectedName = safeName(device, address);
            return true;
        } catch (Exception error) {
            closeQuietly();
            Log.w(TAG, "canal de impresion no disponible: " + error.getClass().getSimpleName());
            return false;
        }
    }

    private String bestBondedPrinter(BluetoothAdapter adapter) {
        try {
            Set<BluetoothDevice> paired = adapter.getBondedDevices();
            if (paired == null || paired.isEmpty()) return "";
            for (BluetoothDevice device : paired) {
                String name = safeName(device, "");
                String address = safeAddress(device);
                if (address.isEmpty()) continue;
                String lower = name.toLowerCase();
                if (lower.contains("printer") || lower.contains("impresora") || lower.contains("epos")
                        || lower.contains("goojprt") || lower.contains("xiniao") || lower.contains("rp80")
                        || lower.contains("mt") || lower.contains("zp")) {
                    return address;
                }
            }
            // Sin nombre obvio se reutiliza el último vínculo conocido por la web.
            return connectedAddress.isEmpty() ? "" : connectedAddress;
        } catch (SecurityException denied) {
            return "";
        }
    }

    // ------------------------------------------------------------------
    // USB (UsbManager, endpoint bulk OUT)
    // ------------------------------------------------------------------

    private boolean isUsbAddress(String address) {
        return address.toUpperCase().startsWith("USB:");
    }

    private UsbDevice firstPrinterUsbDevice() {
        try {
            UsbManager manager = (UsbManager) activity.getSystemService(Context.USB_SERVICE);
            if (manager == null) return null;
            java.util.HashMap<String, UsbDevice> devices = manager.getDeviceList();
            if (devices == null || devices.isEmpty()) return null;
            for (UsbDevice device : devices.values()) {
                if (findOutputTarget(device) != null) {
                    usbDevice = device;
                    usbDeviceName = device.getProductName() != null ? device.getProductName() : device.getDeviceName();
                    return device;
                }
            }
            return null;
        } catch (Throwable error) {
            return null;
        }
    }

    private String writeOverUsb(byte[] payload) {
        UsbDevice device = usbDevice != null ? usbDevice : firstPrinterUsbDevice();
        if (device == null) return error("usb_denied");
        UsbManager manager = (UsbManager) activity.getSystemService(Context.USB_SERVICE);
        if (manager == null) return error("usb_denied");
        if (!manager.hasPermission(device)) {
            // Sin este paso el USB nunca se puede usar: Android solo concede el
            // dispositivo con un diálogo del sistema. Se devuelve el pendiente y el
            // POS reintenta tras autorizar; reenviar el ticket aquí podría
            // duplicarlo.
            requestUsbPermission(manager, device);
            return error("usb_permission_pending");
        }
        UsbTarget found = findOutputTarget(device);
        if (found == null) return error("usb_denied");
        // Android no expone la interfaz desde el endpoint (getInterface es interno),
        // así que se localiza recorriendo las interfaces del dispositivo.
        UsbInterface target = found.usbInterface;
        UsbEndpoint endpoint = found.endpoint;
        UsbDeviceConnection connection = manager.openDevice(device);
        if (connection == null) return error("usb_denied");
        boolean claimed = false;
        try {
            if (!connection.claimInterface(target, true)) return error("usb_denied");
            claimed = true;
            for (int offset = 0; offset < payload.length; offset += PRINT_CHUNK_BYTES) {
                int length = Math.min(PRINT_CHUNK_BYTES, payload.length - offset);
                int sent = connection.bulkTransfer(endpoint, payload, offset, length, USB_TRANSFER_TIMEOUT_MS);
                if (sent < length) {
                    return error("write_failed");
                }
                try {
                    Thread.sleep(PRINT_PAUSE_MS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return error("timeout");
                }
            }
            return okPrint(payload.length, usbDeviceName);
        } catch (Throwable error) {
            return fail("usb", error);
        } finally {
            if (claimed) {
                try {
                    connection.releaseInterface(target);
                } catch (Exception ignored) {
                }
            }
            try {
                connection.close();
            } catch (Exception ignored) {
            }
        }
    }

    private UsbTarget findOutputTarget(UsbDevice device) {
        try {
            for (int i = 0; i < device.getInterfaceCount(); i++) {
                UsbInterface usable = device.getInterface(i);
                for (int j = 0; j < usable.getEndpointCount(); j++) {
                    UsbEndpoint endpoint = usable.getEndpoint(j);
                    if (endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK
                            && endpoint.getDirection() == UsbConstants.USB_DIR_OUT) {
                        return new UsbTarget(usable, endpoint);
                    }
                }
            }
            return null;
        } catch (Throwable error) {
            return null;
        }
    }

    /** Endpoint bulk OUT junto con la interfaz a la que pertenece (hay que reclamarla). */
    private static final class UsbTarget {
        final UsbInterface usbInterface;
        final UsbEndpoint endpoint;

        UsbTarget(UsbInterface usbInterface, UsbEndpoint endpoint) {
            this.usbInterface = usbInterface;
            this.endpoint = endpoint;
        }
    }

    // ------------------------------------------------------------------
    // Utilidades de envelope y estado
    // ------------------------------------------------------------------

    /** Llamado desde onDestroy: libera el socket antes de cerrar la actividad. */
    public void release() {
        try {
            closeQuietly();
        } catch (Throwable ignored) {
        }
    }

    private synchronized void closeQuietly() {
        if (bluetoothOut != null) {
            try {
                bluetoothOut.close();
            } catch (Exception ignored) {
            }
            bluetoothOut = null;
        }
        if (bluetoothSocket != null) {
            try {
                bluetoothSocket.close();
            } catch (Exception ignored) {
            }
            bluetoothSocket = null;
        }
        connectedAddress = "";
    }

    private BluetoothAdapter adapter() {
        try {
            android.bluetooth.BluetoothManager manager =
                    (android.bluetooth.BluetoothManager) activity.getSystemService(Context.BLUETOOTH_SERVICE);
            return manager == null ? null : manager.getAdapter();
        } catch (Throwable error) {
            return null;
        }
    }

    private int safePairedCount(BluetoothAdapter adapter) {
        try {
            Set<BluetoothDevice> paired = adapter.getBondedDevices();
            return paired == null ? 0 : paired.size();
        } catch (SecurityException denied) {
            return -1;
        }
    }

    private static String safeName(BluetoothDevice device, String fallback) {
        try {
            String name = device.getName();
            return name == null || name.isEmpty() ? fallback : name;
        } catch (SecurityException denied) {
            return fallback;
        }
    }

    private static String safeAddress(BluetoothDevice device) {
        try {
            return device.getAddress();
        } catch (SecurityException denied) {
            return "";
        }
    }

    private static String okPrint(int bytes, String deviceName) {
        try {
            JSONObject body = new JSONObject();
            body.put("ok", true);
            body.put("bytes", bytes);
            body.put("deviceName", deviceName == null ? "" : deviceName);
            return body.toString();
        } catch (Exception ignored) {
            return "{\"ok\":true}";
        }
    }

    /** Envelope de error: literal fijo, sin datos del ticket ni direcciones. */
    private static String error(String code) {
        return "{\"ok\":false,\"code\":\"" + code + "\"}";
    }

    private static String fail(String where, Throwable error) {
        Log.w(TAG, "puente de impresion: " + where + " -> " + error.getClass().getSimpleName());
        return error("bridge_error");
    }
}
