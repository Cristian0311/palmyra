import test from "node:test";
import assert from "node:assert/strict";

/**
 * Gates de hardware sin DOM ni impresora: se prueba la lógica pura que decide
 * por dónde imprime el POS, cómo se traduce un fallo de push y cuándo debe
 * ofrecerse el permiso de notificaciones al entrar.
 */

const {
  resolvePrinterRoute,
  printerRouteMessage,
  BLUETOOTH_RFCOMM_CHUNK_BYTES,
  BLUETOOTH_RFCOMM_PAUSE_MS
} = await import("../../src/lib/escpos.ts");

const { describePushFailure, pushFailureMessage } = await import("../../src/lib/nativeApp.ts");

const promptModule = await import("../../src/components/NotificationsPermissionPrompt.tsx");
const {
  shouldShowNotificationsPrompt,
  NOTIFICATIONS_PROMPT_DISMISS_KEY,
  NOTIFICATIONS_PROMPT_ASKED_KEY,
  NOTIFICATIONS_PROMPT_FIRST_RUN_KEY,
  NOTIFICATIONS_PROMPT_OFFER_DAYS
} = promptModule;

const DAY_MS = 24 * 60 * 60 * 1000;
const freshInstall = 2 * DAY_MS;

/* ------------------------------------------------------------------ */
/* Ruta de impresión por capacidad y superficie                         */
/* ------------------------------------------------------------------ */

test("el puente nativo manda sobre Web Bluetooth dentro del APK", () => {
  const decision = resolvePrinterRoute(
    { bluetoothSupported: true, serialSupported: false, nativePrinterBridge: true },
    true,
    "android-app"
  );
  assert.equal(decision.route, "native-android");
  assert.equal(decision.blockReason, null);
  assert.deepEqual(decision.alternatives, ["web-bluetooth"]);
});

test("sin puente nativo, el APK cae en impresión del sistema con causa clara", () => {
  const decision = resolvePrinterRoute(
    { bluetoothSupported: false, serialSupported: false },
    false,
    "android-app"
  );
  assert.equal(decision.route, "system-print");
  assert.equal(decision.blockReason, "webview-no-web-hardware");
  // Nunca un callejón sin salida: siempre hay pasos accionables.
  assert.ok(decision.guidance.length >= 2);
  assert.match(decision.guidance.join(" "), /impresión directa del APK|Bluetooth|USB/i);
  assert.doesNotMatch(decision.headline, /^Web Bluetooth no está disponible/);
});

test("en escritorio la vía preferida es Web Bluetooth y queda el cable como alternativa", () => {
  const decision = resolvePrinterRoute(
    { bluetoothSupported: true, serialSupported: true },
    false,
    "desktop"
  );
  assert.equal(decision.route, "web-bluetooth");
  assert.deepEqual(decision.alternatives, ["web-serial"]);
  assert.equal(decision.blockReason, null);
});

test("solo serie disponible dirige al cable USB", () => {
  const decision = resolvePrinterRoute(
    { bluetoothSupported: false, serialSupported: true },
    false,
    "pwa"
  );
  assert.equal(decision.route, "web-serial");
  assert.deepEqual(decision.alternatives, []);
});

test("una vista embebida no ofrece APIs de hardware y explica el motivo", () => {
  const decision = resolvePrinterRoute(
    { bluetoothSupported: true, serialSupported: true, inIframe: true },
    false,
    "web-tab"
  );
  assert.equal(decision.route, "system-print");
  assert.equal(decision.blockReason, "inside-iframe");
  assert.match(decision.headline, /vista embebida/i);
});

test("navegador sin APIs térmicas guía a Chrome/Edge o a imprimir del sistema", () => {
  const decision = resolvePrinterRoute(
    { bluetoothSupported: false, serialSupported: false },
    false,
    "web-tab"
  );
  assert.equal(decision.route, "system-print");
  assert.equal(decision.blockReason, "no-print-api");
  assert.match(decision.guidance.join(" "), /Chrome|Edge|Imprimir del sistema/);
});

