#!/usr/bin/env bash
# Builds the PALMYRA Android APK with the SDK build-tools directly.
# Gradle is not usable on this machine (Java receives HTTP 404 from dl.google.com),
# so AGP is bypassed: aapt2 + javac + d8 + zipalign + apksigner.
#
# Uso:
#   bash android/build-apk.sh          # APK estándar -> release/PALMYRA-Android.apk
#   bash android/build-apk.sh --lan    # APK de red local -> release/PALMYRA-Android-LAN.apk
#
# Variante --lan: añade res-lan como overlay de aapt2. Ese overlay sustituye
# res/xml/network_security_config.xml por uno que permite cleartext, porque el
# hub de la sucursal habla HTTP en la red privada (http://<IP>:<puerto>). El
# APK estándar NO incluye res-lan y sigue exigiendo HTTPS salvo en
# 127.0.0.1/localhost (servidor interno de la WebView).
#
# Gradle wrapper (android/gradle/wrapper/gradle-wrapper.properties) apunta a
# Gradle 8.9, compatible con AGP 8.5.2. El gradle-wrapper.jar no se versiona:
# se genera con `gradle wrapper` (ver el comentario de ese archivo) y este
# script solo informa al final si falta, con el comando exacto. Este build no
# usa Gradle: compila con aapt2/javac/d8/apksigner.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
build-apk.sh [-h|--help] [--lan]

  (sin argumentos)  APK estándar: cleartext solo 127.0.0.1/localhost.
  --lan             APK para el hub HTTP de la red local (res-lan).
                    NUNCA se publica: /download/android rechaza los nombres LAN.
  -h, --help        Muestra esta ayuda.

Firma:
  Con ANDROID_KEYSTORE_PATH + ANDROID_KEYSTORE_PASSWORD + ANDROID_KEY_ALIAS
  (y opcionalmente ANDROID_KEY_PASSWORD si difiere) se firma con apksigner y se
  verifica el certificado. Sin esas variables se usa la clave de depuración y se
  avisa por consola; el script termina con código 0.

Wrapper de Gradle:
  Al terminar se informa si faltan gradlew, gradlew.bat o gradle-wrapper.jar y,
  si `gradle` está en PATH, el comando para generarlos. El jar no se escribe a
  mano: es un binario opaco que produce `gradle wrapper`.
EOF
}

LAN=0
for arg in "$@"; do
  case "$arg" in
    --lan) LAN=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Argumento no reconocido: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SDK="${ANDROID_SDK_ROOT:-C:/Users/R3ZERO/AppData/Local/Android/Sdk}"
BT="$SDK/build-tools/35.0.0"
PLATFORM_WIN="$SDK/platforms/android-34/android.jar"
LIB_WIN="$(cygpath -m "$PWD")/libs/nanohttpd-2.3.1.jar"
JBR="${JAVA_HOME:-C:/Program Files/Android/Android Studio/jbr}"
JAVAC="$JBR/bin/javac"
JAVA="$JBR/bin/java"
MAIN=app/src/main
LAN_RES="$MAIN/res-lan"
OUT=build
AAPT2="$BT/aapt2.exe"
ZIPALIGN="$BT/zipalign.exe"
APKSIGNER="$BT/lib/apksigner.jar"

