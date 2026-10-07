import { useEffect, useState } from "react";
import { getClosureReceiptLines as getClosureReceiptLinesUtil } from "../utils/getClosureReceiptLines";
import { getTransactionReceiptLines as getTransactionReceiptLinesUtil } from "../utils/getTransactionReceiptLines";
import { formatMoney } from "../utils/paymentMath";
import { printThermalReceipt as printThermalReceiptDirect } from "../../../lib/escpos";
import { useStore } from "../../../store/useStore";
import type { CashRegisterSession, Product, User, Transaction, Currency } from "../../../types";

type ReceiptConfigLike = {
  businessName?: string;
  printerWidth?: "58mm" | "80mm" | string;
  openDrawer?: boolean;
};

type UsePOSPrinterOptions = {
  currentSession: CashRegisterSession | null;
  products: Product[];
  currencies: Currency[];
  baseCurrency: Currency;
  branches: { id: string; name: string }[];
  users: User[];
  currentUser: User | null;
  salarySettlements: any[];
  receiptConfig: ReceiptConfigLike;
  addNotification: (message: string, type?: "info" | "success" | "warning" | "error") => void;
  setPosError: (message: string) => void;
  setPosSuccess: (message: string) => void;
};

export function usePOSPrinter({
  currentSession,
  products,
  currencies,
  baseCurrency,
  branches,
  users,
  currentUser,
  salarySettlements,
  receiptConfig,
  addNotification,
  setPosError,
  setPosSuccess,
}: UsePOSPrinterOptions) {
  const [connectedPrinterName, setConnectedPrinterName] = useState<string | null>(null);
  const [showPrinterSetupModal, setShowPrinterSetupModal] = useState(false);
  const [isConnectingPrinter, setIsConnectingPrinter] = useState(false);
  const [printerStatusMsg, setPrinterStatusMsg] = useState("");

  useEffect(() => {
    import("../../../lib/escpos")
      .then(async ({ autoConnectRememberedThermalPrinter, getConnectedDeviceName }) => {
        const name = await autoConnectRememberedThermalPrinter() || await getConnectedDeviceName();
        if (name) setConnectedPrinterName(name);
      })
      .catch(() => {});
  }, []);

  const handlePairBluetooth = async () => {
    setIsConnectingPrinter(true);
    setPrinterStatusMsg("Buscando impresora Bluetooth...");
    try {
      const { connectBluetoothPrinter } = await import("../../../lib/escpos");
      const device = await connectBluetoothPrinter();
      setConnectedPrinterName(device.name || "Impresora Bluetooth 58mm");
      setPosSuccess(`Impresora "${device.name || "Bluetooth"}" conectada`);
      setPrinterStatusMsg(`Conectado a ${device.name || "Bluetooth"}`);
      setTimeout(() => setPosSuccess(""), 3000);
    } catch (err: any) {
      console.warn("Bluetooth connection error:", err);
      setPosError(err?.message || "No se pudo conectar la impresora Bluetooth");
      setPrinterStatusMsg(err?.message || "Error al conectar");
      setTimeout(() => setPosError(""), 4000);
    } finally {
      setIsConnectingPrinter(false);
    }
  };

  const handleConnectUsb = async () => {
    setIsConnectingPrinter(true);
    setPrinterStatusMsg("Buscando impresora USB...");
    try {
      const { connectPrinter } = await import("../../../lib/escpos");
      await connectPrinter();
      setConnectedPrinterName("Impresora USB (Serie)");
      setPosSuccess("Impresora USB conectada correctamente");
      setPrinterStatusMsg("Impresora USB conectada");
      setTimeout(() => setPosSuccess(""), 3000);
    } catch (err: any) {
      console.warn("USB connection error:", err);
      setPosError(err?.message || "No se pudo conectar la impresora USB");
      setPrinterStatusMsg(err?.message || "Error al conectar");
      setTimeout(() => setPosError(""), 4000);
    } finally {
      setIsConnectingPrinter(false);
    }
  };

  const formatSalaryCUP = (value: number) =>
    `${Math.round(Number(value) || 0).toLocaleString("es-ES")} CUP`;

  const getTransactionReceiptLines = (tx: Transaction): string[] =>
    getTransactionReceiptLinesUtil(tx, {
      receiptConfig: useStore.getState().receiptConfig,
      currentSessionWorkerName: currentSession?.workerName,
      users,
      customers: useStore.getState().customers,
      products,
      currencies,
      baseCurrency,
      formatMoney,
    });

  const getClosureReceiptLines = (session: CashRegisterSession): string[] =>
    getClosureReceiptLinesUtil(session, {
      receiptConfig: useStore.getState().receiptConfig,
      transactions: useStore.getState().transactions,
      products,
      currencies,
      branches,
      users,
      currentUser,
      salarySettlements,
      baseCurrency,
      formatMoney,
      formatSalaryCUP,
    });

  const handleThermalPrint = async (
    tx: Transaction,
    options?: { silent?: boolean }
  ) => {
    try {
      const lines = getTransactionReceiptLines(tx);
      await printThermalReceiptDirect({
        lines,
        openDrawer: receiptConfig.openDrawer ?? true,
        width: (receiptConfig.printerWidth || "58mm") as "58mm" | "80mm",
        onSuccess: (method) => {
          if (!options?.silent) {
            setPosSuccess(
              `Ticket enviado a impresora (${method === "bluetooth" ? "Bluetooth" : "USB/Serie"})`
            );
            setTimeout(() => setPosSuccess(""), 2500);
          }
        },
        onError: (error) => {
          if (!options?.silent) {
            setPosError(error?.message || "Sin conexión activa con impresora");
            setTimeout(() => setPosError(""), 3500);
          }
        },
      });
    } catch (err: any) {
      console.warn("Thermal print:", err);
      if (!options?.silent) {
        setPosError(err?.message || "No se pudo imprimir el ticket");
        setTimeout(() => setPosError(""), 3500);
      }
    }
  };

  const handlePrintClosureThermal = async (
    session: CashRegisterSession | null,
    options?: { silent?: boolean }
  ) => {
    if (!session) return;
    try {
      const lines = getClosureReceiptLines(session);
      await printThermalReceiptDirect({
        lines,
        openDrawer: false,
        width: (receiptConfig.printerWidth || "58mm") as "58mm" | "80mm",
        onSuccess: (method) => {
          if (!options?.silent) {
            setPosSuccess(
              `Cierre impreso (${method === "bluetooth" ? "Bluetooth" : "USB/Serie"})`
            );
            setTimeout(() => setPosSuccess(""), 2500);
          }
        },
        onError: (error) => {
          if (!options?.silent) {
            setPosError(error?.message || "Sin conexión a impresora");
            setTimeout(() => setPosError(""), 3500);
          }
        },
      });
    } catch (err: any) {
      console.error("Error al imprimir comprobante de cierre:", err);
      if (!options?.silent) {
        setPosError(err?.message || "No se pudo imprimir el comprobante de cierre");
        setTimeout(() => setPosError(""), 3500);
      }
    }
  };

  const handleWhatsAppReceipt = (tx: Transaction) => {
    let phone = "";
    const customer = useStore.getState().customers.find((c) => c.id === tx.customerId);

    if (customer?.phone) {
      phone = String(customer.phone || "").replace(/\D/g, "");
    } else {
      const input = window.prompt("Ingrese el número de WhatsApp del cliente:");
      if (!input) return;
      phone = String(input || "").replace(/D/g, "");
    }

    if (!phone) {
      addNotification("Número de teléfono inválido.", "error");
      return;
    }

    const storeName = useStore.getState().storeConfig.storeName;
    const itemsText = (tx.items || [])
      .map((item) => {
        const product = products.find((p) => p.id === (item.product as any));
        const productObject = typeof item.product === "object" ? (item.product as any) : null;
        const productName = productObject?.name || product?.name || item.product || "Producto";
        const productPrice = productObject?.price || product?.price || item.price || 0;
        return `${item.quantity}x ${productName} - ${formatMoney(productPrice * item.quantity, baseCurrency.symbol)}`;
      })
      .join("%0A");

    const body = `Hola, gracias por tu compra en *${storeName}*.%0A%0A*Detalle del recibo ${tx.ticketNumber || tx.id}:*%0A${itemsText}%0A%0A*Total:* ${formatMoney(tx.total, baseCurrency.symbol)}%0A%0A¡Vuelve pronto!`;
    window.open(`https://wa.me/${phone}?text=${body}`, "_blank");
  };

  const handleEmailReceipt = (tx: Transaction) => {
    const customer = useStore.getState().customers.find((c) => c.id === tx.customerId);
    if (!customer?.email) {
      addNotification("El cliente no tiene un correo registrado.", "warning");
      return;
    }

    const storeName = useStore.getState().storeConfig.storeName;
    const subject = `Tu Recibo de Compra - ${storeName}`;
    const body = `Hola ${customer?.name || "Cliente"},

Gracias por tu compra. Tu recibo es ${tx.id} por un total de ${formatMoney(tx.total, baseCurrency.symbol)}.

Saludos,
${storeName}`;
    const url = `mailto:${customer.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank");
  };

  return {
    connectedPrinterName,
    setConnectedPrinterName,
    showPrinterSetupModal,
    setShowPrinterSetupModal,
    isConnectingPrinter,
    printerStatusMsg,
    handlePairBluetooth,
    handleConnectUsb,
    handleThermalPrint,
    handlePrintClosureThermal,
    handleWhatsAppReceipt,
    handleEmailReceipt,
  };
}
