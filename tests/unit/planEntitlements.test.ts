import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACQUISITION_PAYMENTS,
  BILLING_MONTHS,
  PALMYRA_PLANS,
  getPlan,
  isAcquisitionPaymentMethod,
  isBillingMonths,
  isPermanentPlan,
  renewalPeriod,
  slugifyCompany,
  type PlanCode
} from "../../src/config/saas";
import { canUsePlanFeature, getPlanDisplayName, isPermanentPlan as isPermanentPlanFromAccess } from "../../src/services/planAccess";
import { buildWhatsAppPaymentUrl, paymentMethodLabel } from "../../src/utils/whatsapp";

test("PALMYRA publishes Gratis plus exactly the three paid plans", () => {
  assert.deepEqual(
    PALMYRA_PLANS.map((plan) => plan.code),
    ["free", "starter", "growth", "pro"]
  );
});

test("paid prices and limits stay unchanged", () => {
  const expected: Record<PlanCode, { price: number; warehouses: number; employees: number; products: number }> = {
    free: { price: 0, warehouses: 1, employees: 1, products: 25 },
    starter: { price: 10, warehouses: 1, employees: 2, products: 50 },
    growth: { price: 15, warehouses: 3, employees: 4, products: 150 },
    pro: { price: 25, warehouses: 7, employees: 10, products: 300 }
  };

  for (const plan of PALMYRA_PLANS) {
    assert.deepEqual(
      { price: plan.price, warehouses: plan.warehouses, employees: plan.employees, products: plan.products },
      expected[plan.code],
      plan.code
    );
    assert.equal(plan.priceCurrency, "USD");
  }
});

test("free is the smallest plan and Oasis has fewer employees than the higher tiers", () => {
  const free = getPlan("free");
  const oasis = getPlan("starter");
  const caravan = getPlan("growth");
  const citadel = getPlan("pro");

  assert.equal(free.code, "free");
  assert.equal(free.price, 0);
  assert.equal(free.warehouses, 1);
  assert.equal(free.employees, 1);
  assert.ok(oasis.employees < caravan.employees);
  assert.ok(caravan.employees < citadel.employees);
  assert.ok(oasis.warehouses < caravan.warehouses);
  assert.ok(caravan.warehouses < citadel.warehouses);
  assert.ok(free.products < oasis.products);
});

test("Gratis is permanent and includes commercial cloud backup", () => {
  const free = getPlan("free");
  const featureText = free.features.join(" | ");

  assert.match(free.description, /sin vencimiento/i);
  assert.match(featureText, /1 almacén/i);
  assert.match(featureText, /1 empleado \+ propietario/i);
  assert.match(featureText, /respaldo comercial en la nube/i);
  for (const code of ["free", "starter", "growth", "pro"] as const) {
    assert.equal(getPlan(code).features.some((feature) => /respaldo comercial en la nube/i.test(feature)), true, code);
  }
});

test("premium plan features do not leak into lower plans", () => {
  const oasis = getPlan("starter");
  const caravan = getPlan("growth");
  const citadel = getPlan("pro");

  assert.equal(oasis.features.some((x) => /compras|transferencias|analítica|soporte prioritario/i.test(x)), false);
  assert.equal(caravan.features.some((x) => /analítica avanzada|soporte prioritario/i.test(x)), false);
  assert.equal(caravan.features.includes("Compras y recepción"), true);
  assert.equal(caravan.features.includes("Transferencias entre almacenes"), true);
  assert.equal(citadel.features.includes("Analítica avanzada"), true);
  assert.equal(citadel.features.includes("Soporte prioritario"), true);
});

test("isPermanentPlan recognizes only the free plan", () => {
  assert.equal(isPermanentPlan("free"), true);
  assert.equal(isPermanentPlan(" FREE "), true);
  assert.equal(isPermanentPlan("starter"), false);
  assert.equal(isPermanentPlan("trial"), false);
  assert.equal(isPermanentPlan(null), false);
  assert.equal(isPermanentPlan(undefined), false);
  assert.equal(isPermanentPlanFromAccess("free"), true);
  assert.equal(isPermanentPlanFromAccess("pro"), false);
});