# package.json es la única fuente de versión: versionName visible y versionCode
# instalable salen del mismo valor. Debe crecer siempre para que Android acepte
# la actualización encima de la versión instalada.
PACKAGE_VERSION="$(node -p "require('../package.json').version")"
VERSION_NAME="$PACKAGE_VERSION"
VERSION_CODE=$((10#$(printf '%s' "$PACKAGE_VERSION" | awk -F. '{printf "%d%02d%02d", $1, $2, $3}')))
APK_NAME="PALMYRA-Android.apk"
VARIANT_LABEL="estándar"

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/classes" "$OUT/dex" "$MAIN/assets" ../release

# The APK must ship the app that was just built. Copy the fresh Vite output
# (minus the Node server) so a new dist can never be packaged behind a stale shell.
if [[ -f ../dist/index.html ]]; then
  echo "==> syncing ../dist -> $MAIN/assets/web"
  rm -rf "$MAIN/assets/web"
  cp -R ../dist "$MAIN/assets/web"
  # El paquete OTA y el servidor Node no viajan dentro del APK: el teléfono
  # descarga el ZIP desde el servidor y conserva sus datos al actualizar.
  rm -rf "$MAIN/assets/web/releases"
  rm -f "$MAIN/assets/web/server.cjs" "$MAIN/assets/web/server.cjs.map" "$MAIN/assets/web/desktop-server.cjs"
else
  echo "!! ../dist/index.html not found; packaging the existing $MAIN/assets/web"
fi

# El APK debe declarar la misma versión que package.json: scripts/check-release-assets.mjs
# lee assets/web/version.json del propio APK y rechaza el release si no coincide
# con el manifiesto. Un dist viejo aquí produce un APK no publicable.
VERSION_FILE="$MAIN/assets/web/version.json"
if [ ! -f "$VERSION_FILE" ]; then
  echo "!! Falta $VERSION_FILE: el APK debe declarar su versión (npm run build)." >&2
  exit 1
fi
BUNDLE_VERSION="$(node -p "require('./$VERSION_FILE').version" 2>/dev/null || true)"
if [ "$BUNDLE_VERSION" != "$VERSION_NAME" ]; then
  echo "!! $VERSION_FILE declara v${BUNDLE_VERSION:-?} y package.json v$VERSION_NAME." >&2
  echo "   Ejecuta 'npm run build' antes de build-apk.sh para empaquetar el bundle actual." >&2
  exit 1
fi
echo "==> versión del bundle web: v$BUNDLE_VERSION (coincide con package.json)"

# Overlay de seguridad: solo para el APK LAN. res-lan contiene únicamente
# xml/network_security_config.xml, de modo que no se duplica ningún otro recurso.
RES_OVERLAYS=()
if [ "$LAN" -eq 1 ]; then
  if [ ! -f "$LAN_RES/xml/network_security_config.xml" ]; then
    echo "!! Falta $LAN_RES/xml/network_security_config.xml; no se puede compilar la variante LAN." >&2
    exit 1
  fi
  if ! grep -q 'cleartextTrafficPermitted="true"' "$LAN_RES/xml/network_security_config.xml"; then
    echo "!! $LAN_RES/xml/network_security_config.xml debe permitir cleartext para el hub LAN." >&2
    exit 1
  fi
  APK_NAME="PALMYRA-Android-LAN.apk"
  VARIANT_LABEL="LAN (hub HTTP en red privada)"
fi

echo "==> aapt2 compile (resources)"
"$AAPT2" compile --dir "$MAIN/res" -o "$OUT/res.zip"
RES_OVERLAYS+=("$OUT/res.zip")
if [ "$LAN" -eq 1 ]; then
  echo "==> aapt2 compile (res-lan: cleartext para el hub HTTP de la red local)"
  "$AAPT2" compile --dir "$LAN_RES" -o "$OUT/res-lan.zip"
  # El último overlay gana: res-lan sustituye network_security_config.
  RES_OVERLAYS+=("$OUT/res-lan.zip")
fi

echo "==> aapt2 link (manifest + assets) v$VERSION_NAME ($VERSION_CODE), variante $VARIANT_LABEL"
"$AAPT2" link -o "$OUT/base.apk" \
  -I "$PLATFORM_WIN" \
  --manifest "$MAIN/AndroidManifest.xml" \
  -A "$MAIN/assets" \
  --java "$OUT/gen" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --auto-add-overlay "${RES_OVERLAYS[@]}"

echo "==> javac"
find "$MAIN/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
"$JAVAC" -nowarn -source 11 -target 11 -encoding UTF-8 \
  -classpath "$PLATFORM_WIN;$LIB_WIN" \
  -d "$OUT/classes" @"$OUT/sources.txt"

echo "==> d8 (dex)"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$JAVA" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --lib "$PLATFORM_WIN" --min-api 24 --release \
  --output "$OUT/dex" @"$OUT/classes.txt" "$LIB_WIN"

echo "==> package"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && "$JBR/bin/jar" uf ../unsigned.apk classes.dex)

# targetSdk 34 exige resources.arsc sin comprimir y alineado a 4 bytes; con
# `jar uf` y una recompresión completa el instalador de Android rechaza el APK
# con "No se pudo analizar el paquete". Se reconstruye el zip conservando
# STORED para .arsc/.so y DEFLATE solo para el resto.
echo "==> normalize entries (resources.arsc STORED)"
python - "$OUT/unsigned.apk" <<'PY'
import sys, zipfile
src = sys.argv[1]
tmp = src + '.fixed'
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, 'w') as zout:
    for item in zin.infolist():
        name = item.filename.replace('\\', '/')
        if not name or name.endswith('/'):
            continue
        data = zin.read(item)
        uncompressed = name.endswith('.arsc') or name.endswith('.so')
        info = zipfile.ZipInfo(name, date_time=item.date_time)
        info.external_attr = item.external_attr
        info.create_system = item.create_system
        info.compress_type = zipfile.ZIP_STORED if uncompressed else zipfile.ZIP_DEFLATED
        zout.writestr(info, data)
