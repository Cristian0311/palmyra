/**
 * Piezas del protocolo que comparten servidor y cliente.
 *
 * Vive aparte de `auth.ts` porque ese módulo firma con node:crypto y el cliente
 * del renderer debe poder importarse desde el bundle web sin arrastrarlo.
 */

export const HUB_AUTH_HEADERS = {
  device: "x-palmyra-device",
  timestamp: "x-palmyra-timestamp",
  nonce: "x-palmyra-nonce",
  signature: "x-palmyra-signature"
} as const;

export interface HubCanonicalInput {
  method: string;
  path: string;
  timestamp: number | string;
  nonce: string;
  body: string;
}

/** La ruta firmada excluye query y fragmento: `METHOD\nPATH\nTS\nNONCE\nsha256(BODY)`. */
export function canonicalPath(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}