test("printerRouteMessage arma un aviso de una línea", () => {
  const decision = resolvePrinterRoute({ bluetoothSupported: false, serialSupported: false }, false, "android-app");
  const message = printerRouteMessage(decision);
  assert.ok(message.startsWith(decision.headline));
  assert.ok(message.includes(decision.guidance[0]));
});

test("los trozos de escritura nativa coinciden con los de BLE", () => {
  // El mismo tamaño de chunk es lo que reutiliza PalmyraPrinterBridge.java.
  assert.equal(BLUETOOTH_RFCOMM_CHUNK_BYTES, 180);
  assert.equal(BLUETOOTH_RFCOMM_PAUSE_MS, 15);
});

/* ------------------------------------------------------------------ */
/* Causas del fallo de push                                             */
/* ------------------------------------------------------------------ */

const supported = {
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotificationApi: true,
  secureContext: true,
  insideIframe: false,
  vapidKey: "BmPublicVapidKey",
  permission: "granted" as const,
  online: true
};

test("falta de service worker se nombra sola", () => {
  const info = describePushFailure({ ...supported, hasServiceWorker: false });
  assert.equal(info.cause, "no_service_worker");
  assert.match(info.headline, /no terminó de instalarse/i);
});

test("sin API de push (Electron/WebView) se explica la superficie", () => {
  const info = describePushFailure({ ...supported, hasPushManager: false });
  assert.equal(info.cause, "no_push_api");
  assert.match(info.headline, /no admite notificaciones push/i);
});

test("clave VAPID ausente apunta al despliegue, no al usuario", () => {
  const info = describePushFailure({ ...supported, vapidKey: "" });
  assert.equal(info.cause, "missing_vapid_key");
  assert.match(info.headline, /todavía no puede enviar avisos/i);
});

test("permiso denegado dice dónde desbloquearlo", () => {
  const info = describePushFailure({ ...supported, permission: "denied" });
  assert.equal(info.cause, "permission_denied");
  assert.match(info.headline, /bloqueó los avisos/i);
  assert.match(info.detail, /Ajustes|candado/i);
});

test("rechazar el diálogo no se informa como error", () => {
  const info = describePushFailure({ ...supported, permission: "default" });
  assert.equal(info.cause, "permission_dismissed");
  assert.match(info.headline, /sin responder/i);
});

test("contexto no seguro y marco embebido tienen causas propias", () => {
  assert.equal(describePushFailure({ ...supported, secureContext: false }).cause, "insecure_context");
  assert.equal(describePushFailure({ ...supported, insideIframe: true }).cause, "iframe_context");
});

test("suscripción caducada pide volver a registrar el equipo", () => {
  const info = describePushFailure({ ...supported, message: "push subscription expired HTTP 410" });
  assert.equal(info.cause, "subscription_expired");
  assert.match(info.headline, /caducó/i);
});

test("fallo de red del push distingue estar desconectado", () => {
  const offline = describePushFailure({ ...supported, online: false });
  assert.equal(offline.cause, "network");
  const blocked = describePushFailure({ ...supported, message: "NetworkError while fetching" });
  assert.equal(blocked.cause, "network");
});

test("un error del servicio se separa del fallo de red local", () => {
  const info = describePushFailure({ ...supported, message: "Internal Server Error" });
  assert.equal(info.cause, "server_unreachable");
});

test("pushFailureMessage une renglón y cuerpo", () => {
  const info = describePushFailure({ ...supported, hasServiceWorker: false });
  const text = pushFailureMessage(info);
  assert.ok(text.startsWith(info.headline));
  assert.ok(text.includes(info.detail));
  assert.doesNotMatch(info.headline, /serviceWorker|VAPID|NotAllowedError/);
});

test("en el APK se aclara que el aviso del sistema si funciona dentro de la app", () => {
  const info = describePushFailure({
    ...supported,
    hasPushManager: false,
    hasNotificationApi: false,
    androidApp: true
  });
  assert.equal(info.cause, "no_push_api");
  // El dueño lee esto al pulsar "Activar push": no puede sonar a que el APK no
  // avisa nunca, porque desde el shell con PalmyraNotifications si publica.
  assert.match(info.detail, /bandeja de Android/i);
  assert.doesNotMatch(info.detail, /se quedan dentro de PALMYRA/i);
});

