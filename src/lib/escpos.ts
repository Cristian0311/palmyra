import { isDesktopRuntime } from './desktopRuntime';
import {
  getNativePrinterBridge,
  printViaNativePrinter,
  type NativePrinterEnvelope
} from './nativeApp';
import { currentAppSurface, type AppSurface } from './appSurface';

/** Trozo máximo escrito en el canal Bluetooth (misma cifra que el puente Java). */
export const BLUETOOTH_RFCOMM_CHUNK_BYTES = 180;
/** Pausa entre trozos para no desbordar el búfer de la impresora. */
export const BLUETOOTH_RFCOMM_PAUSE_MS = 15;
/** Nombre del puente JavaScript del shell Android (`PALMYRA_PRINTER`). */
export const NATIVE_PRINTER_BRIDGE_KEY = 'PALMYRA_PRINTER';

export const ESCPOS_COMMANDS = {
  INIT: new Uint8Array([0x1b, 0x40]),
  LF: new Uint8Array([0x0a]),
  ALIGN_LEFT: new Uint8Array([0x1b, 0x61, 0x00]),
  ALIGN_CENTER: new Uint8Array([0x1b, 0x61, 0x01]),
  ALIGN_RIGHT: new Uint8Array([0x1b, 0x61, 0x02]),
  BOLD_ON: new Uint8Array([0x1b, 0x45, 0x01]),
  BOLD_OFF: new Uint8Array([0x1b, 0x45, 0x00]),
  TEXT_NORMAL: new Uint8Array([0x1b, 0x21, 0x00]),
  CUT_PARTIAL: new Uint8Array([0x1d, 0x56, 0x01]),
  OPEN_DRAWER: new Uint8Array([0x1b, 0x70, 0x00, 0x19, 0xfa]),
};

let cachedPort: any = null;
let cachedBluetoothDevice: any = null;
let cachedBluetoothCharacteristic: any = null;
let thermalPrintChain: Promise<void> = Promise.resolve();

const THERMAL_PRINTER_SERVICE_UUIDS = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000ae00-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '000018f1-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  '0000af30-0000-1000-8000-00805f9b34fb',
  '0000fee0-0000-1000-8000-00805f9b34fb',
  '0000fe59-0000-1000-8000-00805f9b34fb',
];

const BLUETOOTH_PRINTER_STORAGE_KEY = 'omnisync-pos-thermal-printer';
const AUTO_CONNECT_PRINTER_KEY = 'palmyra:auto-connect-thermal-printer';
/** Última impresora nativa usada por el puente del APK (dirección Bluetooth). */
const NATIVE_PRINTER_ADDRESS_KEY = 'palmyra:native-printer-address';

