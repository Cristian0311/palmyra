export type PlanCode = 'starter' | 'growth' | 'pro';

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
    code: 'starter',
    name: 'Starter',
    price: 10,
    warehouses: 1,
    employees: 2,
    products: 50,
    reports: 'Reportes básicos',
    support: 'Soporte estándar',
    description: 'Para pequeños negocios que quieren empezar con control de ventas, inventario y caja.',
    features: ['1 almacén', '2 empleados + administrador', '50 tipos de productos/SKUs', 'Reportes básicos', 'POS e inventario', 'Modo offline']
  },
  {
    code: 'growth',
    name: 'Growth',
    price: 15,
    warehouses: 3,
    employees: 4,
    products: 150,
    reports: 'Reportes más avanzados',
    support: 'Soporte estándar',
    description: 'Para negocios que necesitan varias ubicaciones, compras y mayor visibilidad operativa.',
    features: ['3 almacenes', '4 empleados + administrador', '150 tipos de productos/SKUs', 'Reportes avanzados', 'Transferencias entre almacenes', 'Compras y proveedores']
  },
  {
    code: 'pro',
    name: 'Pro',
    price: 25,
    warehouses: 7,
    employees: 10,
    products: 300,
    reports: 'Reportes mucho más avanzados',
    support: 'Soporte prioritario',
    description: 'Para empresas con más almacenes, equipos grandes, analítica profunda y atención prioritaria.',
    features: ['7 almacenes', '10 empleados + administrador', '300 tipos de productos/SKUs', 'Reportes avanzados+', 'Analítica avanzada', 'Soporte prioritario']
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