test("plan access grants basic features to Gratis and keeps the full feature set", () => {
  assert.equal(canUsePlanFeature("free", "pos"), true);
  assert.equal(canUsePlanFeature("free", "cash"), true);
  assert.equal(canUsePlanFeature("free", "inventory"), true);
  assert.equal(canUsePlanFeature("free", "basic_reports"), true);
  assert.equal(canUsePlanFeature("free", "cloud_backup"), true);
  assert.equal(canUsePlanFeature("free", "custom_roles"), false);
  assert.equal(canUsePlanFeature("free", "transfers"), false);
  assert.equal(canUsePlanFeature("free", "customers_suppliers"), false);
  assert.equal(canUsePlanFeature("free", "advanced_analytics"), false);

  assert.equal(canUsePlanFeature("starter", "cloud_backup"), true);
  assert.equal(canUsePlanFeature("starter", "custom_roles"), true);
  assert.equal(canUsePlanFeature("starter", "transfers"), false);
  assert.equal(canUsePlanFeature("growth", "transfers"), true);
  assert.equal(canUsePlanFeature("growth", "advanced_analytics"), false);
  assert.equal(canUsePlanFeature("pro", "advanced_analytics"), true);

  assert.equal(canUsePlanFeature(null, "pos"), false);
  assert.equal(canUsePlanFeature("unknown-plan", "pos"), false);
});

test("plan display names stay in Spanish", () => {
  assert.equal(getPlanDisplayName("free"), "Gratis");
  assert.equal(getPlanDisplayName("starter"), "Oasis");
  assert.equal(getPlanDisplayName("growth"), "Caravana");
  assert.equal(getPlanDisplayName("pro"), "Ciudadela");
});

test("only the three Cuba payment methods are accepted", () => {
  assert.deepEqual(ACQUISITION_PAYMENTS.map((method) => method.code), [
    "cup_cash",
    "cup_bank_transfer",
    "usd_cash"
  ]);
  assert.deepEqual(ACQUISITION_PAYMENTS.map((method) => method.currency), ["CUP", "CUP", "USD"]);
  assert.equal(paymentMethodLabel("cup_cash"), "Efectivo en CUP");
  assert.equal(paymentMethodLabel("usd_cash"), "Efectivo en USD");

  assert.equal(isAcquisitionPaymentMethod("cup_cash"), true);
  assert.equal(isAcquisitionPaymentMethod("usd_cash"), true);
  assert.equal(isAcquisitionPaymentMethod("manual_cash"), false);
  assert.equal(isAcquisitionPaymentMethod("paypal_abroad"), false);
  assert.equal(isAcquisitionPaymentMethod("stripe"), false);
  assert.equal(isAcquisitionPaymentMethod(null), false);
});

test("billing durations are limited to 1, 3, 6 and 12 months", () => {
  assert.deepEqual([...BILLING_MONTHS], [1, 3, 6, 12]);
  assert.equal(isBillingMonths(1), true);
  assert.equal(isBillingMonths(6), true);
  assert.equal(isBillingMonths(2), false);
  assert.equal(isBillingMonths(24), false);
});

test("early renewal starts at max(expiry, approval) and adds calendar months", () => {
  const early = renewalPeriod("2026-05-31T00:00:00.000Z", "2026-02-10T00:00:00.000Z", 3);
  assert.equal(early.start, "2026-05-31T00:00:00.000Z");
  assert.equal(early.end, "2026-08-31T00:00:00.000Z");

  const expired = renewalPeriod("2026-01-10T00:00:00.000Z", "2026-02-01T09:00:00.000Z", 6);
  assert.equal(expired.start, "2026-02-01T09:00:00.000Z");
  assert.equal(expired.end, "2026-08-01T09:00:00.000Z");

  const fresh = renewalPeriod(null, "2026-03-01T00:00:00.000Z", 12);
  assert.equal(fresh.start, "2026-03-01T00:00:00.000Z");
  assert.equal(fresh.end, "2027-03-01T00:00:00.000Z");
});

test("renewal clamps month-end instead of overflowing days", () => {
  assert.equal(renewalPeriod(null, "2026-01-31T12:30:00.000Z", 1).end, "2026-02-28T12:30:00.000Z");
  assert.equal(renewalPeriod(null, "2028-01-31T00:00:00.000Z", 1).end, "2028-02-29T00:00:00.000Z");
  assert.equal(renewalPeriod(null, "2026-08-31T00:00:00.000Z", 6).end, "2027-02-28T00:00:00.000Z");
});