function normalizeText(text: string): string {
  return (text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function enqueueThermalPrint<T>(job: () => Promise<T>): Promise<T> {
  const run = thermalPrintChain.then(job, job);
  thermalPrintChain = run.then(() => undefined, () => undefined);
  return run;
}

export function isThermalPrinterAutoConnectEnabled(): boolean {
  try { return window.localStorage.getItem(AUTO_CONNECT_PRINTER_KEY) === '1'; } catch { return false; }
}

export function setThermalPrinterAutoConnect(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(AUTO_CONNECT_PRINTER_KEY, '1');
    else window.localStorage.removeItem(AUTO_CONNECT_PRINTER_KEY);
  } catch {}
}

export function isInsideIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function getHardwareCapabilities() {
  const serialSupported = typeof navigator !== 'undefined' && 'serial' in navigator;
  const bluetoothSupported = typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  const inIframe = isInsideIframe();
  return {
    serialSupported,
    bluetoothSupported,
    inIframe,
    // Campos añadidos: el contrato anterior se conserva tal cual.
    // En Electron la ventana expone los puentes de escritorio (preload aislado).
    isDesktop: isDesktopRuntime(),
    // Dentro de un marco las APIs de hardware lanzan SecurityError: cuenta como
    // no disponible aunque el objeto del navegador exista.
    directPrintingSupported: (serialSupported || bluetoothSupported) && !inIframe,
    // Puente nativo de impresión del APK (`PALMYRA_PRINTER`): es la única vía
    // real de imprimir térmico dentro de una WebView.
    nativePrinterBridge: hasNativePrinterBridgeAvailable()
  };
}

/* ------------------------------------------------------------------ */
/* Ruta de impresión por capacidad y superficie (lógica pura)          */
/* ------------------------------------------------------------------ */

/** Capacidades mínimas que necesita la decisión; `getHardwareCapabilities()` las cumple. */
export type PrinterCapabilities = {
  bluetoothSupported: boolean;
  serialSupported: boolean;
  inIframe?: boolean;
  isDesktop?: boolean;
  nativePrinterBridge?: boolean;
};

export type PrinterRoute =
  | 'web-bluetooth'
  | 'web-serial'
  | 'native-android'
  | 'system-print'
  | 'unavailable';

/** Causales que devuelve `resolvePrinterRoute` cuando no hay vía directa. */
export type PrinterBlockReason =
  | 'inside-iframe'
  | 'webview-no-web-hardware'
  | 'no-print-api'
  | null;

export type PrinterRouteDecision = {
  /** Vía recomendada para imprimir ahora. */
  route: PrinterRoute;
  /** Otras vías posibles en esta superficie (p. ej. cable además de BLE). */
  alternatives: PrinterRoute[];
  /** Motivo técnico por el que no hay vía directa (null si la hay). */
  blockReason: PrinterBlockReason;
  /** Primer renglón del aviso: español claro, sin tecnicismos crudos. */
  headline: string;
  /** Cuerpo del aviso: pasos concretos según la superficie. */
  guidance: string[];
};

const ROUTER_HEADLINES: Record<PrinterRoute, string> = {
  'web-bluetooth': 'Impresión Bluetooth BLE disponible',
  'web-serial': 'Impresión por cable USB disponible',
  'native-android': 'Impresión directa del APK disponible',
  'system-print': 'Usa la impresión del sistema',
  unavailable: 'Este equipo todavía no puede imprimir el ticket directamente'
};

/** El puente de impresión del APK está presente (solo dentro del shell). */
export function hasNativePrinterBridgeAvailable(): boolean {
  return getNativePrinterBridge() !== null;
}

/** Superficie actual para la decisión de ruta (dev/escritorio/APK/PWA/web). */
export function currentPrinterSurface(): AppSurface {
  try {
    return currentAppSurface();
  } catch {
    return 'web-tab';
  }
}

/** El POS corre dentro del shell de Android (WebView sin Web Bluetooth/Serial). */
function isAndroidAppSurface(): boolean {
  return currentPrinterSurface() === 'android-app';
}

/**
 * Mensaje para cuando el navegador no expone la API pedida. Sustituye el viejo
 * «no está disponible en este navegador», que dejaba el flujo sin salida: aquí
 * siempre hay un siguiente paso concreto.
 */
function describeMissingWebHardware(label: 'Bluetooth' | 'USB/Serie'): string {
  const decision = resolvePrinterRoute(
    { bluetoothSupported: false, serialSupported: false },
    false,
    currentPrinterSurface()
  );
  const nextStep = decision.guidance[0] || 'Usa Imprimir del sistema para no perder la venta.';
  return `${label} directo no está disponible en esta ventana. ${nextStep}`;
}

export function readRememberedNativePrinterAddress(): string {
  try {
    return window.localStorage.getItem(NATIVE_PRINTER_ADDRESS_KEY) || '';
  } catch {
    return '';
  }
}

export function rememberNativePrinterAddress(address: string): void {
  try {
    const value = String(address || '').trim();
    if (value) window.localStorage.setItem(NATIVE_PRINTER_ADDRESS_KEY, value);
    else window.localStorage.removeItem(NATIVE_PRINTER_ADDRESS_KEY);
  } catch {}
}

function guideFor(surface: AppSurface, blockReason: PrinterBlockReason): string[] {
  if (surface === 'android-app') {
    return [
      blockReason === 'webview-no-web-hardware'
        ? 'La aplicación de Android imprime con su propio Bluetooth o su puerto USB: no depende de Web Bluetooth.'
        : 'La aplicación de Android puede imprimir por Bluetooth o USB nativo.',
      'Toca «Activar permisos de impresión» y acepta Bluetooth y dispositivos cercanos.',
      'Si la impresora va por cable, conectala al adaptador OTG y vuelve a intentar el vínculo.',
      'Con un shell antiguo sin puente de impresión, usa Compartir/Imprimir del sistema o la app del fabricante.'
    ];
  }
  if (surface === 'desktop') {
    return [
      'Activa Bluetooth en Windows (Ajustes › Bluetooth y dispositivos) y vincula la impresora antes de abrir PALMYRA.',
      'Si la impresora va por cable, conectala por USB y elige el vínculo «Cable USB» en esta ventana.',
      'El instalador de escritorio aún no lista puertos Bluetooth: mientras tanto puedes imprimir con Imprimir del sistema.'
    ];
  }
  if (surface === 'pwa') {
    return [
      'Abre PALMYRA en Chrome o Edge de escritorio para usar Bluetooth o el cable USB.',
      'Si tu equipo ya tiene la impresora instalada en el sistema, usa Imprimir del sistema.'
    ];
  }
  return [
    'Usa Chrome o Edge de escritorio: son los navegadores que permiten conectar la impresora.',
    'Activa Bluetooth en el equipo y vincula la impresora antes de conectarla aquí.',
    'Si la impresora está instalada en el sistema, elige Imprimir del sistema para no perder la venta.'
  ];
}

/**
 * Decide por dónde debe imprimir el POS. Es pura y determinista: recibe las
 * capacidades leídas del entorno, si existe el puente nativo y la superficie, y
 * devuelve la vía recomendada más el texto accionable. Nunca deja un callejón
 * «no está disponible» sin guía.
 */
export function resolvePrinterRoute(
  caps: PrinterCapabilities,
  hasNativeBridge: boolean,
  surface: AppSurface
): PrinterRouteDecision {
  const alternatives: PrinterRoute[] = [];
  const withGuidance = (
    route: PrinterRoute,
    blockReason: PrinterBlockReason,
    headline?: string
  ): PrinterRouteDecision => ({
    route,
    alternatives,
    blockReason,
    headline: headline || ROUTER_HEADLINES[route],
    guidance: guideFor(surface, blockReason)
  });

  // 1) Puente nativo del APK: la WebView no expone Web Bluetooth ni Serial, así
  //    que el puente manda sobre cualquier otra vía.
  if (hasNativeBridge || caps.nativePrinterBridge === true) {
    if (caps.bluetoothSupported && !caps.inIframe) alternatives.push('web-bluetooth');
    return withGuidance('native-android', null, ROUTER_HEADLINES['native-android']);
  }

  // 2) APIs web directas (PC/Electron con handler, Chrome/Edge, PWA).
  if (!caps.inIframe) {
    if (caps.bluetoothSupported) {
      if (caps.serialSupported) alternatives.push('web-serial');
      return withGuidance('web-bluetooth', null);
    }
    if (caps.serialSupported) {
      return withGuidance('web-serial', null);
    }
  }

  // 3) Sin vía directa: se explica el motivo y queda la impresión del sistema.
  const insideIframe = caps.inIframe === true;
  const blockReason: PrinterBlockReason = insideIframe
    ? 'inside-iframe'
    : surface === 'android-app'
      ? 'webview-no-web-hardware'
      : 'no-print-api';
  const headline = insideIframe
    ? 'PALMYRA está abierto en una vista embebida'
    : surface === 'android-app'
      ? 'La aplicación de Android no usa Web Bluetooth'
      : undefined;

  return withGuidance('system-print', blockReason, headline);
}

/** Aviso de una sola línea (primer renglón + primer paso) para toasts cortos. */
export function printerRouteMessage(decision: PrinterRouteDecision): string {
  const firstStep = decision.guidance[0] || '';
  return firstStep ? `${decision.headline}: ${firstStep}` : decision.headline;
}

export function format58mmLine(left: string, right: string, maxCols: number = 32): string {
  const cleanLeft = normalizeText(left).trim();
  const cleanRight = normalizeText(right).trim();
  const rightLen = cleanRight.length;
  const maxLeftLen = Math.max(1, maxCols - rightLen - 1);
  const safeLeft = cleanLeft.length > maxLeftLen ? cleanLeft.substring(0, maxLeftLen) : cleanLeft;
  const spacesNeeded = Math.max(1, maxCols - safeLeft.length - rightLen);
  return safeLeft + ' '.repeat(spacesNeeded) + cleanRight;
}

export function encodeEscPosLines(
  textLines: string[],
  openDrawer: boolean = false,
  width: '58mm' | '80mm' = '58mm'
): Uint8Array {
  const cols = width === '58mm' ? 32 : 48;
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const push = (bytes: Uint8Array) => chunks.push(bytes);
  const pushText = (text: string) => chunks.push(encoder.encode(normalizeText(text)));

  push(ESCPOS_COMMANDS.INIT);

  for (const rawLine of textLines) {
    let line = rawLine || '';
    if (line === '---') {
      pushText('-'.repeat(cols));
      push(ESCPOS_COMMANDS.LF);
      continue;
    }
    if (line === '===') {
      pushText('='.repeat(cols));
      push(ESCPOS_COMMANDS.LF);
      continue;
    }

    let bold = false;
    let center = false;
    let right = false;

    if (line.startsWith('CENTER|')) {
      center = true;
      line = line.substring(7);
    } else if (line.startsWith('RIGHT|')) {
      right = true;
      line = line.substring(6);
    }

    if (line.startsWith('BOLD|')) {
      bold = true;
      line = line.substring(5);
    }

    if (center) push(ESCPOS_COMMANDS.ALIGN_CENTER);
    if (right) push(ESCPOS_COMMANDS.ALIGN_RIGHT);
    if (bold) push(ESCPOS_COMMANDS.BOLD_ON);

    pushText(line);
    push(ESCPOS_COMMANDS.LF);

    if (bold) push(ESCPOS_COMMANDS.BOLD_OFF);
    if (center || right) push(ESCPOS_COMMANDS.ALIGN_LEFT);
  }

  push(ESCPOS_COMMANDS.LF);
  push(ESCPOS_COMMANDS.LF);
  push(ESCPOS_COMMANDS.LF);
  push(ESCPOS_COMMANDS.LF);
  push(ESCPOS_COMMANDS.CUT_PARTIAL);

  if (openDrawer) push(ESCPOS_COMMANDS.OPEN_DRAWER);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function connectPrinter() {
  if (cachedPort?.writable) return cachedPort;

  // El APK no expone Web Serial: sin puente nativo no hay cable que abrir, y el
  // mensaje debe decir qué hacer en lugar de dejar un callejón cerrado.
  if (!getNativePrinterBridge() && isAndroidAppSurface()) {
    throw new Error(
      'En la aplicación de Android la impresora se conecta por Bluetooth o con el puente de impresión del APK. Actualiza PALMYRA e ingresa la impresora desde Configuración de impresora.'
    );
  }

  if (isInsideIframe()) {
    throw new Error('Las APIs de hardware directo están restringidas dentro de marcos. Abre la aplicación en una pestaña nueva.');
  }
  if (typeof navigator === 'undefined' || !('serial' in navigator)) {
    throw new Error(describeMissingWebHardware('USB/Serie'));
  }

  try {
    // @ts-ignore
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    cachedPort = port;
    return port;
  } catch (error: any) {
    if (error?.name === 'NotFoundError' || error?.message?.includes('No port selected')) {
      throw new Error('Selección de puerto cancelada.');
    }
    if (error?.name === 'SecurityError') {
      throw new Error('Permiso denegado por el navegador. Abre el sistema en una pestaña directa.');
    }
    throw new Error(error?.message || 'No se pudo conectar con la impresora USB/Serie.');
  }
}

export async function checkPrinterConnection(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serial' in navigator)) return false;
  try {
    // @ts-ignore
    const ports = await navigator.serial.getPorts();
    if (!ports.length) return false;
    if (!cachedPort || !ports.includes(cachedPort)) cachedPort = ports[0];
    if (!cachedPort.writable) {
      try {
        await cachedPort.open({ baudRate: 9600 });
      } catch (error: any) {
        if (!/already open|already opened/i.test(error?.message || '')) {
          cachedPort = null;
          return false;
        }
      }
    }
    return Boolean(cachedPort?.writable);
  } catch {
    return false;
  }
}

async function findBluetoothWritableCharacteristic(server: any): Promise<any | null> {
  for (const serviceUuid of THERMAL_PRINTER_SERVICE_UUIDS) {
    try {
      const service = await server.getPrimaryService(serviceUuid);
      const characteristics = await service.getCharacteristics();
      const writable = characteristics.find((ch: any) => ch?.properties?.writeWithoutResponse || ch?.properties?.write);
      if (writable) return writable;
    } catch {}
  }

  try {
    const services = await server.getPrimaryServices();
    for (const service of services) {
      const characteristics = await service.getCharacteristics();
      const writable = characteristics.find((ch: any) => ch?.properties?.writeWithoutResponse || ch?.properties?.write);
      if (writable) return writable;
    }
  } catch {}

  return null;
}

async function restoreRememberedBluetoothPrinter(): Promise<any | null> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !('bluetooth' in navigator)) return null;
  try {
    const raw = window.localStorage.getItem(BLUETOOTH_PRINTER_STORAGE_KEY);
    if (!raw) return null;
    const remembered = JSON.parse(raw);
    if (!remembered?.id) return null;

    // @ts-ignore
    const devices = await navigator.bluetooth.getDevices();
    const device = devices.find((item: any) => item.id === remembered.id);
    if (!device?.gatt) return null;

    cachedBluetoothDevice = device;
    device.addEventListener?.('gattserverdisconnected', () => {
      cachedBluetoothCharacteristic = null;
    });

    const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
    cachedBluetoothCharacteristic = await findBluetoothWritableCharacteristic(server);
    if (!cachedBluetoothCharacteristic) {
      cachedBluetoothDevice = null;
      return null;
    }
    return device;
  } catch {
    return null;
  }
}

