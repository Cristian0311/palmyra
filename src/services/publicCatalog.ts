import { getSupabase } from "../lib/supabase";

export interface PublicCatalogProduct {
  id: string;
  sku: string;
  name: string;
  description?: string | null;
  image_path?: string | null;
  category_id?: string | null;
  category_name: string;
  price: number;
  currency_code: string;
  availability?: Array<{ warehouse_id: string; quantity: number; available: boolean }>;
  variants?: Array<{
    id: string;
    name: string;
    sku: string;
    attributes?: Record<string, unknown>;
    availability?: Array<{ warehouse_id: string; quantity: number; available: boolean }>;
  }>;
}

export interface PublicCatalog {
  company: {
    id: string;
    name: string;
    slug: string;
    currency_code: string;
    timezone?: string | null;
  };
  config: {
    enabled: boolean;
    banner_text: string;
    theme_color: string;
    whatsapp_number: string;
    show_prices: boolean;
  };
  warehouses: Array<{ id: string; code: string; name: string }>;
  products: PublicCatalogProduct[];
}

export async function loadPublicCatalog(slug: string): Promise<PublicCatalog> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("La tienda no está configurada.");
  const cleanSlug = slug.trim().toLowerCase();
  if (!cleanSlug) throw new Error("Enlace de tienda inválido.");

  const { data, error } = await supabase.rpc("get_public_catalog", { p_slug: cleanSlug });
  if (error) {
    if (String(error.message).includes("catalog_disabled")) {
      throw new Error("Esta tienda está temporalmente deshabilitada.");
    }
    throw new Error("No se pudo cargar la tienda.");
  }

  return data as PublicCatalog;
}
