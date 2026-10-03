export type BillingMode = "manual_cash" | "online";
export type BillingProvider = "manual_cash" | "stripe" | "paypal" | "mercadopago";

export interface BillingCheckoutRequest {
  companyId: string;
  planId: string;
  mode: BillingMode;
  provider: BillingProvider;
  returnUrl?: string;
}

export interface BillingCheckoutResult {
  status: "pending_payment" | "checkout_required" | "not_configured";
  provider: BillingProvider;
  checkoutUrl?: string;
  message: string;
}

/**
 * Cuba uses manual cash today. International online providers are deliberately
 * represented as adapters so enabling them later does not change subscriptions.
 */
export const BILLING_CONFIGURATION = {
  country: "CU",
  currentMode: "manual_cash" as BillingMode,
  currentProvider: "manual_cash" as BillingProvider,
  futureProviders: ["stripe", "paypal"] as BillingProvider[],
  planCurrency: "USD"
};

export async function resolveBillingCheckout(
  request: BillingCheckoutRequest
): Promise<BillingCheckoutResult> {
  if (request.mode === "manual_cash" || request.provider === "manual_cash") {
    return {
      status: "pending_payment",
      provider: "manual_cash",
      message: "Pago en efectivo pendiente de confirmación por PALMYRA."
    };
  }

  // Reserved international path. No provider is activated until its production
  // credentials/webhook configuration is present.
  return {
    status: "not_configured",
    provider: request.provider,
    message: "El cobro internacional todavía no está activado en este entorno."
  };
}
