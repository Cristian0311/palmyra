#!/usr/bin/env bash
# Builds the PALMYRA Android APK with the SDK build-tools directly.
# Gradle is not usable on this machine (Java receives HTTP 404 from dl.google.com),
# so AGP is bypassed: aapt2 + javac + d8 + zipalign + apksigner.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_SDK_ROOT:-C:/Users/R3ZERO/AppData/Local/Android/Sdk}"
BT="$SDK/build-tools/35.0.0"
PLATFORM_WIN="$SDK/platforms/android-34/android.jar"
LIB_WIN="$(cygpath -m "$PWD")/libs/nanohttpd-2.3.1.jar"
JBR="${JAVA_HOME:-C:/Program Files/Android/Android Studio/jbr}"
JAVAC="$JBR/bin/javac"
JAVA="$JBR/bin/java"
MAIN=app/src/main
OUT=build
AAPT2="$BT/aapt2.exe"
ZIPALIGN="$BT/zipalign.exe"
APKSIGNER="$BT/lib/apksigner.jar"

VERSION_NAME="$(node -p "require('../package.json').version")"
VERSION_CODE=$((10#$(printf '%s' "$VERSION_NAME" | awk -F. '{printf "%d%02d%02d", $1, $2, $3}')))

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/classes" "$OUT/dex" "$MAIN/assets" ../release

# The APK must ship the app that was just built. Copy the fresh Vite output
# (minus the Node server) so a new dist can never be packaged behind a stale shell.
if [[ -f ../dist/index.html ]]; then
  echo "==> syncing ../dist -> $MAIN/assets/web"
  rm -rf "$MAIN/assets/web"
  cp -R ../dist "$MAIN/assets/web"
  rm -f "$MAIN/assets/web/server.cjs"
else
  echo "!! ../dist/index.html not found; packaging the existing $MAIN/assets/web"
fi

echo "==> aapt2 compile (resources)"
"$AAPT2" compile --dir "$MAIN/res" -o "$OUT/res.zip"

echo "==> aapt2 link (manifest + assets) v$VERSION_NAME ($VERSION_CODE)"
"$AAPT2" link -o "$OUT/base.apk" \
  -I "$PLATFORM_WIN" \
  --manifest "$MAIN/AndroidManifest.xml" \
  -A "$MAIN/assets" \
  --java "$OUT/gen" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --auto-add-overlay "$OUT/res.zip"

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

echo "==> normalize entry separators"
python - "$OUT/unsigned.apk" <<'PY'
import os, sys, zipfile
src = sys.argv[1]
tmp = src + '.fixed'
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        zout.writestr(item.filename.replace('\\', '/'), zin.read(item))
os.replace(tmp, src)
PY

echo "==> zipalign"
"$ZIPALIGN" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "==> sign"
if [ ! -f "$HOME/.android/debug.keystore" ]; then
  "$JBR/bin/keytool" -genkeypair -keystore "$HOME/.android/debug.keystore" \
    -storepass android -keypass android -alias androiddebugkey \
    -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -keysize 2048 -validity 10000
fi
APK="../release/PALMYRA-$VERSION_NAME.apk"
"$JAVA" -jar "$APKSIGNER" sign \
  --ks "$HOME/.android/debug.keystore" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$APK" "$OUT/aligned.apk"

"$JAVA" -jar "$APKSIGNER" verify --print-certs "$APK" | head -3
ls -l "$APK"
echo "APK listo: $APK"