test("en PC no se le dice que el programa no puede publicar avisos", () => {
  const info = describePushFailure({ ...supported, hasPushManager: false, desktopApp: true });
  const text = `${info.headline} ${info.detail}`;
  assert.doesNotMatch(text, /solo deja publicar avisos a navegadores/i);
  assert.match(text, /bandeja de Windows/i);
  // Sin servicio de push no hay forma de que el navegador mande el permiso: el
  // texto debe dirigir al aviso de entrada del programa, no a un candado inexistente.
  assert.match(info.detail, /aviso de permisos que PALMYRA muestra al entrar/i);
  assert.doesNotMatch(info.detail, /candado de la barra de direcciones/i);
});

/* ------------------------------------------------------------------ */
/* Aviso de permiso de notificaciones                                   */
/* ------------------------------------------------------------------ */

const baseFacts = {
  permission: "default" as NotificationPermission,
  dismissed: false,
  alreadyAsked: false,
  installedMsAgo: freshInstall,
  isAndroidApp: false
};

test("las claves de localStorage estan versionadas", () => {
  assert.equal(NOTIFICATIONS_PROMPT_DISMISS_KEY, "palmyra.notificationsPrompt.v1");
  assert.equal(NOTIFICATIONS_PROMPT_ASKED_KEY, "palmyra.notificationsPrompt.asked.v1");
  assert.notEqual(NOTIFICATIONS_PROMPT_DISMISS_KEY, NOTIFICATIONS_PROMPT_ASKED_KEY);
});

test("el aviso lee y escribe el mismo sello de primer arranque", () => {
  assert.equal(NOTIFICATIONS_PROMPT_FIRST_RUN_KEY, "palmyra:first-run-ms");
});

test("un equipo recien instalado se ofrece el aviso al entrar", () => {
  // El sello de instalacion se pone al leerlo, asi que la antiguedad maxima es 0:
  // si ese caso se tratara como "desconocido", el programa de PC nunca pediria
  // el permiso y los avisos del sistema quedarian muertos desde el dia uno.
  const decision = shouldShowNotificationsPrompt({ ...baseFacts, installedMsAgo: 0 });
  assert.equal(decision.show, true);
  assert.equal(decision.reason, "default-permission");
});

test("se ofrece cuando el permiso aun esta en default", () => {
  const decision = shouldShowNotificationsPrompt(baseFacts);
  assert.equal(decision.show, true);
  assert.equal(decision.reason, "default-permission");
});

test("no se ofrece si ya esta concedido o denegado", () => {
  assert.equal(shouldShowNotificationsPrompt({ ...baseFacts, permission: "granted" }).show, false);
  assert.equal(shouldShowNotificationsPrompt({ ...baseFacts, permission: "denied" }).reason, "already-denied");
});

test("descartado no vuelve a aparecer", () => {
  const decision = shouldShowNotificationsPrompt({ ...baseFacts, dismissed: true });
  assert.equal(decision.show, false);
  assert.equal(decision.reason, "dismissed");
});

test("en Android el aviso se mantiene aunque no exista Web Push", () => {
  const decision = shouldShowNotificationsPrompt({
    ...baseFacts,
    isAndroidApp: true,
    alreadyAsked: true,
    installedMsAgo: (NOTIFICATIONS_PROMPT_OFFER_DAYS + 90) * DAY_MS
  });
  assert.equal(decision.show, true);
});

test("en web no se persigue al usuario pasado el plazo de ofertas", () => {
  const decision = shouldShowNotificationsPrompt({
    ...baseFacts,
    alreadyAsked: true,
    installedMsAgo: (NOTIFICATIONS_PROMPT_OFFER_DAYS + 1) * DAY_MS
  });
  assert.equal(decision.show, false);
  assert.equal(decision.reason, "asked-too-often");
});

test("sin API de notificaciones no se muestra nada", () => {
  const decision = shouldShowNotificationsPrompt({ ...baseFacts, permission: undefined });
  assert.equal(decision.show, false);
  assert.equal(decision.reason, "no-notification-api");
});
