#!/usr/bin/env node
/**
 * Validador estático del empaquetado Android de PALMYRA (fase F4).
 *
 * Node ESM sin dependencias y SIN Gradle: lee los archivos del paquete y falla
 * si el endurecimiento se degrada. Se usa en `.github/workflows/release.yml`
 * (job `android`, justo después de compilar el APK) y en local antes de
 * etiquetar:
 *
 *   node scripts/check-android-package.mjs
 *   node scripts/check-android-package.mjs --root <repo-o-fixture>
 *
 * Contrato que verifica:
 *   1. Versión: versionName == package.json y versionCode > 0. Si el proyecto
 *      deriva la versión (como aquí), se exige que build.gradle lea
 *      package.json y que versionCode use el esquema documentado en el propio
 *      gradle (acumulación x100 sobre major.minor.patch =>
 *      major*10000+minor*100+patch; 1.3.5 -> 10305).
 *   2. Manifiesto: allowBackup=false, usesCleartextTraffic=false,
 *      networkSecurityConfig=@xml/network_security_config, android:exported
 *      explícito en cada componente (launcher true, el resto false), proveedor
 *      de actualizaciones que solo sirve APKs, y permisos justificados: nada
 *      peligroso fuera de la lista blanca y WRITE_EXTERNAL_STORAGE solo con
 *      maxSdkVersion<=28.
 *   3. Firma: release únicamente con keystore/alias/contraseñas desde variables
 *      de entorno (sin literales versionados); se admite la clave de depuración
 *      como degradación explícita, nunca un almacén a medias.
 *   4. Red: el APK estándar no permite cleartext fuera de
 *      127.0.0.1/localhost, y usesCleartextTraffic no contradice el config. El
 *      overlay res-lan (hub HTTP de la red privada) existe pero está aislado al
 *      sabor `lan`, cuyo nombre de salida lleva el sufijo -LAN y no se publica.
 *   5. Puentes nativos: MainActivity registra PALMYRA_NATIVE, PALMYRA_DB,
 *      PALMYRA_KEYSTORE, PALMYRA_BACKUP y PALMYRA_PRINTER; NativeDb expone
 *      integrity() y checkpoint(). El puente de impresión térmica debe exponer
 *      los seis métodos que consume `src/lib/escpos.ts` (available,
 *      requestPermissions, permissionStatus, listDevices, printRawBase64,
 *      close) y el shell debe poder pedir permisos: PalmyraPermissions lanza el
 *      diálogo en el hilo de UI y MainActivity devuelve el resultado a la web
 *      por `window.__palmyraHardwarePermissions`. Los avisos del sistema salen
 *      por `PALMYRA_NATIVE.showNotification` (PalmyraNotifications): la WebView
 *      no tiene API Web de notificaciones, así que sin ese puente el permiso de
 *      POST_NOTIFICATIONS no tendría ningún uso.
 *
 * Salida: una línea OK/FALLO por comprobación y un resumen; exit code 1 si algo
 * falla. Un valor que no se puede determinar se reporta como «no verificable»
 * y cuenta como fallo: el validador nunca asume que algo está bien.
 *
 * `inspect()` y `main()` se exportan para tests/unit/android-packaging.test.ts;
 * los tests apuntan el validador a fixtures temporales con `root`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/** Rutas relativas al repo que lee el validador (sobrescribibles por `paths`). */
export const DEFAULT_PATHS = {
  packageJson: "package.json",
  gradle: "android/app/build.gradle",
  manifest: "android/app/src/main/AndroidManifest.xml",
  networkMain: "android/app/src/main/res/xml/network_security_config.xml",
  networkLan: "android/app/src/main/res-lan/xml/network_security_config.xml",
  mainActivity: "android/app/src/main/java/cu/palmyra/app/MainActivity.java",
  nativeDb: "android/app/src/main/java/cu/palmyra/app/NativeDb.java",
  updateProvider: "android/app/src/main/java/cu/palmyra/app/UpdateApkProvider.java",
  printerBridge: "android/app/src/main/java/cu/palmyra/app/PalmyraPrinterBridge.java",
  permissions: "android/app/src/main/java/cu/palmyra/app/PalmyraPermissions.java",
  alerts: "android/app/src/main/java/cu/palmyra/app/PalmyraNotifications.java"
};

/** Hosts locales admitidos en claro en el APK publicado. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Bridges que el shell Android debe registrar en la WebView. */
const BRIDGES = ["PALMYRA_NATIVE", "PALMYRA_DB", "PALMYRA_KEYSTORE", "PALMYRA_BACKUP", "PALMYRA_PRINTER"];

/**
 * Permisos de protección peligrosa (o restringida en Play): si aparecen, deben
 * estar justificados y en la lista blanca. Lista explícita para que un permiso
 * nuevo no pase por accidente.
 */
const DANGEROUS_PERMISSIONS = new Set([
  "CAMERA",
  "RECORD_AUDIO",
  "READ_CONTACTS",
  "WRITE_CONTACTS",
  "GET_ACCOUNTS",
  "ACCESS_FINE_LOCATION",
  "ACCESS_COARSE_LOCATION",
  "ACCESS_BACKGROUND_LOCATION",
  "READ_PHONE_STATE",
  "READ_PHONE_NUMBERS",
  "CALL_PHONE",
  "ANSWER_PHONE_CALLS",
  "READ_CALL_LOG",
  "WRITE_CALL_LOG",
  "PROCESS_OUTGOING_CALLS",
  "READ_CALENDAR",
  "WRITE_CALENDAR",
  "BODY_SENSORS",
  "ACTIVITY_RECOGNITION",
  "READ_SMS",
  "SEND_SMS",
  "RECEIVE_SMS",
  "RECEIVE_MMS",
  "RECEIVE_WAP_PUSH",
  "READ_EXTERNAL_STORAGE",
  "WRITE_EXTERNAL_STORAGE",
  "MANAGE_EXTERNAL_STORAGE",
  "READ_MEDIA_IMAGES",
  "READ_MEDIA_VIDEO",
  "READ_MEDIA_AUDIO",
  "READ_MEDIA_VISUAL_USER_SELECTED",
  "POST_NOTIFICATIONS",
  "BLUETOOTH_SCAN",
  "BLUETOOTH_CONNECT",
  "BLUETOOTH_ADVERTISE",
  "NEARBY_WIFI_DEVICES",
  "ACCESS_MEDIA_LOCATION",
  "SYSTEM_ALERT_WINDOW",
  "QUERY_ALL_PACKAGES"
]);

