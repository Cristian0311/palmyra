package cu.palmyra.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.security.Key;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.SignatureException;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Clave del dispositivo para el lease de licencia.
 *
 * La clave privada EC P-256 vive en Android Keystore (alias fijo, no
 * exportable) y solo se usa para firmar/verificar con SHA256withECDSA. La web
 * recibe la clave pública en Base64 (X.509/SPKI) para asociar el lease a este
 * equipo; la privada jamás sale del Keystore ni se serializa a disco.
 *
 * Además sella (`sealSecret`) y abre (`openSecret`) textos pequeños con una
 * clave AES-GCM que también vive en el Keystore: así la copia de la identidad
 * del equipo y del lease queda cifrada con el llavero del sistema y copiar la
 * carpeta de datos de la app a otra tableta no sirve.
 *
 * Todos los métodos devuelven un envelope JSON y NUNCA lanzan al puente
 * JavascriptInterface: un Keystore roto se informa como error explícito.
 */
public final class DeviceKeystore {
    private static final String TAG = "PALMYRA";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String SIGNATURE_ALGORITHM = "SHA256withECDSA";
    /** Alias fijo: una sola identidad criptográfica por instalación. */
    public static final String KEY_ALIAS = "palmyra.license.device.v1";
    /** Alias de la clave AES que sella los sobres de licencia. */
    private static final String WRAP_ALIAS = "palmyra.license.wrap.v1";
    private static final String WRAP_TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int GCM_IV_BYTES = 12;
    /** Los leases son JSON pequeños; 64 KB es un techo de sobra. */
    private static final int MAX_DATA_BYTES = 64 * 1024;
    private static final int MAX_SIGNATURE_BYTES = 4 * 1024;
    /** Identidad del equipo y lease: sobres de pocos KB. */
    private static final int MAX_SECRET_BYTES = 32 * 1024;
    /** Serializa generación y uso: dos llamadas JS simultáneas no crean dos claves. */
    private static final Object LOCK = new Object();

    /** Clave pública del dispositivo en Base64 (X.509 SubjectPublicKeyInfo). */
    public String publicKey() {
        synchronized (LOCK) {
            try {
                KeyPair pair = getOrCreateKeyPair();
                byte[] encoded = pair.getPublic() == null ? null : pair.getPublic().getEncoded();
                if (encoded == null || encoded.length == 0) {
                    return errorEnvelope("keystore_unavailable",
                            "La clave del dispositivo no puede exportarse como clave pública.");
                }
                JSONObject payload = new JSONObject();
                payload.put("algorithm", "EC");
                payload.put("curve", "P-256");
                payload.put("signatureAlgorithm", SIGNATURE_ALGORITHM);
                payload.put("format", "X.509");
                payload.put("publicKey", Base64.encodeToString(encoded, Base64.NO_WRAP));
                return ok(payload);
            } catch (Exception error) {
                logFailure("No se pudo obtener la clave pública del Keystore", error);
                return errorEnvelope("keystore_unavailable",
                        "No se pudo abrir la clave segura del dispositivo.");
            }
        }
    }

    /** Firma {@code dataBase64} (Base64/base64url) y devuelve la firma en Base64. */
    public String sign(String dataBase64) {
        synchronized (LOCK) {
            try {
                byte[] data = decodeData(dataBase64);
                KeyPair pair = getOrCreateKeyPair();
                Signature signer = Signature.getInstance(SIGNATURE_ALGORITHM);
                signer.initSign(pair.getPrivate());
                signer.update(data);
                byte[] signature = signer.sign();
                JSONObject payload = new JSONObject();
                payload.put("algorithm", SIGNATURE_ALGORITHM);
                payload.put("signature", Base64.encodeToString(signature, Base64.NO_WRAP));
                return ok(payload);
            } catch (IllegalArgumentException invalid) {
                return errorEnvelope("invalid_argument", invalid.getMessage());
            } catch (Exception error) {
                logFailure("No se pudo firmar con la clave del dispositivo", error);
                return errorEnvelope("keystore_unavailable",
                        "No se pudo firmar con la clave segura del dispositivo.");
            }
        }
    }

