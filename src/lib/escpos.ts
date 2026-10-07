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
  return {
    serialSupported,
    bluetoothSupported,
    inIframe: isInsideIframe()
  };
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

  if (isInsideIframe()) {
    throw new Error('Las APIs de hardware directo están restringidas dentro de marcos. Abre la aplicación en una pestaña nueva.');
  }
  if (typeof navigator === 'undefined' || !('serial' in navigator)) {
    throw new Error('La conexión USB/Serie directa no está disponible en este navegador.');
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
  if (isInsideIframe()) {
    throw new Error('Las APIs de Bluetooth están restringidas dentro de marcos. Abre la aplicación en una pestaña nueva.');
  }
  if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) {
    throw new Error('Web Bluetooth no está disponible en este navegador.');
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
  if (cachedBluetoothDevice?.gatt?.connected && cachedBluetoothCharacteristic) return true;
  const restored = await restoreRememberedBluetoothPrinter();
  return Boolean(restored?.gatt?.connected && cachedBluetoothCharacteristic);
}

export async function getConnectedDeviceName(): Promise<string | null> {
  if (await checkBluetoothConnection()) {
    return cachedBluetoothDevice?.name || 'Impresora Bluetooth';
  }
  if (await checkPrinterConnection()) return 'Impresora USB/Serie';
  return null;
}

export async function autoConnectRememberedThermalPrinter(): Promise<string | null> {
  if (!isThermalPrinterAutoConnectEnabled()) return null;
  if (await checkBluetoothConnection()) return cachedBluetoothDevice?.name || 'Impresora Bluetooth';
  const restored = await restoreRememberedBluetoothPrinter();
  if (restored) return restored.name || 'Impresora Bluetooth';
  if (await checkPrinterConnection()) return 'Impresora USB/Serie';
  return null;
}

export async function isPrinterConnected(): Promise<boolean> {
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
  try { window.localStorage.removeItem(BLUETOOTH_PRINTER_STORAGE_KEY); } catch {}
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
    Math.min(180, Number(cachedBluetoothCharacteristic.maxWriteWithoutResponseSize || 180))
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
    await new Promise(resolve => setTimeout(resolve, 15));
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

export async function printThermalReceipt(options: {
  lines: string[];
  openDrawer?: boolean;
  width?: '58mm' | '80mm';
  onSuccess?: (method: 'bluetooth' | 'serial') => void;
  onError?: (error: any) => void;
}): Promise<'bluetooth' | 'serial'> {
  const {
    lines,
    openDrawer = false,
    width = '58mm',
    onSuccess,
    onError
  } = options;

  return enqueueThermalPrint(async () => {
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

    const error = new Error(
      'No hay impresora térmica directa conectada. Vincula una impresora Bluetooth BLE o conecta la impresora por USB/Serie.'
    );
    onError?.(error);
    throw error;
  });
}

export async function openCashDrawer() {
  return enqueueThermalPrint(async () => {
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