/**
 * Permisos peligrosos admitidos. Cada uno se justifica aquí, no en el
 * manifiesto, para que quitarlos o añadir otros exija revisar este archivo.
 */
const ALLOWED_DANGEROUS = {
  CAMERA: "escáner QR del POS (getUserMedia); opcional, la app funciona sin cámara",
  POST_NOTIFICATIONS: "avisos locales de la app en Android 13+",
  // Impresión térmica (PalmyraPrinterBridge): caducan con el maxSdkVersion del
  // manifiesto; en API 31+ Bluetooth se gobierna por BLUETOOTH_CONNECT/SCAN.
  ACCESS_FINE_LOCATION: "requisito del escaneo Bluetooth en Android <=11; neverForLocation, nunca se geolocaliza",
  BLUETOOTH_CONNECT: "conectar con la impresora térmica vinculada del POS (Android 12+)",
  BLUETOOTH_SCAN: "buscar la impresora térmica cercana (Android 12+, neverForLocation)"
};

/**
 * Permisos de protección normal ya usados por el shell. Cualquier otro fuera de
 * DANGEROUS_PERMISSIONS + este conjunto se reporta como no revisado (y falla).
 */
const ALLOWED_NORMAL = {
  INTERNET: "sincronización HTTPS y servidor local de la WebView",
  ACCESS_NETWORK_STATE: "detectar red disponible antes de sincronizar",
  REQUEST_INSTALL_PACKAGES: "instalación del APK de actualización ya verificado",
  DOWNLOAD_WITHOUT_NOTIFICATION: "descarga silenciosa del APK de actualización",
  VIBRATE: "aviso de lectura del escáner",
  // Los dos permisos clásicos de Bluetooth cadujan en API 30 (maxSdkVersion del
  // manifiesto); desde Android 12 manda BLUETOOTH_CONNECT/SCAN.
  BLUETOOTH: "hablar RFCOMM/SPP con la impresora térmica del POS (Android <=11)",
  BLUETOOTH_ADMIN: "descubrir y enlazar la impresora térmica (Android <=11)",
  WAKE_LOCK: "mantener viva una importación larga"
};

/** Proveedores admitidos que solo exponen el APK de actualización. */
const ALLOWED_UPDATE_PROVIDERS = [".UpdateApkProvider", "cu.palmyra.app.UpdateApkProvider"];

class Report {
  constructor() {
    this.checks = [];
  }

  pass(section, name, detail) {
    this.checks.push({ ok: true, section, name, detail });
  }

  fail(section, name, detail) {
    this.checks.push({ ok: false, section, name, detail });
  }

  get failures() {
    return this.checks.filter((check) => !check.ok);
  }

  get ok() {
    return this.failures.length === 0;
  }
}

/**
 * Quita comentarios `//` y `/* *\/` de un archivo Groovy respetando las cadenas:
 * los comentarios del gradle documentan el esquema y mencionan `versionCode`,
 * y un regex sobre el texto crudo los confundiría con código real.
 */
function stripComments(source) {
  let out = "";
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out += char;
      if (char === "\\" && quote === '"') {
        out += next ?? "";
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      out += "\n";
      continue;
    }
    out += char;
  }
  return out;
}

/** Atributos `clave="valor"` de una etiqueta XML (prefijo android: incluido). */
function attributes(tagText) {
  const attrs = new Map();
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = re.exec(tagText))) attrs.set(match[1], match[2]);
  return attrs;
}

/** Texto plano de una etiqueta de permiso: `android.permission.CAMERA` -> CAMERA. */
function permissionName(value) {
  if (!value) return null;
  const prefix = "android.permission.";
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Componentes del manifiesto con su cuerpo (para ver intent-filter/meta-data). */
function componentsOf(xml) {
  const found = [];
  const re = /<(activity|activity-alias|service|receiver|provider)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1\s*>)/g;
  let match;
  while ((match = re.exec(xml))) {
    found.push({ kind: match[1], attrs: attributes(match[2]), body: match[4] ?? "" });
  }
  return found;
}

/** Configuración de red normalizada: base-config + domain-configs. */
function parseNetworkConfig(xml) {
  const base = [];
  for (const match of xml.matchAll(/<base-config\b([^>]*?)\/?>/g)) {
    base.push({ cleartext: attributes(match[1]).get("cleartextTrafficPermitted") ?? null });
  }
  const domainConfigs = [];
  for (const match of xml.matchAll(/<domain-config\b([^>]*?)>([\s\S]*?)<\/domain-config>/g)) {
    const attrs = attributes(match[1]);
    const domains = [];
    for (const domain of match[2].matchAll(/<domain\b([^>]*?)>([^<]*)<\/domain>/g)) {
      domains.push({
        host: domain[2].trim(),
        includeSubdomains: attributes(domain[1]).get("includeSubdomains") === "true"
      });
    }
    domainConfigs.push({ cleartext: attrs.get("cleartextTrafficPermitted") ?? null, domains });
  }
  return { base, domainConfigs };
}