    /**
     * Verifica una firma SHA256withECDSA del propio dispositivo.
     * Una firma mal formada es {@code valid:false}; un fallo del Keystore es
     * {@code ok:false}.
     */
    public String verify(String dataBase64, String signatureBase64) {
        synchronized (LOCK) {
            try {
                byte[] data = decodeData(dataBase64);
                byte[] signatureBytes = decodeSignature(signatureBase64);
                KeyPair pair = getOrCreateKeyPair();
                Signature verifier = Signature.getInstance(SIGNATURE_ALGORITHM);
                verifier.initVerify(pair.getPublic());
                verifier.update(data);
                boolean valid;
                try {
                    valid = verifier.verify(signatureBytes);
                } catch (SignatureException malformed) {
                    valid = false;
                }
                JSONObject payload = new JSONObject();
                payload.put("valid", valid);
                return ok(payload);
            } catch (IllegalArgumentException invalid) {
                return errorEnvelope("invalid_argument", invalid.getMessage());
            } catch (Exception error) {
                logFailure("No se pudo verificar con la clave del dispositivo", error);
                return errorEnvelope("keystore_unavailable",
                        "No se pudo verificar con la clave segura del dispositivo.");
            }
        }
    }

    // ---------------------------------------------------------------------
    // Sobre cifrado con el Keystore (identidad del equipo y lease)
    // ---------------------------------------------------------------------

    /**
     * Cifra {@code plainBase64} con una clave AES-GCM del Keystore y devuelve
     * el sobre en Base64 (IV || texto cifrado || etiqueta). La clave AES no es
     * exportable: solo esta instalación puede abrir el sobre.
     */
    public String sealSecret(String plainBase64) {
        synchronized (LOCK) {
            try {
                byte[] plain = decodeSecret(plainBase64);
                SecretKey key = getOrCreateWrapKey();
                byte[] iv = new byte[GCM_IV_BYTES];
                new SecureRandom().nextBytes(iv);
                Cipher cipher = Cipher.getInstance(WRAP_TRANSFORMATION);
                cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
                byte[] sealed = cipher.doFinal(plain);
                byte[] envelope = new byte[iv.length + sealed.length];
                System.arraycopy(iv, 0, envelope, 0, iv.length);
                System.arraycopy(sealed, 0, envelope, iv.length, sealed.length);
                JSONObject payload = new JSONObject();
                payload.put("algorithm", WRAP_TRANSFORMATION);
                payload.put("envelope", Base64.encodeToString(envelope, Base64.NO_WRAP));
                return ok(payload);
            } catch (IllegalArgumentException invalid) {
                return errorEnvelope("invalid_argument", invalid.getMessage());
            } catch (Exception error) {
                logFailure("No se pudo cifrar el secreto del dispositivo", error);
                return errorEnvelope("keystore_unavailable",
                        "No se pudo cifrar el secreto del dispositivo.");
            }
        }
    }

