/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Versión de package.json inyectada por Vite en tiempo de compilación. */
declare const __APP_VERSION__: string;

declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    immediate?: boolean
    onNeedRefresh?: () => void
    onOfflineReady?: () => void
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void
    onRegisterError?: (error: any) => void
  }

  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>
}