/** Busca recursivamente keystores versionados (nunca deben estar en el repo). */
function findKeystores(dir, depth = 0) {
  if (depth > 4) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (entry.name === "build" || entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findKeystores(full, depth + 1));
    } else if (/\.(jks|keystore|p12)$/i.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Inspecciona el paquete Android del repo (o de un fixture).
 *
 * @param {{ root?: string, paths?: Partial<typeof DEFAULT_PATHS> }} [options]
 * @returns {{ ok: boolean, root: string, checks: Array<{ok: boolean, section: string, name: string, detail: string}>, failures: Array<object>, version: string | null, expectedVersionCode: number | null }}
 */
export function inspect(options = {}) {
  const root = resolve(options.root ?? REPO_ROOT);
  const paths = { ...DEFAULT_PATHS, ...(options.paths ?? {}) };
  const report = new Report();

  const read = (key) => {
    const rel = paths[key];
    const abs = join(root, rel);
    try {
      const text = readFileSync(abs, "utf8");
      return { text, rel, abs };
    } catch (error) {
      report.fail("archivo", `${key} no verificable`, `no se pudo leer ${rel} (${error.code ?? error.message})`);
      return null;
    }
  };

  const pkgFile = read("packageJson");
  const gradleFile = read("gradle");
  const manifestFile = read("manifest");
  const networkMainFile = read("networkMain");
  const networkLanFile = read("networkLan");
  const activityFile = read("mainActivity");
  const nativeDbFile = read("nativeDb");
  const printerBridgeFile = read("printerBridge");
  const permissionsFile = read("permissions");
  const alertsFile = read("alerts");

  let version = null;
  let expectedVersionCode = null;
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.text);
      if (typeof pkg.version === "string" && pkg.version.trim()) {
        version = pkg.version.trim();
        const parts = version.split(".");
        if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part))) {
          expectedVersionCode = Number(parts[0]) * 10000 + Number(parts[1]) * 100 + Number(parts[2]);
        } else {
          report.fail("versión", "package.json version", `"${version}" no es major.minor.patch numérico; el versionCode del APK no se puede derivar`);
        }
      } else {
        report.fail("versión", "package.json version", "no verificable: package.json no define una versión de texto");
      }
    } catch (error) {
      report.fail("versión", "package.json", `no verificable: JSON inválido (${error.message})`);
    }
  }

  // El gradle se analiza sin comentarios: allí vive la documentación del
  // esquema y menciona versionCode/storeFile, que no son código.
  const gradleCode = gradleFile ? stripComments(gradleFile.text) : null;
  if (gradleCode && version) checkVersion(report, gradleCode, version, expectedVersionCode);
  if (manifestFile) checkManifest(report, root, paths, manifestFile);
  if (networkMainFile) checkNetworkStandard(report, networkMainFile.text);
  if (networkLanFile && gradleCode) checkNetworkLan(report, networkLanFile.text, gradleCode);
  if (manifestFile && networkMainFile) checkCleartextConsistency(report, manifestFile.text, networkMainFile.text);
  if (gradleCode) checkSigning(report, root, gradleCode);
  if (activityFile) checkBridges(report, activityFile.text);
  if (nativeDbFile) checkNativeDb(report, nativeDbFile.text);
  if (printerBridgeFile) checkPrinterBridge(report, printerBridgeFile.text);
  if (permissionsFile && activityFile) checkPermissionHandoff(report, permissionsFile.text, activityFile.text);
  checkNativeAlerts(report, alertsFile ? alertsFile.text : "", activityFile ? activityFile.text : "");

  return {
    ok: report.ok,
    root,
    checks: report.checks,
    failures: report.failures,
    version,
    expectedVersionCode
  };
}