export async function connectBluetoothPrinter() {
  // En el APK la WebView no expone Web Bluetooth: si existe el puente nativo,
  // el vínculo se hace pidiendo los permisos de Android y leyendo el adaptador.
  const nativeBridge = getNativePrinterBridge();
  if (nativeBridge) {
    return connectNativePrinter(nativeBridge);
  }

  if (isInsideIframe()) {
    throw new Error('Las APIs de Bluetooth están restringidas dentro de marcos. Abre la aplicación en una pestaña nueva.');
  }
  if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) {
    throw new Error(describeMissingWebHardware('Bluetooth'));
  }

  try {
    // @ts-ignore
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: THERMAL_PRINTER_SERVICE_UUIDS
    });

    cachedBluetoothDevice = device;
    device.addEventListener?.('gattserverdisconnected', () => {
      cachedBluetoothCharacteristic = null;
    });

    if (!device.gatt) {
      cachedBluetoothDevice = null;
      throw new Error('El dispositivo seleccionado no expone Bluetooth LE GATT.');
    }

    const server = await device.gatt.connect();
    cachedBluetoothCharacteristic = await findBluetoothWritableCharacteristic(server);

    if (!cachedBluetoothCharacteristic) {
      cachedBluetoothDevice = null;
      throw new Error('La impresora Bluetooth no expone un canal GATT de escritura ESC/POS.');
    }

    try {
      window.localStorage.setItem(BLUETOOTH_PRINTER_STORAGE_KEY, JSON.stringify({
        id: device.id,
        name: device.name || 'Impresora Bluetooth'
      }));
    } catch {}

    return device;
  } catch (error: any) {
    if (error?.name === 'NotFoundError' || /cancel/i.test(error?.message || '')) {
      throw new Error('Búsqueda de dispositivo cancelada.');
    }
    if (error?.name === 'SecurityError') {
      throw new Error('Permiso de Bluetooth denegado. Abre la aplicación en una pestaña directa.');
    }
    throw new Error(error?.message || 'No se pudo conectar con la impresora Bluetooth.');
  }
}

