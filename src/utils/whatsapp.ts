export const PALMYRA_WHATSAPP_PHONE = "5355581669";

export interface WhatsAppPaymentRequest {
  ownerName?: string;
  ownerEmail?: string;
  companyName?: string;
  warehouseName?: string;
  planName: string;
  planCode?: string;
  amount?: number;
  currency?: string;
  paymentMethod?: string;
  requestId?: string;
}

export function buildWhatsAppPaymentUrl(request: WhatsAppPaymentRequest): string {
  const paymentMethod = request.paymentMethod === "manual_bank_transfer"
    ? "Transferencia bancaria"
    : "Efectivo";

  const amount = typeof request.amount === "number"
    ? request.amount.toLocaleString("es-CU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + (request.currency || "USD")
    : "Por confirmar";

  const lines = [
    "Hola PALMYRA, quiero solicitar la activación de un plan.",
    "",
    "Empresa: " + (request.companyName || "No indicado"),
    "Propietario: " + (request.ownerName || "No indicado"),
    "Correo: " + (request.ownerEmail || "No indicado"),
    "Almacén principal: " + (request.warehouseName || "No indicado"),
    "Plan: " + request.planName + (request.planCode ? " (" + request.planCode + ")" : ""),
    "Importe: " + amount,
    "Método de pago: " + paymentMethod,
    ...(request.requestId ? ["Solicitud: " + request.requestId] : []),
    "",
    "Quedo atento para completar el pago y la activación."
  ];

  return "https://wa.me/" + PALMYRA_WHATSAPP_PHONE + "?text=" + encodeURIComponent(lines.join("\n"));
}

export function goToWhatsAppPayment(request: WhatsAppPaymentRequest): void {
  window.location.assign(buildWhatsAppPaymentUrl(request));
}
