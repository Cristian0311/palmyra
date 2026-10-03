export type BillingRegion = "CU" | "INTERNATIONAL";
export type PaymentMethodCode = "manual_cash" | "online_card";

export type PaymentMethod = {
  code: PaymentMethodCode;
  label: string;
  available: boolean;
  provider?: string;
};

export function getPaymentMethods(region: BillingRegion): PaymentMethod[] {
  if (region === "CU") {
    return [
      { code: "manual_cash", label: "Pago en efectivo", available: true, provider: "manual_cash" },
      { code: "online_card", label: "Pago internacional en línea", available: false, provider: "external_gateway" },
    ];
  }
  return [
    { code: "online_card", label: "Pago internacional en línea", available: false, provider: "external_gateway" },
    { code: "manual_cash", label: "Pago manual", available: false, provider: "manual_cash" },
  ];
}

/**
 * Adapter boundary for the future international payment processor.
 * The operational billing flow never depends on a specific provider.
 */
export interface InternationalPaymentProvider {
  createCheckout(input: {
    invoiceId: string;
    amount: number;
    currency: string;
    customerEmail: string;
  }): Promise<{ checkoutUrl: string; externalReference?: string }>;
  handleWebhook(payload: unknown, signature?: string): Promise<void>;
}

export const PAYMENT_PROVIDER_CONFIG = {
  international: "external_gateway",
  cuba: "manual_cash",
} as const;