export async function checkBluetoothConnection(): Promise<boolean> {
  // En el APK no hay GATT que restaurar: la disponibilidad la da el puente.
  if (cachedNativePrinterAvailable) return true;
  if (cachedBluetoothDevice?.gatt?.connected && cachedBluetoothCharacteristic) return true;
  const restored = await restoreRememberedBluetoothPrinter();
  return Boolean(restored?.gatt?.connected && cachedBluetoothCharacteristic);
}

export async function getConnectedDeviceName(): Promise<string | null> {
  if (cachedNativePrinterName) return cachedNativePrinterName;
  if (await checkBluetoothConnection()) {
    return cachedBluetoothDevice?.name || 'Impresora Bluetooth';
  }
  if (await checkPrinterConnection()) return 'Impresora USB/Serie';
  return null;
}

export async function autoConnectRememberedThermalPrinter(): Promise<string | null> {
  if (!isThermalPrinterAutoConnectEnabled()) return null;
  // El puente nativo recuerda la última dirección: si el adaptador sigue
  // disponible, el POS arranca ya vinculado sin abrir el selector.
  if (getNativePrinterBridge()) {
    const availability = await queryNativeAvailabilitySafe();
    if (availability.ok && readRememberedNativePrinterAddress()) {
      cachedNativePrinterAvailable = true;
      return cachedNativePrinterName || 'Impresora del sistema Android';
    }
    return null;
  }
  if (await checkBluetoothConnection()) return cachedBluetoothDevice?.name || 'Impresora Bluetooth';
  const restored = await restoreRememberedBluetoothPrinter();
  if (restored) return restored.name || 'Impresora Bluetooth';
  if (await checkPrinterConnection()) return 'Impresora USB/Serie';
  return null;
}

