/// <reference types="vite/client" />

declare const __ADMIN_BUILD__: string;
declare const __ADMIN_BUILT_AT__: string;
declare const __ADMIN_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_APP_ORIGIN?: string;
  readonly VITE_PALMYRA_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