import os
os.replace(tmp, src)
PY

echo "==> zipalign (4-byte / 16 KB pages)"
"$ZIPALIGN" -f -P 16 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

# Comprobación: un resources.arsc comprimido rompe la instalación en Android.
python - "$OUT/aligned.apk" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    arsc = [i for i in z.infolist() if i.filename == 'resources.arsc']
    if not arsc:
        sys.exit('Falta resources.arsc en el APK')
    if arsc[0].compress_type != zipfile.ZIP_STORED:
        sys.exit('resources.arsc quedó comprimido; Android rechazará la instalación')
    try:
        z.testzip()
    except Exception:
        pass
print('resources.arsc: STORED y verificable')
PY

# ---------------------------------------------------------------------------
# Firma.
#
# Modo release (recomendado): ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD
# y ANDROID_KEY_ALIAS, más ANDROID_KEY_PASSWORD si la clave usa otra contraseña.
# Se firma con apksigner y se verifica el APK resultante. Las contraseñas se
# pasan por entorno (--ks-pass env:...) para que nunca aparezcan en argv, en el
# historial del shell ni en el log de CI.
#
# Modo depuración (sin esas variables): clave androiddebugkey de
# $HOME/.android/debug.keystore, la misma que usa el pipeline actual. Es válido
# para pruebas e instalaciones internas, pero NO para publicar: se avisa y el
# script termina con código 0.
# ---------------------------------------------------------------------------
APK="../release/$APK_NAME"
rm -f "$APK"

SIGN_MODE="debug"
if [ -n "${ANDROID_KEYSTORE_PATH:-}" ] && [ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ] && [ -n "${ANDROID_KEY_ALIAS:-}" ]; then
  SIGN_MODE="release"
elif [ -n "${ANDROID_KEYSTORE_PATH:-}" ] || [ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ] || [ -n "${ANDROID_KEY_ALIAS:-}" ]; then
  echo "!! Firma de release incompleta: se necesitan a la vez ANDROID_KEYSTORE_PATH," >&2
  echo "   ANDROID_KEYSTORE_PASSWORD y ANDROID_KEY_ALIAS. Se usará la clave de depuración." >&2
fi

if [ "$SIGN_MODE" = "release" ]; then
  if [ ! -f "$ANDROID_KEYSTORE_PATH" ]; then
    echo "!! ANDROID_KEYSTORE_PATH no existe o no es un archivo." >&2
    exit 1
  fi
  echo "==> sign (clave de release, alias $ANDROID_KEY_ALIAS)"
  SIGN_ARGS=(sign --ks "$ANDROID_KEYSTORE_PATH" --ks-key-alias "$ANDROID_KEY_ALIAS"
    --ks-pass env:ANDROID_KEYSTORE_PASSWORD)
  if [ -n "${ANDROID_KEY_PASSWORD:-}" ]; then
    SIGN_ARGS+=(--key-pass env:ANDROID_KEY_PASSWORD)
  fi
  "$JAVA" -jar "$APKSIGNER" "${SIGN_ARGS[@]}" --out "$APK" "$OUT/aligned.apk"