export async function isPrinterConnected(): Promise<boolean> {
  if (cachedNativePrinterAvailable) return true;
  if (await checkBluetoothConnection()) return true;
  return checkPrinterConnection();
}

export async function disconnectPrinter() {
  try { await cachedPort?.close?.(); } catch {}
  cachedPort = null;
}

export function disconnectBluetoothPrinter() {
  try { cachedBluetoothDevice?.gatt?.disconnect?.(); } catch {}
  cachedBluetoothDevice = null;
  cachedBluetoothCharacteristic = null;
  cachedNativePrinterAvailable = false;
  cachedNativePrinterName = '';
  try { window.localStorage.removeItem(BLUETOOTH_PRINTER_STORAGE_KEY); } catch {}
}

/** Cierra el canal nativo del APK (RFCOMM/USB) sin borrar la impresora recordada. */
export async function closeNativePrinter(): Promise<void> {
  const bridge = getNativePrinterBridge();
  cachedNativePrinterAvailable = false;
  cachedNativePrinterName = '';
  if (!bridge) return;
  try { await bridge.close(); } catch {}
}

/* ------------------------------------------------------------------ */
/* Impresión por el puente nativo del APK                               */
/* ------------------------------------------------------------------ */

/** Códigos del envelope nativo traducidos a un aviso accionable en español. */
const NATIVE_PRINT_MESSAGES: Record<string, string> = {
  unavailable:
    'Esta versión de la aplicación de Android todavía no incluye la impresión directa. Actualiza PALMYRA desde Configuración › Sistema.',
  no_adapter:
    'El teléfono no tiene Bluetooth o está apagado. Enciéndelo y vuelve a vincular la impresora.',
  permission_denied:
    'Android denegó los permisos de Bluetooth/USB. Acéptalos en Ajustes › Aplicaciones › PALMYRA › Permisos.',
  not_paired:
    'La impresora no está vinculada. Vincúlala primero en Ajustes › Dispositivos conectados y vuelve aquí.',
  connect_failed:
    'No se pudo abrir el canal con la impresora. Apágala y enciéndela, y comprueba que esté cerca del teléfono.',
  write_failed:
    'La impresora rechazó el ticket. Revisa que tenga papel y que no esté ocupada; vuelve a intentarlo.',
  timeout:
    'La impresora tardó demasiado en responder. Acércala al teléfono e inténtalo de nuevo.',
  usb_denied:
    'Android no dio permiso para usar el puerto USB. Reconecta el cable y acepta el aviso de permiso.',
  usb_permission_pending:
    'Acepta el aviso de Android para permitir que PALMYRA use la impresora USB y vuelve a imprimir el ticket.',
  empty_data: 'No hay contenido que imprimir: el ticket quedó vacío.',
  too_large: 'El ticket es demasiado grande para enviarlo directo. Divide el comprobante e inténtalo de nuevo.',
  bad_response: 'El sistema de impresión del teléfono respondió mal. Reinicia la app e inténtalo de nuevo.',
  bridge_error: 'Falló el puente de impresión del APK. Reinicia la app e inténtalo de nuevo.',
  print_failed: 'La impresora no aceptó el ticket. Revisa papel, batería y vínculo Bluetooth.'
};

