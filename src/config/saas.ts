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
    name: 'Oasis',
    price: 10,
    priceCurrency: 'USD',
    warehouses: 1,
    employees: 2,
    products: 50,
    reports: 'Reportes básicos',
    support: 'Soporte estándar',
    description: 'Para comenzar a vender y controlar lo esencial sin complicaciones.',
    features: ['1 almacén', '2 empleados + administrador', '50 tipos de productos/SKUs', 'Punto de venta', 'Inventario y caja', 'Clientes y proveedores', 'Reportes básicos', 'Modo offline']
  },
  {
    code: 'growth',
    name: 'Caravana',
    price: 15,
    priceCurrency: 'USD',
    warehouses: 3,
    employees: 4,
    products: 150,
    reports: 'Reportes más avanzados',
    support: 'Soporte estándar',
    description: 'Para negocios que ya mueven mercancía entre varios puntos y necesitan más control.',
    features: ['3 almacenes', '4 empleados + administrador', '150 tipos de productos/SKUs', 'Compras y recepción', 'Transferencias entre almacenes', 'Reportes avanzados', 'Equipo con roles', 'Operación multi-almacén']
  },
  {
    code: 'pro',
    name: 'Ciudadela',
    price: 25,
    priceCurrency: 'USD',
    warehouses: 7,
    employees: 10,
    products: 300,
    reports: 'Reportes mucho más avanzados',
    support: 'Soporte prioritario',
    description: 'Para empresas con mayor estructura, más ubicaciones y análisis profundo.',
    features: ['7 almacenes', '10 empleados + administrador', '300 tipos de productos/SKUs', 'Analítica avanzada', '7 almacenes operativos', 'Soporte prioritario']
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