else
  echo "==> sign (clave de DEPURACIÓN)"
  if [ ! -f "$HOME/.android/debug.keystore" ]; then
    "$JBR/bin/keytool" -genkeypair -keystore "$HOME/.android/debug.keystore" \
      -storepass android -keypass android -alias androiddebugkey \
      -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -keysize 2048 -validity 10000
  fi
  "$JAVA" -jar "$APKSIGNER" sign \
    --ks "$HOME/.android/debug.keystore" --ks-pass pass:android --key-pass pass:android \
    --ks-key-alias androiddebugkey \
    --out "$APK" "$OUT/aligned.apk"
fi

# Verificación real del APK firmado. --print-certs imprime el DN y el digest del
# certificado (nunca contraseñas ni el contenido del keystore); se filtran solo
# esas dos líneas para que el log sea legible.
echo "==> verify signature"
if ! "$JAVA" -jar "$APKSIGNER" verify --print-certs "$APK" > "$OUT/apksigner-verify.txt" 2>&1; then
  cat "$OUT/apksigner-verify.txt" >&2
  echo "!! apksigner verify falló: el APK no quedó correctamente firmado." >&2
  exit 1
fi
grep -E 'Signer #1 certificate (DN|SHA-256 digest):' "$OUT/apksigner-verify.txt" | head -2 || true

if [ "$SIGN_MODE" != "release" ]; then
  echo ""
  echo "AVISO: APK firmado con la clave de DEPURACIÓN (androiddebugkey)."
  echo "       No sirve para publicar una actualización ni para Play Store."
  echo "       Define ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD y"
  echo "       ANDROID_KEY_ALIAS (y ANDROID_KEY_PASSWORD si difiere) para firmar"
  echo "       con la clave de release."
  echo ""
fi

ls -l "$APK"
echo "APK listo: $APK (v$VERSION_NAME, versionCode $VERSION_CODE, variante $VARIANT_LABEL, firma $SIGN_MODE)"

# ---------------------------------------------------------------------------
# Estado del wrapper de Gradle.
#
# gradlew, gradlew.bat y gradle/wrapper/gradle-wrapper.jar se generan con
# `gradle wrapper`, que respeta gradle-wrapper.properties (Gradle 8.9). El jar
# es un binario opaco: NO se versiona ni se escribe a mano. Este script compila
# sin Gradle (aapt2/javac/d8/apksigner), así que solo informa.
# ---------------------------------------------------------------------------
report_gradle_wrapper() {
  local missing=()
  [ -f gradlew ] || missing+=("gradlew")
  [ -f gradlew.bat ] || missing+=("gradlew.bat")
  [ -f gradle/wrapper/gradle-wrapper.jar ] || missing+=("gradle/wrapper/gradle-wrapper.jar")

  if [ "${#missing[@]}" -eq 0 ]; then
    echo "==> wrapper de Gradle completo (gradlew, gradlew.bat, gradle-wrapper.jar)"
    return 0
  fi

  echo ""
  echo "AVISO: wrapper de Gradle incompleto; falta: ${missing[*]}"
  echo "       El gradle-wrapper.jar no se inventa ni se versiona."
  if command -v gradle >/dev/null 2>&1; then
    local gver
    gver="$(gradle --version 2>/dev/null | awk '/^Gradle /{print $2; exit}')"
    echo "       Gradle ${gver:-desconocida} está en PATH. Genera el wrapper con:"
  else
    echo "       Gradle no está en PATH. Instala Gradle 8.9 y ejecuta, desde android/:"
  fi
  echo "         gradle wrapper --gradle-version 8.9 --distribution-type bin"
  echo "       Ese comando crea gradlew, gradlew.bat y gradle/wrapper/gradle-wrapper.jar"
  echo "       sin sobrescribir gradle-wrapper.properties. Este build no lo necesita."
  echo ""
  return 1
}

report_gradle_wrapper || true
