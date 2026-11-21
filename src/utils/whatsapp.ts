import { ACQUISITION_PAYMENTS } from '../config/saas';

export const PALMYRA_WHATSAPP_PHONE = '5355581669';

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
  months?: number;
  requestId?: string;
}

export function paymentMethodLabel(method?: string): string {
  return ACQUISITION_PAYMENTS.find((item) => item.code === method)?.label
    || ({ manual_cash: 'Efectivo (registro anterior; moneda por confirmar)', manual_bank_transfer: 'Transferencia bancaria (registro anterior; moneda por confirmar)' }[method || ''])
    || 'Método por confirmar';
}

export function buildWhatsAppPaymentUrl(request: WhatsAppPaymentRequest): string {
  const amount = typeof request.amount === 'number' && Number.isFinite(request.amount)
    ? request.amount.toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (request.currency || 'USD')
    : 'Por confirmar';
  const cup = request.paymentMethod === 'cup_cash' || request.paymentMethod === 'cup_bank_transfer';
  const lines = [
    'Hola PALMYRA, quiero coordinar el pago de mi solicitud de plan.',
    'Empresa: ' + (request.companyName || 'No indicado'),
    ...(request.ownerName ? ['Propietario: ' + request.ownerName] : []),
    ...(request.ownerEmail ? ['Correo: ' + request.ownerEmail] : []),
    ...(request.warehouseName ? ['Almacén principal: ' + request.warehouseName] : []),
    'Plan: ' + request.planName,
    'Duración: ' + (request.months || 1) + ' mes(es)',
    'Precio de referencia del período: ' + amount,
    'Método de pago: ' + paymentMethodLabel(request.paymentMethod),
    ...(cup ? ['Importe en CUP: por acordar con PALMYRA. Sin conversión automática.'] : []),
    ...(request.requestId ? ['Solicitud: ' + request.requestId] : []),
    'La solicitud no activa ni renueva el plan hasta la confirmación manual del pago.',
  ];
  return 'https://wa.me/' + PALMYRA_WHATSAPP_PHONE + '?text=' + encodeURIComponent(lines.join('\n'));
}

export function goToWhatsAppPayment(request: WhatsAppPaymentRequest): void {
  window.location.assign(buildWhatsAppPaymentUrl(request));
}