export function describeNativePrintCode(code?: string): string {
  return NATIVE_PRINT_MESSAGES[code || 'print_failed'] || NATIVE_PRINT_MESSAGES.print_failed;
}

let cachedNativePrinterAvailable = false;
let cachedNativePrinterName = '';

async function queryNativeAvailabilitySafe(): Promise<NativePrinterEnvelope> {
  const bridge = getNativePrinterBridge();
  if (!bridge) return { ok: false, code: 'unavailable' };
  try {
    const raw = await bridge.available();
    return typeof raw === 'string' ? parseNativeEnvelopeText(raw) : { ok: false, code: 'bad_response' };
  } catch {
    return { ok: false, code: 'bridge_error' };
  }
}

function parseNativeEnvelopeText(raw: string): NativePrinterEnvelope {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return { ok: false, code: 'bad_response' };
    if (parsed.ok === true) {
      return {
        ok: true,
        deviceName: typeof parsed.deviceName === 'string' ? parsed.deviceName : undefined,
        bytes: Number.isFinite(Number(parsed.bytes)) ? Number(parsed.bytes) : undefined
      };
    }
    return { ok: false, code: typeof parsed.code === 'string' ? parsed.code : 'print_failed' };
  } catch {
    return { ok: false, code: 'bad_response' };
  }
}

/**
 * Impresoras vinculadas que reporta el shell Android. Sin esto el puente tiene
 * que adivinar la impresora por nombre; elegir la dirección deja la impresión
 * fuera de esa heurística.
 */
