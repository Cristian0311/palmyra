/**
 * Contrato del puente de escritorio que expone el preload aislado de Electron.
 *
 * La ventana nunca recibe Node ni ipcRenderer: solo estas funciones, con datos
 * primitivos saneados. En navegador/PWA/APK los getters devuelven null y todo
 * queda inerte.
 */

export type DesktopDbParam = string | number | null | { b64: string };

export type DesktopDbRequest =
  | { op: "exec"; sql: string }
  | { op: "run"; sql: string; params?: DesktopDbParam[] }
  | { op: "all"; sql: string; params?: DesktopDbParam[] }
  | { op: "status" };

export interface DesktopDbStatus {
  ready: boolean;
  driver: "sqljs" | "unavailable";
  filePath: string;
  sizeBytes: number;
  schemaVersion: number;
  lastWriteAt: number;
  lastError: string;
}

export type DesktopDbResult =
  | { ok: true; changes: number }
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: true; status: DesktopDbStatus }
  | { ok: false; error: string };

export type DesktopDbInvoke = (request: DesktopDbRequest) => Promise<DesktopDbResult>;

export interface DesktopHubStatus {
  enabled: boolean;
  running: boolean;
  host: string;
  port: number;
  companyId: string;
  pairingCode: string;
  pairingExpiresAt: string;
  lastError: string;
  /** El hub se pidió con TLS (nunca degrada a HTTP). */
  tlsEnabled: boolean;
  /** sha256 (hex) del certificado del hub; vacío sin TLS o con el hub detenido. */
  tlsFingerprint: string;
}

export type DesktopHubResult =
  | { ok: true; status: DesktopHubStatus }
  | { ok: false; error: string };

export interface DiscoveredHub {
  host: string;
  port: number;
  url: string;
  fingerprint: string;
  name: string;
}

export type DesktopHubPinResult = { ok: boolean; error?: string };

export type DesktopHubDiscoveryResult =
  | { ok: true; hubs: DiscoveredHub[] }
  | { ok: false; error: string };

export interface DesktopHubBridge {
  status(): Promise<DesktopHubResult>;
  start(companyId: string): Promise<DesktopHubResult>;
  stop(): Promise<DesktopHubResult>;
  newPairingCode(): Promise<DesktopHubResult>;
  /** Fija la huella TLS del hub por hostname antes de navegar a él. */
  pinCertificate?(baseUrl: string, fingerprint: string): Promise<DesktopHubPinResult>;
  /** Hubs anunciados por mDNS en la LAN. */
  discoverHubs?(timeoutMs?: number): Promise<DesktopHubDiscoveryResult>;
}

declare global {
  interface Window {
    palmyraDesktopDb?: { invoke: DesktopDbInvoke };
    palmyraDesktopHub?: DesktopHubBridge;
  }
}

export function getDesktopDbBridge(): { invoke: DesktopDbInvoke } | null {
  if (typeof window === "undefined") return null;
  const bridge = window.palmyraDesktopDb;
  return bridge && typeof bridge.invoke === "function" ? bridge : null;
}

export function getDesktopHubBridge(): DesktopHubBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.palmyraDesktopHub;
  return bridge && typeof bridge.status === "function" ? bridge : null;
}

export function isDesktopRuntime(): boolean {
  return getDesktopDbBridge() !== null || getDesktopHubBridge() !== null;
}

export function emptyDbStatus(error = ""): DesktopDbStatus {
  return {
    ready: false,
    driver: "unavailable",
    filePath: "",
    sizeBytes: 0,
    schemaVersion: 0,
    lastWriteAt: 0,
    lastError: error
  };
}

export function emptyHubStatus(error = ""): DesktopHubStatus {
  return {
    enabled: false,
    running: false,
    host: "",
    port: 0,
    companyId: "",
    pairingCode: "",
    pairingExpiresAt: "",
    lastError: error,
    tlsEnabled: false,
    tlsFingerprint: ""
  };
}