test("renewal rejects unsupported durations and invalid dates", () => {
  assert.throws(() => renewalPeriod(null, "2026-01-01T00:00:00.000Z", 2 as never), /invalid_billing_months/);
  assert.throws(() => renewalPeriod("not-a-date", "2026-01-01T00:00:00.000Z", 1), /invalid_date/);
});

test("WhatsApp request describes the manual Cuba payment without a gateway", () => {
  const cup = decodeURIComponent(buildWhatsAppPaymentUrl({
    companyName: "Bodega La Palma",
    planName: "Caravana",
    planCode: "growth",
    paymentMethod: "cup_bank_transfer",
    months: 6,
    amount: 90,
    currency: "USD",
    requestId: "req-123"
  }));

  assert.match(cup, /^https:\/\/wa\.me\/5355581669\?text=/);
  assert.match(cup, /Plan: Caravana/);
  assert.match(cup, /Duración: 6 mes\(es\)/);
  assert.match(cup, /Método de pago: Transferencia bancaria en CUP/);
  assert.match(cup, /Importe en CUP: por acordar con PALMYRA\. Sin conversión automática\./);
  assert.match(cup, /Solicitud: req-123/);
  assert.match(cup, /no activa ni renueva el plan hasta la confirmación manual/i);

  const usd = decodeURIComponent(buildWhatsAppPaymentUrl({
    planName: "Oasis",
    planCode: "starter",
    paymentMethod: "usd_cash",
    months: 1,
    amount: 10,
    currency: "USD"
  }));
  assert.match(usd, /Método de pago: Efectivo en USD/);
  assert.match(usd, /Precio de referencia del período: 10[.,]00 USD/);
  assert.doesNotMatch(usd, /Importe en CUP/);

  assert.match(paymentMethodLabel("manual_cash"), /registro anterior/);
});

test("slugifyCompany produces the slug format enforced by the onboarding RPC", () => {
  assert.equal(slugifyCompany("  Bodega La Palma  "), "bodega-la-palma");
  assert.equal(slugifyCompany("Café Núñez"), "cafe-nunez");
  assert.match(slugifyCompany("Mi Negocio 24/7"), /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test("the applied Cuba plan migration encodes free-forever and manual renewals", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20261118130000_cuba_free_plans_manual_renewals.sql"),
    "utf8"
  );

  assert.match(sql, /APPLIED 2026-11-20/);
  assert.match(sql, /'free','Gratis',0,'USD',0/);
  assert.match(sql, /update public\.plans set trial_days=0 where code='starter'/);
  assert.match(sql, /plans_trial_days_policy_check check \(trial_days=0\)/);
  assert.match(sql, /free_plan_has_no_expiry/);

  for (const method of ["cup_cash", "cup_bank_transfer", "usd_cash"]) {
    assert.match(sql, new RegExp(`'${method}'`), method);
  }
  assert.doesNotMatch(sql, /paypal_from_abroad_only/);
  assert.match(sql, /p_payment_method not in \('cup_cash','cup_bank_transfer','usd_cash'\)/);
  assert.doesNotMatch(sql, /terms_version=3[\s\S]{0,200}?paypal/i);
  assert.match(sql, /create unique index if not exists plan_requests_one_pending_v3/);
  assert.match(sql, /request_company_plan_v3/);
  assert.match(sql, /approve_plan_request_v3/);
  assert.match(sql, /already_approved/);
  assert.match(sql, /greatest\(v_now,case when v_sub\.status='trialing'/);
  assert.match(sql, /make_interval\(months=>v_req\.billing_months\)/);

  // Never rewrite or delete commercial history while adjusting the catalog.
  assert.doesNotMatch(sql, /delete from public\.(subscriptions|billing_payments|billing_invoices)/i);
  assert.doesNotMatch(sql, /truncate/i);
});

test("the free cloud migration gives Gratis cloud backup like the paid plans", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20261120120000_free_plan_cloud_backup.sql"),
    "utf8"
  );

  assert.match(sql, /APPLIED 2026-11-20/);
  assert.match(sql, /where code='free'/);
  assert.match(sql, /"storage_mode":"cloud_backup"/);
  assert.match(sql, /"cloud_backup":true/);
  assert.match(sql, /when 'cloud_backup' then p\.code in \('free','starter','growth','pro','trial'\)/);
  assert.doesNotMatch(sql, /storage_mode','local_only/);
  assert.doesNotMatch(sql, /cloud_backup',false/);
});
