import type { PlatformSupportSettings } from "../../services/platformAdmin";
import type { PlatformOverview, PlatformPlan } from "../../services/platformAdminConsole";

export type AdminTab = "resumen" | "empresas" | "usuarios" | "planes" | "soporte" | "auditoria" | "ajustes";

export type CompanyLite = {
  id: string;
  name: string;
  slug?: string | null;
  account_status?: string | null;
  active?: boolean | null;
  products?: number | null;
  employees?: number | null;
  warehouses?: number | null;
  created_at?: string | null;
  plan_code?: string | null;
  plan_name?: string | null;
  plan_status?: string | null;
  period_end?: string | null;
};

export type PlanRequestLite = {
  id: string;
  status?: string | null;
  company_id?: string | null;
  company_name?: string | null;
  company_status?: string | null;
  plan_code?: string | null;
  plan_name?: string | null;
  monthly_price?: number | null;
  billing_months?: number | null;
  quoted_amount?: number | null;
  quoted_currency?: string | null;
  payment_method?: string | null;
  requested_at?: string | null;
  approved_at?: string | null;
  note?: string | null;
  contact_phone?: string | null;
  owner_email?: string | null;
};

export type AdminContext = {
  busy: boolean;
  version: number;
  companies: CompanyLite[];
  plans: PlatformPlan[];
  overview: PlatformOverview | null;
  usage: Record<string, any> | null;
  pendingRequests: PlanRequestLite[];
  supportSettings: PlatformSupportSettings;
  goTo: (tab: AdminTab) => void;
  run: (fn: () => Promise<unknown>, message: string) => Promise<void>;
  refresh: () => Promise<void>;
};
