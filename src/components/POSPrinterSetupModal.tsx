import React from 'react';
import { Bluetooth, Printer, Usb, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { printThermalReceipt, disconnectPrinter, disconnectBluetoothPrinter, isThermalPrinterAutoConnectEnabled, setThermalPrinterAutoConnect, getHardwareCapabilities } from '../lib/escpos';

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
  const capabilities = React.useMemo(() => getHardwareCapabilities(), []);

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
  const bluetoothAvailable = capabilities.bluetoothSupported && !capabilities.inIframe;
  const serialAvailable = capabilities.serialSupported && !capabilities.inIframe;
  const directPrintingAvailable = bluetoothAvailable || serialAvailable;
  const capabilityTags: string[] = [];
  if (capabilities.isDesktop) capabilityTags.push('Escritorio PALMYRA');
  if (bluetoothAvailable) capabilityTags.push('Bluetooth disponible');
  if (serialAvailable) capabilityTags.push('Puerto USB disponible');
  const capabilityMessage = capabilities.inIframe
    ? 'Vista embebida: abre PALMYRA en su propia ventana para usar la impresora térmica.'
    : capabilityTags.length > 0
      ? capabilityTags.join(' · ')
      : 'Este dispositivo no expone impresión térmica directa; usa Imprimir del sistema.';

  return (
  <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4">
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="printer-setup-title"
      className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden animate-in zoom-in-95 border border-slate-100"
    >
      <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-200">
            <Printer className="w-4 h-4" />
          </div>
          <div>
            <h3 id="printer-setup-title" className="text-xs font-black text-slate-900 uppercase tracking-wider">Configuración de Impresora Térmica</h3>
            <p className="text-[10px] font-bold text-slate-500">Bluetooth BLE o conexión por cable USB/Serie</p>
          </div>
        </div>
        <button 
          onClick={() => onClose()}
          className="w-7 h-7 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200/50 flex items-center justify-center transition-all"
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
          <p className="text-[9px] font-bold uppercase tracking-wide text-slate-500 leading-4">
            {capabilityMessage}
          </p>
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
          <button
            type="button"
            disabled={isConnectingPrinter || !bluetoothAvailable}
            onClick={onPairBluetooth}
            title={bluetoothAvailable ? undefined : "Web Bluetooth no está disponible en este dispositivo."}
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
              Web Bluetooth no está disponible aquí: usa la impresión del sistema.
            </p>
          )}

          <button
            type="button"
            disabled={isConnectingPrinter || !serialAvailable}
            onClick={onConnectUsb}
            title={serialAvailable ? undefined : "La conexión por cable USB/Serie no está disponible en este dispositivo."}
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
              La conexión USB/Serie no está disponible aquí: usa la impresión del sistema.
            </p>
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
                onSuccess: (method) => {
                  onSuccess(`Prueba enviada por ${method === 'bluetooth' ? 'Bluetooth' : 'USB/Serie'}`);
                  setTimeout(() => onSuccess(""), 2500);
                }
              });
              if (!printed) {
                onError("No hay impresora conectada");
                setTimeout(() => onError(""), 3000);
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