function checkVersion(report, gradle, version, expectedVersionCode) {
  const declaredName = /versionName\s+([^\s;]+)/.exec(gradle)?.[1] ?? null;
  if (!declaredName) {
    report.fail("versión", "versionName", "no verificable: build.gradle no declara versionName");
  } else if (/^["']/.test(declaredName)) {
    const literal = declaredName.replace(/^["']|["']$/g, "");
    if (literal === version) {
      report.pass("versión", "versionName", `literal "${literal}" == package.json`);
    } else {
      report.fail("versión", "versionName", `"${literal}" != package.json "${version}"; el APK anunciaría otra versión`);
    }
  } else if (/packageJson\.version/.test(gradle) && /file\(\s*['"]\.\.\/\.\.\/package\.json['"]\s*\)/.test(gradle)) {
    report.pass("versión", "versionName", `derivado de package.json (${version})`);
  } else {
    report.fail("versión", "versionName", `no verificable: "${declaredName}" no es literal ni se deriva de package.json`);
  }

  const declaredCode = /versionCode\s+([A-Za-z0-9_.]+)/.exec(gradle)?.[1] ?? null;
  if (!declaredCode) {
    report.fail("versión", "versionCode", "no verificable: build.gradle no declara versionCode");
    return;
  }
  if (expectedVersionCode !== null && expectedVersionCode <= 0) {
    report.fail("versión", "versionCode", `la versión ${version} produce versionCode ${expectedVersionCode}; debe ser mayor que 0`);
    return;
  }
  if (/^\d+$/.test(declaredCode)) {
    const code = Number(declaredCode);
    if (expectedVersionCode === null) {
      report.fail("versión", "versionCode", `no verificable: ${code} sin esquema documentado`);
    } else if (code <= 0) {
      report.fail("versión", "versionCode", `${code} debe ser mayor que 0`);
    } else if (code === expectedVersionCode) {
      report.pass("versión", "versionCode", `${code} == ${version} con esquema major*10000+minor*100+patch`);
    } else {
      report.fail("versión", "versionCode", `${code} != ${expectedVersionCode} esperado para ${version} (major*10000+minor*100+patch)`);
    }
    return;
  }

  // versionCode derivado: el propio gradle documenta el esquema como acumulación
  // x100 sobre los tres componentes (1.3.5 -> ((0*100+1)*100+3)*100+5 = 10305).
  const definition = new RegExp(`(?:def\\s+)?${declaredCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*([^\\n]+)`).exec(gradle)?.[1] ?? "";
  const accumulation = /tokenize\(\s*['"]\.['"]\s*\)/.test(gradle)
    && /inject\(\s*0\s*\)/.test(gradle)
    && /\*\s*100\s*\+/.test(gradle);
  const threeParts = /\\d\+\\\.\\d\+\\\.\\d\+/.test(gradle);
  if (accumulation && threeParts && expectedVersionCode !== null) {
    report.pass(
      "versión",
      "versionCode",
      `derivado (${declaredCode}${definition ? "" : " inline"}) con esquema x100 de 3 componentes => ${expectedVersionCode} para ${version}`
    );
  } else {
    report.fail(
      "versión",
      "versionCode",
      `no verificable: "${declaredCode}" no es numérico ni usa el esquema documentado (acumulación x100 de major.minor.patch con 3 componentes numéricos)`
    );
  }
}

function checkManifest(report, root, paths, manifestFile) {
  const xml = manifestFile.text;
  const appMatch = /<application\b([^>]*)>/.exec(xml);
  if (!appMatch) {
    report.fail("manifiesto", "application", "no verificable: el manifiesto no tiene <application>");
    return;
  }
  const app = attributes(appMatch[1]);

  const allowBackup = app.get("android:allowBackup");
  if (allowBackup === "false") {
    report.pass("manifiesto", "allowBackup", "false");
  } else if (allowBackup === undefined) {
    report.fail("manifiesto", "allowBackup", "no verificable: android:allowBackup ausente (en targetSdk 31+ el valor por defecto puede ser true)");
  } else {
    report.fail("manifiesto", "allowBackup", `debe ser "false" (encontrado "${allowBackup}"): respaldos de ADB/nube copiarían la base y la licencia`);
  }

  const cleartext = app.get("android:usesCleartextTraffic");
  if (cleartext === "false") {
    report.pass("manifiesto", "usesCleartextTraffic", "false");
  } else if (cleartext === undefined) {
    report.fail("manifiesto", "usesCleartextTraffic", 'no verificable: android:usesCleartextTraffic ausente');
  } else {
    report.fail("manifiesto", "usesCleartextTraffic", `debe ser "false" (encontrado "${cleartext}")`);
  }

  const netConfig = app.get("android:networkSecurityConfig");
  if (netConfig === "@xml/network_security_config") {
    report.pass("manifiesto", "networkSecurityConfig", netConfig);
  } else if (netConfig === undefined) {
    report.fail("manifiesto", "networkSecurityConfig", "no verificable: el manifiesto no fija android:networkSecurityConfig");
  } else {
    report.fail("manifiesto", "networkSecurityConfig", `debe ser @xml/network_security_config (encontrado "${netConfig}")`);
  }

  const components = componentsOf(xml);
  if (components.length === 0) {
    report.fail("manifiesto", "componentes", "no verificable: no se encontró ningún componente con android:exported");
  }
  let launcherSeen = false;
  for (const component of components) {
    const name = component.attrs.get("android:name") ?? `(sin nombre ${component.kind})`;
    const exported = component.attrs.get("android:exported");
    const isLauncher = component.kind === "activity" && /android\.intent\.action\.MAIN/.test(component.body);
    if (isLauncher) launcherSeen = true;
    if (exported === undefined) {
      report.fail("manifiesto", `exported de ${name}`, `no verificable: ${component.kind} sin android:exported explícito`);
    } else if (isLauncher && exported !== "true") {
      report.fail("manifiesto", `exported de ${name}`, `la actividad launcher debe declarar android:exported="true" (encontrado "${exported}")`);
    } else if (!isLauncher && exported !== "false") {
      report.fail("manifiesto", `exported de ${name}`, `${component.kind} interno debe declarar android:exported="false" (encontrado "${exported}")`);
    } else {
      report.pass("manifiesto", `exported de ${name}`, `${component.kind} ${exported}`);
    }
  }
  if (!launcherSeen) {
    report.fail("manifiesto", "actividad launcher", "no verificable: no hay activity con MAIN/LAUNCHER");
  }

  for (const provider of components.filter((component) => component.kind === "provider")) {
    checkProvider(report, root, paths, provider);
  }

  checkPermissions(report, xml);
}

function checkProvider(report, root, paths, provider) {
  const name = provider.attrs.get("android:name") ?? "";
  const exported = provider.attrs.get("android:exported");
  if (exported !== "false") {
    report.fail("manifiesto", `proveedor ${name}`, `no verificable: un proveedor debe ser android:exported="false" (encontrado "${exported ?? "(ausente)"}")`);
  }
  if (provider.attrs.get("android:grantUriPermissions") !== "true") {
    report.fail("manifiesto", `proveedor ${name}`, 'no verificable: falta android:grantUriPermissions="true" para ceder el APK al instalador');
  }

  if (/FileProvider/.test(name)) {
    const meta = /<meta-data\b([^>]*?)\/?>/.exec(provider.body);
    const metaAttrs = meta ? attributes(meta[1]) : new Map();
    const resource = metaAttrs.get("android:resource");
    const wanted = metaAttrs.get("android:name");
    if (wanted !== "android.support.FILE_PROVIDER_PATHS" || !resource?.startsWith("@xml/")) {
      report.fail("manifiesto", `FileProvider ${name}`, "no verificable: sin meta-data android.support.FILE_PROVIDER_PATHS hacia un @xml/*");
      return;
    }
    const rel = join("android/app/src/main/res/xml", `${resource.slice("@xml/".length)}.xml`);
    let xml;
    try {
      xml = readFileSync(join(root, rel), "utf8");
    } catch (error) {
      report.fail("manifiesto", `FileProvider ${name}`, `no verificable: no se pudo leer ${rel} (${error.code ?? error.message})`);
      return;
    }
    if (/<(root-path|external-path)\b/.test(xml)) {
      report.fail("manifiesto", `FileProvider ${name}`, `rutas genéricas (root-path/external-path) en ${rel}: el proveedor daría acceso a todo el almacenamiento`);
      return;
    }
    const pathValues = [...xml.matchAll(/<[\w-]*path\b[^>]*?android:path="([^"]*)"[^>]*?\/?>/g)].map((match) => match[1]);
    if (pathValues.length === 0) {
      report.fail("manifiesto", `FileProvider ${name}`, `no verificable: ${rel} no declara ninguna ruta`);
      return;
    }
    const generic = pathValues.filter((value) => value === "/" || value === "" || !/apk/i.test(value));
    if (generic.length > 0) {
      report.fail("manifiesto", `FileProvider ${name}`, `solo debe exponer APKs; rutas no-APK en ${rel}: ${generic.map((value) => `"${value}"`).join(", ")}`);
      return;
    }
    report.pass("manifiesto", `FileProvider ${name}`, `solo rutas de APK (${pathValues.join(", ")})`);
    return;
  }

  if (ALLOWED_UPDATE_PROVIDERS.includes(name)) {
    const authority = provider.attrs.get("android:authorities") ?? "";
    if (!/\.updates$/.test(authority)) {
      report.fail("manifiesto", `proveedor ${name}`, `authority "${authority}" debería terminar en .updates (solo APKs de actualización)`);
    } else {
      report.pass("manifiesto", `proveedor ${name}`, `solo APKs de actualización (authority ${authority})`);
    }
    let javaText;
    try {
      javaText = readFileSync(join(root, paths.updateProvider), "utf8");
    } catch (error) {
      report.fail("manifiesto", `proveedor ${name}`, `no verificable: no se pudo leer ${paths.updateProvider} (${error.code ?? error.message})`);
      return;
    }
    const dirOk = /"apk-updates"/.test(javaText);
    const mimeOk = /application\/vnd\.android\.package-archive/.test(javaText);
    if (dirOk && mimeOk && !/getExternalFilesDir|Environment\.getExternalStorageDirectory/.test(javaText)) {
      report.pass("manifiesto", `proveedor ${name}`, "sirve solo cache/apk-updates con MIME de APK");
    } else {
      report.fail("manifiesto", `proveedor ${name}`, "el proveedor no se limita a cache/apk-updates con MIME de APK");
    }
    return;
  }

  report.fail("manifiesto", `proveedor ${name}`, `proveedor no revisado: solo se admiten FileProvider restringido o ${ALLOWED_UPDATE_PROVIDERS[0]}`);
}

function checkPermissions(report, xml) {
  const declared = [...xml.matchAll(/<uses-permission\b([^>]*?)\/?>/g)].map((match) => attributes(match[1]));
  if (declared.length === 0) {
    report.fail("permisos", "uses-permission", "no verificable: no se declaró ningún permiso");
    return;
  }
  for (const attrs of declared) {
    const name = permissionName(attrs.get("android:name"));
    if (!name) {
      report.fail("permisos", "uses-permission", "no verificable: permiso sin android:name");
      continue;
    }
    const maxSdk = attrs.get("android:maxSdkVersion");
    if (DANGEROUS_PERMISSIONS.has(name)) {
      if (name === "WRITE_EXTERNAL_STORAGE") {
        const limit = maxSdk === undefined ? Infinity : Number(maxSdk);
        if (!Number.isFinite(limit)) {
          report.fail("permisos", name, `android:maxSdkVersion no verificable ("${maxSdk}")`);
        } else if (limit > 28) {
          report.fail("permisos", name, `maxSdkVersion=${maxSdk}: debe ser <=28 (en API 29+ se escribe con MediaStore)`);
        } else {
          report.pass("permisos", name, `permitido solo hasta API ${maxSdk} (respaldos en Descargas)`);
        }
        continue;
      }
      const reason = ALLOWED_DANGEROUS[name];
      if (reason) {
        report.pass("permisos", name, `peligroso justificado: ${reason}`);
      } else {
        report.fail("permisos", name, "permiso peligroso no justificado: retíralo o añádelo a ALLOWED_DANGEROUS con su motivo");
      }
      continue;
    }
    const normalReason = ALLOWED_NORMAL[name];
    if (normalReason) {
      report.pass("permisos", name, `normal: ${normalReason}`);
    } else {
      report.fail("permisos", name, "permiso no revisado: añádelo a ALLOWED_NORMAL con su motivo o retíralo");
    }
  }
}

function checkNetworkStandard(report, xml) {
  const { base, domainConfigs } = parseNetworkConfig(xml);
  if (base.length === 0) {
    report.fail("red", "base-config estándar", "no verificable: el config estándar no declara <base-config>");
  } else if (base.some((entry) => entry.cleartext === "true")) {
    report.fail("red", "base-config estándar", 'cleartextTrafficPermitted="true" en el APK publicado: todo el tráfico externo iría en claro');
  } else if (base.some((entry) => entry.cleartext !== "false")) {
    report.fail("red", "base-config estándar", 'no verificable: falta cleartextTrafficPermitted="false"');
  } else {
    report.pass("red", "base-config estándar", "cleartext prohibido por defecto");
  }

  const permitTrue = domainConfigs.filter((entry) => entry.cleartext === "true");
  if (permitTrue.length === 0) {
    report.fail("red", "excepción local", "no verificable: sin excepción para el servidor local la WebView no cargaría la app");
  }
  for (const entry of permitTrue) {
    if (entry.domains.length === 0) {
      report.fail("red", "domain-config en claro", 'no verificable: domain-config con cleartext="true" sin <domain>');
      continue;
    }
    for (const domain of entry.domains) {
      const host = domain.host.toLowerCase();
      if (!LOCAL_HOSTS.has(host)) {
        report.fail("red", `cleartext de ${domain.host}`, `dominio público en claro: solo 127.0.0.1/localhost/::1 pueden usar HTTP (includeSubdomains=${domain.includeSubdomains})`);
      } else {
        report.pass("red", `cleartext de ${domain.host}`, "host local del servidor de la WebView");
      }
    }
  }
}

function checkNetworkLan(report, xml, gradle) {
  const { base, domainConfigs } = parseNetworkConfig(xml);
  if (base.length === 0) {
    report.fail("red", "res-lan base-config", "no verificable: el overlay LAN no declara <base-config>");
  } else if (base.every((entry) => entry.cleartext === "true")) {
    report.pass("red", "res-lan base-config", "cleartext para el hub HTTP de la red privada (sabor lan, no publicado)");
  } else if (base.some((entry) => entry.cleartext === "false")) {
    report.fail("red", "res-lan base-config", "el sabor lan no podría hablar con el hub HTTP de la sucursal");
  } else {
    report.fail("red", "res-lan base-config", "no verificable: falta cleartextTrafficPermitted");
  }

  for (const entry of domainConfigs) {
    for (const domain of entry.domains) {
      if (!LOCAL_HOSTS.has(domain.host.toLowerCase())) {
        report.fail("red", `res-lan dominio ${domain.host}`, "el overlay LAN no debe listar dominios públicos; el hub se alcanza por IP privada");
      }
    }
  }
  if (!domainConfigs.some((entry) => entry.domains.length > 0)) {
    report.pass("red", "res-lan dominios", "sin dominios públicos (solo IP privada del hub)");
  }

  const isolatedSource = /lan\s*\{[^}]*res\.srcDirs\s*=\s*\[[^\]]*res-lan[^\]]*\]/s.test(gradle.replace(/\n/g, " "));
  if (!isolatedSource) {
    report.fail("red", "aislamiento del overlay LAN", "no verificable: build.gradle no asigna res-lan solo al sabor lan");
  } else {
    report.pass("red", "aislamiento del overlay LAN", "res-lan solo entra en el sabor lan");
  }

  if (/PALMYRA-Android-LAN\.apk/.test(gradle) && /PALMYRA-Android\.apk/.test(gradle)) {
    report.pass("red", "nombre del APK LAN", "el sabor lan se emite como PALMYRA-Android-LAN.apk (rechazado al publicar)");
  } else {
    report.fail("red", "nombre del APK LAN", "no verificable: el sabor lan debe salir como PALMYRA-Android-LAN.apk para no confundirse con el estándar");
  }
}

function checkCleartextConsistency(report, manifestXml, networkMainXml) {
  const app = attributes(/<application\b([^>]*)>/.exec(manifestXml)?.[1] ?? "");
  const manifestValue = app.get("android:usesCleartextTraffic");
  const base = parseNetworkConfig(networkMainXml).base;
  const configValue = base[0]?.cleartext ?? null;
  if (manifestValue === null || configValue === null) {
    report.fail("red", "coherencia usesCleartextTraffic/config", "no verificable: falta el atributo del manifiesto o la base-config");
    return;
  }
  if (manifestValue !== configValue) {
    report.fail(
      "red",
      "coherencia usesCleartextTraffic/config",
      `se contradicen: manifiesto="${manifestValue}" y base-config="${configValue}" (desde API 24 manda el config, así que el manifiesto mentiría)`
    );
    return;
  }
  report.pass("red", "coherencia usesCleartextTraffic/config", `ambos "${manifestValue}"`);
}

function checkSigning(report, root, gradle) {
  // Un literal en la asignación directa o en la variable intermedia
  // (`def keystorePassword = 'x'`) equivale a versionar la credencial.
  const literal = /(storePassword|keyPassword|keyAlias|storeFile)\s+(["'])/.exec(gradle)
    ?? /def\s+(keystorePassword|keyPassword|keystorePath|keyAlias)\s*=\s*["']/.exec(gradle);
  if (literal) {
    report.fail("firma", `literal en ${literal[1]}`, "la firma de release debe leer keystore/alias/contraseñas de variables de entorno, no de valores versionados");
  } else {
    report.pass("firma", "sin literales", "ninguna credencial de firma escrita en build.gradle");
  }

  const fallbackLiteral = /System\.getenv\([^)]*\)\s*\?:\s*["']/.test(gradle);
  if (fallbackLiteral) {
    report.fail("firma", "fallback literal", 'un getenv con valor por defecto en texto plano anularía el secreto (usa "?: null")');
  } else {
    report.pass("firma", "fallback literal", "sin valores por defecto en texto plano");
  }

  const requiredEnv = ["ANDROID_KEYSTORE_PATH", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS"];
  // Se admite la lectura directa (System.getenv) o mediante un helper del
  // propio gradle (envTrim), pero nunca un valor literal.
  const missingEnv = requiredEnv.filter((name) => !new RegExp(`(?:getenv|envTrim)\\(\\s*['"]${name}['"]\\s*\\)`).test(gradle));
  if (missingEnv.length > 0) {
    report.fail("firma", "variables de entorno", `no verificable: build.gradle no lee ${missingEnv.join(", ")}`);
  } else {
    report.pass("firma", "variables de entorno", "keystore, contraseña y alias desde ANDROID_KEYSTORE_*");
  }

  const guardedRelease = /if\s*\(\s*hasReleaseKeystore\s*\)/.test(gradle) && /signingConfigs\.release/.test(gradle);
  if (!guardedRelease) {
    report.fail("firma", "signingConfigs.release", "no verificable: el bloque release debe existir solo con credenciales completas (hasReleaseKeystore)");
  } else {
    report.pass("firma", "signingConfigs.release", "solo se define con keystore y credenciales completas");
  }

  const buildTypesAt = gradle.search(/buildTypes\s*\{/);
  const signingLine = buildTypesAt >= 0
    ? /signingConfig\s+([^\n]+)/.exec(gradle.slice(buildTypesAt))?.[1]?.trim() ?? null
    : null;
  if (!signingLine) {
    report.fail("firma", "signingConfig de release", "no verificable: buildTypes.release no declara signingConfig");
  } else if (/signingConfigs\.debug$/.test(signingLine)) {
    report.pass("firma", "signingConfig de release", "clave de depuración explícita (APK instalable, no publicable)");
  } else if (/signingConfigs\.release/.test(signingLine) && /hasReleaseKeystore/.test(signingLine)) {
    report.pass("firma", "signingConfig de release", "signingConfigs.release solo con credenciales, si no debug");
  } else if (/signingConfigs\.release/.test(signingLine)) {
    report.fail("firma", "signingConfig de release", "usa signingConfigs.release sin comprobar hasReleaseKeystore: un release quedaría sin firma válida");
  } else {
    report.fail("firma", "signingConfig de release", `no verificable: "${signingLine}"`);
  }

  const keystores = findKeystores(join(root, "android"));
  if (keystores.length > 0) {
    report.fail("firma", "keystore versionado", `hay almacenes de claves dentro del repo: ${keystores.map((file) => file.slice(root.length + 1)).join(", ")}`);
  } else {
    report.pass("firma", "keystore versionado", "ningún .jks/.keystore/.p12 en android/");
  }
}

function checkBridges(report, activityText) {
  for (const bridge of BRIDGES) {
    const registered = new RegExp(`addJavascriptInterface\\s*\\([\\s\\S]{0,200}?"${bridge}"\\s*\\)`).test(activityText);
    if (registered) {
      report.pass("puentes", bridge, "registrado en addJavascriptInterface");
    } else {
      report.fail("puentes", bridge, `no verificable: MainActivity no registra ${bridge}; el POS perdería ese puente`);
    }
  }
}

function checkNativeDb(report, text) {
  const methods = [
    { name: "integrity", re: /public\s+(?:synchronized\s+)?[\w<>\[\],\s]+\s+integrity\s*\(/ },
    { name: "checkpoint", re: /public\s+(?:synchronized\s+)?[\w<>\[\],\s]+\s+checkpoint\s*\(/ }
  ];
  for (const method of methods) {
    if (method.re.test(text)) {
      report.pass("puentes", `NativeDb.${method.name}`, "expuesto como método público");
    } else {
      report.fail("puentes", `NativeDb.${method.name}`, `no verificable: NativeDb no expone ${method.name}() público`);
    }
  }
}

/**
 * Puente de impresión térmica. `src/lib/escpos.ts` llama a estos seis métodos por
 * su nombre: si uno desaparece, el POS deja de imprimir sin que nada falle al
 * compilar (el puente es reflection-free desde la web).
 */
function checkPrinterBridge(report, text) {
  const methods = ["available", "requestPermissions", "permissionStatus", "listDevices", "printRawBase64", "close"];
  for (const name of methods) {
    const exposed = new RegExp(`@JavascriptInterface\\s+public\\s+String\\s+${name}\\s*\\(`).test(text);
    if (exposed) {
      report.pass("puentes", `PALMYRA_PRINTER.${name}`, "expuesto con @JavascriptInterface");
    } else {
      report.fail("puentes", `PALMYRA_PRINTER.${name}`, `no verificable: PalmyraPrinterBridge no expone ${name}() anotado; escpos.ts lo necesita`);
    }
  }

  // El permiso USB del sistema es lo que convierte "usb_denied" en una impresora
  // utilizable: sin PendingIntent, UsbManager.hasPermission() nunca pasa a true.
  if (/requestUsbPermission\s*\(/.test(text) && /ACTION_USB_PERMISSION/.test(text) && /usb_permission_pending/.test(text)) {
    report.pass("puentes", "PALMYRA_PRINTER.USB", "pide el permiso USB del sistema y avisa de que queda pendiente");
  } else {
    report.fail("puentes", "PALMYRA_PRINTER.USB", "no verificable: el puente no pide el permiso USB (UsbManager.requestPermission) o no devuelve usb_permission_pending");
  }
}

/**
 * Ida y vuelta de permisos: el diálogo de Android solo se puede abrir desde el
 * hilo de UI y el resultado vuelve a la web por un push, porque el hilo del
 * puente bloquearía el `requestPermissions` si esperara el resultado.
 */
function checkPermissionHandoff(report, permissionsText, activityText) {
  if (/public\s+static\s+final\s+int\s+REQUEST_CODE/.test(permissionsText)) {
    report.pass("permisos", "REQUEST_CODE", "PalmyraPermissions define el código de la solicitud");
  } else {
    report.fail("permisos", "REQUEST_CODE", "no verificable: PalmyraPermissions no declara REQUEST_CODE público");
  }

  if (/runOnUiThread\s*\([\s\S]{0,200}?requestPermissions\s*\(/.test(permissionsText)) {
    report.pass("permisos", "Hilo de UI", "el diálogo se abre con runOnUiThread (el puente corre en el hilo JavaBridge)");
  } else {
    report.fail("permisos", "Hilo de UI", "no verificable: requestPermissions no se publica en el hilo de UI; Android lanzaría CalledFromWrongThreadException");
  }

  if (/notificationsGranted/.test(permissionsText) && /bluetoothGranted/.test(permissionsText)) {
    report.pass("permisos", "Estado consultable", "notificaciones y Bluetooth exponen su estado real al shell web");
  } else {
    report.fail("permisos", "Estado consultable", "no verificable: faltan notificationsGranted()/bluetoothGranted(); el aviso de permisos no puede saber si ya fueron concedidos");
  }

  if (/window\.__palmyraHardwarePermissions/.test(activityText) && /dispatchHardwarePermissions/.test(activityText)) {
    report.pass("permisos", "Devolver el resultado", "onRequestPermissionsResult empuja el resultado a window.__palmyraHardwarePermissions");
  } else {
    report.fail("permisos", "Devolver el resultado", "no verificable: MainActivity no devuelve el resultado del diálogo a la web (queda pendiente para siempre)");
  }

  if (/requestCode\s*==\s*PalmyraPermissions\.REQUEST_CODE/.test(activityText)) {
    report.pass("permisos", "Código gestionado", "MainActivity reconoce el REQUEST_CODE del shell");
  } else {
    report.fail("permisos", "Código gestionado", "no verificable: onRequestPermissionsResult no comprueba PalmyraPermissions.REQUEST_CODE");
  }
}

/**
 * Avisos del sistema (bandeja de Android). La WebView no implementa la API Web de
 * notificaciones —`Notification.permission` queda en "denied" para siempre—, así
 * que `src/lib/osAlert.ts` solo puede publicar a través de este puente. Si falta,
 * el permiso que se pide al entrar no sirve para nada.
 */
function checkNativeAlerts(report, notificationsText, activityText) {
  if (!notificationsText) {
    report.fail("puentes", "PALMYRA_NATIVE.showNotification", "no verificable: falta PalmyraNotifications.java; el APK no puede publicar avisos del sistema");
    return;
  }

  if (/@JavascriptInterface\s+public\s+String\s+showNotification\s*\(/.test(activityText)) {
    report.pass("puentes", "PALMYRA_NATIVE.showNotification", "expuesto con @JavascriptInterface para osAlert.ts");
  } else {
    report.fail("puentes", "PALMYRA_NATIVE.showNotification", "no verificable: MainActivity no expone showNotification(); los avisos locales se quedan en la campana");
  }

  if (/PalmyraNotifications\.show\s*\(/.test(activityText)) {
    report.pass("puentes", "Delegación del aviso", "el puente delega en PalmyraNotifications en vez de improvisar");
  } else {
    report.fail("puentes", "Delegación del aviso", "no verificable: el puente no llama a PalmyraNotifications.show()");
  }

  if (/CHANNEL_ID\s*=\s*"palmyra-avisos"/.test(notificationsText) && /createNotificationChannel/.test(notificationsText)) {
    report.pass("puentes", "Canal de avisos", "PalmyraNotifications crea el canal palmyra-avisos (Android 8+ descarta avisos sin canal)");
  } else {
    report.fail("puentes", "Canal de avisos", "no verificable: sin NotificationChannel los avisos nunca aparecen en Android 8+");
  }

  if (/ensureChannel\s*\(/.test(notificationsText) && /new\s+Notification\.Builder\s*\(\s*activity\s*,\s*CHANNEL_ID\s*\)/.test(notificationsText)) {
    report.pass("puentes", "Canal antes del aviso", "el canal se garantiza antes de construir la notificación");
  } else {
    report.fail("puentes", "Canal antes del aviso", "no verificable: se construye el aviso sin asegurar el canal primero (el sistema lo descarta en silencio)");
  }

  if (/notificationsGranted/.test(notificationsText)) {
    report.pass("puentes", "Respeto del permiso", "el aviso consulta POST_NOTIFICATIONS y devuelve permission_denied en vez de abrir el diálogo");
  } else {
    report.fail("puentes", "Respeto del permiso", "no verificable: el aviso ignora el permiso de notificaciones concedido al entrar");
  }

  if (/FLAG_IMMUTABLE/.test(notificationsText) && /PendingIntent\.getActivity/.test(notificationsText)) {
    report.pass("puentes", "Apertura al tocar", "el PendingIntent es inmutable y abre la app (Android 12+ exige FLAG_IMMUTABLE)");
  } else {
    report.fail("puentes", "Apertura al tocar", "no verificable: el PendingIntent del aviso no es inmutable; Android 12+ rechazaría el aviso");
  }
}

/** Imprime el informe y devuelve el resultado (mismo objeto que `inspect`). */
export function report(result, { log = console.log } = {}) {
  log(`PALMYRA · empaquetado Android — ${result.root}`);
  let section = null;
  for (const check of result.checks) {
    if (check.section !== section) {
      section = check.section;
      log("");
      log(`[${section}]`);
    }
    log(`${check.ok ? "OK   " : "FALLO"}  ${check.name}: ${check.detail}`);
  }
  const passed = result.checks.length - result.failures.length;
  log("");
  log(`Resumen: ${passed} OK, ${result.failures.length} fallo(s) de ${result.checks.length} comprobaciones.`);
  if (!result.ok) {
    log("CHECK ANDROID: FALLO");
    for (const failure of result.failures) log(`  - ${failure.name}: ${failure.detail}`);
  } else {
    log("CHECK ANDROID: OK");
  }
  return result;
}

/** Resultado sin comprobaciones para los errores de argumentos de `main`. */
const emptyResult = (root, ok, failure) => ({ ok, root, checks: [], failures: failure ? [failure] : [], version: null, expectedVersionCode: null });

/**
 * Punto de entrada: `node scripts/check-android-package.mjs [--root <dir>]`.
 * Devuelve el resultado de `inspect` (no lanza) y fija exit code 1 si falla.
 */
export function main(argv = process.argv.slice(2), options = {}) {
  const { log = console.log, ...inspectOptions } = options;
  let root = REPO_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) {
        console.error("--root necesita un directorio");
        process.exitCode = 1;
        return emptyResult(root, false, { name: "--root", detail: "falta el directorio" });
      }
      root = resolve(value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Uso: node scripts/check-android-package.mjs [--root <directorio>]");
      return emptyResult(root, true);
    } else {
      console.error(`Argumento no reconocido: ${arg}`);
      process.exitCode = 2;
      return emptyResult(root, false, { name: arg, detail: "argumento no reconocido" });
    }
  }
  const result = report(inspect({ ...inspectOptions, root }), { log });
  if (!result.ok) process.exitCode = 1;
  return result;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main();
}