    /**
     * Descifra un sobre creado por {@link #sealSecret(String)}. Un sobre de otro
     * equipo (o alterado) falla la autenticación GCM y se informa como error,
     * nunca como texto basura.
     */
    public String openSecret(String envelopeBase64) {
        synchronized (LOCK) {
            try {
                byte[] envelope = decodeEnvelope(envelopeBase64);
                if (envelope.length <= GCM_IV_BYTES) {
                    throw new IllegalArgumentException("El sobre cifrado está incompleto.");
                }
                byte[] iv = new byte[GCM_IV_BYTES];
                byte[] sealed = new byte[envelope.length - GCM_IV_BYTES];
                System.arraycopy(envelope, 0, iv, 0, iv.length);
                System.arraycopy(envelope, iv.length, sealed, 0, sealed.length);
                SecretKey key = getOrCreateWrapKey();
                Cipher cipher = Cipher.getInstance(WRAP_TRANSFORMATION);
                cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
                byte[] plain = cipher.doFinal(sealed);
                JSONObject payload = new JSONObject();
                payload.put("value", Base64.encodeToString(plain, Base64.NO_WRAP));
                return ok(payload);
            } catch (IllegalArgumentException invalid) {
                return errorEnvelope("invalid_argument", invalid.getMessage());
            } catch (Exception error) {
                // Un sobre de otro equipo no debe revelar nada del contenido.
                logFailure("No se pudo abrir el secreto del dispositivo", error);
                return errorEnvelope("keystore_unavailable",
                        "El secreto del dispositivo no se puede abrir en este equipo.");
            }
        }
    }

    // ---------------------------------------------------------------------
    // Keystore
    // ---------------------------------------------------------------------

    /** Clave AES del Keystore para los sobres de licencia; se crea si falta. */
    private static SecretKey getOrCreateWrapKey() throws Exception {
        KeyStore store = KeyStore.getInstance(ANDROID_KEYSTORE);
        store.load(null);
        if (store.containsAlias(WRAP_ALIAS)) {
            try {
                Key key = store.getKey(WRAP_ALIAS, null);
                if (key instanceof SecretKey && "AES".equals(key.getAlgorithm())) {
                    return (SecretKey) key;
                }
            } catch (Exception unusable) {
                // Entrada ilegible: se reemplaza abajo (los sobres viejos dejan
                // de abrirse y la app rehace la identidad, sin bloquear).
                logFailure("La clave de cifrado del dispositivo no pudo leerse; se reemplaza", unusable);
            }
            store.deleteEntry(WRAP_ALIAS);
        }

        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(WRAP_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    /**
     * Devuelve la clave existente o la crea. Si la entrada del Keystore está
     * ilegible o no es EC P-256 se reemplaza: sin clave válida el dispositivo
     * no podría volver a firmar y quedaría bloqueado por completo.
     */
    private KeyPair getOrCreateKeyPair() throws Exception {
        KeyStore store = KeyStore.getInstance(ANDROID_KEYSTORE);
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            try {
                KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
                if (entry instanceof KeyStore.PrivateKeyEntry) {
                    KeyStore.PrivateKeyEntry privateEntry = (KeyStore.PrivateKeyEntry) entry;
                    PublicKey key = privateEntry.getCertificate() == null
                            ? null
                            : privateEntry.getCertificate().getPublicKey();
                    if (isP256(key) && privateEntry.getPrivateKey() != null
                            && "EC".equals(privateEntry.getPrivateKey().getAlgorithm())) {
                        return new KeyPair(key, privateEntry.getPrivateKey());
                    }
                }
            } catch (Exception unusable) {
                // Entrada inválida o clave invalidada: se reemplaza abajo.
                logFailure("La clave del dispositivo no pudo leerse; se reemplaza", unusable);
            }
            store.deleteEntry(KEY_ALIAS);
        }

        KeyPairGenerator generator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE);
        generator.initialize(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build());
        return generator.generateKeyPair();
    }

    private static boolean isP256(PublicKey key) {
        if (!(key instanceof ECPublicKey)) return false;
        ECParameterSpec params = ((ECPublicKey) key).getParams();
        return params != null
                && params.getCurve() != null
                && params.getCurve().getField() != null
                && params.getCurve().getField().getFieldSize() == 256;
    }

    // ---------------------------------------------------------------------
    // Entrada y envelopes
    // ---------------------------------------------------------------------

