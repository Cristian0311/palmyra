import React from 'react';
import { Bluetooth, Printer, ShieldCheck, Usb, X } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  printThermalReceipt,
  disconnectPrinter,
  disconnectBluetoothPrinter,
  isThermalPrinterAutoConnectEnabled,
  setThermalPrinterAutoConnect,
  getHardwareCapabilities,
  resolvePrinterRoute,
  currentPrinterSurface,
  connectNativePrinter,
  closeNativePrinter,
  listNativeBondedPrinters,
  readRememberedNativePrinterAddress,
  rememberNativePrinterAddress,
  type ThermalPrintMethod
} from '../lib/escpos';
import { requestNativeHardwarePermissions } from '../lib/nativeApp';

interface POSPrinterSetupModalProps {
  connectedPrinterName: string | null;
  printerStatusMsg: string;
  isConnectingPrinter: boolean;
  onClose: () => void;
  onPairBluetooth: () => void | Promise<void>;
  onConnectUsb: () => void | Promise<void>;
  onPrinterConnectedChange: (name: string | null) => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
  printerWidth?: '58mm' | '80mm';
}

export default function POSPrinterSetupModal({
  connectedPrinterName,
  printerStatusMsg,
  isConnectingPrinter,
  onClose,
  onPairBluetooth,
  onConnectUsb,
  onPrinterConnectedChange,
  onSuccess,
  onError,
  printerWidth = '58mm'
}: POSPrinterSetupModalProps) {
  const [autoConnect, setAutoConnect] = React.useState(() => isThermalPrinterAutoConnectEnabled());
  const [nativeBusy, setNativeBusy] = React.useState(false);
  const [nativeDevices, setNativeDevices] = React.useState<{ address: string; name: string }[]>([]);
  const [nativeSelected, setNativeSelected] = React.useState(() => readRememberedNativePrinterAddress());
  const capabilities = React.useMemo(() => getHardwareCapabilities(), []);
  // La decisión de ruta vive en una función pura (resolvePrinterRoute) para que
  // sea probable sin DOM: aquí solo se pinta su resultado.
  const routeDecision = React.useMemo(
    () => resolvePrinterRoute(capabilities, capabilities.nativePrinterBridge === true, currentPrinterSurface()),
    [capabilities]
  );

  // Escape cierra el panel con el mismo manejador del botón Cerrar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Capacidad real del dispositivo: la API debe existir y no estar bloqueada
  // por un marco embebido.
  const bluetoothAvailable = routeDecision.route === 'web-bluetooth' || (capabilities.bluetoothSupported && !capabilities.inIframe);
  const serialAvailable = routeDecision.route === 'web-serial' || (capabilities.serialSupported && !capabilities.inIframe);
  const nativeAvailable = routeDecision.route === 'native-android';
  const directPrintingAvailable = bluetoothAvailable || serialAvailable || nativeAvailable;
  const capabilityTags: string[] = [];
  if (capabilities.isDesktop) capabilityTags.push('Escritorio PALMYRA');
  if (nativeAvailable) capabilityTags.push('Impresión directa del APK');
  if (bluetoothAvailable) capabilityTags.push('Bluetooth disponible');
  if (serialAvailable) capabilityTags.push('Puerto USB disponible');
  const guidanceLines = directPrintingAvailable ? [] : routeDecision.guidance.slice(0, 3);
  const capabilityMessage = directPrintingAvailable
    ? `${routeDecision.headline}: ${capabilityTags.join(' · ')}`
    : routeDecision.headline;

  const askNativePermissions = async () => {
    setNativeBusy(true);
    try {
      const result = await requestNativeHardwarePermissions();
      if (result.ok) onSuccess('Permisos de impresión concedidos');
      else onError(result.code === 'permission_denied'
        ? 'Android denegó los permisos. Actívalos en Ajustes › Aplicaciones › PALMYRA › Permisos.'
        : 'No se pudieron pedir los permisos ahora. Reinicia la app e inténtalo de nuevo.');
    } finally {
      setNativeBusy(false);
      setTimeout(() => onSuccess(""), 2500);
    }
  };

  const pairNativePrinter = async () => {
    setNativeBusy(true);
    try {
      const connected = await connectNativePrinter();
      onPrinterConnectedChange(connected.name);
      onSuccess(`Vinculada: ${connected.name}`);
      setTimeout(() => onSuccess(""), 2500);
    } catch (error: any) {
      onError(error?.message || 'No se pudo vincular la impresora desde Android.');
      setTimeout(() => onError(""), 4000);
    } finally {
      setNativeBusy(false);
    }
  };

  /** Lista de impresoras vinculadas en Android: evita que el shell adivine. */
  const loadNativeDevices = async () => {
    setNativeBusy(true);
    try {
      const found = await listNativeBondedPrinters();
      setNativeDevices(found);
      if (!found.length) {
        onError('Android no reporta ningún dispositivo vinculado. Vincula la impresora en Ajustes › Dispositivos conectados.');
        setTimeout(() => onError(""), 4000);
      }
    } finally {
      setNativeBusy(false);
    }
  };

  const chooseNativePrinter = (device: { address: string; name: string }) => {
    rememberNativePrinterAddress(device.address);
    setNativeSelected(device.address);
    onPrinterConnectedChange(device.name);
    onSuccess(`Impresora elegida: ${device.name}`);
    setTimeout(() => onSuccess(""), 2500);
  };

  return (
  <div
    className="palmyra-overlay z-[var(--z-modal)] flex items-center justify-center p-3 sm:p-4"
    role="presentation"
    onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="printer-setup-title"
      className="palmyra-modal-panel w-full max-w-sm overflow-hidden animate-in zoom-in-95 max-h-[92dvh] overflow-y-auto"
    >
      <div className="p-5 border-b border-base flex items-center justify-between bg-subtle">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-200">
            <Printer className="w-4 h-4" />
          </div>
          <div>
            <h3 id="printer-setup-title" className="text-xs font-black text-primary uppercase tracking-wider">Configuración de Impresora Térmica</h3>
            <p className="text-[10px] font-bold text-muted">Bluetooth BLE o conexión por cable USB/Serie</p>
          </div>
        </div>
        <button 
          onClick={() => onClose()}
          className="w-7 h-7 rounded-lg text-muted hover:text-primary hover:bg-subtle flex items-center justify-center transition-all"
          aria-label="Cerrar configuración de impresora"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 space-y-4">
        {/* Current Status */}
        <div className={cn(
          "p-3 rounded-2xl border flex items-center justify-between",
          connectedPrinterName ? "bg-emerald-50/70 border-emerald-200 text-emerald-900" : "bg-slate-50 border-slate-200 text-slate-700"
        )}>
          <div className="flex items-center gap-2.5">
            <div className={cn("w-2.5 h-2.5 rounded-full", connectedPrinterName ? "bg-emerald-500 animate-pulse" : "bg-slate-400")} />
            <div>
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-500">Estado actual</div>
              <div className="text-xs font-black truncate max-w-[170px]">{connectedPrinterName || "Sin conexión activa"}</div>
            </div>
          </div>
          {connectedPrinterName && (
            <button 
              onClick={async () => {
                await disconnectPrinter();
                await disconnectBluetoothPrinter();
                await closeNativePrinter();
                onPrinterConnectedChange(null);
                onSuccess("Impresora desconectada");
                setTimeout(() => onSuccess(""), 2000);
              }}
              className="px-2.5 py-1 bg-white border border-rose-200 text-rose-600 rounded-lg text-[10px] font-black uppercase hover:bg-rose-50 transition-all"
            >
              Desconectar
            </button>
          )}
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <span className={cn(
            "mt-1 w-1.5 h-1.5 rounded-full shrink-0",
            directPrintingAvailable ? "bg-emerald-500" : "bg-amber-500"
          )} />
          <div className="min-w-0">
            <p className="text-[9px] font-bold uppercase tracking-wide text-slate-500 leading-4">
              {capabilityMessage}
            </p>
            {guidanceLines.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {guidanceLines.map((line) => (
                  <li key={line} className="text-[9px] font-semibold leading-4 text-slate-600">• {line}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {printerStatusMsg && (
          <p role="status" className="text-[10px] font-bold text-indigo-600 text-center animate-pulse">{printerStatusMsg}</p>
        )}

        <label className="flex items-start gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-3 cursor-pointer">
          <input
            type="checkbox"
            checked={autoConnect}
            onChange={e => {
              const enabled = e.target.checked;
              setAutoConnect(enabled);
              setThermalPrinterAutoConnect(enabled);
            }}
            className="mt-0.5 h-4 w-4 accent-indigo-600"
          />
          <span className="min-w-0">
            <span className="block text-[10px] font-black uppercase tracking-wider text-indigo-800">Siempre conectar</span>
            <span className="block mt-0.5 text-[9px] font-semibold leading-4 text-indigo-700/80">Al abrir PALMYRA, intentará reconectar automáticamente esta impresora si Bluetooth o el puerto autorizado están disponibles.</span>
          </span>
        </label>

        {/* Connection Actions */}
        <div className="space-y-2">
          {nativeAvailable && (
            <>
              <button
                type="button"
                disabled={nativeBusy}
                onClick={pairNativePrinter}
                title="Usa el Bluetooth o el USB del teléfono para imprimir directo, sin Web Bluetooth."
                className="w-full p-3 bg-violet-600 hover:bg-violet-700 text-white rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-between transition-all shadow-md active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <div className="flex items-center gap-2.5">
                  <Printer className="w-4 h-4 text-violet-200" />
                  <span>{connectedPrinterName ? 'Reintentar vínculo directo' : '1. Vincular impresora del sistema'}</span>
                </div>
                <span className="text-[9px] bg-violet-500/50 px-2 py-0.5 rounded-md text-violet-100">Bluetooth / USB</span>
              </button>
              <button
                type="button"
                disabled={nativeBusy}
                onClick={() => void askNativePermissions()}
                className="w-full p-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-between transition-all active:scale-95 disabled:opacity-60 border border-slate-200"
              >
                <div className="flex items-center gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-slate-500" />
                  <span>2. Activar permisos de impresión</span>
                </div>
                <span className="text-[9px] bg-slate-200 px-2 py-0.5 rounded-md text-slate-600">Android</span>
              </button>

              <button
                type="button"
                disabled={nativeBusy}
                onClick={() => void loadNativeDevices()}
                title="Lista lo que Android ya tiene vinculado para elegir la impresora sin adivinar."
                className="w-full p-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-between transition-all active:scale-95 disabled:opacity-60 border border-slate-200"
              >
                <div className="flex items-center gap-2.5">
                  <Bluetooth className="w-4 h-4 text-slate-500" />
                  <span>3. Elegir entre las vinculadas</span>
                </div>
                <span className="text-[9px] bg-slate-200 px-2 py-0.5 rounded-md text-slate-600">
                  {nativeDevices.length ? `${nativeDevices.length} lista(s)` : 'Opcional'}
                </span>
              </button>

              {nativeDevices.length > 0 && (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-1.5 space-y-1">
                  {nativeDevices.map(device => (
                    <button
                      key={device.address}
                      type="button"
                      onClick={() => chooseNativePrinter(device)}
                      className={cn(
                        'w-full px-2.5 py-2 rounded-xl text-left text-[11px] font-bold transition-colors flex items-center justify-between gap-2',
                        nativeSelected === device.address
                          ? 'bg-violet-600 text-white'
                          : 'bg-white text-slate-700 hover:bg-violet-50 border border-slate-200'
                      )}
                    >
                      <span className="truncate">{device.name}</span>
                      <span className={cn('text-[9px] font-mono shrink-0', nativeSelected === device.address ? 'text-violet-100' : 'text-slate-400')}>
                        {device.address.slice(-8)}
                      </span>
                    </button>
                  ))}
                  <p className="px-1 pb-0.5 text-[9px] font-semibold text-slate-500">
                    Se guarda la dirección elegida: el ticket saldrá siempre por esa impresora.
                  </p>
                </div>
              )}
            </>
          )}

          {!nativeAvailable && (
            <>
              <button
                type="button"
                disabled={isConnectingPrinter || !bluetoothAvailable}
                onClick={onPairBluetooth}
                title={bluetoothAvailable ? undefined : routeDecision.guidance[0]}
                className="w-full p-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-between transition-all shadow-md shadow-indigo-100 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex items-center gap-2.5">
                  <Bluetooth className="w-4 h-4 text-indigo-200" />
                  <span>1. Vincular Bluetooth BLE</span>
                </div>
                <span className="text-[9px] bg-indigo-500/50 px-2 py-0.5 rounded-md text-indigo-100">BLE / Directo</span>
              </button>
              {!bluetoothAvailable && (
                <p className="px-1 text-[9px] font-semibold text-amber-700">
                  {routeDecision.guidance[0] || 'Este navegador no permite conectar la impresora: usa Imprimir del sistema.'}
                </p>
              )}

              <button
                type="button"
                disabled={isConnectingPrinter || !serialAvailable}
                onClick={onConnectUsb}
                title={serialAvailable ? undefined : routeDecision.guidance[1] || routeDecision.guidance[0]}
                className="w-full p-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-2xl text-xs font-black uppercase tracking-wider flex items-center justify-between transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed border border-slate-200"
              >
                <div className="flex items-center gap-2.5">
                  <Usb className="w-4 h-4 text-slate-500" />
                  <span>2. Conectar por Cable USB</span>
                </div>
                <span className="text-[9px] bg-slate-200 px-2 py-0.5 rounded-md text-slate-600">USB / OTG</span>
              </button>
              {!serialAvailable && (
                <p className="px-1 text-[9px] font-semibold text-amber-700">
                  {routeDecision.guidance[1] || routeDecision.guidance[0] || 'El cable USB no está disponible aquí: usa Imprimir del sistema.'}
                </p>
              )}
            </>
          )}
        </div>

        {/* Test Ticket */}
        <div className="pt-2 border-t border-slate-100 flex gap-2">
          <button
            type="button"
            onClick={async () => {
              const printed = await printThermalReceipt({
                lines: [
                  "CENTER|BOLD|PALMYRA",
                  "CENTER|TICKET DE PRUEBA",
                  "---",
                  `Fecha: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
                  "Estado: Correcto",
                  "---",
                  "CENTER|Impresión Térmica OK"
                ],
                openDrawer: true,
                width: printerWidth,
                onSuccess: (method: ThermalPrintMethod) => {
                  const label = method === 'bluetooth' ? 'Bluetooth' : method === 'native' ? 'impresión del sistema' : 'USB/Serie';
                  onSuccess(`Prueba enviada por ${label}`);
                  setTimeout(() => onSuccess(""), 2500);
                }
              });
              if (!printed) {
                onError(resolvePrinterRoute(capabilities, capabilities.nativePrinterBridge === true, currentPrinterSurface()).guidance[0]
                  || 'No hay impresora conectada');
                setTimeout(() => onError(""), 4000);
              }
            }}
            className="flex-1 py-2.5 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-800 transition-all flex items-center justify-center gap-1.5 active:scale-95"
          >
            <Printer className="w-3.5 h-3.5" />
            Imprimir Prueba
          </button>

          <button
            type="button"
            onClick={() => onClose()}
            className="px-4 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-200 transition-all active:scale-95"
          >
            Listo
          </button>
        </div>
      </div>
    </div>
  </div>
  );
}
