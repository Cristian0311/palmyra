/**
 * Texto de los avisos que el servidor entrega al WhatsApp del dueño del SaaS.
 * Se mantiene separado del envío (ownerAlerts.ts) para poder probar el
 * contenido sin depender de variables de entorno ni de red.
 */

export function supportAlertLines(input: {
  companyName: string;
  requestType: string;
  subject: string;
  message: string;
  contactPhone?: string;
  requestId?: string;
  version?: string;
  online?: boolean;
  pendingOperations?: number;
}): string[] {
  return [
    `Empresa: ${input.companyName}`,
    `Tipo: ${input.requestType}`,
    `Asunto: ${input.subject.trim()}`,
    `Detalle: ${input.message.trim()}`,
    input.contactPhone?.trim() ? `Teléfono: ${input.contactPhone.trim()}` : "",
    input.requestId ? `Solicitud: ${input.requestId}` : "",
    input.version ? `Versión: ${input.version}` : "",
    typeof input.online === "boolean" ? `Conexión: ${input.online ? "En línea" : "Sin conexión"}` : "",
    typeof input.pendingOperations === "number" ? `Operaciones pendientes: ${input.pendingOperations}` : "",
  ].filter(Boolean);
}

export function planRequestAlertLines(input: {
  companyName: string;
  planName: string;
  months: number;
  paymentMethodLabel: string;
  amountLabel?: string;
  requestId?: string;
  note?: string;
}): string[] {
  return [
    `Empresa: ${input.companyName}`,
    `Plan solicitado: ${input.planName}`,
    `Duración: ${input.months} mes(es)`,
    `Método de pago: ${input.paymentMethodLabel}`,
    input.amountLabel ? `Importe de referencia: ${input.amountLabel}` : "",
    input.requestId ? `Solicitud: ${input.requestId}` : "",
    input.note || "El plan no cambia hasta que se confirme el pago.",
  ].filter(Boolean);
}

export function planCancelledAlertLines(input: {
  companyName: string;
  planName?: string;
  requestId?: string;
}): string[] {
  return [
    `Empresa: ${input.companyName}`,
    input.planName ? `Plan solicitado: ${input.planName}` : "",
    input.requestId ? `Solicitud: ${input.requestId}` : "",
    "El cliente canceló su solicitud pendiente de plan.",
  ].filter(Boolean);
}

export function companyCreatedAlertLines(input: {
  companyName: string;
  planName: string;
  paymentMethodLabel: string;
  months: number;
  ownerName?: string;
  ownerEmail?: string;
}): string[] {
  return [
    `Empresa: ${input.companyName}`,
    `Plan inicial: ${input.planName}`,
    `Duración: ${input.months} mes(es)`,
    `Método de pago: ${input.paymentMethodLabel}`,
    input.ownerName ? `Propietario: ${input.ownerName}` : "",
    input.ownerEmail ? `Correo: ${input.ownerEmail}` : "",
  ].filter(Boolean);
}