    private static byte[] decodeData(String encoded) {
        if (encoded == null || encoded.trim().isEmpty()) {
            throw new IllegalArgumentException("Los datos a procesar están vacíos.");
        }
        byte[] bytes;
        try {
            bytes = decodeBase64(encoded);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Los datos no están en Base64 válido.");
        }
        if (bytes == null || bytes.length == 0) {
            throw new IllegalArgumentException("Los datos a procesar están vacíos.");
        }
        if (bytes.length > MAX_DATA_BYTES) {
            throw new IllegalArgumentException("Los datos superan el tamaño permitido (64 KB).");
        }
        return bytes;
    }

    /** Texto a sellar: Base64 válido y acotado (identidad y lease son pequeños). */
    private static byte[] decodeSecret(String encoded) {
        if (encoded == null || encoded.trim().isEmpty()) {
            throw new IllegalArgumentException("El secreto a cifrar está vacío.");
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(encoded, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("El secreto no está en Base64 válido.");
        }
        if (bytes == null || bytes.length == 0) {
            throw new IllegalArgumentException("El secreto a cifrar está vacío.");
        }
        if (bytes.length > MAX_SECRET_BYTES) {
            throw new IllegalArgumentException("El secreto supera el tamaño permitido.");
        }
        return bytes;
    }

    /** Sobre cifrado: Base64 válido y acotado antes de tocar el Keystore. */
    private static byte[] decodeEnvelope(String encoded) {
        if (encoded == null || encoded.trim().isEmpty()) {
            throw new IllegalArgumentException("El sobre cifrado está vacío.");
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(encoded, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("El sobre cifrado no está en Base64 válido.");
        }
        if (bytes == null || bytes.length == 0) {
            throw new IllegalArgumentException("El sobre cifrado está vacío.");
        }
        if (bytes.length > MAX_SECRET_BYTES + GCM_IV_BYTES + GCM_TAG_BITS / 8) {
            throw new IllegalArgumentException("El sobre cifrado supera el tamaño permitido.");
        }
        return bytes;
    }

    private static byte[] decodeSignature(String encoded) {
        if (encoded == null || encoded.trim().isEmpty()) {
            throw new IllegalArgumentException("La firma está vacía.");
        }
        byte[] bytes;
        try {
            bytes = decodeBase64(encoded);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("La firma no está en Base64 válido.");
        }
        if (bytes == null || bytes.length == 0) {
            throw new IllegalArgumentException("La firma está vacía.");
        }
        if (bytes.length > MAX_SIGNATURE_BYTES) {
            throw new IllegalArgumentException("La firma supera el tamaño permitido.");
        }
        return bytes;
    }

    /** El log es diagnóstico: si fallara, el Keystore no debe lanzar al JS. */
    private static void logFailure(String message, Throwable error) {
        try {
            Log.e(TAG, message, error);
        } catch (Throwable ignored) {
            // Sin log disponible se conserva la respuesta de error al llamador.
        }
    }

    /** Acepta Base64 estándar y base64url (la web usa URL-safe en huellas). */
    private static byte[] decodeBase64(String encoded) {
        boolean urlSafe = encoded.indexOf('-') >= 0 || encoded.indexOf('_') >= 0;
        return Base64.decode(encoded, urlSafe ? Base64.URL_SAFE : Base64.DEFAULT);
    }

    private static String ok(JSONObject payload) {
        try {
            payload.put("ok", true);
            return payload.toString();
        } catch (Exception error) {
            return errorEnvelope("error", "No se pudo preparar la respuesta del Keystore.");
        }
    }

    /** Envelope de error compartido con el puente JS; nunca lanza. */
    static String errorEnvelope(String code, String message) {
        try {
            JSONObject envelope = new JSONObject();
            envelope.put("ok", false);
            envelope.put("error", code == null || code.isEmpty() ? "error" : code);
            envelope.put("message", message == null || message.isEmpty()
                    ? "Error desconocido del Keystore."
                    : message);
            return envelope.toString();
        } catch (Exception ignored) {
            return "{\"ok\":false,\"error\":\"error\",\"message\":\"Error desconocido del Keystore.\"}";
        }
    }
}
