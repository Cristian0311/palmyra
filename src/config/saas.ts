export type PlanCode = 'free' | 'starter' | 'growth' | 'pro';
export type PaidPlanCode = Exclude<PlanCode, 'free'>;
export const BILLING_MONTHS = [1, 3, 6, 12] as const;
export type BillingMonths = typeof BILLING_MONTHS[number];
export const ACQUISITION_PAYMENTS = [
  { code: 'cup_cash', label: 'Efectivo en CUP', currency: 'CUP', detail: 'Importe en CUP acordado con PALMYRA antes del pago.' },
  { code: 'cup_bank_transfer', label: 'Transferencia bancaria en CUP', currency: 'CUP', detail: 'Datos bancarios e importe confirmados por PALMYRA.' },
  { code: 'usd_cash', label: 'Efectivo en USD', currency: 'USD', detail: 'Entrega coordinada en Cuba y confirmación manual.' },
] as const;
export type AcquisitionPaymentMethod = typeof ACQUISITION_PAYMENTS[number]['code'];
export const isAcquisitionPaymentMethod = (value: unknown): value is AcquisitionPaymentMethod =>
  ACQUISITION_PAYMENTS.some((method) => method.code === value);
export const isBillingMonths = (value: number): value is BillingMonths =>
  BILLING_MONTHS.some((months) => months === value);

// Gratis does not expire and has no renewal date; every plan syncs to the cloud.
export const isPermanentPlan = (code?: string | null): boolean => code?.trim().toLowerCase() === 'free';

// Preview only. The locked approval RPC is authoritative; UTC calendar months clamp month-end.
export function renewalPeriod(expiry: string | null | undefined, approvedAt: string, months: BillingMonths) {
  if (!isBillingMonths(months)) throw new Error('invalid_billing_months');
  const approval = new Date(approvedAt);
  const expires = expiry ? new Date(expiry) : approval;
  if (!Number.isFinite(approval.getTime()) || !Number.isFinite(expires.getTime())) throw new Error('invalid_date');
  const start = new Date(Math.max(approval.getTime(), expires.getTime()));
  const end = new Date(start);
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return { start: start.toISOString(), end: end.toISOString() };
}

export interface SaaSPlan {
  code: PlanCode;
  name: string;
  price: number;
  priceCurrency: 'USD';
  warehouses: number;
  employees: number;
  products: number;
  reports: string;
  support: string;
  description: string;
  features: string[];
}

export const PALMYRA_PLANS: SaaSPlan[] = [
  {
    code: 'free',
    name: 'Gratis',
    price: 0,
    priceCurrency: 'USD',
    warehouses: 1,
    employees: 1,
    products: 25,
    reports: 'Reportes básicos',
    support: 'Ayuda de autoservicio',
    description: 'Sin vencimiento. Operación básica con respaldo comercial en la nube incluido.',
    features: ['1 almacén', '1 empleado + propietario', '25 tipos de productos/SKUs', 'Punto de venta básico', 'Caja en efectivo', 'Inventario básico', 'Reportes básicos', 'Modo offline', 'Respaldo comercial en la nube']
  },
  {
    code: 'starter',
    name: 'Oasis',
    price: 10,
    priceCurrency: 'USD',
    warehouses: 1,
    employees: 2,
    products: 50,
    reports: 'Reportes básicos',
    support: 'Soporte estándar',
    description: 'Para comenzar a vender y controlar lo esencial sin complicaciones.',
    features: [
      '1 almacén',
      '2 empleados + administrador',
      '50 tipos de productos/SKUs',
      'Punto de venta',
      'Inventario y caja',
      'Equipo con roles',
      'Reportes básicos',
      'Modo offline',
      'Respaldo comercial en la nube'
    ]
  },
  {
    code: 'growth',
    name: 'Caravana',
    price: 15,
    priceCurrency: 'USD',
    warehouses: 3,
    employees: 4,
    products: 150,
    reports: 'Reportes avanzados',
    support: 'Soporte estándar',
    description: 'Para negocios que ya mueven mercancía entre varios puntos y necesitan más control.',
    features: [
      '3 almacenes',
      '4 empleados + administrador',
      '150 tipos de productos/SKUs',
      'Punto de venta',
      'Inventario y caja',
      'Clientes y proveedores',
      'Modo offline',
      'Compras y recepción',
      'Transferencias entre almacenes',
      'Reportes avanzados',
      'Equipo con roles',
      'Operación multi-almacén',
      'Respaldo comercial en la nube'
    ]
  },
  {
    code: 'pro',
    name: 'Ciudadela',
    price: 25,
    priceCurrency: 'USD',
    warehouses: 7,
    employees: 10,
    products: 300,
    reports: 'Analítica avanzada',
    support: 'Soporte prioritario',
    description: 'Para empresas con mayor estructura, más ubicaciones y análisis profundo.',
    features: [
      '7 almacenes',
      '10 empleados + administrador',
      '300 tipos de productos/SKUs',
      'Punto de venta',
      'Inventario y caja',
      'Clientes y proveedores',
      'Modo offline',
      'Compras y recepción',
      'Transferencias entre almacenes',
      'Reportes avanzados',
      'Equipo con roles',
      'Operación multi-almacén',
      'Analítica avanzada',
      'Soporte prioritario',
      'Respaldo comercial en la nube'
    ]
  }
];

export const getPlan = (code?: string | null) =>
  PALMYRA_PLANS.find((plan) => plan.code === code) || PALMYRA_PLANS[0];

export const slugifyCompany = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