export async function listNativeBondedPrinters(): Promise<{ address: string; name: string }[]> {
  const bridge = getNativePrinterBridge();
  if (!bridge || typeof bridge.listDevices !== 'function') return [];
  try {
    const raw = String(await bridge.listDevices());
    if (raw.length > 64 * 1024) return [];
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed?.ok !== true || !Array.isArray(parsed.devices)) return [];
    const items: { address: string; name: string }[] = [];
    for (const device of parsed.devices.slice(0, 40)) {
      const address = String((device as Record<string, unknown>)?.address || '').trim().toUpperCase();
      if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(address)) continue;
      const name = String((device as Record<string, unknown>)?.name || '').trim().slice(0, 60);
      items.push({ address, name: name || address });
      if (items.length >= 20) break;
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Vínculo de la impresora dentro del APK: pide los permisos de Android y
 * comprueba el adaptador. Devuelve el nombre del dispositivo para la UI del POS.
 */
export async function connectNativePrinter(bridge?: ReturnType<typeof getNativePrinterBridge>): Promise<{ name: string }> {
  const printer = bridge || getNativePrinterBridge();
  if (!printer) {
    throw new Error(describeNativePrintCode('unavailable'));
  }
  let permissionCode = '';
  try {
    if (typeof printer.requestPermissions === 'function') {
      const permission = parseNativeEnvelopeText(String(await printer.requestPermissions()));
      if (!permission.ok) permissionCode = permission.code || 'permission_denied';
    }
  } catch {
    permissionCode = 'permission_denied';
  }
  const availability = await queryNativeAvailabilitySafe();
  if (!availability.ok) {
    throw new Error(describeNativePrintCode(availability.code || permissionCode));
  }
  cachedNativePrinterAvailable = true;
  cachedNativePrinterName = availability.deviceName || 'Impresora del sistema Android';
  return { name: cachedNativePrinterName };
}

/** Envía el ticket por el puente nativo; lanza con el motivo traducido. */
async function printReceiptOverNativePrinter(textLines: string[], openDrawer: boolean, width: '58mm' | '80mm'): Promise<void> {
  const bridge = getNativePrinterBridge();
  if (!bridge) throw new Error(describeNativePrintCode('unavailable'));
  const bytes = encodeEscPosLines(textLines, openDrawer, width);
  const result = await printViaNativePrinter(bytes, readRememberedNativePrinterAddress());
  if (!result.ok) {
    cachedNativePrinterAvailable = false;
    throw new Error(describeNativePrintCode(result.code));
  }
  cachedNativePrinterAvailable = true;
  cachedNativePrinterName = result.deviceName || cachedNativePrinterName || 'Impresora del sistema Android';
}

export async function printReceiptOverBluetooth(
  textLines: string[],
  openDrawer: boolean = false,
  width: '58mm' | '80mm' = '58mm'
) {
  if (!cachedBluetoothDevice?.gatt) throw new Error('No hay impresora Bluetooth conectada.');

  const server = cachedBluetoothDevice.gatt.connected
    ? cachedBluetoothDevice.gatt
    : await cachedBluetoothDevice.gatt.connect();

  if (!cachedBluetoothCharacteristic) {
    cachedBluetoothCharacteristic = await findBluetoothWritableCharacteristic(server);
  }
  if (!cachedBluetoothCharacteristic) {
    throw new Error('La impresora Bluetooth no ofrece un canal ESC/POS escribible.');
  }

  const bytes = encodeEscPosLines(textLines, openDrawer, width);
  const maxChunk = Math.max(
    20,
    Math.min(BLUETOOTH_RFCOMM_CHUNK_BYTES, Number(cachedBluetoothCharacteristic.maxWriteWithoutResponseSize || BLUETOOTH_RFCOMM_CHUNK_BYTES))
  );

  for (let offset = 0; offset < bytes.length; offset += maxChunk) {
    const chunk = bytes.slice(offset, offset + maxChunk);
    if (
      cachedBluetoothCharacteristic.properties?.writeWithoutResponse &&
      typeof cachedBluetoothCharacteristic.writeValueWithoutResponse === 'function'
    ) {
      await cachedBluetoothCharacteristic.writeValueWithoutResponse(chunk);
    } else if (typeof cachedBluetoothCharacteristic.writeValueWithResponse === 'function') {
      await cachedBluetoothCharacteristic.writeValueWithResponse(chunk);
    } else {
      await cachedBluetoothCharacteristic.writeValue(chunk);
    }
    await new Promise(resolve => setTimeout(resolve, BLUETOOTH_RFCOMM_PAUSE_MS));
  }
}

export async function printReceiptOverSerial(
  textLines: string[],
  openDrawer: boolean = false,
  width: '58mm' | '80mm' = '58mm'
) {
  if (!await checkPrinterConnection() || !cachedPort?.writable) {
    throw new Error('No hay impresora USB/Serie conectada.');
  }

  const bytes = encodeEscPosLines(textLines, openDrawer, width);
  const writer = cachedPort.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

export type ThermalPrintMethod = 'bluetooth' | 'serial' | 'native';

export async function printThermalReceipt(options: {
  lines: string[];
  openDrawer?: boolean;
  width?: '58mm' | '80mm';
  onSuccess?: (method: ThermalPrintMethod) => void;
  onError?: (error: any) => void;
}): Promise<ThermalPrintMethod> {
  const {
    lines,
    openDrawer = false,
    width = '58mm',
    onSuccess,
    onError
  } = options;

  return enqueueThermalPrint(async () => {
    // Ruta nativa del APK primero: la WebView no tiene GATT ni serie, así que
    // cualquier intento web fallaría igual. El resto de superficies no tiene
    // puente y baja a Web Bluetooth/Serial exactamente como antes.
    if (getNativePrinterBridge()) {
      try {
        await printReceiptOverNativePrinter(lines, openDrawer, width);
        onSuccess?.('native');
        return 'native';
      } catch (error: any) {
        console.warn('[ThermalPrinter] Native bridge failed:', error?.message || error);
        const nativeError = new Error(
          error?.message || describeNativePrintCode('print_failed')
        );
        onError?.(nativeError);
        throw nativeError;
      }
    }

    try {
      if (await checkBluetoothConnection()) {
        await printReceiptOverBluetooth(lines, openDrawer, width);
        onSuccess?.('bluetooth');
        return 'bluetooth';
      }
    } catch (error) {
      console.warn('[ThermalPrinter] Bluetooth failed:', error);
      cachedBluetoothCharacteristic = null;
    }

    try {
      if (await checkPrinterConnection()) {
        await printReceiptOverSerial(lines, openDrawer, width);
        onSuccess?.('serial');
        return 'serial';
      }
    } catch (error) {
      console.warn('[ThermalPrinter] USB/Serial failed:', error);
      cachedPort = null;
    }

    const decision = resolvePrinterRoute(getHardwareCapabilities(), false, currentPrinterSurface());
    const error = new Error(
      `No hay impresora térmica directa conectada. ${decision.guidance[0] || ''} Vincula una impresora Bluetooth BLE o conecta la impresora por USB/Serie.`.replace(/\s+/g, ' ').trim()
    );
    onError?.(error);
    throw error;
  });
}

export async function openCashDrawer() {
  return enqueueThermalPrint(async () => {
    // El cajón se abre con el mismo canal del ticket: en el APK viaja por el
    // puente nativo (RFCOMM/USB); fuera de él, por GATT o serie como siempre.
    if (getNativePrinterBridge()) {
      const result = await printViaNativePrinter(ESCPOS_COMMANDS.OPEN_DRAWER, readRememberedNativePrinterAddress());
      if (!result.ok) throw new Error(describeNativePrintCode(result.code));
      return;
    }

    if (await checkBluetoothConnection()) {
      const writerChar = cachedBluetoothCharacteristic;
      if (writerChar) {
        if (writerChar.properties?.writeWithoutResponse && typeof writerChar.writeValueWithoutResponse === 'function') {
          await writerChar.writeValueWithoutResponse(ESCPOS_COMMANDS.OPEN_DRAWER);
        } else if (typeof writerChar.writeValueWithResponse === 'function') {
          await writerChar.writeValueWithResponse(ESCPOS_COMMANDS.OPEN_DRAWER);
        } else {
          await writerChar.writeValue(ESCPOS_COMMANDS.OPEN_DRAWER);
        }
        return;
      }
    }

    if (await checkPrinterConnection()) {
      const writer = cachedPort.writable.getWriter();
      try {
        await writer.write(new Uint8Array([
          ...ESCPOS_COMMANDS.INIT,
          ...ESCPOS_COMMANDS.OPEN_DRAWER
        ]));
      } finally {
        writer.releaseLock();
      }
      return;
    }

    throw new Error('No hay impresora térmica directa conectada para abrir el cajón.');
  });
}

export async function testWifiPrinterConnection(ipAddress: string, _port: number = 9100) {
  if (!ipAddress?.trim()) {
    throw new Error('Ingresa una dirección IP válida.');
  }
  if (!/^(\\d{1,3}\\.){3}\\d{1,3}$/.test(ipAddress.trim())) {
    throw new Error('Formato de IP no válido.');
  }
  throw new Error('La impresión por red no está habilitada en el modo directo actual. Usa Bluetooth BLE o USB/Serie.');
}

export const printESCPOS = printThermalReceipt;
