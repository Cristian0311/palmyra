const compactId = (id: string) => String(id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

/**
 * Códigos de documento cortos y legibles para la interfaz. El identificador
 * real de cada registro sigue siendo el UUID interno; este código es solo la
 * etiqueta humana (tickets, traslados, cotizaciones, auditorías, órdenes).
 */
export function documentCode(prefix: string, id: string, size = 6): string {
  const compact = compactId(id);
  if (!compact) return prefix;
  return `${prefix}-${compact.slice(-size)}`;
}

/** Etiqueta del ticket de venta, sin exponer nunca el UUID completo. */
export function ticketDisplay(ticketNumber: string | undefined | null, id: string): string {
  const ticket = String(ticketNumber || '').trim();
  if (ticket) return ticket.replace(/^PALMYRA-/i, '').toUpperCase();
  const raw = String(id || '').trim();
  if (/^PALMYRA-TK/i.test(raw)) return raw.replace(/^PALMYRA-/i, '').toUpperCase();
  if (/^TK\d+/i.test(raw)) return raw.toUpperCase();
  return documentCode('TK', raw);
}
